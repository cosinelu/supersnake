'use strict';
/**
 * room.js — 对局房间（v3.0）：固定步长模拟 + 快照广播 + 掉线判负 + 结算
 *
 * 一个 Room = 一局 HeadlessGame（N 真人 + AI 补位）。
 * 真人连接抽象为 { connId, name, send(obj), ... }，send 由 index.js 注入（ws.send 包装），
 * 因此本文件可在无网络的集成测试中原样驱动。
 *
 * 时序：构造 → start()（matched 广播 + 倒计时）→ step(dt) 循环（auto 模式由 setInterval 驱动，
 * 测试手动驱动）→ over（淘汰殆尽/超时）→ linger 后 onEmpty 回收。
 */
var path = require('path');
var JS = path.join(__dirname, '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'ai', 'multiplayer']
  .forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'transport', 'headlessGame']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS;
var P = CS.protocol;

var nextRoomId = 1;

/**
 * @param {object} opts {
 *   players: [{ connId, name, send }],   // send(obj)：发送协议消息（已实现 ws 包装）
 *   config: server/config（或测试覆盖版）,
 *   onEmpty: fn(room)                     // 房间销毁回调
 * }
 */
function Room(opts) {
  this.id = 'r' + (nextRoomId++);
  this.config = opts.config;
  this.onEmpty = opts.onEmpty || function () {};
  this.state = 'countdown'; // countdown → running → over
  this.tickCount = 0;
  this.countdownLeft = this.config.COUNTDOWN_MS;
  this._timer = null;
  this._overTimer = null;

  var self = this;
  this.game = new CS.HeadlessGame({
    onEvent: function (kind, data) { self._broadcast(P.event(kind, data)); }
  });
  var names = opts.players.map(function (p) { return p.name; });
  var entries = this.game.setup(names);

  this.humans = {}; // connId → human
  var self2 = this;
  opts.players.forEach(function (p, i) {
    self2.humans[p.connId] = {
      connId: p.connId, name: p.name, send: p.send,
      entry: entries[i], connected: true,
      angle: entries[i].snake.angle, boost: 0,
      lastSeq: 0,           // 已应用的输入 seq（快照 ack）
      overSent: false
    };
  });
  this.totalHumans = opts.players.length;
}

/** 广播 matched，进入倒计时（step 驱动递减） */
Room.prototype.start = function () {
  var players = [];
  for (var cid in this.humans) {
    players.push({ id: this.humans[cid].entry.id, name: this.humans[cid].name });
  }
  // 初始墙体一并下发（后续新增墙体走 wall 事件增量广播）
  var walls = this.game.walls.rects.map(function (r) { return [r.x | 0, r.y | 0, r.w | 0, r.h | 0]; });
  for (var c in this.humans) {
    var h = this.humans[c];
    h.send({
      t: P.S2C.MATCHED, roomId: this.id, playerId: h.entry.id,
      players: players, countdownMs: this.config.COUNTDOWN_MS,
      W: this.game.W, H: this.game.H, walls: walls
    });
  }
};

/** 真实时钟循环（生产用；须在 start() 之后调用；测试直接调 step 不需要本方法）
 *  累加器补帧：Windows 定时器粒度 15.6ms 时 setInterval(33) 实际只有 ~21Hz，
 *  按真实流逝时间补齐固定步长，保证游戏时间 = 真实时间（Linux 1ms 粒度下等价直跑）。 */
Room.prototype.run = function () {
  var self = this;
  if (this._timer) return;
  var last = this.config.nowFn();
  var acc = 0;
  this._timer = setInterval(function () {
    var now = self.config.nowFn();
    acc += now - last;
    last = now;
    var n = 0;
    while (acc >= self.config.TICK_MS && n < 4 && self.state !== 'over') {
      self.step(self.config.TICK_MS);
      acc -= self.config.TICK_MS;
      n++;
    }
    if (acc >= self.config.TICK_MS) acc = 0; // 长卡顿丢弃欠账，防追帧螺旋
  }, this.config.TICK_MS);
};

/** 便捷：start + run（单房间调试模式用） */
Room.prototype.startAuto = function () {
  this.start();
  this.run();
};

/** 输入处理：保留最新角度/加速位 + seq（快照 ack 用） */
Room.prototype.handleInput = function (connId, msg) {
  var h = this.humans[connId];
  if (!h || !h.connected || this.state !== 'running') return;
  var seq = msg.seq | 0;
  if (seq < h.lastSeq || seq > h.lastSeq + this.config.INPUT_MAX_SEQ_JUMP) return; // 乱序/异常丢弃
  if (typeof msg.a === 'number' && isFinite(msg.a)) h.angle = msg.a;
  h.boost = msg.bo ? 1 : 0;
  h.lastSeq = seq;
};

/** 掉线判负：立即淘汰该玩家（尸体掉落/事件广播走 mp 正常流程） */
Room.prototype.handleDrop = function (connId) {
  var h = this.humans[connId];
  if (!h || !h.connected) return;
  h.connected = false;
  if (this.state !== 'over' && h.entry.alive) {
    this.game.mp.kill(h.entry); // death 事件经 onMpEvent 自动广播
  }
};

/** 推进一个 tick（countdown/running/over 状态机） */
Room.prototype.step = function (dt) {
  if (this.state === 'over') return;

  if (this.state === 'countdown') {
    this.countdownLeft -= dt;
    if (this.countdownLeft <= 0) {
      this.state = 'running';
      this._broadcast({ t: P.S2C.START, tick: 0 });
    }
    return;
  }

  // running：写入真人输入 → 模拟 → 快照 → 结算判定
  for (var cid in this.humans) {
    var h = this.humans[cid];
    if (h.connected) this.game.setInput(h.entry, h.angle);
  }
  this.game.tick(dt);
  this.tickCount++;

  if (this.tickCount % this.config.SNAP_EVERY === 0) this._broadcastSnap();

  this._checkPlayerDeaths();
  this._checkOver();
};

Room.prototype._broadcast = function (msg) {
  for (var cid in this.humans) {
    var h = this.humans[cid];
    if (h.connected) safeSend(h, msg);
  }
};

/** 快照广播：ack 按连接个性化（该连接已应用到哪个输入 seq） */
Room.prototype._broadcastSnap = function () {
  var snap = P.snap(this.tickCount, 0, this.game.mp.timeMs,
    this.game.mp.allEntries(), this.game.spawner.blocks, this.game.spawner.meteors);
  for (var cid in this.humans) {
    var h = this.humans[cid];
    if (!h.connected) continue;
    snap.ack = h.lastSeq;
    safeSend(h, snap);
  }
};

/** 真人自然死亡（撞墙/被撞）→ 立即给本人发 over(dead)（对手继续） */
Room.prototype._checkPlayerDeaths = function () {
  for (var cid in this.humans) {
    var h = this.humans[cid];
    if (h.connected && !h.overSent && !h.entry.alive) {
      h.overSent = true;
      safeSend(h, { t: P.S2C.OVER, reason: P.OVER_REASON.DEAD, ranks: this._ranks() });
    }
  }
};

/** 结算条件：存活真人 ≤1（多真人局）或团灭 / 到达对局上限 */
Room.prototype._checkOver = function () {
  var alive = this.game.mp.alivePlayerCount();
  var threshold = this.totalHumans > 1 ? 1 : 0;
  var reason = null;
  if (alive <= threshold) reason = P.OVER_REASON.WIN;
  else if (this.game.mp.timeMs >= this.config.MATCH_MAX_MS) reason = P.OVER_REASON.TIMEOUT;
  if (!reason) return;

  this.state = 'over';
  var ranks = this._ranks();
  for (var cid in this.humans) {
    var h = this.humans[cid];
    if (!h.connected || h.overSent) continue;
    h.overSent = true;
    var r = h.entry.alive ? reason : P.OVER_REASON.DEAD;
    safeSend(h, { t: P.S2C.OVER, reason: r, ranks: ranks });
  }
  if (this._timer) { clearInterval(this._timer); this._timer = null; }
  var self = this;
  this._overTimer = setTimeout(function () { self.onEmpty(self); }, this.config.OVER_LINGER_MS);
};

/** 最终排行：存活优先，其后按总分（生存+消除+彩色星加成）降序 */
Room.prototype._ranks = function () {
  var arr = this.game.mp.allEntries().map(function (e) {
    return {
      id: e.id, name: e.name, isPlayer: e.isPlayer, alive: e.alive,
      score: (e.survivalScore || 0) + (e.elimScore || 0) + (e.mpBonusScore || 0),
      length: e.snake.length(), kills: e.kills
    };
  });
  arr.sort(function (a, b) {
    if (!!a.alive !== !!b.alive) return a.alive ? -1 : 1;
    return b.score - a.score;
  });
  for (var i = 0; i < arr.length; i++) arr[i].rank = i + 1;
  return arr;
};

Room.prototype.destroy = function () {
  if (this._timer) { clearInterval(this._timer); this._timer = null; }
  if (this._overTimer) { clearTimeout(this._overTimer); this._overTimer = null; }
};

function safeSend(h, msg) {
  try { h.send(msg); } catch (e) { h.connected = false; }
}

module.exports = Room;
