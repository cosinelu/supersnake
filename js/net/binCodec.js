'use strict';
/**
 * binCodec.js — 二进制读写器 + 量化工具 + CRC16（v3.1 M1a）
 *
 * 设计见 docs/architecture/02-udp-transport.md §2、§3。
 *
 * 为什么要它：现状 JSON 快照最坏 19662 字节，UDP 发出会被切成 14 个 IP 分片，
 * 而 IP 分片重组在内核完成，缺任一片则整组丢弃（应用层连残片都收不到）——
 * 单片丢 2% 会放大成整帧报废 24.6%，比 TCP 还糟。
 * 二进制编码把同样内容压到 632 字节（31x），压进单个 datagram（≤1472B），
 * 丢包率不再被分片放大。
 *
 * 平台约束（重要）：
 *   **不使用 Node 的 Buffer** —— 微信小游戏环境没有该对象。
 *   统一用 Uint8Array + DataView，浏览器 / 小游戏 / node 三端通用。
 */
(function (root) {
  var CS = root.CS = root.CS || {};

  var TWO_PI = Math.PI * 2;

  // ---------------- 量化 ----------------
  //
  // 精度取舍已实测验证（架构文档 §7.2）：
  //   坐标 uint16 1px  → 蛇节半径 13px，无感
  //   角度 uint8 1.4°  → TURN_RATE 下单帧转向远大于此
  //   节心方向角 uint8 → 累积误差平均 1.38px / 最大 3.68px，均 < SEG_RADIUS/3

  /** 世界坐标 → uint16（1px 精度；地图 4200x2800 < 65535） */
  function qCoord16(v) {
    var n = Math.round(v);
    return n < 0 ? 0 : (n > 65535 ? 65535 : n);
  }

  /** 角度 → uint8（2π/256 ≈ 1.4°）。输入任意实数，先归一到 [0,2π) */
  function qAngle8(a) {
    var n = a % TWO_PI;
    if (n < 0) n += TWO_PI;
    var q = Math.round(n / TWO_PI * 256);
    return q >= 256 ? 0 : q;   // 256 环回到 0（正好一整圈）
  }
  /** uint8 → 角度，返回 [0,2π) */
  function dqAngle8(q) { return (q & 0xFF) / 256 * TWO_PI; }

  /** 角度 → uint16（2π/65536 ≈ 0.0055°，上行用，精度远超需要） */
  function qAngle16(a) {
    var n = a % TWO_PI;
    if (n < 0) n += TWO_PI;
    var q = Math.round(n / TWO_PI * 65536);
    return q >= 65536 ? 0 : q;
  }
  /** uint16 → 角度，返回 [0,2π) */
  function dqAngle16(q) { return (q & 0xFFFF) / 65536 * TWO_PI; }

  // ---------------- CRC16 (CCITT-FALSE, 表驱动) ----------------
  //
  // 目的是**防损坏**（中间设备篡改 / UDP checksum 漏检的残留错误），
  // **不是安全机制** —— 攻击者同样能算出正确 CRC。见架构文档 §3.5。
  var CRC_TABLE = (function () {
    var t = new Uint16Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n << 8;
      for (var k = 0; k < 8; k++) {
        c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
      }
      t[n] = c;
    }
    return t;
  })();

  /**
   * 计算 CRC16。
   * @param {Uint8Array} u8
   * @param {number} [from=0] 起始下标
   * @param {number} [to=u8.length] 结束下标（不含）
   */
  function crc16(u8, from, to) {
    var c = 0xFFFF;
    var i = from == null ? 0 : from;
    var end = to == null ? u8.length : to;
    for (; i < end; i++) {
      c = ((c << 8) ^ CRC_TABLE[((c >> 8) ^ u8[i]) & 0xFF]) & 0xFFFF;
    }
    return c;
  }

  // ---------------- BinWriter ----------------

  /**
   * 顺序写入器。容量不足时自动扩容（2 倍），最终用 bytes() 取出精确长度的视图。
   * @param {number} [cap=256] 初始容量
   */
  function BinWriter(cap) {
    this.buf = new Uint8Array(cap || 256);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  BinWriter.prototype._need = function (n) {
    if (this.pos + n <= this.buf.length) return;
    var cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf);
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  };

  BinWriter.prototype.u8 = function (v) {
    this._need(1);
    this.buf[this.pos++] = v & 0xFF;
    return this;
  };
  BinWriter.prototype.i8 = function (v) {
    this._need(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
    return this;
  };
  BinWriter.prototype.u16 = function (v) {
    this._need(2);
    this.view.setUint16(this.pos, v & 0xFFFF, true); // little-endian
    this.pos += 2;
    return this;
  };
  BinWriter.prototype.i16 = function (v) {
    this._need(2);
    var n = Math.round(v || 0);
    if (n < -32768) n = -32768;
    if (n > 32767) n = 32767;
    this.view.setInt16(this.pos, n, true);
    this.pos += 2;
    return this;
  };
  BinWriter.prototype.u32 = function (v) {
    this._need(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  };

  /** 当前已写字节数 */
  BinWriter.prototype.length = function () { return this.pos; };

  /** 取出结果（**共享底层内存的子视图**，调用方不要再写 writer） */
  BinWriter.prototype.bytes = function () {
    return this.buf.subarray(0, this.pos);
  };

  /** 取出结果的独立拷贝（需要跨帧持有时用，避免被后续写入污染） */
  BinWriter.prototype.copy = function () {
    return this.buf.slice(0, this.pos);
  };

  /**
   * 在末尾追加 CRC16（覆盖从 0 到当前位置的全部内容）。
   * 校验时对「除末尾 2 字节外的全部内容」重算比对。
   */
  BinWriter.prototype.finishCrc16 = function () {
    var c = crc16(this.buf, 0, this.pos);
    return this.u16(c);
  };

  // ---------------- BinReader ----------------

  /**
   * 顺序读取器。越界读取返回 0 并置 `overflow` 标志——
   * 调用方**必须检查 overflow**，因为 UDP 上可能收到任意畸形/截断的包。
   * @param {Uint8Array} u8
   */
  function BinReader(u8) {
    this.buf = u8;
    this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = 0;
    this.overflow = false;
  }

  BinReader.prototype._ok = function (n) {
    if (this.pos + n > this.buf.length) { this.overflow = true; return false; }
    return true;
  };

  BinReader.prototype.u8 = function () {
    if (!this._ok(1)) return 0;
    return this.buf[this.pos++];
  };
  BinReader.prototype.i8 = function () {
    if (!this._ok(1)) return 0;
    var v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  };
  BinReader.prototype.u16 = function () {
    if (!this._ok(2)) return 0;
    var v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  };
  BinReader.prototype.i16 = function () {
    if (!this._ok(2)) return 0;
    var v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  };
  BinReader.prototype.u32 = function () {
    if (!this._ok(4)) return 0;
    var v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  };

  /** 剩余未读字节数 */
  BinReader.prototype.remain = function () { return this.buf.length - this.pos; };

  /**
   * 校验末尾 2 字节的 CRC16 是否与前面内容匹配。
   * 通过时把 buf 逻辑长度收缩到不含 CRC（后续 remain() 不会把 CRC 算进去）。
   * @returns {boolean}
   */
  BinReader.prototype.checkCrc16 = function () {
    var n = this.buf.length;
    if (n < 3) return false;
    var want = this.view.getUint16(n - 2, true);
    return crc16(this.buf, 0, n - 2) === want;
  };

  CS.bin = {
    BinWriter: BinWriter,
    BinReader: BinReader,
    crc16: crc16,
    qCoord16: qCoord16,
    qAngle8: qAngle8, dqAngle8: dqAngle8,
    qAngle16: qAngle16, dqAngle16: dqAngle16,
    TWO_PI: TWO_PI
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CS.bin;
})(typeof window !== 'undefined' ? window : globalThis);
