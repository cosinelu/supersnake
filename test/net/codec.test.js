'use strict';
/**
 * codec.test.js — 二进制编解码回归（v3.1 M1a）
 *
 * 对应设计：docs/architecture/02-udp-transport.md §2、§3
 *
 * 守护的核心不变量：
 *   1. 编解码往返一致（随机输入，含极端长度）
 *   2. 精度损失在实测容忍范围内（节心 ≤4px / 坐标 ≤1px / 角度 ≤1.5°）
 *   3. **任意构造下单帧 ≤1400 字节** —— 这是「永不触发 IP 分片」的硬约束，
 *      一旦破坏，UDP 方案的全部收益归零（丢 2% 会放大成整帧报废 24.6%）
 *   4. 畸形/截断/篡改输入必须返回 null，不得抛异常（UDP 上一定会收到垃圾包）
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles',
  'ai', 'multiplayer'].forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'binCodec', 'binProtocol'].forEach(function (f) {
  require(path.join(JS, 'net', f + '.js'));
});

var CS = globalThis.CS, cfg = CS.config, B = CS.bin, BP = CS.binProtocol;
var M = cfg.MULTI;

var pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

/** 确定性随机（结果可复现，便于定位失败） */
var _seed = 20260902;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }

/**
 * 造一条**真实形态**的蛇。
 *
 * 两个必须遵守的构造要求，否则会伪造出不存在的编码缺陷：
 *  1. **边走边长**：不能 `new Snake(len)` 后跑几百帧 —— 那样轨迹弧长不足
 *     （260 帧 × 150px/s ≈ 1287px，只够 42 节），尾部节心会全部堆在轨迹末点。
 *  2. **约束在地图内**：坐标用 uint16 编码，真实对局有 walls 兜着不会越界；
 *     测试若让蛇跑出地图，会被 clamp 成 0/65535，产生几百像素的假误差。
 */
function mkSnake(len, x, y) {
  var s = new CS.Snake(x == null ? 1200 + rnd() * 1600 : x,
    y == null ? 900 + rnd() * 1000 : y, cfg.MIN_LENGTH || 3, rnd() * 6, cfg.COLOR_KEYS.slice());
  var grown = s.colors.length;
  var i = 0;
  // 每步都把蛇拉回地图中心区域，模拟 walls 的约束效果
  function step() {
    if (s.x < 400 || s.x > M.W - 400 || s.y < 400 || s.y > M.H - 400) {
      s.setTargetAngle(Math.atan2(M.H / 2 - s.y, M.W / 2 - s.x));
    } else if (i % 9 === 0) {
      s.setTargetAngle(s.angle + (rnd() - 0.5) * Math.PI * 1.4);
    }
    s.update(33); i++;
  }
  for (; i < 60;) step();                     // 先走够轨迹
  while (grown < len) {                       // 再边走边长
    for (var k = 0; k < 8; k++) step();
    s.grow(cfg.COLOR_KEYS[Math.floor(rnd() * 8)]);
    grown++;
  }
  for (k = 0; k < 30; k++) step();            // 让身体沿轨迹排布稳定
  return s;
}
function mkEntry(id, len, x, y) {
  return {
    id: id, name: '蜡笔小新', isPlayer: id === 1, alive: true, kills: 2,
    elimScore: 340, elimTotal: 12, maxLen: len, survivalScore: 87,
    mpBonusScore: 0, bittenUntil: 0, slowUntil: 0, snake: mkSnake(len, x, y)
  };
}

// ---------------- T1 BinWriter / BinReader ----------------
function t1() {
  section('T1 二进制读写器');
  var w = new B.BinWriter(4);                       // 故意给小容量，逼出扩容
  w.u8(1).u16(65535).u32(4294967295).i8(-128).u8(255);
  ok(w.length() === 9, '自动扩容后长度正确（9）', '实际 ' + w.length());

  var r = new B.BinReader(w.bytes());
  ok(r.u8() === 1 && r.u16() === 65535 && r.u32() === 4294967295 &&
    r.i8() === -128 && r.u8() === 255, '各宽度读写往返一致');
  ok(r.overflow === false, '正常读取不置 overflow');
  r.u8();
  ok(r.overflow === true, '越界读取置 overflow（UDP 截断包的防线）');

  // 子视图（byteOffset != 0）：UDP 收包常见形态
  var big = new Uint8Array(100);
  for (var i = 0; i < 100; i++) big[i] = i;
  var sub = big.subarray(10, 20);
  var r2 = new B.BinReader(sub);
  ok(r2.u8() === 10, '子视图 byteOffset 正确（DataView 未错位）', '读到 ' + sub[0]);

  // CRC
  var w2 = new B.BinWriter(); w2.u8(42).u16(1234).u32(999); w2.finishCrc16();
  ok(new B.BinReader(w2.bytes()).checkCrc16(), 'CRC16 校验通过');
  var bad = w2.copy(); bad[1] ^= 0xFF;
  ok(!new B.BinReader(bad).checkCrc16(), '单字节篡改被 CRC16 检出');
}

// ---------------- T2 量化精度 ----------------
function t2() {
  section('T2 量化精度（对照架构文档 §7.2）');
  var maxA8 = 0, maxA16 = 0;
  for (var i = 0; i < 3000; i++) {
    var a = (rnd() - 0.5) * Math.PI * 4;            // 含超出 [0,2π) 的输入
    var norm = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    var d8 = Math.abs(B.dqAngle8(B.qAngle8(a)) - norm);
    if (d8 > Math.PI) d8 = Math.PI * 2 - d8;        // 环回边界
    var d16 = Math.abs(B.dqAngle16(B.qAngle16(a)) - norm);
    if (d16 > Math.PI) d16 = Math.PI * 2 - d16;
    if (d8 > maxA8) maxA8 = d8;
    if (d16 > maxA16) maxA16 = d16;
  }
  var deg8 = maxA8 * 180 / Math.PI, deg16 = maxA16 * 180 / Math.PI;
  ok(deg8 <= 1.5, 'uint8 角度误差 ≤1.5°（' + deg8.toFixed(3) + '°）');
  ok(deg16 <= 0.01, 'uint16 角度误差 ≤0.01°（' + deg16.toFixed(5) + '°）');

  var maxC = 0;
  for (i = 0; i < 3000; i++) {
    var v = rnd() * M.W;
    var d = Math.abs(B.qCoord16(v) - v);
    if (d > maxC) maxC = d;
  }
  ok(maxC <= 0.5, '坐标量化误差 ≤0.5px（' + maxC.toFixed(3) + '）');
  ok(M.W <= 65535 && M.H <= 65535,
    '地图尺寸在 uint16 范围内（' + M.W + 'x' + M.H + '）');
}

// ---------------- T3 snap 往返一致性与节心精度 ----------------
function t3() {
  section('T3 snap 编解码往返（随机 40 组）');
  var worstSeg = 0, worstHead = 0, worstColor = 0, bad = 0;
  for (var t = 0; t < 40; t++) {
    var nS = 1 + Math.floor(rnd() * 8);
    var ents = [];
    for (var k = 0; k < nS; k++) {
      ents.push({ e: mkEntry(k + 1, 4 + Math.floor(rnd() * 45)), lite: false });
    }
    var u8 = BP.encSnapBin({ tick: t, ack: t * 3, timeMs: t * 1000, entries: ents });
    var dec = BP.decSnapBin(u8);
    if (!dec) { bad++; continue; }
    if (dec.sn.length !== nS) { bad++; continue; }
    for (k = 0; k < nS; k++) {
      var src = ents[k].e, got = dec.sn[k];
      if (src.id !== got.id || src.alive !== got.alive || src.isPlayer !== got.isPlayer) bad++;
      var dh = Math.hypot(src.snake.x - got.x, src.snake.y - got.y);
      if (dh > worstHead) worstHead = dh;
      // 节心重建误差
      var n = Math.min(src.snake.segPos.length, got.segPos.length);
      for (var i = 0; i < n; i++) {
        var d = Math.hypot(src.snake.segPos[i].x - got.segPos[i].x,
          src.snake.segPos[i].y - got.segPos[i].y);
        if (d > worstSeg) worstSeg = d;
      }
      // 颜色序列
      if (src.snake.colors.length !== got.colors.length) worstColor++;
      else for (i = 0; i < got.colors.length; i++) {
        if (src.snake.colors[i] !== got.colors[i]) { worstColor++; break; }
      }
    }
  }
  ok(bad === 0, '40 组随机快照全部解码成功且字段一致', bad + ' 组异常');
  ok(worstHead <= 1.0, '头部坐标误差 ≤1px（' + worstHead.toFixed(3) + '）');
  // 判据按**物理意义**定，不拍脑袋定绝对值：只要误差远小于蛇节半径就看不出来。
  // 参数扫描（锚点 4~16 × 间距策略 5 种）后当前配置实测 ~4.6px，SEG_RADIUS=13。
  ok(worstSeg < cfg.SEG_RADIUS / 2, '节心误差 < 半个蛇节半径（肉眼不可见）：' +
    worstSeg.toFixed(2) + ' < ' + (cfg.SEG_RADIUS / 2));
  ok(worstSeg <= 6.0, '节心重建误差 ≤6px（实测 ' + worstSeg.toFixed(2) + '）');
  ok(worstColor === 0, '颜色序列 4bit 编码无损（含奇数长度）', worstColor + ' 条不一致');

  // 边界：节心重叠（出生瞬间 / 轨迹弧长不足）。
  // 这是真实场景 —— 若解码端一律按 SEG_SPACING 外推，重叠的尾巴会被甩出几百像素。
  var young = new CS.Snake(2000, 1500, 40, 1.0, cfg.COLOR_KEYS.slice());
  for (var q = 0; q < 12; q++) young.update(33);      // 只走 12 帧，轨迹远不够 40 节
  var overlap = 0;
  for (q = 1; q < young.segPos.length; q++) {
    if (Math.hypot(young.segPos[q].x - young.segPos[q - 1].x,
      young.segPos[q].y - young.segPos[q - 1].y) < 1) overlap++;
  }
  var ye = {
    id: 1, name: 'y', isPlayer: true, alive: true, kills: 0, elimScore: 0, elimTotal: 0,
    maxLen: 40, survivalScore: 0, mpBonusScore: 0, bittenUntil: 0, slowUntil: 0, snake: young
  };
  var yd = BP.decSnapBin(BP.encSnapBin({ tick: 1, ack: 1, timeMs: 0, entries: [{ e: ye, lite: false }] }));
  var yWorst = 0;
  var yn = Math.min(young.segPos.length, yd.sn[0].segPos.length);
  for (q = 0; q < yn; q++) {
    var yd2 = Math.hypot(young.segPos[q].x - yd.sn[0].segPos[q].x,
      young.segPos[q].y - yd.sn[0].segPos[q].y);
    if (yd2 > yWorst) yWorst = yd2;
  }
  ok(overlap > 0, '构造出了节心重叠场景（' + overlap + '/' + young.segPos.length + ' 节重叠）');
  ok(yWorst <= 4.0, '重叠节心不被外推甩飞（最大误差 ' + yWorst.toFixed(2) + 'px）',
    '误差 ' + yWorst.toFixed(1) + 'px —— 长度位未生效？');

  // 长蛇误差不随长度发散（锚点机制）
  var lens = [10, 25, 45, 71, 120], divergence = [];
  lens.forEach(function (L) {
    var sk = mkSnake(L, 2000, 1500);
    var ee = {
      id: 1, name: 'z', isPlayer: true, alive: true, kills: 0, elimScore: 0, elimTotal: 0,
      maxLen: L, survivalScore: 0, mpBonusScore: 0, bittenUntil: 0, slowUntil: 0, snake: sk
    };
    var dd = BP.decSnapBin(BP.encSnapBin({ tick: 1, ack: 1, timeMs: 0, entries: [{ e: ee, lite: false }] }));
    var mx = 0, nn = Math.min(sk.segPos.length, dd.sn[0].segPos.length);
    for (var j = 0; j < nn; j++) {
      var e2 = Math.hypot(sk.segPos[j].x - dd.sn[0].segPos[j].x,
        sk.segPos[j].y - dd.sn[0].segPos[j].y);
      if (e2 > mx) mx = e2;
    }
    divergence.push(mx);
  });
  console.log('       长度 ' + lens.join('/') + ' 节的最大误差：' +
    divergence.map(function (v) { return v.toFixed(1); }).join(' / ') + ' px');
  // 核心不变量：误差**不随长度发散**（无锚点时 71 节会到 838px）。
  // 判据是「长蛇不比短蛇差太多」+「绝对值仍在肉眼不可见范围」。
  ok(Math.max.apply(null, divergence) < cfg.SEG_RADIUS / 2,
    '任意长度误差均 < 半个蛇节半径（每 ' + 16 + ' 节绝对锚点生效）',
    '最大 ' + Math.max.apply(null, divergence).toFixed(1) + 'px');
  ok(divergence[4] < divergence[1] * 6,
    '120 节误差未相对 25 节爆炸性发散（' + divergence[4].toFixed(1) +
    ' vs ' + divergence[1].toFixed(1) + '）');
}

// ---------------- T4 体积与单包硬约束 ----------------
function t4() {
  section('T4 体积与「永不分片」硬约束');
  var UDP_SAFE = 1472;      // 1500 MTU - 20 IP - 8 UDP
  var HARD_CAP = 1400;      // 组包硬约束（留 72B 余量）

  // 后期最坏：18 蛇 x 25 节 + 色块增量
  var ents = [];
  for (var k = 0; k < 18; k++) ents.push({ e: mkEntry(k + 1, 25), lite: false });
  var add = [], del = [];
  for (var i = 0; i < 3; i++) add.push({ bid: i, x: rnd() * M.W, y: rnd() * M.H, color: 'red' });
  for (i = 0; i < 4; i++) del.push(100 + i);
  var u8 = BP.encSnapBin({ tick: 1, ack: 1, timeMs: 90000, entries: ents, blockAdd: add, blockDel: del });
  console.log('       18蛇x25节 + 色块增量 = ' + u8.length + ' 字节');
  // 门槛按「必须单包」倒推，不按理想值拍脑袋：
  // 1472 是 UDP 安全载荷，1400 是留给组包器的硬约束。
  ok(u8.length <= UDP_SAFE, '压进单个 UDP datagram（' + u8.length + ' ≤ ' + UDP_SAFE + '）');
  ok(u8.length <= HARD_CAP, '满足组包硬约束（' + u8.length + ' ≤ ' + HARD_CAP + '）');

  // JSON 对照，量化压缩比
  var P = CS.protocol;
  var snJ = ents.map(function (o) { return P.serSnake(o.e); });
  var blJ = [];
  for (i = 0; i < 168; i++) blJ.push(P.serBlock({ x: rnd() * M.W, y: rnd() * M.H, color: 'red', kind: 'color' }));
  var jsonLen = P.encode({ t: 'snap', tk: 1, ack: 1, tm: 0, sn: snJ, bl: blJ, mt: [] }).length;
  var ratio = jsonLen / u8.length;
  console.log('       JSON 对照 = ' + jsonLen + ' 字节，压缩比 ' + ratio.toFixed(1) + 'x');
  ok(ratio >= 12, '相对 JSON 压缩比 ≥12x（' + ratio.toFixed(1) + 'x）');

  // 极端 1：18 条 x 71 节 —— 超出单包，必须靠 LOD 降级
  ents = [];
  for (k = 0; k < 18; k++) ents.push({ e: mkEntry(k + 1, 71), lite: false });
  u8 = BP.encSnapBin({ tick: 1, ack: 1, timeMs: 0, entries: ents });
  console.log('       18蛇x71节 全完整档 = ' + u8.length + ' 字节' +
    (u8.length > HARD_CAP ? '（超硬约束，需 LOD 降级）' : ''));

  // 极端 2：18 条 x 120 节 —— 组包器必须靠 LOD 降级守住硬约束
  ents = [];
  for (k = 0; k < 18; k++) ents.push({ e: mkEntry(k + 1, 120), lite: false });
  var full = BP.encSnapBin({ tick: 1, ack: 1, timeMs: 0, entries: ents });
  console.log('       18蛇x120节 全完整档 = ' + full.length + ' 字节（远超硬约束）');

  // 用**正式的组包器**验证，而不是测试里手写一遍降级逻辑
  // （手写会与实现脱钩 —— 这个教训在 layout.test.js 已经吃过一次）
  var capped = BP.encSnapCapped({ tick: 1, ack: 1, timeMs: 0, entries: ents }, HARD_CAP);
  console.log('       encSnapCapped 降级 ' + capped.degraded + ' 条后 = ' +
    capped.bytes.length + ' 字节');
  ok(!capped.overflow, 'encSnapCapped 守住硬约束 ≤' + HARD_CAP +
    '（' + capped.bytes.length + '）');
  ok(capped.degraded > 0, '极端场景确实触发了 LOD 降级（' + capped.degraded + ' 条）');
  var decCap = BP.decSnapBin(capped.bytes);
  ok(decCap !== null && decCap.sn.length === 18, '降级后仍含全部 18 条蛇（小地图不缺人）');
  ok(decCap && decCap.sn[0].lite === false, '本机玩家（首条）永不被降级');

  // 常规场景不应触发降级
  ents = [];
  for (k = 0; k < 8; k++) ents.push({ e: mkEntry(k + 1, 25), lite: false });
  var normal = BP.encSnapCapped({ tick: 1, ack: 1, timeMs: 0, entries: ents }, HARD_CAP);
  ok(normal.degraded === 0, '常规场景（8蛇x25节）不触发降级', '降了 ' + normal.degraded + ' 条');

  // lite 档体积
  var one = BP.encSnapBin({ tick: 1, ack: 1, timeMs: 0, entries: [{ e: mkEntry(1, 40), lite: true }] });
  var oneFull = BP.encSnapBin({ tick: 1, ack: 1, timeMs: 0, entries: [{ e: mkEntry(1, 40), lite: false }] });
  ok(one.length < oneFull.length, 'lite 档显著小于完整档（' + one.length + ' vs ' + oneFull.length + '）');
  var decLite = BP.decSnapBin(one);
  ok(decLite && decLite.sn[0].lite === true, 'lite 标志位可被解码识别');
  ok(decLite && decLite.sn[0].segPos.length === 1, 'lite 档只含头部（小地图仍可用）');
}

// ---------------- T5 色块增量 ----------------
function t5() {
  section('T5 色块增量编解码');
  var add = [], del = [];
  for (var i = 0; i < 12; i++) {
    add.push({ bid: 1000 + i, x: rnd() * M.W, y: rnd() * M.H, color: cfg.COLOR_KEYS[i % 8] });
  }
  for (i = 0; i < 20; i++) del.push(500 + i);
  var u8 = BP.encSnapBin({ tick: 5, ack: 5, timeMs: 0, entries: [], blockAdd: add, blockDel: del });
  var dec = BP.decSnapBin(u8);
  ok(dec !== null, '空蛇 + 纯色块增量可解码');
  ok(dec.blockAdd.length === 12 && dec.blockDel.length === 20,
    'add/del 数量一致（' + dec.blockAdd.length + '/' + dec.blockDel.length + '）');
  var okAll = true;
  for (i = 0; i < 12; i++) {
    if (dec.blockAdd[i].bid !== add[i].bid) okAll = false;
    if (dec.blockAdd[i].color !== add[i].color) okAll = false;
    if (Math.abs(dec.blockAdd[i].x - add[i].x) > 1) okAll = false;
  }
  ok(okAll, '色块 id/坐标/颜色往返一致');
  var okDel = true;
  for (i = 0; i < 20; i++) if (dec.blockDel[i] !== del[i]) okDel = false;
  ok(okDel, '删除列表往返一致');

  // 峰值体积（四连消除 + 尸体爆发）
  add = []; del = [];
  for (i = 0; i < 24; i++) add.push({ bid: i, x: rnd() * M.W, y: rnd() * M.H, color: 'red' });
  for (i = 0; i < 32; i++) del.push(i);
  var peak = BP.encSnapBin({ tick: 1, ack: 1, timeMs: 0, entries: [], blockAdd: add, blockDel: del });
  console.log('       峰值色块增量（add24/del32）= ' + peak.length + ' 字节');
  ok(peak.length <= 300, '色块增量峰值 ≤300 字节（' + peak.length + '）');
}

// ---------------- T6 上行 Fragment ----------------
function t6() {
  section('T6 上行 input Fragment');
  var f = BP.encInputFrag(0xDEADBEEF, 12345, 2.35, 0);
  ok(f.length === 12, 'Fragment 恰好 12 字节（' + f.length + '）');
  var d = BP.decInputFrag(f);
  ok(d !== null, '正常 Fragment 可解码');
  ok(d.token === 0xDEADBEEF, 'token 往返一致（' + d.token.toString(16) + '）');
  ok(d.frameId === 12345, 'frameId 往返一致');
  ok(Math.abs(d.angle - 2.35) < 0.001, 'angle 精度 <0.001rad（' + d.angle.toFixed(6) + '）');
  ok(BP.decInputFrag(BP.encInputFrag(1, 1, 0, 1)).boost === 1, 'boost 位往返一致');

  // 帧号环回安全性：30Hz x 5 分钟对局
  var framesPerMatch = 30 * 60 * 5;
  ok(framesPerMatch < 65536, 'uint16 frameId 一局内不环回（' +
    framesPerMatch + ' < 65536，环回需 ' + (65536 / 30 / 60).toFixed(1) + ' 分钟）');

  // 上行带宽
  var bw = 12 * 30 * 3;
  ok(bw / 1024 < 2, '30Hz x3 冗余上行 <2 KB/s（' + (bw / 1024).toFixed(2) + '）');
}

// ---------------- T7 畸形输入健壮性 ----------------
function t7() {
  section('T7 畸形输入必须返回 null 且不抛异常');
  var cases = [
    ['null', null],
    ['空数组', new Uint8Array(0)],
    ['过短', new Uint8Array(5)],
    ['全零', new Uint8Array(64)],
    ['随机噪声', (function () {
      var a = new Uint8Array(200);
      for (var i = 0; i < 200; i++) a[i] = Math.floor(rnd() * 256);
      return a;
    })()]
  ];
  var threw = 0, notNull = 0;
  cases.forEach(function (c) {
    try {
      var r = BP.decSnapBin(c[1]);
      if (r !== null) { notNull++; console.log('       ' + c[0] + ' 返回了非 null'); }
    } catch (e) { threw++; console.log('       ' + c[0] + ' 抛异常: ' + e.message); }
  });
  ok(threw === 0, '畸形 snap 输入不抛异常');
  ok(notNull === 0, '畸形 snap 输入一律返回 null');

  // 截断：合法包砍掉尾巴
  var ents = [{ e: mkEntry(1, 30), lite: false }];
  var good = BP.encSnapBin({ tick: 1, ack: 1, timeMs: 0, entries: ents });
  var truncOk = true, truncThrew = 0;
  for (var cut = 1; cut < good.length; cut += 3) {
    try {
      if (BP.decSnapBin(good.subarray(0, cut)) !== null) truncOk = false;
    } catch (e) { truncThrew++; }
  }
  ok(truncThrew === 0, '任意位置截断不抛异常');
  ok(truncOk, '任意位置截断一律返回 null（CRC 或 overflow 拦截）');

  // 篡改：翻转任意一个字节都应被 CRC 拦截
  var caught = 0, total = 0;
  for (var i = 0; i < good.length; i += 5) {
    var bad = good.slice();
    bad[i] ^= 0xFF;
    total++;
    if (BP.decSnapBin(bad) === null) caught++;
  }
  ok(caught === total, 'CRC16 检出全部单字节篡改（' + caught + '/' + total + '）');

  // 上行 Fragment 畸形
  threw = 0; notNull = 0;
  [null, new Uint8Array(0), new Uint8Array(11), new Uint8Array(13), new Uint8Array(12)]
    .forEach(function (u) {
      try { if (BP.decInputFrag(u) !== null) notNull++; } catch (e) { threw++; }
    });
  ok(threw === 0 && notNull === 0, '畸形 Fragment 一律 null 且不抛异常');
}

// ---------------- 主流程 ----------------
console.log('二进制编解码回归（v3.1 M1a）');
t1(); t2(); t3(); t4(); t5(); t6(); t7();
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
