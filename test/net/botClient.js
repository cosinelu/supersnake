'use strict';
/**
 * botClient.js — 脚本化机器人客户端（联机自动测试用）
 * 真实 WebSocket 连接 + 可注入种子的输入序列 + 全消息记录（供断言）。
 *
 * 行为模式（behavior）：
 *   'wander'  随机缓转游走（默认）
 *   'still'   不发输入（直行，用于快速撞墙/掉线局）
 *   'circle'  匀速转圈
 */
var path = require('path');
var WebSocket = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));

require(path.join(__dirname, '..', '..', 'js', 'net', 'protocol.js'));
var P = globalThis.CS.protocol;

/**
 * @param {object} opts { url, name, behavior, rng, inputIntervalMs }
 */
function BotClient(opts) {
  this.url = opts.url;
  this.name = opts.name || 'bot';
  this.behavior = opts.behavior || 'wander';
  this.rng = opts.rng || Math.random;
  this.inputIntervalMs = opts.inputIntervalMs || 60;

  this.ws = null;
  this.playerId = 0;
  this.roomId = null;
  this.matched = null;
  this.started = false;
  this.over = null;
  this.snaps = [];
  this.events = [];
  this.errors = [];
  this.queuedMsgs = [];
  this.seq = 0;
  this._angle = this.rng() * Math.PI * 2;
  this._inputTimer = null;
  this._closed = false;
}

BotClient.prototype.connect = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    self.ws = new WebSocket(self.url);
    self.ws.on('open', function () { resolve(); });
    self.ws.on('error', function (e) { self.errors.push(String(e)); reject(e); });
    self.ws.on('close', function () { self._closed = true; self._stopInputs(); });
    self.ws.on('message', function (data) {
      var msg = P.decode(data.toString());
      if (!msg) { self.errors.push('undecodable server message'); return; }
      self._onMessage(msg);
    });
  });
};

BotClient.prototype._onMessage = function (msg) {
  switch (msg.t) {
    case P.S2C.QUEUED: this.queuedMsgs.push(msg); break;
    case P.S2C.MATCHED:
      this.matched = msg; this.playerId = msg.playerId; this.roomId = msg.roomId;
      break;
    case P.S2C.START:
      this.started = true;
      this._startInputs();
      break;
    case P.S2C.SNAP: this.snaps.push(msg); break;
    case P.S2C.EVENT: this.events.push(msg); break;
    case P.S2C.OVER: this.over = msg; this._stopInputs(); break;
    case P.S2C.ERROR: this.errors.push(msg.code + ': ' + msg.msg); break;
  }
};

BotClient.prototype.join = function () {
  this.ws.send(P.encode(P.join(this.name)));
};

BotClient.prototype._startInputs = function () {
  var self = this;
  if (this.behavior === 'still') return;
  this._inputTimer = setInterval(function () {
    if (self._closed || !self.ws || self.ws.readyState !== WebSocket.OPEN) return;
    if (self.behavior === 'wander') {
      self._angle += (self.rng() - 0.5) * 0.9; // 缓转
    } else if (self.behavior === 'circle') {
      self._angle += 0.08;
    }
    self.seq++;
    self.ws.send(P.encode(P.input(self.seq, self._angle, false)));
  }, this.inputIntervalMs);
};

BotClient.prototype._stopInputs = function () {
  if (this._inputTimer) { clearInterval(this._inputTimer); this._inputTimer = null; }
};

BotClient.prototype.close = function () {
  this._stopInputs();
  if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
};

/** 等待条件满足（轮询 20ms），超时抛错 */
BotClient.prototype.waitFor = function (pred, timeoutMs, label) {
  var self = this;
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    var timer = setInterval(function () {
      var v;
      try { v = pred(self); } catch (e) { v = false; }
      if (v) { clearInterval(timer); resolve(v); }
      else if (Date.now() - t0 > (timeoutMs || 15000)) {
        clearInterval(timer);
        reject(new Error('waitFor 超时: ' + (label || '条件未满足') +
          ' (matched=' + !!self.matched + ' started=' + self.started +
          ' snaps=' + self.snaps.length + ' over=' + !!self.over + ' errors=' + self.errors.join(';') + ')'));
      }
    }, 20);
  });
};

module.exports = BotClient;
