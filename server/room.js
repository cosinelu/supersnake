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
['protocol', 'transport', 'headlessGame', 'binCodec', 'binProtocol']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS;
var P = CS.protocol;
var BP = CS.binProtocol;

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
  this.udp = opts.udp || null;   // UdpEndpoint（可选）：为 null 时全程走 TCP
  this.state = 'countdown'; // countdown → running → over
  this.tickCount = 0;
  this.countdownLeft = this.config.COUNTDOWN_MS;
  this._timer = null;
  this._overTimer = null;
  // 色块增量同步：记录上一帧的色块集合，每帧算出 add/del（见 02-udp-transport.md §2.4）
  this._blockSeen = {};     // bid → block
  this._nextBid = 1;
  this._lowFreqAt = 0;      // 低频通道（昵称/计分/色块全量校正）上次发送时刻

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

/**
 * 低频通道（1Hz，走 TCP）：昵称 / 计分 / 排行榜 + 色块全量校正。
 *
 * 这些字段永不变或低频变，从 30Hz 的每帧快照里移出去（原本占 103 B/蛇）。
 * 色块全量是增量同步的兜底：客户端漏收任一增量都会永久偏差，
 * 靠 1Hz 全量整体替换修复。走 TCP 是因为它低频、体积大、且不能丢。
 */
Room.prototype._maybeLowFreq = function () {
  if (!this.udp || !this.config.UDP_ENABLED) return;   // 纯 TCP 路径无需低频通道
  var now = this.config.nowFn();
  var period = this.config.LOWFREQ_MS || 1000;
  if (now - this._lowFreqAt < period) return;
  this._lowFreqAt = now;

  var entries = this.game.mp.allEntries();
  var meta = entries.map(function (e) {
    return {
      id: e.id, nm: e.name, kl: e.kills | 0, es: e.elimScore | 0,
      et: e.elimTotal | 0, ml: e.maxLen | 0,
      sv: e.survivalScore | 0, mb: e.mpBonusScore | 0
    };
  });
  var blocks = this.game.spawner.blocks;
  var full = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.__bid == null) continue;   // 尚未编号的下一帧增量会带上
    full.push({ bid: b.__bid, x: Math.round(b.x), y: Math.round(b.y), c: b.color });
  }
  this._broadcast({ t: 'meta', tk: this.tickCount, sn: meta, blocks: full });
};

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
    var msg = {
      t: P.S2C.MATCHED, roomId: this.id, playerId: h.entry.id,
      players: players, countdownMs: this.config.COUNTDOWN_MS,
      W: this.game.W, H: this.game.H, walls: walls,
      snapIntervalMs: this.config.TICK_MS * this.config.SNAP_EVERY // 客户端插值缓冲据此自适应
    };
    // 加速通道接入信息（可选）：客户端据此打洞；拿不到就全程走 TCP
    // （见 02-udp-transport.md §4.3）。
    // **两条通道都下发**（裸 UDP + WebTransport），由客户端按自身能力挑一条：
    // 小游戏 wx.createUDPSocket → 裸 UDP，浏览器 → WebTransport，Node → dgram。
    // 服务器不猜客户端类型，谁打通了就用谁（isReady 按连接实测）。
    if (this.udp) {
      var info = this.udp.offer(c, this.id);
      if (info) {
        if (info.port) { msg.udpPort = info.port; msg.udpToken = info.token; }
        if (info.wtPort) {
          msg.wtPort = info.wtPort;
          msg.wtToken = info.wtToken;
          msg.wtPath = info.wtPath;
        }
      }
    }
    h.send(msg);
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

/** 输入处理：保留最新角度/加速位 + seq（快照 ack 用）
 *
 * seq 校验用于丢弃乱序/重放包。但不能简单「seq < lastSeq 就丢」：
 * 客户端 WsTransport.seq 在重建连接后从 0 重新计数，而服务端 lastSeq 停在旧值，
 * 会导致该玩家输入被**永久**丢弃（表现为「怎么划都不动」且无法自行恢复）。
 * 因此对「大幅回退」判定为新的计数周期，重置基线而非丢弃。 */
Room.prototype.handleInput = function (connId, msg) {
  var h = this.humans[connId];
  if (!h || !h.connected || this.state !== 'running') return;
  var seq = msg.seq | 0;
  if (seq > h.lastSeq + this.config.INPUT_MAX_SEQ_JUMP) return; // 异常跳变（作弊/损坏）：忽略
  // 回退幅度小 → 网络乱序，丢弃（后续更新的包会补上）；
  // 回退幅度大（含归零）→ 客户端重新计数，接受并把基线拉回，避免永久失效。
  if (seq < h.lastSeq && (h.lastSeq - seq) < this.config.INPUT_SEQ_RESET_GAP) return;
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
  this._maybeLowFreq();

  this._checkPlayerDeaths();
  this._checkOver();
};

Room.prototype._broadcast = function (msg) {
  for (var cid in this.humans) {
    var h = this.humans[cid];
    if (h.connected) safeSend(h, msg);
  }
};

/**
 * 快照广播：ack 按连接个性化（该连接已应用到哪个输入 seq）。
 *
 * 双通道（见 docs/architecture/02-udp-transport.md §4）：
 *   UDP 会话就绪 → 发二进制帧（冗余打散，单包 ≤ UDP_SNAP_CAP 永不分片）
 *   否则         → 回落 TCP JSON（保底通道，不做任何额外处理）
 * 两条通道的解码结果同构，客户端上层零感知。
 */
Room.prototype._broadcastSnap = function () {
  var entries = this.game.mp.allEntries();
  var blocks = this.game.spawner.blocks;
  var useUdp = this.udp && this.config.UDP_ENABLED;

  // 色块增量：只在启用 UDP 时才需要（TCP 路径沿用全量 JSON，保持零改动）
  var delta = useUdp ? this._blockDelta(blocks) : null;

  var snap = null;   // TCP 路径的 JSON 快照（懒构造：全 UDP 时不必付出序列化开销）
  for (var cid in this.humans) {
    var h = this.humans[cid];
    if (!h.connected) continue;

    if (useUdp && this.udp.isReady(cid)) {
      var ents = this._orderForViewer(h, entries);
      var res = BP.encSnapCapped({
        tick: this.tickCount, ack: h.lastSeq, timeMs: this.game.mp.timeMs,
        entries: ents, blockAdd: delta.add, blockDel: delta.del
      }, this.config.UDP_SNAP_CAP);
      if (res.degraded > 0) this._degradeCount = (this._degradeCount || 0) + 1;
      this.udp.sendFrame(cid, res.bytes);
      continue;
    }

    if (!snap) {
      snap = P.snap(this.tickCount, 0, this.game.mp.timeMs,
        entries, blocks, this.game.spawner.meteors);
    }
    snap.ack = h.lastSeq;
    safeSend(h, snap);
  }
};

/**
 * 按「与观察者的距离」升序排列实体，本机玩家永远排第一。
 *
 * 这个顺序是 encSnapCapped 降级策略的前提：超预算时从末尾（最远）开始降级为
 * lite 档，本机玩家（index 0）永不被降级。
 */
Room.prototype._orderForViewer = function (h, entries) {
  var me = h.entry;
  var mx = me.snake.x, my = me.snake.y;
  var rest = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e === me) continue;
    var dx = e.snake.x - mx, dy = e.snake.y - my;
    rest.push({ e: e, d: dx * dx + dy * dy });
  }
  rest.sort(function (a, b) { return a.d - b.d; });
  var out = [{ e: me, lite: false }];
  for (i = 0; i < rest.length; i++) out.push({ e: rest[i].e, lite: false });
  return out;
};

/**
 * 计算色块增量。
 *
 * 色块占 JSON 快照的 60%（168 块 × 69 字节 = 11814 B）却基本静止，
 * 全量重传是最大的一块浪费。稳态每帧变化 < 5 个。
 *
 * 漏收增量会导致客户端永久偏差 → 由 1Hz 全量校正（走 TCP）兜底，见 _sendLowFreq。
 */
Room.prototype._blockDelta = function (blocks) {
  var add = [], del = [];
  var now = {};
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.__bid == null) {
      b.__bid = this._nextBid++;
      if (this._nextBid > 65535) this._nextBid = 1;   // uint16 环回
      add.push({ bid: b.__bid, x: b.x, y: b.y, color: b.color });
    }
    now[b.__bid] = 1;
  }
  for (var bid in this._blockSeen) {
    if (!now[bid]) del.push(parseInt(bid, 10));
  }
  this._blockSeen = now;
  return { add: add, del: del };
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
