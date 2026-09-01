'use strict';
/**
 * matchmaker.js — 匹配队列（v3.0）
 * 规则（见 docs/architecture/01-online-multiplayer.md §6）：
 *   队列 ≥ ROOM_SIZE → 立即满编开局；
 *   队首等待 > MATCH_TIMEOUT_MS 且队列 ≥ MIN_HUMANS → 以现有真人 + AI 补位开局；
 *   cancel / 掉线 → 移出队列。
 */
var Room = require('./room');

/**
 * @param {object} config server/config（或测试覆盖版）
 * @param {object} hooks { onRoomCreated(room), onRoomEmpty(room) }
 */
function Matchmaker(config, hooks) {
  this.config = config;
  this.hooks = hooks || {};
  this.queue = []; // [{ connId, name, send, joinedAt }]
  this.rooms = {}; // roomId → Room
}

Matchmaker.prototype.add = function (conn) {
  // 已在队列则忽略（重复 join）
  for (var i = 0; i < this.queue.length; i++) {
    if (this.queue[i].connId === conn.connId) return;
  }
  this.queue.push({
    connId: conn.connId, name: conn.name, send: conn.send,
    joinedAt: this.config.nowFn()
  });
  this._notifyQueue();
  this._tryForm();
};

Matchmaker.prototype.remove = function (connId) {
  for (var i = 0; i < this.queue.length; i++) {
    if (this.queue[i].connId === connId) {
      this.queue.splice(i, 1);
      this._notifyQueue();
      return true;
    }
  }
  return false;
};

Matchmaker.prototype.inQueue = function (connId) {
  for (var i = 0; i < this.queue.length; i++) {
    if (this.queue[i].connId === connId) return true;
  }
  return false;
};

/** 周期检查（生产由 index.js setInterval 驱动；测试手动调用并注入 now） */
Matchmaker.prototype.tick = function () {
  var now = this.config.nowFn();
  if (this.queue.length >= this.config.MIN_HUMANS &&
      this.queue.length < this.config.ROOM_SIZE &&
      now - this.queue[0].joinedAt >= this.config.MATCH_TIMEOUT_MS) {
    this._form(this.queue.length); // 超时补位局
  }
};

Matchmaker.prototype._tryForm = function () {
  if (this.queue.length >= this.config.ROOM_SIZE) this._form(this.config.ROOM_SIZE);
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

Matchmaker.prototype._form = function (n) {
  var members = this.queue.splice(0, n);
  this._dedupeNames(members);
  var self = this;
  var room = new Room({
    players: members,
    config: this.config,
    onEmpty: function (r) {
      delete self.rooms[r.id];
      if (self.hooks.onRoomEmpty) self.hooks.onRoomEmpty(r);
    }
  });
  this.rooms[room.id] = room;
  room.start();
  if (this.hooks.onRoomCreated) this.hooks.onRoomCreated(room);
  this._notifyQueue();
  return room;
};

/** 队列位次播报 {pos, size, need}（pos=本人位次，size=当前队列人数） */
Matchmaker.prototype._notifyQueue = function () {
  var size = this.queue.length;
  for (var i = 0; i < size; i++) {
    var q = this.queue[i];
    try {
      q.send({ t: 'queued', pos: i + 1, size: size, need: this.config.ROOM_SIZE });
    } catch (e) { /* 发送失败由连接层清理 */ }
  }
};

Matchmaker.prototype.destroy = function () {
  for (var id in this.rooms) this.rooms[id].destroy();
  this.rooms = {};
  this.queue = [];
};

module.exports = Matchmaker;
