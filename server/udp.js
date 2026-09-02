'use strict';
/**
 * udp.js — 服务器 UDP 端点（v3.1 M1b）
 *
 * 设计见 docs/architecture/02-udp-transport.md §3、§4。
 *
 * 职责边界（**只做传输，不碰游戏逻辑**）：
 *   收包 → 三道校验 → 解出 { connId, frameId, angle, boost } → 交给 Room.handleInput
 *   发包 → 把已编码的二进制帧按 UDP_DUP 份发给指定会话
 * 判定、模拟、房间生命周期一律不变，仍由 room.js 负责。
 *
 * 为什么需要会话表：UDP 无连接，源 IP:Port 在 NAT 重绑定 / 4G↔WiFi 切换时会变，
 * 服务器需要稳定标识才知道包属于哪个玩家。这是**功能需求，不是安全机制**
 * （判定权全在服务器，伪造上行只能让自己的蛇转向，改不了血/分/判定）。
 */
var dgram = require('dgram');
var crypto = require('crypto');
var path = require('path');

var JS = path.join(__dirname, '..', 'js');
require(path.join(JS, 'net', 'binCodec.js'));
require(path.join(JS, 'net', 'binProtocol.js'));
var BP = globalThis.CS.binProtocol;

var MAGIC_INPUT = BP.MAGIC_INPUT;
var MAGIC_HELLO = 0x48;   // 'H' 客户端打洞
var MAGIC_HACK = 0x4B;    // 'K' 服务器回应

/**
 * @param {object} config server/config.js（可覆盖）
 * @param {object} hooks  { onInput(connId, {frameId, angle, boost}) }
 */
function UdpEndpoint(config, hooks) {
  this.config = config;
  this.hooks = hooks || {};
  this.sock = null;
  /** token(number) → session */
  this.sessions = {};
  /** connId → token，便于按连接查会话 */
  this.byConn = {};
  /** 源地址限速：'ip:port' → { count, windowStart } */
  this.rate = {};
  this.stats = { rx: 0, tx: 0, dropMagic: 0, dropToken: 0, dropCrc: 0, dropSeq: 0, dropRate: 0 };
  this._rateTimer = null;
}

/** 生成 32bit 会话令牌（房内唯一即可；仅用于身份识别） */
UdpEndpoint.prototype.createSession = function (connId, roomId) {
  var old = this.byConn[connId];
  if (old != null) delete this.sessions[old];
  var token;
  do { token = crypto.randomBytes(4).readUInt32LE(0); } while (this.sessions[token]);
  this.sessions[token] = {
    token: token, connId: connId, roomId: roomId,
    addr: null, port: 0,          // 打洞后填充
    lastFrameId: -1,              // 上行去重基线
    lastSeen: Date.now(),
    verified: false               // 是否完成 hello 握手
  };
  this.byConn[connId] = token;
  return token;
};

UdpEndpoint.prototype.dropSession = function (connId) {
  var token = this.byConn[connId];
  if (token == null) return;
  delete this.sessions[token];
  delete this.byConn[connId];
};

/** 该连接的 UDP 是否已打通（未打通时上层应走 TCP） */
UdpEndpoint.prototype.isReady = function (connId) {
  var token = this.byConn[connId];
  var s = token != null && this.sessions[token];
  return !!(s && s.verified && s.addr);
};

/**
 * 为某连接准备 UDP 接入信息，随 matched 一并下发。
 * 客户端拿到后向该端口打洞；拿不到（返回 null）就全程走 TCP。
 * @returns {{port:number, token:number}|null}
 */
UdpEndpoint.prototype.offer = function (connId, roomId) {
  if (!this.sock) return null;
  var token = this.createSession(connId, roomId);
  return { port: this.port(), token: token };
};

/**
 * 每源限速：防止有人往端口灌垃圾流量。
 * 正常上行 30Hz × UDP_DUP(3) = 90 包/秒，给 4 倍余量。
 */
UdpEndpoint.prototype._rateOk = function (key) {
  var now = Date.now();
  var r = this.rate[key];
  if (!r || now - r.windowStart >= 1000) {
    this.rate[key] = { count: 1, windowStart: now };
    return true;
  }
  r.count++;
  return r.count <= (this.config.UDP_RATE_LIMIT || 400);
};

/**
 * 上行 frameId 去重。
 *
 * 规则与 room.js:handleInput 的 seq 语义**保持一致**（只是换了传输层）：
 *   - 超前跳变过大 → 异常，丢弃
 *   - 小幅回退      → 网络乱序，丢弃（后续更新的包会补上）
 *   - 大幅回退      → 客户端重新计数（重连/重开），接受并重置基线
 *
 * 最后一条是既有教训：客户端重连后计数归零而服务器基线停在旧值，
 * 会导致该玩家输入**永久**失效（表现为「怎么划都不动」且无法自行恢复）。
 * @returns {boolean} 是否采纳
 */
UdpEndpoint.prototype._acceptFrame = function (s, frameId) {
  var last = s.lastFrameId;
  if (last < 0) { s.lastFrameId = frameId; return true; }
  var jump = this.config.INPUT_MAX_SEQ_JUMP || 1000;
  var resetGap = this.config.INPUT_SEQ_RESET_GAP || 64;
  if (frameId > last + jump) return false;               // 异常跳变
  if (frameId < last) {
    if (last - frameId < resetGap) return false;         // 小幅乱序：丢弃
    s.lastFrameId = frameId;                             // 大幅回退：重新计数
    return true;
  }
  if (frameId === last) return false;                    // 重复副本（冗余的正常情况）
  s.lastFrameId = frameId;
  return true;
};

UdpEndpoint.prototype._onMessage = function (buf, rinfo) {
  this.stats.rx++;
  var key = rinfo.address + ':' + rinfo.port;
  if (!this._rateOk(key)) { this.stats.dropRate++; return; }
  if (!buf || buf.length < 6) { this.stats.dropMagic++; return; }

  var magic = buf[0];

  // ---- 打洞握手：magic1 + token4 + crc16 = 7 字节 ----
  if (magic === MAGIC_HELLO) {
    if (buf.length !== 7) { this.stats.dropMagic++; return; }
    var u8h = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    var B = globalThis.CS.bin;
    if (new B.BinReader(u8h).checkCrc16() !== true) { this.stats.dropCrc++; return; }
    var tk = buf.readUInt32LE(1);
    var sh = this.sessions[tk];
    if (!sh) { this.stats.dropToken++; return; }
    sh.addr = rinfo.address;
    sh.port = rinfo.port;
    sh.verified = true;
    sh.lastSeen = Date.now();
    // 回 ack，客户端据此判定 UDP 可用
    var w = new B.BinWriter(8);
    w.u8(MAGIC_HACK); w.u32(tk); w.finishCrc16();
    this._sendRaw(Buffer.from(w.bytes()), rinfo.address, rinfo.port);
    return;
  }

  // ---- keepalive：magic1 + token4 + crc16，magic 复用 HELLO，无需额外类型 ----

  // ---- 上行输入 Fragment ----
  if (magic !== MAGIC_INPUT) { this.stats.dropMagic++; return; }
  var u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  var frag = BP.decInputFrag(u8);
  if (!frag) { this.stats.dropCrc++; return; }
  var s = this.sessions[frag.token];
  if (!s) { this.stats.dropToken++; return; }

  // 地址跟随：NAT 重绑定 / 网络切换后源地址会变，以最新合法包为准
  if (s.addr !== rinfo.address || s.port !== rinfo.port) {
    s.addr = rinfo.address;
    s.port = rinfo.port;
  }
  s.verified = true;
  s.lastSeen = Date.now();

  if (!this._acceptFrame(s, frag.frameId)) { this.stats.dropSeq++; return; }
  if (this.hooks.onInput) {
    this.hooks.onInput(s.connId, { frameId: frag.frameId, angle: frag.angle, boost: frag.boost });
  }
};

UdpEndpoint.prototype._sendRaw = function (buf, addr, port) {
  if (!this.sock || !addr) return;
  try { this.sock.send(buf, port, addr); this.stats.tx++; } catch (e) { /* 忽略瞬时错误 */ }
};

/**
 * 向某连接发送一帧（按 UDP_DUP 份冗余，**帧内时间打散**）。
 *
 * 打散是必须的：丢包按时间段发生（基站切换/缓冲溢出，窗口 20~100ms），
 * 同一毫秒连发的副本在窗口内**同生共死**。3000 帧实测「x3 同时发」与「x1」
 * 结果完全相同；打散后短窗口场景从 7.90% 降到 0.23%。
 *
 * @param {string} connId
 * @param {Uint8Array} bytes 已编码的帧
 */
UdpEndpoint.prototype.sendFrame = function (connId, bytes) {
  var token = this.byConn[connId];
  var s = token != null && this.sessions[token];
  if (!s || !s.verified || !s.addr) return false;
  var dup = this.config.UDP_DUP || 3;
  var interval = (this.config.TICK_MS || 33) * (this.config.SNAP_EVERY || 1);
  var buf = Buffer.from(bytes);
  this._sendRaw(buf, s.addr, s.port);
  if (dup <= 1) return true;

  // 后续副本按 interval/dup 均分延迟。
  // 注意 Node 的 setTimeout 系统性偏慢（实测目标 22ms 实际 33ms），
  // 若不钳制，末份可能落到下一帧之后 —— 那就不再是「本帧的冗余」而是纯浪费带宽。
  // 因此按 dup 均分后再留 20% 余量，保证全部副本落在本帧窗口内。
  var span = interval * 0.8;
  var self = this;
  var addr = s.addr, port = s.port;
  for (var i = 1; i < dup; i++) {
    var delay = Math.max(1, Math.round(span / dup * i));
    var tm = setTimeout(function () {
      // 发送时重新取当前地址：期间可能发生 NAT 重绑定
      var cur = self.sessions[token];
      self._sendRaw(buf, cur ? cur.addr : addr, cur ? cur.port : port);
    }, delay);
    if (tm.unref) tm.unref();   // 不阻止进程退出
  }
  return true;
};

/** 清理超时会话（NAT 映射失效 / 客户端消失） */
UdpEndpoint.prototype._sweep = function () {
  var now = Date.now();
  var ttl = this.config.UDP_SESSION_TTL_MS || 60000;
  for (var t in this.sessions) {
    var s = this.sessions[t];
    if (now - s.lastSeen > ttl) {
      delete this.byConn[s.connId];
      delete this.sessions[t];
    }
  }
  this.rate = {};   // 限速窗口整体重置，避免无限增长
};

UdpEndpoint.prototype.listen = function (cb) {
  var self = this;
  this.sock = dgram.createSocket({ type: 'udp4', recvBufferSize: 1 << 20 });
  this.sock.on('message', function (buf, rinfo) {
    try { self._onMessage(buf, rinfo); } catch (e) { /* 单包异常不得影响服务 */ }
  });
  this.sock.on('error', function () { /* 忽略：UDP 错误不应终止进程 */ });
  this._rateTimer = setInterval(function () { self._sweep(); }, 10000);
  if (this._rateTimer.unref) this._rateTimer.unref();
  // 注意用 != null 而非 ||：UDP_PORT=0 是「随机空闲端口」的合法值（测试用），
  // 写成 `|| 8091` 会把 0 吞掉，导致并发测试抢占同一端口。
  var bindPort = this.config.UDP_PORT != null ? this.config.UDP_PORT : 8092;
  this.sock.bind(bindPort, this.config.HOST, function () {
    if (cb) cb();
  });
};

UdpEndpoint.prototype.port = function () {
  return this.sock ? this.sock.address().port : 0;
};

UdpEndpoint.prototype.close = function (cb) {
  if (this._rateTimer) { clearInterval(this._rateTimer); this._rateTimer = null; }
  this.sessions = {}; this.byConn = {}; this.rate = {};
  if (this.sock) {
    try { this.sock.close(cb); } catch (e) { if (cb) cb(); }
    this.sock = null;
  } else if (cb) cb();
};

UdpEndpoint.MAGIC_HELLO = MAGIC_HELLO;
UdpEndpoint.MAGIC_HACK = MAGIC_HACK;
module.exports = UdpEndpoint;
