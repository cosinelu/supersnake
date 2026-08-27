'use strict';
/**
 * localTransport.js — 本地传输实现（v3.0）：在进程内跑完整多人对局（真人 1 名 + AI），
 * 输出与 WsTransport 完全同构的 matched/start/snap/event/over 事件流。
 *
 * 用途：
 *  1. 联机 UI / 渲染管线开发：服务器没起也能用真实数据流调试（netMatch + renderer 直接消费）；
 *  2. 自动化测试：Node 中驱动协议事件流做回归（test/net/*）。
 *
 * 驱动方式：
 *  - pump(dtMs) 手动步进（测试/确定性场景）；
 *  - startAuto(intervalMs) 用 setInterval 自动推进（浏览器开发用）。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var TransportBase = CS.TransportBase;
  var P = CS.protocol;

  function LocalTransport(opts) {
    TransportBase.call(this);
    opts = opts || {};
    this.tickMs = opts.tickMs || 33;      // 模拟步长（与服务器一致 30Hz）
    this.snapEvery = opts.snapEvery || 2; // 每 2 tick 一帧快照（15Hz）
    this.game = null;
    this.playerEntry = null;
    this.tickCount = 0;
    this._pendingAngle = null;
    this._inputSeq = 0;
    this._timer = null;
    this._overSent = false;
  }
  LocalTransport.prototype = Object.create(TransportBase.prototype);
  LocalTransport.prototype.constructor = LocalTransport;

  LocalTransport.prototype.joinMatch = function (name) {
    var self = this;
    this.game = new CS.HeadlessGame({
      onEvent: function (kind, data) { self._emit('event', P.event(kind, data)); }
    });
    var players = this.game.setup([name || '我']);
    this.playerEntry = players[0];
    this.tickCount = 0;
    this._overSent = false;
    var walls = this.game.walls.rects.map(function (r) { return [r.x | 0, r.y | 0, r.w | 0, r.h | 0]; });
    this._emit('matched', {
      roomId: 'local', playerId: this.playerEntry.id,
      players: [{ id: this.playerEntry.id, name: this.playerEntry.name }],
      countdownMs: 0, W: this.game.W, H: this.game.H, walls: walls
    });
    this._emit('start', { tick: 0 });
  };

  LocalTransport.prototype.cancelMatch = function () {};

  LocalTransport.prototype.sendInput = function (angle, boost) {
    this._pendingAngle = angle;
    this._inputSeq++;
  };

  /** 手动推进一个模拟步长：输入 → tick → 事件已同步流出 → 按频率发快照 → 结算检测 */
  LocalTransport.prototype.pump = function (dtMs) {
    if (!this.game || this._overSent) return;
    var dt = dtMs || this.tickMs;
    if (this._pendingAngle !== null) this.game.setInput(this.playerEntry, this._pendingAngle);
    this.game.tick(dt);
    this.tickCount++;
    if (this.tickCount % this.snapEvery === 0) {
      this._emit('snap', P.snap(
        this.tickCount, this._inputSeq, this.game.mp.timeMs,
        this.game.mp.allEntries(), this.game.spawner.blocks, this.game.spawner.meteors));
    }
    if (!this.playerEntry.alive && !this._overSent) {
      this._overSent = true;
      this._emit('over', { reason: P.OVER_REASON.DEAD, ranks: this._ranks() });
    }
  };

  /** 结算排行（本地单真人：按存活 + 总分排） */
  LocalTransport.prototype._ranks = function () {
    var es = this.game.mp.allEntries();
    var arr = es.map(function (e) {
      return {
        id: e.id, name: e.name, isPlayer: e.isPlayer, alive: e.alive,
        score: (e.survivalScore || 0) + (e.elimScore || 0) + (e.mpBonusScore || 0),
        length: e.snake.length()
      };
    });
    arr.sort(function (a, b) {
      if (!!a.alive !== !!b.alive) return a.alive ? -1 : 1;
      return b.score - a.score;
    });
    for (var i = 0; i < arr.length; i++) arr[i].rank = i + 1;
    return arr;
  };

  /** 浏览器自动推进（开发用）；intervalMs 缺省 = tickMs */
  LocalTransport.prototype.startAuto = function (intervalMs) {
    var self = this;
    this.stopAuto();
    this._timer = setInterval(function () { self.pump(self.tickMs); }, intervalMs || this.tickMs);
  };

  LocalTransport.prototype.stopAuto = function () {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  };

  LocalTransport.prototype.dispose = function () {
    this.stopAuto();
    this.game = null;
    TransportBase.prototype.dispose.call(this);
  };

  CS.LocalTransport = LocalTransport;
  if (typeof module !== 'undefined' && module.exports) module.exports = LocalTransport;
})(typeof window !== 'undefined' ? window : globalThis);
