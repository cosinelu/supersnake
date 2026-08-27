'use strict';
/**
 * transport.js — 传输层接口（v3.0，浏览器/Node 通用）
 *
 * 设计见 docs/architecture/01-online-multiplayer.md §5.2。
 * game/netMatch 只面对本接口，不知道自己在联网还是单机。
 *
 * 方法：
 *   connect()              建立连接（LocalTransport 为空操作，立即 onOpen）
 *   joinMatch(name)        进匹配队列
 *   cancelMatch()          取消匹配
 *   sendInput(angle,boost) 上行方向输入（实现方负责节流）
 *   dispose()              释放资源
 *
 * 事件（on(name, fn) 注册）：
 *   open                   连接就绪
 *   queued   {pos, need}   排队中
 *   matched  {roomId, playerId, players, countdownMs, W, H}
 *   start    {tick}
 *   snap     快照（protocol.snap 结构）
 *   event    离散事件（protocol.event 结构）
 *   over     {reason, ranks}
 *   drop     {reason}      连接中断（→ 掉线判负结算）
 *   error    {code, msg}
 */
(function (root) {
  var CS = root.CS = root.CS || {};

  function TransportBase() { this._handlers = {}; }

  TransportBase.prototype.on = function (name, fn) {
    (this._handlers[name] = this._handlers[name] || []).push(fn);
    return this;
  };

  TransportBase.prototype._emit = function (name, a, b) {
    var hs = this._handlers[name];
    if (!hs) return;
    for (var i = 0; i < hs.length; i++) {
      try { hs[i](a, b); } catch (e) {
        if (typeof console !== 'undefined') console.error('[transport] handler error (' + name + '):', e);
      }
    }
  };

  // 子类实现以下方法（基类给出空操作/抛错兜底）
  TransportBase.prototype.connect = function () { this._emit('open'); };
  TransportBase.prototype.joinMatch = function (/* name */) {};
  TransportBase.prototype.cancelMatch = function () {};
  TransportBase.prototype.sendInput = function (/* angle, boost */) {};

  /** 便捷：一次性注册整张事件表 { queued: fn, snap: fn, ... } */
  TransportBase.prototype.onAll = function (table) {
    for (var k in table) if (table.hasOwnProperty(k)) this.on(k, table[k]);
    return this;
  };

  TransportBase.prototype.dispose = function () { this._handlers = {}; };

  CS.TransportBase = TransportBase;
  if (typeof module !== 'undefined' && module.exports) module.exports = TransportBase;
})(typeof window !== 'undefined' ? window : globalThis);
