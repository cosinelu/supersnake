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
    this.onProbe = opts.onProbe || function () {};
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
    this.tickStep = 1;          // 相邻逻辑快照的 tick 差（默认每 tick 一帧）
    this.expectedDup = 3;       // 服务端每帧发送副本数（诊断副本接收率）
    this._lastHelloAt = 0;
    this._prevPathRtt = 0;
    this.stats = {
      sent: 0, recv: 0, dupDropped: 0, decodeFail: 0, fallbacks: 0, socketErrors: 0,
      rawSnaps: 0, missingFrames: 0, outOfOrder: 0,
      pathRttMs: 0, pathRttJitterMs: 0, pathRttMinMs: 0, pathRttMaxMs: 0
    };
    // 玩家侧仍然静默回落 WSS，但工程诊断不能再静默：否则手机只显示 TCP，
    // 无法区分“不支持 WebTransport”“QUIC/端口被拦”与“运行中断链”。
    this.diag = {
      state: 'not_attempted', phase: '', reason: '', target: '',
      lastError: '', failedAt: 0, helloSent: 0, ackedAt: 0, firstSnapAt: 0
    };

    this._hsTimer = null;
    this._kaTimer = null;
    this._stallTimer = null;
    this._probeTimer = null;    // 回落后仅在双发探测窗内尝试恢复，避免小 ACK 假阳性
    this._pending = [];         // 打散发送的定时器句柄，dispose 时清理
  }

  UdpAccel.prototype._markFailure = function (reason, phase, err, terminal) {
    this.diag.state = terminal ? 'terminal' : 'fallback';
    this.diag.reason = reason || 'unknown';
    this.diag.phase = phase || '';
    this.diag.failedAt = Date.now();
    this.diag.lastError = err && (err.message || String(err)) || '';
  };

  /**
   * 用 matched 下发的信息建立 UDP 旁路。
   * @param {object} info { udpPort, udpToken, host }
   */
  UdpAccel.prototype.attach = function (info) {
    if (!info || !info.udpPort || info.udpToken == null) {
      this._markFailure('invalid_offer', 'offer');
      return false;
    }
    if (!this.socketFactory) {
      this._markFailure('factory_unavailable', 'factory');
      return false;
    }
    this.host = info.host || this._defaultHost();
    this.port = info.udpPort;
    this.token = info.udpToken >>> 0;
    this.diag.state = 'connecting';
    this.diag.phase = 'factory';
    var diagHost = this.host.indexOf(':') >= 0 && this.host.charAt(0) !== '['
      ? '[' + this.host + ']' : this.host;
    this.diag.target = diagHost + ':' + this.port;
    if (info.snapIntervalMs) this.frameIntervalMs = info.snapIntervalMs;
    if (info.tickStep > 0) this.tickStep = info.tickStep | 0;
    if (info.expectedDup > 0) {
      this.expectedDup = info.expectedDup | 0;
      this.dup = this.expectedDup; // 上下行冗余策略保持一致，且诊断按同一真值计算
    }

    var self = this;
    try {
      this.sock = this.socketFactory();
    } catch (e) {
      this._markFailure('constructor_throw', 'factory', e, true);
      return false;
    }
    if (!this.sock) {
      var ff = this.socketFactory.lastFailure;
      this._markFailure(ff && ff.reason || 'factory_unavailable',
        ff && ff.phase || 'factory', ff && ff.error, true);
      return false;
    }
    if (this.sock.target) this.diag.target = this.sock.target;

    this.diag.phase = 'hello';
    this.sock.onMessage(function (u8) { self._onMessage(u8); });
    if (typeof this.sock.onError === 'function') {
      this.sock.onError(function (err) {
        self.stats.socketErrors++;
        self.available = false;
        self._markFailure(err && err.transportReason || 'socket_error',
          err && err.transportPhase || 'runtime', err, true);
        // WebTransport writable/reader/会话关闭属于终止性错误：当前 socket 已不可恢复。
        // 停掉握手、保活、探测和打散定时器，避免每 300ms/5s 重复发送 accel(0)。
        if (self._hsTimer) { clearInterval(self._hsTimer); self._hsTimer = null; }
        if (self._kaTimer) { clearInterval(self._kaTimer); self._kaTimer = null; }
        if (self._stallTimer) { clearInterval(self._stallTimer); self._stallTimer = null; }
        if (self._probeTimer) { clearTimeout(self._probeTimer); self._probeTimer = null; }
        for (var i = 0; i < self._pending.length; i++) clearTimeout(self._pending[i]);
        self._pending.length = 0;
        self._setActive(false, true);
      });
    }

    this._sendHello();
    // 打洞可能丢包，握手窗口内重试几次
    var tries = 0;
    this._hsTimer = setInterval(function () {
      if (self.available) { clearInterval(self._hsTimer); self._hsTimer = null; return; }
      tries++;
      if (tries * 300 >= HANDSHAKE_TIMEOUT_MS) {
        // 判定 UDP 不可用：玩家无感走 TCP，但把失败阶段留给 __net()。
        clearInterval(self._hsTimer); self._hsTimer = null;
        // 即使 active 从未变成 true，也必须强制上报一次 false：服务端可能已经
        // 收到 hello 并开始发二进制，只是回程 ACK/快照全丢。不上报就会形成
        // 服务端持续抑制 TCP、客户端却等待 TCP 的“假回落”。
        self._markFailure('hello_ack_timeout', 'hello');
        self._setActive(false, true);
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
    this._lastHelloAt = Date.now();
    this.diag.helloSent++;
    this._raw(w.bytes());
  };

  UdpAccel.prototype._raw = function (u8) {
    if (!this.sock) return false;
    try {
      if (this.sock.send(u8, this.host, this.port) === false) {
        this.stats.socketErrors++;
        this.available = false;
        this._markFailure('send_failed', 'write');
        this._setActive(false, true);
        return false;
      }
      this.stats.sent++;
      return true;
    } catch (e) {
      this.stats.socketErrors++;
      this.available = false;
      this._markFailure('send_failed', 'write', e);
      this._setActive(false, true);
      return false;
    }
  };

  UdpAccel.prototype._setActive = function (v, forceNotify) {
    if (this.active === v && !forceNotify) return;
    var wasActive = this.active;
    this.active = v;
    if (v) {
      this.diag.state = 'active';
      this.diag.phase = 'snap';
    }
    if (!v && wasActive) this.stats.fallbacks++;
    this.onStateChange(v);
  };

  UdpAccel.prototype._onMessage = function (u8) {
    if (!u8 || !u8.length) return;

    if (u8[0] === MAGIC_HACK) {
      // ACK 与 hello 一样是 7B 完整帧：magic1 + token4 + crc16。
      // 只看首字节会把随机/截断包当成可用性证明，并刷新停滞计时形成假在线。
      if (u8.length !== 7 || new B.BinReader(u8).checkCrc16() !== true) {
        this.stats.decodeFail++;
        return;
      }
      var ackToken = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, true);
      if (ackToken !== this.token) { this.stats.decodeFail++; return; }
      this.lastRecvAt = Date.now();
      this.diag.ackedAt = this.lastRecvAt;
      if (this._lastHelloAt > 0) {
        var rtt = Math.max(0, Date.now() - this._lastHelloAt);
        this.stats.pathRttMs = rtt;
        if (!this.stats.pathRttMinMs || rtt < this.stats.pathRttMinMs) this.stats.pathRttMinMs = rtt;
        if (rtt > this.stats.pathRttMaxMs) this.stats.pathRttMaxMs = rtt;
        if (this._prevPathRtt > 0) {
          this.stats.pathRttJitterMs +=
            (Math.abs(rtt - this._prevPathRtt) - this.stats.pathRttJitterMs) / 16;
        }
        this._prevPathRtt = rtt;
      }
      if (!this.available) {
        this.available = true;
        if (this._hsTimer) { clearInterval(this._hsTimer); this._hsTimer = null; }
        this._startKeepalive();
        this._startStallWatch();
        this._setActive(true);   // 首次握手：允许加速通道接管
      } else if (!this.active) {
        // 回落后的 hello_ack 只能证明 7B 小包往返，不足以证明完整快照可达。
        // 进入“服务器双发”探测窗；收到真实 snap 后才 active=true 并停止 TCP。
        this._startProbe();
      }
      return;
    }

    var dec = BP.decSnapBin(u8);
    if (!dec) { this.stats.decodeFail++; return; }
    this.lastRecvAt = Date.now();
    if (!this.diag.firstSnapAt) this.diag.firstSnapAt = this.lastRecvAt;
    this.stats.rawSnaps++;

    // 下行去重：冗余副本与乱序。tick 是 uint16，需处理环回。
    // 同时统计逻辑帧缺失；这才是 UDP/WT 可称为「丢帧率」的指标。
    if (this.lastRecvTick >= 0) {
      var d = (dec.tk - this.lastRecvTick) & 0xFFFF;
      if (d === 0) { this.stats.dupDropped++; return; }
      if (d > 32767) {
        this.stats.dupDropped++;
        this.stats.outOfOrder++;
        return;
      }
      var logical = Math.round(d / this.tickStep);
      if (logical > 1) this.stats.missingFrames += logical - 1;
    }
    this.lastRecvTick = dec.tk;
    this.stats.recv++;
    if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; }
    this._setActive(true);       // 只有完整二进制快照到达才确认恢复
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
  UdpAccel.prototype.sendInput = function (angle, boost, seq) {
    if (!this.active || !this.sock) return false;
    // WsTransport 传入跨 TCP/加速通道共享的逻辑序号；独立测试/工具可省略并沿用内部计数。
    // 两条通道若各自计数，早期加速回落后 TCP seq 会落后服务端 lastSeq，输入将被冻结。
    this.frameId = (typeof seq === 'number' && isFinite(seq))
      ? (seq & 0xFFFF) : ((this.frameId + 1) & 0xFFFF);
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

  /** 回落后的安全恢复：短暂请求服务器双发，完整快照到达后才停 TCP。 */
  UdpAccel.prototype._startProbe = function () {
    if (this.active || this._probeTimer) return;
    var self = this;
    this.onProbe(true);
    this._probeTimer = setTimeout(function () {
      self._probeTimer = null;
      if (!self.active) self.onProbe(false);
    }, STALL_MS + 200);
  };

  /** NAT 保活：死亡/观战时不发上行，映射会失效（通常 30s） */
  UdpAccel.prototype._startKeepalive = function () {
    var self = this;
    if (this._kaTimer) return;
    this._kaTimer = setInterval(function () {
      if (!self.sock) return;
      // 无论下行是否繁忙都发一次极小 hello：除 NAT 保活外，它还是加速通道
      // 唯一可用的双向 RTT 探针。7 字节 / 5 秒可忽略，服务端会立即回 hello_ack。
      self._sendHello();
    }, KEEPALIVE_MS);
  };

  /** 下行停滞检测：连续 STALL_MS 无包 → 回落 TCP，但后台继续等 UDP 恢复 */
  UdpAccel.prototype._startStallWatch = function () {
    var self = this;
    if (this._stallTimer) return;
    this._stallTimer = setInterval(function () {
      if (!self.active) return;
      if (Date.now() - self.lastRecvAt > STALL_MS) {
        self._markFailure('downlink_stall', 'runtime');
        self._setActive(false);
      }
    }, 200);
  };

  UdpAccel.prototype.dispose = function () {
    if (this._hsTimer) { clearInterval(this._hsTimer); this._hsTimer = null; }
    if (this._kaTimer) { clearInterval(this._kaTimer); this._kaTimer = null; }
    if (this._stallTimer) { clearInterval(this._stallTimer); this._stallTimer = null; }
    if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; }
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
   * 浏览器：WebTransport（HTTP/3 over QUIC）。
   *
   * 浏览器没有裸 UDP，这是唯一能让网页版吃到「二进制 + 冗余打散」收益的通道
   * （2026-03 起 Baseline，Safari 26.4 补齐最后一块，覆盖约 90%）。
   *
   * **不可靠 datagram 的语义与裸 UDP 完全一致** ⇒ 上层 `UdpAccel`、
   * `binProtocol`、冗余打散、去重、降级逻辑**全部原样复用**，这里只换管道。
   *
   * 两个适配要点：
   * 1. **握手是异步的，而 socketFactory 必须同步返回** ——
   *    故立即返回一个「壳」，把 ready 之前的发送**排队**，ready 后冲刷。
   *    `UdpAccel` 因此不需要知道任何异步细节（它的打洞本来就带重试，
   *    多等几十毫秒无影响）。
   * 2. **地址来自 matched 的 `wtPort`/`wtPath`**，WebTransport 要完整 https URL，
   *    所以 `send(u8, host, port)` 的后两个参数被忽略 —— URL 在创建时已定。
   *
   * @param {object} info { host, wtPort, wtPath, certHashes? }
   *   `certHashes` 仅测试用（自签证书）；生产走标准 Web PKI，不传。
   */
  function makeWebTransportFactory(info) {
    var f = function () {
      f.lastFailure = null;
      var WT = (typeof WebTransport !== 'undefined') ? WebTransport
        : (typeof globalThis !== 'undefined' ? globalThis.WebTransport : null);
      if (!WT) {
        f.lastFailure = { reason: 'webtransport_unsupported', phase: 'factory' };
        return null;
      }
      if (!info || !info.wtPort) {
        f.lastFailure = { reason: 'invalid_offer', phase: 'offer' };
        return null;
      }

      var host = info.host ||
        (typeof location !== 'undefined' && location.hostname ? location.hostname : '127.0.0.1');
      var authority = host.indexOf(':') >= 0 && host.charAt(0) !== '[' ? '[' + host + ']' : host;
      var url = 'https://' + authority + ':' + info.wtPort + (info.wtPath || '/wt');
      var opts = {};
      if (info.certHashes) opts.serverCertificateHashes = info.certHashes;

      var wt;
      try { wt = new WT(url, opts); } catch (e) {
        f.lastFailure = { reason: 'constructor_throw', phase: 'factory', error: e };
        return null;
      }

      var writer = null, reader = null, onMsg = null, onError = null, closed = false;
      var queue = [];   // ready 之前的待发数据（限长，防异常场景无限增长）

      function taggedError(err, reason, phase) {
        var out = err instanceof Error ? err : new Error(reason);
        out.transportReason = reason;
        out.transportPhase = phase;
        return out;
      }

      function fail(err, reason, phase) {
        if (closed) return;
        closed = true;
        queue.length = 0;
        if (onError) onError(taggedError(err, reason || 'socket_error', phase || 'runtime'));
      }

      function writeDatagram(u8) {
        if (!writer || closed) return false;
        try {
          var pending = writer.write(u8);
          if (pending && typeof pending.catch === 'function') {
            pending.catch(function (e) { fail(e, 'write_rejected', 'write'); });
          }
          return true;
        } catch (e) {
          fail(e, 'write_rejected', 'write');
          return false;
        }
      }

      // datagrams.writable 在 1.6.x 已标记 deprecated，但 createWritable
      // 未必存在 ⇒ 能力探测，不硬用其中一个
      function makeWriter(d) {
        if (d && typeof d.createWritable === 'function') return d.createWritable().getWriter();
        if (d && d.writable) return d.writable.getWriter();
        return null;
      }

      wt.ready.then(function () {
        if (closed) return;
        try {
          writer = makeWriter(wt.datagrams);
          reader = wt.datagrams && wt.datagrams.readable && wt.datagrams.readable.getReader();
          if (!writer || !reader) throw new Error('WebTransport datagram API unavailable');
        } catch (e) {
          fail(e, 'datagram_api_error', 'datagram_api');
          return;
        }
        for (var i = 0; i < queue.length; i++) {
          if (!writeDatagram(queue[i])) break;
        }
        queue.length = 0;
        (function pump() {
          if (closed || !reader) return;
          reader.read().then(function (res) {
            if (res.done || closed) {
              if (res.done) fail(null, 'session_closed', 'read');
              return;
            }
            if (onMsg) {
              var v = res.value;
              onMsg(v instanceof Uint8Array ? v : new Uint8Array(v));
            }
            pump();
          }).catch(function (e) { fail(e, 'read_rejected', 'read'); });
        })();
      }).catch(function (e) { fail(e, 'wt_ready_rejected', 'wt_ready'); });

      wt.closed.then(function () { fail(null, 'session_closed', 'session'); })
        .catch(function (e) { fail(e, 'session_closed', 'session'); });

      return {
        target: url,
        onMessage: function (cb) { onMsg = cb; },
        onError: function (cb) { onError = cb; },
        send: function (u8) {
          if (closed) return false;
          if (!writer) {
            if (queue.length < 32) queue.push(u8);
            return true;
          }
          return writeDatagram(u8);
        },
        close: function () {
          closed = true;
          queue.length = 0;
          try { if (wt) wt.close(); } catch (e) {}
        }
      };
    };
    f.channelKind = 'wt';
    return f;
  }

  /**
   * 按运行环境挑一个可用的 socket 工厂。
   *
   * @param {object} [info] matched 下发的接入信息；含 `wtPort` 时浏览器才可能走 WT
   * @returns {function|null} null ⇒ 无加速通道，全程走 TCP
   */
  function autoSocketFactory(info) {
    if (typeof wx !== 'undefined' && wx.createUDPSocket) return wxSocketFactory;
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      return nodeSocketFactory;
    }
    var hasWT = (typeof WebTransport !== 'undefined') ||
      (typeof globalThis !== 'undefined' && globalThis.WebTransport);
    if (hasWT && info && info.wtPort) return makeWebTransportFactory(info);
    return null;
  }

  // 每个工厂自报通道类型（'udp' | 'wt'）。
  //
  // 为什么标在工厂上而不是让调用方再判一次平台：`_setupUdp` 需要知道走的是
  // 哪条通道（选 port/token、上报给 UI），而它原本自己又判了一遍 wx/node ——
  // **同一件事在两处独立判定，迟早分叉**，而且分叉后 UI 显示的通道会与
  // 实际走的通道不一致，那种 bug 极难发现（显示错的那个看起来完全正常）。
  // 现在判定只有 autoSocketFactory 一处，其余人读标注。
  wxSocketFactory.channelKind = 'udp';
  nodeSocketFactory.channelKind = 'udp';

  CS.UdpAccel = UdpAccel;
  CS.udpSocketFactories = {
    wx: wxSocketFactory,
    node: nodeSocketFactory,
    webTransport: makeWebTransportFactory,
    auto: autoSocketFactory
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UdpAccel: UdpAccel, factories: CS.udpSocketFactories };
  }
})(typeof window !== 'undefined' ? window : globalThis);
