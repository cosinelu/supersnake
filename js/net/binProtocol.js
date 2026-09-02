'use strict';
/**
 * binProtocol.js — snap / input 的二进制编解码（v3.1 M1a）
 *
 * 设计见 docs/architecture/02-udp-transport.md §2、§3。
 *
 * 核心约定（**解码结果与 JSON 路径同构**）：
 *   decSnapBin() 产出的对象与 protocol.decode() 解析 JSON snap 后的结构一致，
 *   因此 netMatch / onlineMatch / renderer 全部零改动，两条通道可随时互换。
 *
 * 节心编码的关键取舍：不传坐标，只传**每节相对上一节的方向角**（uint8），
 * 长度用 cfg.SEG_SPACING 重建。依据是实测相邻节心间距恒定在 25.92~30.00px
 * （SEG_SPACING=30，急转时弦长压缩到 26），累积误差平均 1.38px / 最大 3.68px，
 * 均远小于 SEG_RADIUS(13)，肉眼不可见。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var B = CS.bin;
  var cfg = CS.config;

  var MAGIC_SNAP = 0x53;  // 'S'
  var MAGIC_INPUT = 0x49; // 'I'
  var BIN_VER = 1;

  // flags 位定义
  var F_ALIVE = 1;
  var F_PLAYER = 2;
  var F_LITE = 4;      // 精简档：只有头部，segCount=0
  var F_BITTEN = 8;
  var F_SLOW = 16;

  // 颜色 4bit 编码（8 种基础色 + wild，留 6 个空位）
  var COLOR_IDX = ['red', 'blue', 'green', 'orange', 'purple', 'yellow', 'teal', 'pink', 'wild'];
  var COLOR_MAP = {};
  (function () { for (var i = 0; i < COLOR_IDX.length; i++) COLOR_MAP[COLOR_IDX[i]] = i; })();
  function cIdx(c) { var v = COLOR_MAP[c]; return v == null ? 0 : v; }
  function cName(i) { return COLOR_IDX[i] || 'red'; }

  /**
   * 绝对锚点间隔（节）。
   *
   * 为什么必须有：节心用「相对上一节的方向角 + 间距」重建时，量化误差会沿链
   * **单调累积**。实测无锚点时：25 节尾部 5.4px → 45 节 51.3px → 71 节 838px
   * （**整条蛇散架**）。
   *
   * 取值 16 是参数扫描（锚点 4/6/8/12/16 × 间距策略 5 种，共 25 组配置）的结果：
   * 在「最大误差 ≤4px」的全部可行解里体积最小。
   */
  var ANCHOR_EVERY = 16;

  /**
   * 节间距编码：**只对偏离稳态的节单独记录**（异常表，不占常规字节）。
   *
   * 实测稳态间距恒定在 25.92~30.00px（SEG_SPACING=30，急转时弦长压缩到 26）。
   * 为什么不能省掉间距：出生瞬间 / 轨迹弧长不足时尾部节心会重叠（间距 0），
   * 若一律按 SEG_SPACING 外推会把尾巴甩出几百像素（实测 450px）。
   *
   * DIST_EPS 是精度与体积的直接权衡（同为参数扫描结果，ANCHOR_EVERY=16 下）：
   *   EPS=1.0 → 73 字节/25节，误差 3.94px  ← 采用
   *   EPS=1.5 → 68 字节，误差 4.92px（超出 SEG_RADIUS/2，蛇身看得出歪）
   *   EPS=3.0 → 59 字节，误差 14.75px（明显散架）
   *
   * 编码放在角度序列之后作为独立的「异常表」，而不是借用角度的 bit0 ——
   * 借 bit0 会让角度精度从 1.4° 降到 2.8°，实测误差从 1.76px 涨到 5.54px。
   */
  var DIST_EPS = 1.0;
  function distIdx(d) {
    var q = Math.round(d * 2);
    return q < 0 ? 0 : (q > 255 ? 255 : q);
  }
  function distVal(q) { return (q & 255) / 2; }

  // ---------------- 下行 snap ----------------

  /**
   * 编码一条蛇。
   * @param {object} e Entry：{ id, isPlayer, alive, bittenUntil, slowUntil, snake }
   * @param {BinWriter} w
   * @param {boolean} lite 精简档（只发头部，用于视野外的蛇；小地图仍能显示）
   * @param {number} nowMs 当前对局时间（判定 bitten/slow 是否生效）
   */
  function encSnake(w, e, lite, nowMs) {
    var s = e.snake;
    // segCount 以 colors 为准；segPos 恒为 colors.length + 1（含尾巴节）
    var n = lite ? 0 : Math.min(255, s.colors.length);
    var fl = 0;
    if (e.alive) fl |= F_ALIVE;
    if (e.isPlayer) fl |= F_PLAYER;
    if (lite) fl |= F_LITE;
    if (e.bittenUntil > nowMs) fl |= F_BITTEN;
    if (e.slowUntil > nowMs) fl |= F_SLOW;

    w.u8(e.id & 0xFF);
    w.u8(fl);
    w.u16(B.qCoord16(s.x));
    w.u16(B.qCoord16(s.y));
    w.u8(B.qAngle8(s.angle));
    w.u8(Math.min(255, Math.round(s.speed / 4)));  // 4px/s 精度，覆盖 0~1020
    w.u8(n);
    if (n === 0) return;

    // 每节：角度 uint8（完整 2π/256 = 1.4° 精度）。
    // 间距偏离 SEG_SPACING 超过 DIST_EPS 的节，其编号与间距值追加在角度序列之后
    // （实测仅 0.5% 的节命中，见 DIST_EPS 注释）。
    // 每 ANCHOR_EVERY 节插一个绝对坐标锚点，阻断量化误差沿链累积
    // （无锚点时 71 节尾部误差达 838px，整条蛇散架）。
    var SP = cfg.SEG_SPACING;
    var exIdx = [], exVal = [];
    for (var i = 1; i <= n && i < s.segPos.length; i++) {
      var dx = s.segPos[i].x - s.segPos[i - 1].x;
      var dy = s.segPos[i].y - s.segPos[i - 1].y;
      var d = Math.sqrt(dx * dx + dy * dy);
      w.u8(B.qAngle8(Math.atan2(dy, dx)));
      if (Math.abs(d - SP) > DIST_EPS) { exIdx.push(i); exVal.push(distIdx(d)); }
      if (i % ANCHOR_EVERY === 0) {
        w.u16(B.qCoord16(s.segPos[i].x));
        w.u16(B.qCoord16(s.segPos[i].y));
      }
    }
    // segPos 不足 n 时补齐（防御：理论上不会发生）
    for (; i <= n; i++) {
      w.u8(0);
      if (i % ANCHOR_EVERY === 0) { w.u16(0); w.u16(0); }
    }
    // 异常间距表：count + [节号, 间距] × count
    w.u8(Math.min(255, exIdx.length));
    for (i = 0; i < exIdx.length && i < 255; i++) { w.u8(exIdx[i]); w.u8(exVal[i]); }

    // 颜色：4bit/节，两节一字节（高位在前）
    for (i = 0; i < n; i += 2) {
      var hi = cIdx(s.colors[i]);
      var lo = (i + 1 < n) ? cIdx(s.colors[i + 1]) : 0;
      w.u8((hi << 4) | lo);
    }
  }

  /** 解码一条蛇，产出与 deSnake() 同构的对象（name/计分走低频通道，此处留空） */
  function decSnake(r) {
    var id = r.u8();
    var fl = r.u8();
    var x = r.u16();
    var y = r.u16();
    var angle = B.dqAngle8(r.u8());
    var speed = r.u8() * 4;
    var n = r.u8();

    var segPos = [{ x: x, y: y }];
    var colors = [];
    if (n > 0) {
      var SP = cfg.SEG_SPACING;
      var angs = [], anchors = {};
      for (var i = 1; i <= n; i++) {
        angs.push(B.dqAngle8(r.u8()));
        if (i % ANCHOR_EVERY === 0) anchors[i] = { x: r.u16(), y: r.u16() };
      }
      // 异常间距表
      var exN = r.u8(), dists = {};
      for (i = 0; i < exN; i++) { var ei = r.u8(); dists[ei] = distVal(r.u8()); }
      // 重建
      var px = x, py = y;
      for (i = 1; i <= n; i++) {
        var d = (dists[i] != null) ? dists[i] : SP;
        px += Math.cos(angs[i - 1]) * d;
        py += Math.sin(angs[i - 1]) * d;
        var an = anchors[i];
        if (an) { px = an.x; py = an.y; }   // 锚点：绝对坐标覆盖，清零累积误差
        segPos.push({ x: px, y: py });
      }
      for (i = 0; i < n; i += 2) {
        var b = r.u8();
        colors.push(cName((b >> 4) & 0x0F));
        if (i + 1 < n) colors.push(cName(b & 0x0F));
      }
    }
    return {
      id: id, name: null, isPlayer: !!(fl & F_PLAYER), alive: !!(fl & F_ALIVE),
      lite: !!(fl & F_LITE),
      x: x, y: y, angle: angle, speed: speed,
      colors: colors, segPos: segPos,
      // 以下由低频 meta 通道补齐；解码层给 0 占位，消费方按 meta 覆盖
      kills: 0, elimScore: 0, elimTotal: 0, maxLen: n,
      survivalScore: 0, mpBonusScore: 0,
      bitten: !!(fl & F_BITTEN), slow: !!(fl & F_SLOW),
      bittenUntil: 0, slowUntil: 0
    };
  }

  /**
   * 编码一帧 snap。
   * @param {object} o { tick, ack, timeMs, entries:[{e, lite}], blockAdd:[], blockDel:[] }
   * @returns {Uint8Array}
   */
  function encSnapBin(o) {
    var w = new B.BinWriter(1024);
    w.u8(MAGIC_SNAP);
    w.u8(BIN_VER);
    w.u16(o.tick & 0xFFFF);
    w.u16(o.ack & 0xFFFF);
    w.u16(Math.min(65535, Math.round((o.timeMs || 0) / 100))); // 0.1s 精度，覆盖 109 分钟
    var ents = o.entries || [];
    w.u8(Math.min(255, ents.length));
    for (var i = 0; i < ents.length && i < 255; i++) {
      encSnake(w, ents[i].e, !!ents[i].lite, o.timeMs || 0);
    }
    // 色块增量：add 列表 + del 列表
    var add = o.blockAdd || [], del = o.blockDel || [];
    w.u8(Math.min(255, add.length));
    for (i = 0; i < add.length && i < 255; i++) {
      var b = add[i];
      w.u16(b.bid & 0xFFFF);
      w.u16(B.qCoord16(b.x));
      w.u16(B.qCoord16(b.y));
      w.u8(cIdx(b.color));
    }
    w.u8(Math.min(255, del.length));
    for (i = 0; i < del.length && i < 255; i++) w.u16(del[i] & 0xFFFF);
    w.finishCrc16();
    return w.bytes();
  }

  /**
   * 解码一帧 snap。任何校验失败返回 null（UDP 上会收到畸形/截断包，必须容错）。
   * @param {Uint8Array} u8
   */
  function decSnapBin(u8) {
    if (!u8 || u8.length < 12) return null;
    var r = new B.BinReader(u8);
    if (!r.checkCrc16()) return null;
    if (r.u8() !== MAGIC_SNAP) return null;
    if (r.u8() !== BIN_VER) return null;
    var tick = r.u16();
    var ack = r.u16();
    var timeMs = r.u16() * 100;
    var nS = r.u8();
    var sn = [];
    for (var i = 0; i < nS; i++) {
      var s = decSnake(r);
      if (r.overflow) return null;
      sn.push(s);
    }
    var nAdd = r.u8();
    var add = [];
    for (i = 0; i < nAdd; i++) {
      add.push({ bid: r.u16(), x: r.u16(), y: r.u16(), color: cName(r.u8()), kind: 'color' });
    }
    var nDel = r.u8();
    var del = [];
    for (i = 0; i < nDel; i++) del.push(r.u16());
    if (r.overflow) return null;
    return { t: 'snap', tk: tick, ack: ack, tm: timeMs, sn: sn, blockAdd: add, blockDel: del };
  }

  // ---------------- 上行 input Fragment（12 字节） ----------------

  /**
   * magic1 + token4 + frameId2 + angle2 + flags1 + crc16(2) = 12 字节
   * @returns {Uint8Array}
   */
  function encInputFrag(token, frameId, angle, boost) {
    var w = new B.BinWriter(12);
    w.u8(MAGIC_INPUT);
    w.u32(token >>> 0);
    w.u16(frameId & 0xFFFF);
    w.u16(B.qAngle16(angle));
    w.u8(boost ? 1 : 0);
    w.finishCrc16();
    return w.bytes();
  }

  /** 解码上行 Fragment，校验失败返回 null */
  function decInputFrag(u8) {
    if (!u8 || u8.length !== 12) return null;
    var r = new B.BinReader(u8);
    if (!r.checkCrc16()) return null;
    if (r.u8() !== MAGIC_INPUT) return null;
    var token = r.u32();
    var frameId = r.u16();
    var angle = B.dqAngle16(r.u16());
    var flags = r.u8();
    if (r.overflow || !isFinite(angle)) return null;
    return { token: token, frameId: frameId, angle: angle, boost: (flags & 1) ? 1 : 0 };
  }

  /**
   * 组包并保证**永不触发 IP 分片**（架构文档 §2.6 硬约束）。
   *
   * 这是整个 UDP 方案的最后防线：一旦单包超过 MTU 被切成 N 片，
   * 内核重组要求全部分片到齐，缺一片则整组丢弃 ——
   * 单片丢 2% 会放大成整帧报废 24.6%（14 片时），比 TCP 还糟。
   *
   * 策略：先全完整档；超限则**从最远的蛇开始降级为 lite**（只发头部，
   * 小地图仍可用），直到满足预算。本机玩家（entries[0]）永远保持完整档。
   *
   * @param {object} o 同 encSnapBin 的入参，entries 需按「与本机距离升序」排列
   * @param {number} [cap=1400] 字节预算
   * @returns {{ bytes:Uint8Array, degraded:number }} degraded = 被降级的蛇数（>0 应打点告警）
   */
  function encSnapCapped(o, cap) {
    var limit = cap || 1400;
    var ents = (o.entries || []).map(function (x) { return { e: x.e, lite: !!x.lite }; });
    var out = encSnapBin({
      tick: o.tick, ack: o.ack, timeMs: o.timeMs, entries: ents,
      blockAdd: o.blockAdd, blockDel: o.blockDel
    });
    var degraded = 0;
    var i = ents.length - 1;
    while (out.length > limit && i > 0) {          // i > 0：绝不降级本机玩家
      if (!ents[i].lite) { ents[i].lite = true; degraded++; }
      i--;
      out = encSnapBin({
        tick: o.tick, ack: o.ack, timeMs: o.timeMs, entries: ents,
        blockAdd: o.blockAdd, blockDel: o.blockDel
      });
    }
    return { bytes: out, degraded: degraded, overflow: out.length > limit };
  }

  CS.binProtocol = {
    MAGIC_SNAP: MAGIC_SNAP, MAGIC_INPUT: MAGIC_INPUT, BIN_VER: BIN_VER,
    F_ALIVE: F_ALIVE, F_PLAYER: F_PLAYER, F_LITE: F_LITE,
    F_BITTEN: F_BITTEN, F_SLOW: F_SLOW,
    encSnapBin: encSnapBin, decSnapBin: decSnapBin,
    encSnapCapped: encSnapCapped,
    encInputFrag: encInputFrag, decInputFrag: decInputFrag,
    ANCHOR_EVERY: ANCHOR_EVERY, DIST_EPS: DIST_EPS,
    cIdx: cIdx, cName: cName
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CS.binProtocol;
})(typeof window !== 'undefined' ? window : globalThis);
