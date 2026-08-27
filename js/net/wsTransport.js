'use strict';
/**
 * wsTransport.js — WebSocket 传输实现（v3.0，浏览器联机客户端）
 *
 * 连接匹配服务器，把协议消息路由为 TransportBase 事件（queued/matched/start/snap/event/over），
 * 断线发 drop（→ 客户端进"掉线判负"结算，不重连，见架构文档 §1）。
 *
 * 浏览器默认地址：同域 /ws（Nginx 反代）；可用 opts.url 覆盖（本地调试 ws://127.0.0.1:8090）。
 * Node 测试可注入 opts.WebSocketImpl（ws 包）与 opts.url 直接复用本类。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var TransportBase = CS.TransportBase;
  var P = CS.protocol;

  function defaultUrl() {
    if (typeof location !== 'undefined' && location.host) {
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }
    return 'ws://127.0.0.1:8090';
  }

  function WsTransport(opts) {
    TransportBase.call(this);
    opts = opts || {};
    this.url = opts.url || defaultUrl();
    this.WS = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.heartbeatMs = opts.heartbeatMs || 5000;
    this.ws = null;
    this.seq = 0;
    this.rtt = 0;          // 最近一次 ping/pong 往返（ms）
    this.playerId = 0;
    this.roomId = null;
    this._hbTimer = null;
    this._dropped = false;
  }
  WsTransport.prototype = Object.create(TransportBase.prototype);
  WsTransport.prototype.constructor = WsTransport;

  WsTransport.prototype.connect = function () {
    var self = this;
    if (!this.WS) throw new Error('WsTransport: 无 WebSocket 实现（浏览器应原生支持）');
    var ws = this.ws = new this.WS(this.url);

    ws.onopen = function () {
      self._dropped = false;
      self._emit('open');
      self._hbTimer = setInterval(function () {
        if (ws.readyState === 1) ws.send(P.encode(P.ping(Date.now())));
      }, self.heartbeatMs);
    };
    ws.onmessage = function (ev) {
      var msg = P.decode(typeof ev === 'string' ? ev : ev.data);
      if (!msg) return; // 服务器消息畸形：忽略（协议内错误走 error 类型）
      switch (msg.t) {
        case P.S2C.QUEUED: self._emit('queued', msg); break;
        case P.S2C.MATCHED:
          self.playerId = msg.playerId; self.roomId = msg.roomId;
          self._emit('matched', msg);
          break;
        case P.S2C.START: self._emit('start', msg); break;
        case P.S2C.SNAP: self._emit('snap', msg); break;
        case P.S2C.EVENT: self._emit('event', msg); break;
        case P.S2C.OVER: self._emit('over', msg); break;
        case P.S2C.PONG: self.rtt = Date.now() - msg.ts; break;
        case P.S2C.ERROR: self._emit('error', msg); break;
      }
    };
    ws.onclose = function () {
      if (self._hbTimer) { clearInterval(self._hbTimer); self._hbTimer = null; }
      if (!self._dropped) {
        self._dropped = true;
        self._emit('drop', { reason: P.OVER_REASON.DROPPED });
      }
    };
    ws.onerror = function () { /* close 随后触发 drop */ };
  };

  WsTransport.prototype._send = function (obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(P.encode(obj));
  };

  WsTransport.prototype.joinMatch = function (name) { this._send(P.join(name)); };
  WsTransport.prototype.cancelMatch = function () { this._send(P.cancel()); };

  /** 上行输入（调用方节流，建议 ≤30Hz；seq 单调递增供服务器 ack） */
  WsTransport.prototype.sendInput = function (angle, boost) {
    this.seq++;
    this._send(P.input(this.seq, angle, boost));
  };

  WsTransport.prototype.dispose = function () {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    if (this.ws) {
      try { this._dropped = true; this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    TransportBase.prototype.dispose.call(this);
  };

  CS.WsTransport = WsTransport;
  if (typeof module !== 'undefined' && module.exports) module.exports = WsTransport;
})(typeof window !== 'undefined' ? window : globalThis);
