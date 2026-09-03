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

  function makeSnapStats() {
    return {
      received: 0, missing: 0, late: 0, stalls: 0,
      lastAt: 0, lastTick: null, jitterMs: 0, maxGapMs: 0,
      intervals: []
    };
  }

  function percentile(arr, q) {
    if (!arr || !arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.floor(a.length * q))];
  }

  function pct(n, d) { return d > 0 ? n * 100 / d : 0; }

  function tickAfterOrSame(tick, base) {
    if (base == null || base < 0) return true;
    var d = ((tick | 0) - (base | 0)) & 0xFFFF;
    return d === 0 || d <= 32767;
  }

  function WsTransport(opts) {
    TransportBase.call(this);
    opts = opts || {};
    this.url = opts.url || defaultUrl();
    this.WS = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.heartbeatMs = opts.heartbeatMs || 5000;
    this.ws = null;
    this.seq = 0;
    this.rtt = 0;          // 最近一次 wss ping/pong 往返（ms）
    this.rttJitter = 0;    // RFC3550 风格 EWMA：相邻 RTT 差的平滑值
    this.rttMin = 0;
    this.rttMax = 0;
    this.rttSamples = [];
    this._prevRtt = 0;
    this.snapStats = { tcp: makeSnapStats(), wt: makeSnapStats(), udp: makeSnapStats() };
    this.timing = {
      tickMs: 33,
      tcpIntervalMs: 66, accelIntervalMs: 33,
      tcpEvery: 2, accelEvery: 1, udpDup: 3
    };
    this.playerId = 0;
    this.roomId = null;
    this._hbTimer = null;
    this._dropped = false;

    // 加速层（v3.1）：matched 带回接入信息后建立旁路，承载 input/snap。
    //   裸 UDP（微信小游戏 / Node）或 WebTransport（浏览器）
    // 拿不到 / 打洞失败 / 中途停滞 → 自动走 TCP，对局不受影响。
    // 传 udp:false 可显式关闭（回滚点）。
    //
    // **工厂只能在 matched 之后选定**：浏览器分支要看服务器有没有下发 wtPort，
    // 且 WebTransport 需要带端口的完整 URL ⇒ 构造时还不知道，不能提前定。
    this.udpEnabled = opts.udp !== false;
    this.udpFactoryOverride = opts.udpSocketFactory || null;   // 测试可注入
    this.udpFactory = null;    // 由 _setupUdp 依 matched 信息选定
    this.udp = null;
    this.meta = {};        // 低频通道缓存：id → { nm, kl, es, ... }
    this._metaTick = -1;
    this._blocksById = {}; // 二进制色块增量的本地基线；1Hz meta / TCP 全量会校正
    this._blockTick = -1;
    this._lastSnapTick = null; // 跨 TCP/加速通道去重，避免独立管道乱序回滚
  }
  WsTransport.prototype = Object.create(TransportBase.prototype);
  WsTransport.prototype.constructor = WsTransport;

  WsTransport.prototype._recordRtt = function (rtt) {
    if (!(rtt >= 0) || rtt > 60000) return;
    this.rtt = rtt;
    if (!this.rttMin || rtt < this.rttMin) this.rttMin = rtt;
    if (rtt > this.rttMax) this.rttMax = rtt;
    if (this._prevRtt > 0) {
      this.rttJitter += (Math.abs(rtt - this._prevRtt) - this.rttJitter) / 16;
    }
    this._prevRtt = rtt;
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > 60) this.rttSamples.shift();
  };

  /**
   * 记录应用层快照到达质量。TCP 可靠有序，不能把停顿说成「丢包」；
   * 因此两类指标分开：missing 是逻辑快照缺失，late/stalls 是到达间隔异常。
   */
  /** 通道切换时只清到达基线，保留累计样本；避免把正常的通道空窗误算成缺帧/长卡顿。 */
  WsTransport.prototype._resetSnapBaseline = function (kind) {
    kind = kind === 'wt' || kind === 'udp' ? kind : 'tcp';
    var st = this.snapStats[kind];
    st.lastAt = 0;
    st.lastTick = null;
  };

  WsTransport.prototype._recordSnap = function (msg, kind) {
    kind = kind === 'wt' || kind === 'udp' ? kind : 'tcp';
    var st = this.snapStats[kind];
    var now = Date.now();
    var accel = kind !== 'tcp';
    var interval = accel ? this.timing.accelIntervalMs : this.timing.tcpIntervalMs;
    var tickStep = accel ? this.timing.accelEvery : this.timing.tcpEvery;
    st.received++;

    if (st.lastAt > 0) {
      var gap = Math.max(0, now - st.lastAt);
      st.intervals.push(gap);
      if (st.intervals.length > 180) st.intervals.shift();
      if (gap > st.maxGapMs) st.maxGapMs = gap;
      st.jitterMs += (Math.abs(gap - interval) - st.jitterMs) / 16;
      if (gap > interval * 1.5) st.late++;
      if (gap > interval * 2.5) st.stalls++;
    }

    if (st.lastTick != null && msg && typeof msg.tk === 'number') {
      var d;
      if (accel) d = (msg.tk - st.lastTick) & 0xFFFF;
      else d = msg.tk - st.lastTick;
      if (d > 0 && d <= 32767 && tickStep > 0) {
        var frames = Math.round(d / tickStep);
        if (frames > 1) st.missing += frames - 1;
      }
    }
    st.lastAt = now;
    st.lastTick = msg && typeof msg.tk === 'number' ? msg.tk : st.lastTick;
  };

  WsTransport.prototype.diagnostics = function (kind) {
    kind = kind === 'wt' || kind === 'udp' ? kind : 'tcp';
    var st = this.snapStats[kind];
    var total = st.received + st.missing;
    return {
      rttMs: this.rtt,
      rttP50Ms: percentile(this.rttSamples, 0.50),
      rttP95Ms: percentile(this.rttSamples, 0.95),
      rttJitterMs: this.rttJitter,
      rttMinMs: this.rttMin,
      rttMaxMs: this.rttMax,
      receivedFrames: st.received,
      missingFrames: st.missing,
      frameLossPct: pct(st.missing, total),
      latePct: pct(st.late, Math.max(0, st.received - 1)),
      stalls: st.stalls,
      arrivalP50Ms: percentile(st.intervals, 0.50),
      arrivalP95Ms: percentile(st.intervals, 0.95),
      arrivalMaxMs: st.maxGapMs,
      arrivalJitterMs: st.jitterMs,
      wsBufferedBytes: this.ws && typeof this.ws.bufferedAmount === 'number'
        ? this.ws.bufferedAmount : 0
    };
  };

  WsTransport.prototype.connect = function () {
    var self = this;
    if (!this.WS) throw new Error('WsTransport: 无 WebSocket 实现（浏览器应原生支持）');
    var ws = this.ws = new this.WS(this.url);

    ws.onopen = function () {
      self._dropped = false;
      self._emit('open');
      // 首次 RTT 不应等 5 秒心跳周期；联机一建立就测一次，HUD 开局即可显示。
      if (ws.readyState === 1) ws.send(P.encode(P.ping(Date.now())));
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
          self.meta = {}; self._metaTick = 0;
          self._blocksById = {}; self._blockTick = -1; self._lastSnapTick = null;
          // matched 本身可靠且已含 id/name，用它给首个二进制帧建立最低限度的 meta。
          // UDP/WT 与 wss 无跨通道顺序保证，不能假定 1Hz meta 一定先到。
          var players = msg.players || [];
          for (var pi = 0; pi < players.length; pi++) {
            self.meta[players[pi].id] = {
              id: players[pi].id, nm: players[pi].name || ('玩家' + players[pi].id),
              kl: 0, es: 0, et: 0, ml: 0, sv: 0, mb: 0
            };
          }
          self.snapStats = { tcp: makeSnapStats(), wt: makeSnapStats(), udp: makeSnapStats() };
          self.timing.tickMs = msg.tickMs || 33;
          self.timing.tcpIntervalMs = msg.tcpSnapIntervalMs || msg.snapIntervalMs || 66;
          self.timing.accelIntervalMs = msg.accelSnapIntervalMs || msg.snapIntervalMs || 33;
          self.timing.tcpEvery = msg.tcpSnapEvery || Math.max(1,
            Math.round(self.timing.tcpIntervalMs / self.timing.tickMs));
          self.timing.accelEvery = msg.accelSnapEvery || Math.max(1,
            Math.round(self.timing.accelIntervalMs / self.timing.tickMs));
          self.timing.udpDup = msg.udpDup || 3;
          self._setupUdp(msg);
          self._emit('matched', msg);
          break;
        case P.S2C.START: self._emit('start', msg); break;
        case P.S2C.SNAP:
          if (!self._acceptSnapTick(msg.tk)) break;
          self._syncBlocksFromTcp(msg);
          self._recordSnap(msg, 'tcp');
          self._emit('snap', msg);
          break;
        case P.S2C.EVENT: self._emit('event', msg); break;
        case P.S2C.OVER: self._emit('over', msg); break;
        case P.S2C.PONG: self._recordRtt(Date.now() - msg.ts); break;
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
   * 建立加速旁路（matched 后调用）。
   * 失败不抛错、不提示玩家 —— 静默走 TCP，对局体验不受影响。
   *
   * 服务器把**两条通道的接入信息都下发**（udpPort/udpToken + wtPort/wtToken），
   * 客户端按自身能力挑一条：小游戏/Node 走裸 UDP，浏览器走 WebTransport。
   * 两条通道在服务端是**独立的会话表**，token 各用各的，绝不能混。
   */
  WsTransport.prototype._setupUdp = function (msg) {
    if (!this.udpEnabled || !CS.UdpAccel) return;

    var host = null;
    if (typeof location !== 'undefined' && location.hostname) host = location.hostname;
    else if (this.url) {
      var m = /^wss?:\/\/([^:/]+)/.exec(this.url);
      if (m) host = m[1];
    }

    // 选工厂：注入优先（测试），否则按环境自动选。
    // 传入 msg 让浏览器分支能看到 wtPort/wtPath。
    this.udpFactory = this.udpFactoryOverride ||
      (CS.udpSocketFactories && CS.udpSocketFactories.auto &&
       CS.udpSocketFactories.auto({
         host: host, wtPort: msg.wtPort, wtPath: msg.wtPath,
         certHashes: msg.wtCertHashes || null   // 仅测试环境会带
       }));
    if (!this.udpFactory) return;   // 无可用通道（如无 WebTransport 的旧浏览器）

    // 走哪条通道就用哪套 port/token。
    //
    // **通道类型由工厂自报**（`channelKind`），这里不再重判平台 ——
    // `autoSocketFactory` 已经按 wx / node / 浏览器做过选择，
    // 在这儿判第二遍等于两处独立判定同一件事：一旦分叉，
    // UI 显示的通道就会与实际走的不一致，而那种 bug 看起来完全正常。
    var kind = this.udpFactory.channelKind === 'wt' ? 'wt' : 'udp';
    var port = msg.udpPort, token = msg.udpToken;
    if (kind === 'wt') {
      // WebTransport：端口已编进工厂的 URL，这里的 port 只是
      // 给 UdpAccel 的形式参数，真正要紧的是 token（两个端点会话表独立）。
      port = msg.wtPort;
      token = msg.wtToken;
    }
    if (!port || token == null) return;

    var self = this;
    this.udpKind = kind;
    this.udp = new CS.UdpAccel({
      socketFactory: this.udpFactory,
      onSnap: function (dec) {
        if (!self._acceptSnapTick(dec.tk)) return;
        self._recordSnap(dec, kind);
        self._emit('snap', self._mergeMeta(dec));
      },
      // 带上通道类型：上层要能区分「WebTransport」与「裸 UDP」。
      // 只报一个 active 布尔的话，页面上说不清玩家实际走的是哪条。
      onStateChange: function (active) {
        // 控制面必须同步给服务器，才能让“下行停滞 → 回落 TCP”真正生效。
        // 只在客户端把 active 置 false 不够：服务端仍会因旧握手状态抑制 TCP。
        self._resetSnapBaseline(active ? kind : 'tcp');
        self._send(P.accel(active));
        self._emit('udp', { active: active, kind: kind });
      },
      // 回落后先请求短暂“双发探测”；收到完整二进制 snap 才由 onStateChange
      // 确认 active=true。这样 7B ACK 可达但大 datagram 不通时不会周期性黑屏。
      onProbe: function (probing) { self._send(P.accel(probing ? 2 : 0)); }
    });
    if (!this.udp.attach({
      udpPort: port, udpToken: token, host: host,
      snapIntervalMs: msg.accelSnapIntervalMs || msg.snapIntervalMs,
      tickStep: msg.accelSnapEvery || 1,
      expectedDup: msg.udpDup || 3
    })) {
      this.udp = null;
    }
  };

  /** 跨 TCP/加速通道只接收单调更新的快照，避免独立管道乱序把视图回滚。 */
  WsTransport.prototype._acceptSnapTick = function (tick) {
    if (typeof tick !== 'number') return false;
    if (this._lastSnapTick != null) {
      var d = (tick - this._lastSnapTick) & 0xFFFF;
      if (d === 0 || d > 32767) return false;
    }
    this._lastSnapTick = tick;
    return true;
  };

  /** TCP 全量快照也要重建二进制增量基线，否则恢复加速后会从旧 blocks 继续打补丁。 */
  WsTransport.prototype._syncBlocksFromTcp = function (msg) {
    if (!msg || !Array.isArray(msg.bl) || !tickAfterOrSame(msg.tk, this._blockTick)) return;
    var next = {};
    for (var i = 0; i < msg.bl.length; i++) {
      var d = msg.bl[i];
      if (d.bid == null) return; // 旧服务端无 bid：不破坏现有可靠基线
      var b = P.deBlock(d);
      next[d.bid] = b;
    }
    this._blocksById = next;
    this._blockTick = msg.tk;
  };

  /** 低频通道：昵称与计分从每帧快照移出后，在此缓存并回填 */
  WsTransport.prototype._onMeta = function (msg) {
    var freshMeta = tickAfterOrSame(msg.tk, this._metaTick);
    var arr = msg.sn || [];
    if (freshMeta) {
      for (var i = 0; i < arr.length; i++) this.meta[arr[i].id] = arr[i];
      this._metaTick = msg.tk;
    }
    if (msg.blocks && tickAfterOrSame(msg.tk, this._blockTick)) {
      // 可靠的 1Hz 全量是色块增量的纠偏基线：必须整体替换，不能在旧集合上追加。
      this._blocksById = {};
      for (i = 0; i < msg.blocks.length; i++) {
        var b = msg.blocks[i];
        this._blocksById[b.bid] = {
          bid: b.bid, x: b.x, y: b.y, color: b.c == null ? null : b.c,
          kind: b.k || 'color', rarity: b.r || null, r: b.rr || 0
        };
      }
      this._blockTick = msg.tk;
    }
    this._emit('meta', msg);
  };

  /**
   * 把二进制解码对象规范化为 JSON snap 的**短键线格式**。
   * decSnake() 产出的是便于编码层测试的长键对象，不能直接喂给 RemoteMatch：
   * 后者会再次调用 protocol.deSnake() 并读取 sg/co。色块增量也必须先合成为
   * 全量 bl；否则真实调用链会在 snap.bl.map() 处崩溃。
   */
  WsTransport.prototype._mergeMeta = function (dec) {
    var wireSn = [];
    for (var i = 0; i < dec.sn.length; i++) {
      var s = dec.sn[i];
      var m = this.meta[s.id];
      wireSn.push(P.serSnake({
        id: s.id,
        name: String((m && m.nm) || s.name || ('玩家' + s.id)),
        isPlayer: s.isPlayer,
        alive: s.alive,
        kills: m ? m.kl : s.kills,
        elimScore: m ? m.es : s.elimScore,
        elimTotal: m ? m.et : s.elimTotal,
        maxLen: m ? m.ml : s.maxLen,
        survivalScore: m ? m.sv : s.survivalScore,
        mpBonusScore: m ? m.mb : s.mpBonusScore,
        bittenUntil: s.bitten ? dec.tm + 100 : 0,
        slowUntil: s.slow ? dec.tm + 100 : 0,
        snake: s
      }));
    }

    // TCP/meta 与加速快照来自独立管道：较新的全量基线可能先于旧增量到达。
    // 旧增量必须整帧忽略，否则会把已经纠正的色块重新删除/复活，并把基线 tick 回拨。
    if (tickAfterOrSame(dec.tk, this._blockTick)) {
      var del = dec.blockDel || [];
      for (i = 0; i < del.length; i++) delete this._blocksById[del[i]];
      var add = dec.blockAdd || [];
      for (i = 0; i < add.length; i++) {
        var a = add[i];
        this._blocksById[a.bid] = {
          bid: a.bid, x: a.x, y: a.y, color: a.color, kind: a.kind || 'color',
          rarity: a.rarity || null, r: a.r || 0
        };
      }
      this._blockTick = dec.tk;
    }

    var ids = Object.keys(this._blocksById).sort(function (a, b) { return (+a) - (+b); });
    var bl = [];
    for (i = 0; i < ids.length; i++) bl.push(P.serBlock(this._blocksById[ids[i]]));
    var mt = [];
    var meteors = dec.meteors || [];
    for (i = 0; i < meteors.length; i++) mt.push(P.serMeteor(meteors[i]));

    return { t: P.S2C.SNAP, tk: dec.tk, ack: dec.ack, tm: dec.tm, sn: wireSn, bl: bl, mt: mt };
  };

  WsTransport.prototype.joinMatch = function (name) { this._send(P.join(name)); };
  WsTransport.prototype.cancelMatch = function () { this._send(P.cancel()); };

  /**
   * 上行输入（调用方节流，建议 ≤30Hz；seq 单调递增供服务器 ack）。
   * UDP 旁路可用时走 UDP（冗余打散），否则走 TCP —— 切换对调用方透明。
   */
  WsTransport.prototype.sendInput = function (angle, boost) {
    // 输入序号属于“玩家输入流”，不属于某条物理通道。每个逻辑输入只递增一次，
    // UDP/WT 与 TCP 共用它，回落时下一帧才能紧接服务端 lastSeq 而不是从 1 重来。
    this.seq = (this.seq + 1) & 0xFFFF;
    if (this.udp && this.udp.sendInput(angle, boost, this.seq)) return;
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
