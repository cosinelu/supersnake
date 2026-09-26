'use strict';
/**
 * matchmaker.js — 匹配队列（v3.0，v3.1+ 支持团队战 2v2v2v2v2）
 * 规则（见 docs/architecture/01-online-multiplayer.md §6 / §6.1）：
 *  FFA（自由混战）：
 *    队列 ≥ ROOM_SIZE(4) → 立即满编开局；
 *    队首等待 > MATCH_TIMEOUT_MS 且 ≥ MIN_HUMANS → 以现有真人 + AI 补位开局；
 *  团队战（mode='team'，2v2v2v2v2）：
 *    按 teamCode 组队（好友房号）/ 余下 solo 两两配对 → 凑满 TEAM_TEAMS(5) 队即开局；
 *    队首等待 > TEAM_MATCH_TIMEOUT_MS 且 ≥ TEAM_MIN_HUMANS → 以现有真人 + AI 补位开局；
 *    每队 2 槽，空槽由 AI 补位（单人 = 本人 + 1 AI 队友 + 4 个纯 AI 队）。
 *  cancel / 掉线 → 移出队列。
 *
 * 两种模式各有一条独立队列，互不串台。
 */
var Room = require('./room');

/**
 * @param {object} config server/config（或测试覆盖版）
 * @param {object} hooks { onRoomCreated(room), onRoomEmpty(room) }
 */
function Matchmaker(config, hooks) {
  this.config = config;
  this.hooks = hooks || {};
  this.queues = { ffa: [], team: [] }; // 按 mode 分队列
  this.rooms = {}; // roomId → Room
}

Matchmaker.prototype.add = function (conn) {
  var mode = conn.mode === 'team' ? 'team' : 'ffa';
  var q = this.queues[mode];
  // 已在队列则忽略（重复 join）
  for (var i = 0; i < q.length; i++) {
    if (q[i].connId === conn.connId) return;
  }
  q.push({
    connId: conn.connId, name: conn.name, send: conn.send,
    mode: mode, teamCode: mode === 'team' ? (conn.teamCode || null) : null,
    joinedAt: this.config.nowFn()
  });
  this._notifyQueue(mode);
  this._tryForm(mode);
};

Matchmaker.prototype.remove = function (connId) {
  var modes = ['ffa', 'team'];
  for (var m = 0; m < modes.length; m++) {
    var q = this.queues[modes[m]];
    for (var i = 0; i < q.length; i++) {
      if (q[i].connId === connId) {
        q.splice(i, 1);
        this._notifyQueue(modes[m]);
        return true;
      }
    }
  }
  return false;
};

Matchmaker.prototype.inQueue = function (connId) {
  return this._inQueue('ffa', connId) || this._inQueue('team', connId);
};

Matchmaker.prototype._inQueue = function (mode, connId) {
  var q = this.queues[mode];
  for (var i = 0; i < q.length; i++) if (q[i].connId === connId) return true;
  return false;
};

/** 周期检查（生产由 index.js setInterval 驱动；测试手动调用并注入 now） */
Matchmaker.prototype.tick = function () {
  var now = this.config.nowFn();
  // FFA 超时补位
  var fq = this.queues.ffa;
  if (fq.length >= this.config.MIN_HUMANS &&
      fq.length < this.config.ROOM_SIZE &&
      now - fq[0].joinedAt >= this.config.MATCH_TIMEOUT_MS) {
    this._form('ffa', fq.length);
  }
  // 团队超时补位
  var tq = this.queues.team;
  if (tq.length >= this.config.TEAM_MIN_HUMANS) {
    var teams = this._buildTeams(tq);
    if (teams.length >= this.config.TEAM_TEAMS ||
        now - tq[0].joinedAt >= this.config.TEAM_MATCH_TIMEOUT_MS) {
      this._formTeam();
    }
  }
};

Matchmaker.prototype._tryForm = function (mode) {
  if (mode === 'ffa') {
    if (this.queues.ffa.length >= this.config.ROOM_SIZE) this._form('ffa', this.config.ROOM_SIZE);
  } else {
    var teams = this._buildTeams(this.queues.team);
    if (teams.length >= this.config.TEAM_TEAMS) this._formTeam();
  }
};

/**
 * 把团队队列成员分组为「人类队」：
 *  - 同 teamCode 的真人优先编入同队（最多 2 人，超出者降级为 solo）；
 *  - 余下 solo 真人两两配对；
 *  - 落单的 solo 自成 1 人队（将由 AI 补为队友）。
 * 返回数组：teams[i] = 该队的真人成员数组（长度 1~2）。
 * 纯函数、依队列顺序确定，保证多次调用分组稳定（不会产生队友反复变动）。
 */
Matchmaker.prototype._buildTeams = function (queue) {
  var byCode = {};
  var solos = [];
  for (var i = 0; i < queue.length; i++) {
    var m = queue[i];
    if (m.teamCode) {
      (byCode[m.teamCode] = byCode[m.teamCode] || []).push(m);
    } else {
      solos.push(m);
    }
  }
  var teams = [];
  for (var code in byCode) {
    var g = byCode[code];
    for (var j = 0; j < g.length; j += 2) {
      if (j + 1 < g.length) teams.push([g[j], g[j + 1]]);
      else solos.push(g[j]); // 同 code 第 3+ 人降级为 solo
    }
  }
  for (var k = 0; k < solos.length; k += 2) {
    if (k + 1 < solos.length) teams.push([solos[k], solos[k + 1]]);
    else teams.push([solos[k]]); // 落单 solo → 1 人队（AI 补位队友）
  }
  return teams;
};

/**
 * 房间内真人昵称去重：同名者依次追加 ·2 ·3 …（总长 ≤12，超出则截断基部）。
 * 场景：同一浏览器多标签页共享 localStorage，昵称会完全相同；服务器必须保证
 * 房间内名牌/排行榜/结算名单可区分（客户端只展示，不做去重）。
 */
Matchmaker.prototype._dedupeNames = function (members) {
  var used = {};
  for (var i = 0; i < members.length; i++) {
    var base = String(members[i].name || '玩家');
    var name = base;
    for (var k = 2; used[name]; k++) {
      var suffix = '·' + k;
      name = base.slice(0, 12 - suffix.length) + suffix;
    }
    used[name] = true;
    members[i].name = name;
  }
};

/** FFA 建房：取队列前 n 名真人（其余留队），AI 由 room 补位 */
Matchmaker.prototype._form = function (mode, n) {
  var q = this.queues[mode];
  var members = q.splice(0, n);
  this._dedupeNames(members);
  var self = this;
  var room = new Room({
    players: members,
    config: this.config,
    udp: this.hooks.udp || null,   // UDP 端点（可选）：为 null 时房间全程走 TCP
    onEmpty: function (r) {
      delete self.rooms[r.id];
      if (self.hooks.onRoomEmpty) self.hooks.onRoomEmpty(r);
    }
  });
  this.rooms[room.id] = room;
  room.start();
  if (this.hooks.onRoomCreated) this.hooks.onRoomCreated(room);
  this._notifyQueue(mode);
  return room;
};

/**
 * 团队战建房：消耗全部团队队列成员，按 _buildTeams 分组后补满 5×2 编制。
 * 人类队不足 5 队时用纯 AI 队补齐；每队空槽由 AI 补位。
 * 生成 teamSpecs（供 Room.setupTeams 建场）与 players（真人连接列表）。
 */
Matchmaker.prototype._formTeam = function () {
  var q = this.queues.team;
  var members = q.splice(0, q.length);
  this._dedupeNames(members);
  var humanTeams = this._buildTeams(members); // 每队 1~2 真人

  var TEAMS = this.config.TEAM_TEAMS;
  var SIZE = this.config.TEAM_SIZE;
  var teamSpecs = [];
  var players = [];
  for (var t = 0; t < TEAMS; t++) {
    var humanTeam = (t < humanTeams.length) ? humanTeams[t] : [];
    var slot = [];
    for (var s = 0; s < SIZE; s++) {
      if (s < humanTeam.length) {
        var m = humanTeam[s];
        slot.push({ isHuman: true, name: m.name, connId: m.connId });
        players.push({ connId: m.connId, name: m.name, send: m.send });
      } else {
        slot.push({ isHuman: false }); // AI 补位（队友或纯 AI 队）
      }
    }
    teamSpecs.push(slot);
  }

  var self = this;
  var room = new Room({
    players: players,
    teams: teamSpecs,
    config: this.config,
    udp: this.hooks.udp || null,
    onEmpty: function (r) {
      delete self.rooms[r.id];
      if (self.hooks.onRoomEmpty) self.hooks.onRoomEmpty(r);
    }
  });
  this.rooms[room.id] = room;
  room.start();
  if (this.hooks.onRoomCreated) this.hooks.onRoomCreated(room);
  this._notifyQueue('team');
  return room;
};

/** 队列位次播报 {pos, size, need}（pos=本人位次，size=当前队列人数，need=满编所需） */
Matchmaker.prototype._notifyQueue = function (mode) {
  var q = this.queues[mode];
  var size = q.length;
  var need = (mode === 'team') ? this.config.TEAM_TEAMS : this.config.ROOM_SIZE;
  for (var i = 0; i < size; i++) {
    var mq = q[i];
    try {
      mq.send({ t: 'queued', pos: i + 1, size: size, need: need, mode: mode });
    } catch (e) { /* 发送失败由连接层清理 */ }
  }
};

Matchmaker.prototype.destroy = function () {
  for (var id in this.rooms) this.rooms[id].destroy();
  this.rooms = {};
  this.queues = { ffa: [], team: [] };
};

module.exports = Matchmaker;
