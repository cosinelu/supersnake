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

    // UDP 加速层（v3.1）：matched 带回接入信息后建立旁路，承载 input/snap。
    // 拿不到 / 打洞失败 / 中途停滞 → 自动走 TCP，对局不受影响。
    // 传 udp:false 可显式关闭（回滚点）。
    this.udpEnabled = opts.udp !== false;
    this.udpFactory = opts.udpSocketFactory ||
      (CS.udpSocketFactories && CS.udpSocketFactories.auto && CS.udpSocketFactories.auto());
    this.udp = null;
    this.meta = {};        // 低频通道缓存：id → { nm, kl, es, ... }
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
          self._setupUdp(msg);
          self._emit('matched', msg);
          break;
        case P.S2C.START: self._emit('start', msg); break;
        case P.S2C.SNAP: self._emit('snap', msg); break;
        case P.S2C.EVENT: self._emit('event', msg); break;
        case P.S2C.OVER: self._emit('over', msg); break;
        case P.S2C.PONG: self.rtt = Date.now() - msg.ts; break;
        case P.S2C.ERROR: self._emit('error', msg); break;
        case 'meta': self._onMeta(msg); break;   // 1Hz 低频：昵称/计分/色块全量校正
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

  /**
   * 建立 UDP 旁路（matched 后调用）。
   * 失败不抛错、不提示玩家 —— 静默走 TCP，对局体验不受影响。
   */
  WsTransport.prototype._setupUdp = function (msg) {
    if (!this.udpEnabled || !this.udpFactory) return;
    if (!msg.udpPort || msg.udpToken == null) return;
    if (!CS.UdpAccel) return;
    var self = this;
    var host = null;
    if (typeof location !== 'undefined' && location.hostname) host = location.hostname;
    else if (this.url) {
      var m = /^wss?:\/\/([^:/]+)/.exec(this.url);
      if (m) host = m[1];
    }
    this.udp = new CS.UdpAccel({
      socketFactory: this.udpFactory,
      onSnap: function (dec) { self._emit('snap', self._mergeMeta(dec)); },
      onStateChange: function (active) { self._emit('udp', { active: active }); }
    });
    if (!this.udp.attach({
      udpPort: msg.udpPort, udpToken: msg.udpToken, host: host,
      snapIntervalMs: msg.snapIntervalMs
    })) {
      this.udp = null;
    }
  };

  /** 低频通道：昵称与计分从每帧快照移出后，在此缓存并回填 */
  WsTransport.prototype._onMeta = function (msg) {
    var arr = msg.sn || [];
    for (var i = 0; i < arr.length; i++) this.meta[arr[i].id] = arr[i];
    if (msg.blocks) this._metaBlocks = msg.blocks;   // 色块全量校正基线
    this._emit('meta', msg);
  };

  /**
   * 把低频通道的字段回填进二进制快照，产出与 JSON snap **同构**的对象。
   * 这样上层（netMatch / onlineMatch / renderer）完全不需要知道数据来自哪条通道。
   */
  WsTransport.prototype._mergeMeta = function (dec) {
    for (var i = 0; i < dec.sn.length; i++) {
      var s = dec.sn[i];
      var m = this.meta[s.id];
      if (!m) continue;
      s.name = m.nm;
      s.kills = m.kl; s.elimScore = m.es; s.elimTotal = m.et;
      s.maxLen = m.ml; s.survivalScore = m.sv; s.mpBonusScore = m.mb;
    }
    return dec;
  };

  WsTransport.prototype.joinMatch = function (name) { this._send(P.join(name)); };
  WsTransport.prototype.cancelMatch = function () { this._send(P.cancel()); };

  /**
   * 上行输入（调用方节流，建议 ≤30Hz；seq 单调递增供服务器 ack）。
   * UDP 旁路可用时走 UDP（冗余打散），否则走 TCP —— 切换对调用方透明。
   */
  WsTransport.prototype.sendInput = function (angle, boost) {
    if (this.udp && this.udp.sendInput(angle, boost)) return;
    this.seq++;
    this._send(P.input(this.seq, angle, boost));
  };

  WsTransport.prototype.dispose = function () {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    if (this.udp) { this.udp.dispose(); this.udp = null; }
    if (this.ws) {
      try { this._dropped = true; this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    TransportBase.prototype.dispose.call(this);
  };

  CS.WsTransport = WsTransport;
  if (typeof module !== 'undefined' && module.exports) module.exports = WsTransport;
})(typeof window !== 'undefined' ? window : globalThis);
