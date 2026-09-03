'use strict';
/**
 * udpTransport.js — UDP 加速层（v3.1 M1b，客户端）
 *
 * 设计见 docs/architecture/02-udp-transport.md §3、§4。
 *
 * **不是一个独立的 Transport，而是挂在 WsTransport 上的加速层。**
 * 这个选择是刻意的：
 *   - TCP 连接全程保留作控制通道（join/matched/over/event 这些不可替代的消息）
 *   - UDP 只承载幂等的 input / snap，随时可以停用而不影响对局
 *   - 降级不需要"切换传输层"，只是停止使用一条旁路 —— 状态机简单到不会出错
 *
 * 生命周期：
 *   matched 带回 { udpPort, udpToken } → attach() → 打洞 → 收到 ack 则 active
 *   1.5s 无 ack           → 判定 UDP 不可用，永久走 TCP
 *   对局中 500ms 无下行    → 回落 TCP，后台继续重试（网络可能恢复）
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var B = CS.bin;
  var BP = CS.binProtocol;

  var MAGIC_HELLO = 0x48;
  var MAGIC_HACK = 0x4B;

  var HANDSHAKE_TIMEOUT_MS = 1500;  // 打洞超时 → 判定 UDP 不可用
  var STALL_MS = 500;               // 对局中多久没有下行就回落 TCP
  var KEEPALIVE_MS = 5000;          // NAT 映射保活（映射通常 30s 失效）

  /**
   * @param {object} opts
   *   socketFactory  () => UdpSocketLike  平台适配（小游戏 wx.createUDPSocket / node dgram）
   *   onSnap(decoded) 收到并解码成功的快照（与 JSON snap 同构）
   *   onStateChange(active) UDP 可用性变化（供 HUD 显示与统计）
   */
  function UdpAccel(opts) {
    opts = opts || {};
    this.socketFactory = opts.socketFactory || null;
    this.onSnap = opts.onSnap || function () {};
    this.onStateChange = opts.onStateChange || function () {};
    this.dup = opts.dup || 3;
    this.frameIntervalMs = opts.frameIntervalMs || 33;

    this.sock = null;
    this.host = null;
    this.port = 0;
    this.token = 0;
    this.active = false;        // 握手完成且下行正常
    this.available = false;     // 握手是否成功过（失败则不再重试打洞）
    this.frameId = 0;
    this.lastRecvTick = -1;     // 下行去重：tick 回退或重复则丢弃
    this.lastRecvAt = 0;
    this.stats = { sent: 0, recv: 0, dupDropped: 0, decodeFail: 0, fallbacks: 0 };

    this._hsTimer = null;
    this._kaTimer = null;
    this._stallTimer = null;
    this._pending = [];         // 打散发送的定时器句柄，dispose 时清理
  }

  /**
   * 用 matched 下发的信息建立 UDP 旁路。
   * @param {object} info { udpPort, udpToken, host }
   */
  UdpAccel.prototype.attach = function (info) {
    if (!info || !info.udpPort || info.udpToken == null) return false;
    if (!this.socketFactory) return false;
    this.host = info.host || this._defaultHost();
    this.port = info.udpPort;
    this.token = info.udpToken >>> 0;
    if (info.snapIntervalMs) this.frameIntervalMs = info.snapIntervalMs;

    var self = this;
    try {
      this.sock = this.socketFactory();
    } catch (e) { return false; }
    if (!this.sock) return false;

    this.sock.onMessage(function (u8) { self._onMessage(u8); });

    this._sendHello();
    // 打洞可能丢包，握手窗口内重试几次
    var tries = 0;
    this._hsTimer = setInterval(function () {
      if (self.available) { clearInterval(self._hsTimer); self._hsTimer = null; return; }
      tries++;
      if (tries * 300 >= HANDSHAKE_TIMEOUT_MS) {
        // 判定 UDP 不可用：静默走 TCP，不打扰玩家（架构文档 §4.3）
        clearInterval(self._hsTimer); self._hsTimer = null;
        self._setActive(false);
        return;
      }
      self._sendHello();
    }, 300);
    return true;
  };

  UdpAccel.prototype._defaultHost = function () {
    if (typeof location !== 'undefined' && location.hostname) return location.hostname;
    return '127.0.0.1';
  };

  UdpAccel.prototype._sendHello = function () {
    var w = new B.BinWriter(8);
    w.u8(MAGIC_HELLO); w.u32(this.token); w.finishCrc16();
    this._raw(w.bytes());
  };

  UdpAccel.prototype._raw = function (u8) {
    if (!this.sock) return;
    try { this.sock.send(u8, this.host, this.port); this.stats.sent++; } catch (e) { /* 忽略瞬时错误 */ }
  };

  UdpAccel.prototype._setActive = function (v) {
    if (this.active === v) return;
    this.active = v;
    if (!v) this.stats.fallbacks++;
    this.onStateChange(v);
  };

  UdpAccel.prototype._onMessage = function (u8) {
    if (!u8 || !u8.length) return;
    this.lastRecvAt = Date.now();

    if (u8[0] === MAGIC_HACK) {
      if (!this.available) {
        this.available = true;
        if (this._hsTimer) { clearInterval(this._hsTimer); this._hsTimer = null; }
        this._startKeepalive();
        this._startStallWatch();
      }
      this._setActive(true);
      return;
    }

    var dec = BP.decSnapBin(u8);
    if (!dec) { this.stats.decodeFail++; return; }

    // 下行去重：冗余副本与乱序。tick 是 uint16，需处理环回
    if (this.lastRecvTick >= 0) {
      var d = (dec.tk - this.lastRecvTick) & 0xFFFF;
      // d 落在 [1, 32767] 视为更新的帧；否则是旧帧或重复
      if (d === 0 || d > 32767) { this.stats.dupDropped++; return; }
    }
    this.lastRecvTick = dec.tk;
    this.stats.recv++;
    this._setActive(true);
    this.onSnap(dec);
  };

  /**
   * 上行输入：发 dup 份，**帧内按时间均分打散**。
   *
   * 打散是必须的：丢包按时间段发生（基站切换/缓冲溢出，窗口 20~100ms），
   * 同一毫秒连发的副本在窗口内同生共死 —— 3000 帧实测「x3 同时发」与「x1」
   * 结果完全相同，打散后短窗口场景从 7.90% 降到 0.23%。
   *
   * @returns {boolean} 是否已由 UDP 承载（false 时调用方应走 TCP）
   */
  UdpAccel.prototype.sendInput = function (angle, boost) {
    if (!this.active || !this.sock) return false;
    this.frameId = (this.frameId + 1) & 0xFFFF;
    var frag = BP.encInputFrag(this.token, this.frameId, angle, boost);
    this._raw(frag);
    if (this.dup <= 1) return true;

    // 后续副本在本帧窗口内**时间打散**。
    //
    // 两个坑，都实测踩过（服务器侧 udp.js:sendFrame 是同一套逻辑、同一组坑）：
    // 1) **不能一次性排多个 setTimeout**：定时器分辨率在 Windows 上约 15.6ms，
    //    9ms 与 18ms 会被合并到同一 tick（实测两份都在 23ms 发出），
    //    打散退化成「同时发」—— 而同时发在突发丢包下等于没发
    //    （3000 帧模拟与 x1 结果完全相同，因为副本共命运）。
    // 2) **不能死守原定时刻**：链式调度时若第 k 份因漂移迟到，第 k+1 份的
    //    原定时刻可能已过期，wait 被钳到最小值 → 两份紧挨着发出，又退回坑 1。
    //
    // 解法：每发完一份，用**剩余窗口 / 剩余份数**重新均分，并保证最小间隔
    // MIN_GAP 确实跨越不同的定时器 tick。窗口只是**间隔的参考值**，
    // **不用来砍份数** —— UDP_DUP 是功能约定（抗丢包），窗口只是带宽优化，
    // 为省一点带宽而少发一份冗余是本末倒置（曾因此偶发只发出 2 份）。
    var MIN_GAP = 6;
    var deadline = Date.now() + this.frameIntervalMs * 0.8;
    var self = this;
    var left = this.dup - 1;
    function scheduleNext() {
      if (left <= 0) return;
      var wait = Math.max(MIN_GAP, Math.round((deadline - Date.now()) / left));
      self._track(setTimeout(function () {
        if (!self.active || !self.sock) { left = 0; return; }
        self._raw(frag);
        left--;
        scheduleNext();
      }, wait));
    }
    scheduleNext();
    return true;
  };

  /** 记录定时器句柄供 dispose 清理（限长，防止长对局无限增长） */
  UdpAccel.prototype._track = function (tm) {
    this._pending.push(tm);
    if (this._pending.length > 64) this._pending.shift();
  };

  /** NAT 保活：死亡/观战时不发上行，映射会失效（通常 30s） */
  UdpAccel.prototype._startKeepalive = function () {
    var self = this;
    if (this._kaTimer) return;
    this._kaTimer = setInterval(function () {
      if (!self.sock) return;
      if (Date.now() - self.lastRecvAt < KEEPALIVE_MS) return;
      self._sendHello();   // hello 兼作 keepalive，服务器会刷新 lastSeen
    }, KEEPALIVE_MS);
  };

  /** 下行停滞检测：连续 STALL_MS 无包 → 回落 TCP，但后台继续等 UDP 恢复 */
  UdpAccel.prototype._startStallWatch = function () {
    var self = this;
    if (this._stallTimer) return;
    this._stallTimer = setInterval(function () {
      if (!self.active) return;
      if (Date.now() - self.lastRecvAt > STALL_MS) self._setActive(false);
    }, 200);
  };

  UdpAccel.prototype.dispose = function () {
    if (this._hsTimer) { clearInterval(this._hsTimer); this._hsTimer = null; }
    if (this._kaTimer) { clearInterval(this._kaTimer); this._kaTimer = null; }
    if (this._stallTimer) { clearInterval(this._stallTimer); this._stallTimer = null; }
    for (var i = 0; i < this._pending.length; i++) clearTimeout(this._pending[i]);
    this._pending.length = 0;
    if (this.sock) { try { this.sock.close(); } catch (e) {} this.sock = null; }
    this.active = false;
    this.available = false;
  };

  // ---------------- 平台适配 ----------------
  //
  // 统一的 socket 接口：{ onMessage(cb), send(u8, host, port), close() }
  // 各平台的差异全部收敛在这里，UdpAccel 本身与平台无关。

  /** 微信小游戏：wx.createUDPSocket（基础库 2.9.4+ 可连任意公网 IP/域名） */
  function wxSocketFactory() {
    if (typeof wx === 'undefined' || !wx.createUDPSocket) return null;
    var s = wx.createUDPSocket();
    s.bind();
    return {
      onMessage: function (cb) {
        s.onMessage(function (res) {
          var msg = res && res.message;
          cb(msg instanceof Uint8Array ? msg : new Uint8Array(msg));
        });
      },
      send: function (u8, host, port) {
        s.send({ address: host, port: port, message: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length) });
      },
      close: function () { try { s.close(); } catch (e) {} }
    };
  }

  /** Node（测试与工具用）：dgram */
  function nodeSocketFactory() {
    if (typeof require !== 'function') return null;
    var dgram = require('dgram');
    var s = dgram.createSocket('udp4');
    s.bind();
    return {
      onMessage: function (cb) {
        s.on('message', function (buf) {
          cb(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
        });
      },
      send: function (u8, host, port) {
        s.send(Buffer.from(u8.buffer, u8.byteOffset, u8.length), port, host);
      },
      close: function () { try { s.close(); } catch (e) {} }
    };
  }

  /**
   * 按运行环境挑一个可用的 socket 工厂。
   * 浏览器**没有裸 UDP**（WebTransport 是后续阶段的事），返回 null → 全程 TCP。
   */
  function autoSocketFactory() {
    if (typeof wx !== 'undefined' && wx.createUDPSocket) return wxSocketFactory;
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      return nodeSocketFactory;
    }
    return null;
  }

  CS.UdpAccel = UdpAccel;
  CS.udpSocketFactories = {
    wx: wxSocketFactory,
    node: nodeSocketFactory,
    auto: autoSocketFactory
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UdpAccel: UdpAccel, factories: CS.udpSocketFactories };
  }
})(typeof window !== 'undefined' ? window : globalThis);
