'use strict';
/**
 * webtransport.js — 浏览器 WebTransport 端点（v3.1 阶段 1d）
 *
 * 设计见 docs/architecture/02-udp-transport.md §7.4.1、docs/plan/02-udp-refactor-plan.md 阶段 1d。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个文件：浏览器没有裸 UDP
 * ---------------------------------------------------------------------------
 * `js/net/udpTransport.js` 的 socket 工厂只有 wx / node 两个真实分支，
 * 浏览器返回 null ⇒ 网页版全程 wss + JSON，完全吃不到 1a/1b 的收益
 * （二进制编码、冗余打散、48× 压缩）。
 *
 * WebTransport 的 datagram 语义是「不可靠、不有序、有大小上限」，
 * 与本项目的 UDP 通道**完全一致** ⇒ `binProtocol` / 冗余打散 / 去重 / 降级
 * 全部原样复用，只是换了一层管道。
 *
 * ---------------------------------------------------------------------------
 * 关键约束（都已实测确认，不要再试别的路）
 * ---------------------------------------------------------------------------
 * 1. **nginx 不能反代 WebTransport**：它只能做 HTTP/3 终端，不通告
 *    SETTINGS_ENABLE_CONNECT_PROTOCOL / H3_DATAGRAM / WT_ENABLED（缺一浏览器
 *    直接拒绝建会话），拒绝 CONNECT，且没有 HTTP/3 上游能力。
 *    `stream{}` UDP 透传也不行 —— 按四元组做伪会话，QUIC Connection ID
 *    迁移会断连。⇒ **必须本进程直接终结 QUIC/TLS**。
 * 2. **环境隔离只能靠端口，不能靠域名**（与 wss 相反）：`Http3Server` 只收
 *    单套 cert/privKey、无 SNI 分流。dev 8093 / official 443，各自独占。
 * 3. **两层放行**：ufw + 云控制台（后者只能手动）。
 *
 * ---------------------------------------------------------------------------
 * 接口与 UdpEndpoint 同构（这是本文件最重要的设计约束）
 * ---------------------------------------------------------------------------
 * `room.js` 只通过 4 个方法用传输层：offer / isReady / sendFrame / dropSession。
 * 本类实现同样的 4 个方法 ⇒ **room.js 一行都不用改**，
 * 由 `server/transportHub.js` 决定某个连接该走哪条通道。
 *
 * 会话语义也与 `server/udp.js` 保持一致（token 识别、frameId 去重规则），
 * 否则同一套客户端逻辑要为两条通道分叉，而它们本该只是「管道不同」。
 */
var crypto = require('crypto');
var path = require('path');

var JS = path.join(__dirname, '..', 'js');
require(path.join(JS, 'net', 'binCodec.js'));
require(path.join(JS, 'net', 'binProtocol.js'));
var BP = globalThis.CS.binProtocol;
var B = globalThis.CS.bin;

var MAGIC_INPUT = BP.MAGIC_INPUT;
var MAGIC_HELLO = 0x48;   // 'H' 与 udp.js 完全一致：客户端打洞/保活
var MAGIC_HACK = 0x4B;    // 'K' 服务器回应

var WT_PATH = '/wt';      // WebTransport 会话路径（客户端 URL 的 path 部分）

/**
 * @param {object} config server/config.js（可覆盖）
 * @param {object} hooks  { onInput(connId, {frameId, angle, boost}) }
 */
function WebTransportEndpoint(config, hooks) {
  this.config = config;
  this.hooks = hooks || {};
  this.server = null;
  this.listening = false;

  /** token(number) → session（与 udp.js 的 sessions 同构） */
  this.sessions = {};
  /** connId → token */
  this.byConn = {};
  this.stats = {
    rx: 0, tx: 0, sessions: 0,
    dropMagic: 0, dropToken: 0, dropCrc: 0, dropSeq: 0,
    certReloads: 0, certReloadFail: 0
  };
  this._closing = false;
  this._certWatched = false;
}

/**
 * 生成 32bit 会话令牌。与 udp.js:createSession 语义一致 ——
 * 仅用于身份识别，不是安全机制（判定权全在服务器，伪造上行只能让自己的蛇转向）。
 */
WebTransportEndpoint.prototype.createSession = function (connId, roomId) {
  var old = this.byConn[connId];
  if (old != null) delete this.sessions[old];
  var token;
  do { token = crypto.randomBytes(4).readUInt32LE(0); } while (this.sessions[token]);
  this.sessions[token] = {
    token: token, connId: connId, roomId: roomId,
    wt: null,               // WebTransport 会话对象（hello 到达后绑定）
    writer: null,           // datagrams writer
    lastFrameId: -1,        // 上行去重基线
    lastSeen: Date.now(),
    verified: false
  };
  this.byConn[connId] = token;
  return token;
};

WebTransportEndpoint.prototype.dropSession = function (connId) {
  var token = this.byConn[connId];
  if (token == null) return;
  var s = this.sessions[token];
  if (s && s.wt) { try { s.wt.close(); } catch (e) {} }
  delete this.sessions[token];
  delete this.byConn[connId];
};

/** 该连接的 WebTransport 是否已打通（未通时上层应走 TCP 或裸 UDP） */
WebTransportEndpoint.prototype.isReady = function (connId) {
  var token = this.byConn[connId];
  var s = token != null && this.sessions[token];
  return !!(s && s.verified && s.writer);
};

/**
 * 为某连接准备接入信息，随 matched 一并下发。
 * @returns {{port:number, token:number, path:string}|null}
 */
WebTransportEndpoint.prototype.offer = function (connId, roomId) {
  if (!this.listening) return null;
  var token = this.createSession(connId, roomId);
  return { port: this.port(), token: token, path: WT_PATH };
};

/**
 * 上行 frameId 去重 —— **与 udp.js:_acceptFrame 逐条对齐**。
 * 两条通道用同一套规则，客户端才不需要分叉。
 * 特别是「大幅回退＝客户端重新计数」这条：缺了它，重连玩家的输入会永久失效
 * （表现为怎么划都不动且无法自行恢复）。
 */
WebTransportEndpoint.prototype._acceptFrame = function (s, frameId) {
  var last = s.lastFrameId;
  if (last < 0) { s.lastFrameId = frameId; return true; }
  var jump = this.config.INPUT_MAX_SEQ_JUMP || 1000;
  var resetGap = this.config.INPUT_SEQ_RESET_GAP || 64;
  if (frameId > last + jump) return false;
  if (frameId < last) {
    if (last - frameId < resetGap) return false;
    s.lastFrameId = frameId;
    return true;
  }
  if (frameId === last) return false;
  s.lastFrameId = frameId;
  return true;
};

/** 处理一个上行 datagram（与 udp.js:_onMessage 同构，少了地址跟随 —— QUIC 自己管连接迁移） */
WebTransportEndpoint.prototype._onDatagram = function (u8, wt) {
  this.stats.rx++;
  if (!u8 || u8.length < 6) { this.stats.dropMagic++; return; }
  var magic = u8[0];

  // ---- 打洞/保活：magic1 + token4 + crc16 = 7 字节 ----
  if (magic === MAGIC_HELLO) {
    if (u8.length !== 7) { this.stats.dropMagic++; return; }
    if (new B.BinReader(u8).checkCrc16() !== true) { this.stats.dropCrc++; return; }
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.length);
    var tk = dv.getUint32(1, true);
    var sh = this.sessions[tk];
    if (!sh) { this.stats.dropToken++; return; }
    // 绑定会话 ⇒ 从此可下行。QUIC 连接本身就是有状态的，
    // 不需要 udp.js 那套「地址跟随」（Connection ID 迁移由 QUIC 层透明处理）。
    sh.wt = wt;
    sh.verified = true;
    sh.lastSeen = Date.now();
    if (!sh.writer) sh.writer = this._makeWriter(wt);
    var w = new B.BinWriter(8);
    w.u8(MAGIC_HACK); w.u32(tk); w.finishCrc16();
    this._rawSend(sh, w.bytes());
    return;
  }

  // ---- 上行输入 Fragment ----
  if (magic !== MAGIC_INPUT) { this.stats.dropMagic++; return; }
  var frag = BP.decInputFrag(u8);
  if (!frag) { this.stats.dropCrc++; return; }
  var s = this.sessions[frag.token];
  if (!s) { this.stats.dropToken++; return; }
  s.wt = wt;
  s.verified = true;
  s.lastSeen = Date.now();
  if (!s.writer) s.writer = this._makeWriter(wt);
  if (!this._acceptFrame(s, frag.frameId)) { this.stats.dropSeq++; return; }
  if (this.hooks.onInput) {
    this.hooks.onInput(s.connId, { frameId: frag.frameId, angle: frag.angle, boost: frag.boost });
  }
};

/**
 * 取 datagrams writer。
 * 注意：`session.datagrams.writable` 在 1.6.x 已标记 deprecated，
 * 但当前版本 `createWritable()` 未必存在，故做能力探测而不是硬用其中一个。
 */
WebTransportEndpoint.prototype._makeWriter = function (wt) {
  try {
    if (wt.datagrams && typeof wt.datagrams.createWritable === 'function') {
      return wt.datagrams.createWritable().getWriter();
    }
    if (wt.datagrams && wt.datagrams.writable) {
      return wt.datagrams.writable.getWriter();
    }
  } catch (e) { /* 会话可能已关闭 */ }
  return null;
};

/** 单次下行写入（异常一律吞掉：传输层错误不得影响对局） */
WebTransportEndpoint.prototype._rawSend = function (s, bytes) {
  if (!s || !s.writer) return false;
  try {
    // 不 await：datagram 是即发即忘，等 writer 会把 30Hz 的循环拖慢
    s.writer.write(bytes);
    this.stats.tx++;
    return true;
  } catch (e) {
    s.writer = null;   // writer 失效（会话关闭）→ 下次重建
    return false;
  }
};

/**
 * 向某连接发送一帧（按 UDP_DUP 份冗余，**帧内时间打散**）。
 *
 * 打散逻辑与 `udp.js:sendFrame` 完全相同，两个坑也一样：
 * 1) 不能一次性排多个 setTimeout（定时器分辨率会把它们合并到同一 tick，
 *    退化成「同时发」，而同时发在突发丢包下等于没发 —— 副本共命运）
 * 2) 不能死守原定时刻（漂移后 wait 被钳到最小值，又退回坑 1）
 * 解法：每发完一份用「剩余窗口 / 剩余份数」重新均分，并保证 MIN_GAP。
 * 窗口只是间隔参考，**不用来砍份数** —— UDP_DUP 是功能约定，
 * 为省带宽少发一份冗余是本末倒置。
 *
 * 弱网实测（见 test/net/weaknet.test.js）：打散比同时发帧到达率高 +10.2pp，
 * 长卡顿次数减少 73%。
 */
WebTransportEndpoint.prototype.sendFrame = function (connId, bytes) {
  var token = this.byConn[connId];
  var s = token != null && this.sessions[token];
  if (!s || !s.verified || !s.writer) return false;
  var dup = this.config.UDP_DUP || 3;
  var interval = (this.config.TICK_MS || 33) * (this.config.SNAP_EVERY || 1);
  this._rawSend(s, bytes);
  if (dup <= 1) return true;

  var MIN_GAP = 6;   // 须大于常见定时器抖动，否则跨不过 tick 等于没打散
  var deadline = Date.now() + interval * 0.8;
  var self = this;
  var left = dup - 1;
  function scheduleNext() {
    if (left <= 0) return;
    var wait = Math.max(MIN_GAP, Math.round((deadline - Date.now()) / left));
    var tm = setTimeout(function () {
      var cur = self.sessions[token];
      if (!cur || !cur.writer || self._closing) { left = 0; return; }
      self._rawSend(cur, bytes);
      left--;
      scheduleNext();
    }, wait);
    if (tm.unref) tm.unref();
  }
  scheduleNext();
  return true;
};

/**
 * 启动 HTTP/3 服务并开始接受会话。
 *
 * @param {function} [cb] 监听成功回调
 */
WebTransportEndpoint.prototype.listen = function (cb) {
  var self = this;
  // 动态 import：这个包是 ESM，且 native 加载是异步的。
  //
  // **解析路径要手工拼，不能靠 Node 的包解析**，两条路都堵着：
  //   - `import('@fails-components/webtransport')` 的解析基准是**调用方文件**，
  //     从 test/ 下驱动时会 ERR_MODULE_NOT_FOUND（依赖装在 server/node_modules）
  //   - 该包的 `exports` 完全封闭（连 ./package.json 都不暴露），
  //     所以 `require.resolve(包名 + 子路径)` 一律 ERR_PACKAGE_PATH_NOT_EXPORTED
  // 故直接按 __dirname 拼到 node_modules 里的 ESM 入口。
  //
  // **并且必须等 quicheLoaded** —— 否则库会静默回退 HTTP/2 并以
  // 「Opening handshake failed」失败，堆栈指向 http2/node/client.js，
  // 排查方向会被完全带偏（实测踩过）。
  var url = WebTransportEndpoint.libEntryUrl();
  import(url).then(function (mod) {
    return mod.quicheLoaded.then(function () { return mod; });
  }).then(function (mod) {
    var cert, privKey;
    if (self.config.WT_CERT_PEM && self.config.WT_KEY_PEM) {
      // 测试注入：直接给 PEM 内容，免落盘
      cert = self.config.WT_CERT_PEM;
      privKey = self.config.WT_KEY_PEM;
    } else {
      // 路径必须由环境变量给（WT_CERT / WT_KEY）——
      // 代码里不写死含域名的路径：那会让代码与某套部署绑死、造成环境串台，
      // 也会被 scripts/check-hygiene.sh 拦下。
      if (!self.config.WT_CERT || !self.config.WT_KEY) {
        throw new Error('缺少 WT_CERT / WT_KEY（证书路径须由环境变量提供）');
      }
      var fs = require('fs');
      cert = fs.readFileSync(self.config.WT_CERT);
      privKey = fs.readFileSync(self.config.WT_KEY);
    }
    self.server = new mod.Http3Server({
      port: self.config.WT_PORT != null ? self.config.WT_PORT : 8093,
      host: self.config.WT_HOST || '0.0.0.0',
      secret: self.config.WT_SECRET || crypto.randomBytes(16).toString('hex'),
      cert: cert,
      privKey: privKey
    });
    self.server.startServer();
    // ready 超时保护：证书无效等情况下库可能**永不 resolve 也不 reject**，
    // 没有这层保护会让调用方（含测试）永久挂住而不是拿到明确失败。
    var readyTimeout = new Promise(function (_, reject) {
      var tm = setTimeout(function () {
        reject(new Error('Http3Server ready 超时（证书无效？端口被占？）'));
      }, self.config.WT_READY_TIMEOUT_MS || 8000);
      if (tm.unref) tm.unref();
    });
    return Promise.race([self.server.ready, readyTimeout]).then(function () {
      self.listening = true;
      self._acceptSessions();
      self._watchCert();     // certbot 续期后自动热换，无需外部钩子
      if (cb) cb();
    });
  }).catch(function (err) {
    // 起不来不阻断服务：降级为「无 WT 通道」，浏览器走 wss，对局照常
    self.listening = false;
    self.server = null;
    if (self.hooks.onError) self.hooks.onError(err);
    if (cb) cb(err);
  });
};

/**
 * 持续接受新会话；每个会话独立读取 datagram 流。
 *
 * 注意 `sessionStream(path)` **直接返回 ReadableStream，不是 Promise**
 * （与 MDN 上浏览器侧的示例签名不同，照抄会得到
 * 「sessionStream(...).then is not a function」）。
 */
WebTransportEndpoint.prototype._acceptSessions = function () {
  var self = this;
  var stream;
  try {
    stream = this.server.sessionStream(WT_PATH);
  } catch (e) {
    if (this.hooks.onError) this.hooks.onError(e);
    return;
  }
  if (!stream || typeof stream.getReader !== 'function') return;
  var reader = stream.getReader();
  (function pump() {
    if (self._closing) { try { reader.releaseLock(); } catch (e) {} return; }
    reader.read().then(function (res) {
      if (res.done) return;
      self.stats.sessions++;
      self._handleSession(res.value);
      pump();
    }).catch(function () { /* 关闭中 */ });
  })();
};

/** 单个会话：等 ready → 循环读 datagram */
WebTransportEndpoint.prototype._handleSession = function (wt) {
  var self = this;
  wt.ready.then(function () {
    var dr;
    try {
      dr = wt.datagrams.readable.getReader();
    } catch (e) { return; }
    (function pump() {
      if (self._closing) { try { dr.releaseLock(); } catch (e) {} return; }
      dr.read().then(function (res) {
        if (res.done) return;
        var v = res.value;
        try {
          self._onDatagram(
            v instanceof Uint8Array ? v : new Uint8Array(v), wt
          );
        } catch (e) { /* 单包异常不得影响服务：这层直接暴露在公网 */ }
        pump();
      }).catch(function () { /* 会话结束 */ });
    })();
  }).catch(function () { /* 握手失败：客户端会自行降级 */ });

  // 会话关闭 → 解绑 writer，isReady 随之变 false，上层自动回落
  wt.closed.then(cleanup).catch(cleanup);
  function cleanup() {
    for (var t in self.sessions) {
      var s = self.sessions[t];
      if (s.wt === wt) { s.wt = null; s.writer = null; s.verified = false; }
    }
  }
};

WebTransportEndpoint.prototype.port = function () {
  if (!this.server) return 0;
  var a = this.server.address();
  return a ? a.port : 0;
};

/**
 * 尝试热换证书。
 *
 * **警告：走 HTTP/3 时这个调用是 no-op**（实测 + 查库源码确认）。
 *
 * `Http3Server.updateCert` 的实现是：
 *     this.transportsInts.forEach(t => { if (t.updateCert) t.updateCert(...) })
 * 而 `updateCert` **只有 http2 transport 实现了**（走 Node 的
 * `setSecureContext`）；`-transport-http3-quiche` 里根本没有这个方法
 * （grep 全包零命中，native 侧也没有）。条件不成立 ⇒ 静默跳过、
 * 不报错、不抛异常。所以它返回 true 只代表「调用没炸」。
 *
 * 实测证据（旧/新 hash 双向对照，这是唯一能证伪的测法）：
 *     换证后用**新**证书 hash 连 → 超时不通
 *     换证后用**旧**证书 hash 连 → 依然连通
 * ⇒ 服务器仍持旧证书。
 *
 * 因此本方法**不作为续期方案**，只保留给将来库补上实现时用。
 * 真正的续期路径见 `_watchCert`：重建整个端点。
 *
 * @returns {boolean} 仅表示调用未抛异常，**不表示证书真的换了**
 */
WebTransportEndpoint.prototype.updateCert = function (cert, privKey) {
  if (!this.server || typeof this.server.updateCert !== 'function') return false;
  try { this.server.updateCert(cert, privKey); return true; } catch (e) { return false; }
};

/**
 * 监听证书文件变化，变了就**重建端点**（不是热换 —— 见 updateCert 的说明）。
 *
 * 为什么必须处理：证书 90 天到期、certbot 每天检查一次。续期后若服务器
 * 仍持旧证书，QUIC 握手会一直用过期证书、浏览器直接拒连。而这个故障
 * 要等到续期那天才暴露，表现是「昨天还好好的，今天全连不上」。
 *
 * 为什么是重建而不是热换：quiche transport 没实现 `updateCert`（见上），
 * HTTP/3 下热换在库层面就不存在。剩下的选择只有重建端点或重启进程。
 *
 * 为什么重建端点优于重启进程：**wss 通道完全不受影响**。重建只影响
 * WebTransport 的 UDP socket，正在对局的玩家会被 `UdpAccel` 的停滞检测
 * 自动切回 wss（1b 已实现的降级路径），对局继续；等下一次 matched 再走
 * 新端点。而重启进程会断掉所有 WebSocket、直接踢人。
 * 换句话说：**已有的降级路径正好就是换证的缓冲垫**，不需要额外机制。
 *
 * 为什么进程自己盯文件、而不用 certbot 的 deploy hook：
 * 钩子是外部脚本，与进程之间没有现成通信通道；靠钩子就意味着
 * 「重装系统 / 换机 / 忘记配」都会让续期悄悄失效。让进程自己发现，
 * 这件事就不依赖任何人记得 —— 与 netem 脚本自带兜底清理同一个判断。
 *
 * 用 `fs.watchFile`（轮询 stat）而非 `fs.watch`（inotify）：certbot 是
 * **替换符号链接**而不是原地改文件，inotify 盯的是旧 inode，换完就再也
 * 收不到事件。轮询看的是路径，符号链接换指向照样能发现。
 */
WebTransportEndpoint.prototype._watchCert = function () {
  if (!this.config.WT_CERT || !this.config.WT_KEY) return;
  if (this.config.WT_CERT_WATCH === false) return;
  var self = this;
  var fs = require('fs');
  var interval = this.config.WT_CERT_WATCH_MS || 60000;
  var busy = false;

  var onChange = function (cur, prev) {
    // mtime 相同说明只是轮询触发、内容没变
    if (cur.mtimeMs === prev.mtimeMs) return;
    if (busy || self._closing) return;
    busy = true;
    // 延迟一拍再动：certbot 先写 fullchain 再写 privkey，
    // 立刻读会拿到「新证书 + 旧私钥」的错配组合。
    setTimeout(function () {
      if (self._closing) { busy = false; return; }
      self._rebuild(function () { busy = false; });
    }, 2000);
  };

  fs.watchFile(this.config.WT_CERT, { interval: interval }, onChange);
  fs.watchFile(this.config.WT_KEY, { interval: interval }, onChange);
  this._certWatched = true;
};

/**
 * 用新证书重建 Http3Server（会话全部作废，客户端由降级路径接住）。
 *
 * 端口必须复用**当前实际监听的端口**而不是配置值：配置里可能写 0
 * （测试用随机端口），重建时再传 0 会换到另一个端口，
 * 已下发给客户端的 `wtPort` 就全部指向空气了。
 */
WebTransportEndpoint.prototype._rebuild = function (cb) {
  var self = this;
  var curPort = this.port() || this.config.WT_PORT;
  var oldServer = this.server;

  this.listening = false;
  // 会话作废：新端点的 QUIC 连接是全新的，旧 token 对应的 wt 已随旧 server 死掉。
  // 不清会导致 sendFrame 往已关闭的会话写、isReady 给出假阳性。
  for (var t in this.sessions) {
    var s = this.sessions[t];
    if (s.wt) { try { s.wt.close(); } catch (e) {} }
    s.wt = null;
  }
  this.sessions = {}; this.byConn = {};
  this.server = null;
  if (oldServer) { try { oldServer.stopServer(); } catch (e) {} }

  // 稍等让 native 侧释放端口，否则新 server 绑同一端口会失败
  setTimeout(function () {
    var savedPort = self.config.WT_PORT;
    self.config.WT_PORT = curPort;
    // 重建时不要再挂一遍 watch（已经在盯着了）
    var alreadyWatched = self._certWatched;
    self._certWatched = true;
    self.listen(function (err) {
      self._certWatched = alreadyWatched;
      self.config.WT_PORT = savedPort;
      if (err) {
        self.stats.certReloadFail++;
        if (self.hooks.onError) self.hooks.onError(err);
      } else {
        self.stats.certReloads++;
      }
      if (cb) cb(err);
    });
  }, 300);
};

WebTransportEndpoint.prototype.close = function (cb) {
  this._closing = true;
  this.listening = false;
  // 必须先解除 watchFile：它会持有 libuv handle 让**进程无法退出**，
  // 测试里表现为「断言全过但进程挂住」——比断言失败更难查。
  if (this._certWatched) {
    var fs = require('fs');
    try { fs.unwatchFile(this.config.WT_CERT); } catch (e) {}
    try { fs.unwatchFile(this.config.WT_KEY); } catch (e) {}
    this._certWatched = false;
  }
  for (var t in this.sessions) {
    var s = this.sessions[t];
    if (s.wt) { try { s.wt.close(); } catch (e) {} }
  }
  this.sessions = {}; this.byConn = {};
  if (this.server) {
    try { this.server.stopServer(); } catch (e) {}
    this.server = null;
  }
  // stopServer 是同步的，但 native 侧关闭有延迟，给一点时间避免端口占用
  setTimeout(function () { if (cb) cb(); }, 50);
};

WebTransportEndpoint.MAGIC_HELLO = MAGIC_HELLO;
WebTransportEndpoint.MAGIC_HACK = MAGIC_HACK;
WebTransportEndpoint.WT_PATH = WT_PATH;
/**
 * 库 ESM 入口的 file:// URL。
 * 导出供测试复用 —— 测试**不该自己拼一份路径**，否则实现改了路径、
 * 测试仍指着旧的，就变成两套逻辑（layout.test.js 吃过复刻脱钩的亏）。
 */
WebTransportEndpoint.libEntryUrl = function () {
  var entry = path.join(
    __dirname, 'node_modules', '@fails-components', 'webtransport',
    'lib', 'index.node.js'
  );
  return 'file://' + entry.replace(/\\/g, '/');
};
module.exports = WebTransportEndpoint;
