'use strict';
/**
 * body.test.js — 本机预测体身体完整性回归（v3.0.2）
 * 运行：node test/net/body.test.js
 *
 * 背景（架构文档 §5.4.1）：快照只带节心（间距 SEG_SPACING=30px），而 trail 采样步长
 * TRAIL_STEP=3px。早期实现把 segPos 直接当 trail，弧长恰好等于身体长度、余量为零；
 * 一旦 colors 变长（吃块/流星注入/尸体色块），轨迹立刻不够，computeBody 沿轨迹排布时
 * 尾部全部节堆在轨迹末点 —— 用户可见现象是「头抛弃身体，只有头能动，身体留在原地」。
 *
 * 该 bug 只有本人可见：他机蛇走插值层直接用快照 segPos 渲染，不重建轨迹。
 *
 * 本文件把当时诊断出的复现场景固化为断言，核心指标：
 *   - 堆叠节数（相邻节间距 < 5px 视为堆叠）必须为 0
 *   - 节间距应接近 SEG_SPACING（容差 ±20%）
 *   - 轨迹弧长必须 ≥ 身体所需弧长
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'ai', 'multiplayer']
  .forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'prediction'].forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS;
var cfg = CS.config;
var P = CS.protocol;

var passed = 0, failed = 0, failedNames = [];
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); failedNames.push(name); }
}
function section(t) { console.log('\n[' + t + ']'); }

var KEYS = cfg.COLOR_KEYS.slice(0, 6);

/** 把一条 Snake 走一遍真实协议序列化 → 反序列化，得到 deSnake 结果 */
function snapOf(snake, overrides) {
  var e = Object.assign({
    id: 1, name: 'P1', isPlayer: true, alive: true, kills: 0, elimScore: 0,
    elimTotal: 0, maxLen: snake.colors.length, survivalScore: 0, mpBonusScore: 0,
    bittenUntil: 0, slowUntil: 0, snake: snake
  }, overrides || {});
  return P.deSnake(P.serSnake(e));
}

/**
 * 构造一个「整体平移」的权威快照：head 与 segPos 一起偏移。
 * 这才是真实 hardSnap 的形态 —— 服务器蛇确实在别处，头和身体是自洽的。
 * （若只平移 head 而不动 segPos，会造出真实链路不可能出现的不一致输入。）
 */
function snapShifted(snake, dx, dy) {
  var d = snapOf(snake);
  d.x += dx; d.y += dy;
  d.segPos = d.segPos.map(function (p) { return { x: p.x + dx, y: p.y + dy }; });
  return d;
}

/** 身体完整性度量 */
function measure(s) {
  var stack = 0, gaps = [], maxGap = 0;
  for (var i = 1; i < s.segPos.length; i++) {
    var a = s.segPos[i - 1], b = s.segPos[i];
    var d = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
    gaps.push(d);
    if (d < 5) stack++;
    if (d > maxGap) maxGap = d;
  }
  return {
    stack: stack, gaps: gaps, maxGap: maxGap,
    segs: s.segPos.length, colors: s.colors.length,
    arc: CS.predictTrailArc(s),
    need: (s.colors.length + 1) * cfg.SEG_SPACING
  };
}

/** 断言一条预测蛇身体健康
 *
 * 关于节间距容差：trail-following 下「相邻节直线距离」是轨迹弧长对应的**弦长**，
 * 急转弯时弦长必然小于 SEG_SPACING（实测纯本地蛇持续急转时头-第1节可低至 26px）。
 * 这是运动模型的固有几何，不是缺陷。因此下限取 SEG_SPACING*0.8=24px
 * （比实测几何下限 26px 再留一点余量），只用于捕捉「塌缩/脱节」这类真实故障；
 * 判断预测体是否健康的**主判据是堆叠节数为 0 + 轨迹弧长充足**。
 */
function assertHealthy(s, label) {
  var m = measure(s);
  ok(m.stack === 0, label + '：无堆叠节（' + m.segs + ' 节）',
    '堆叠 ' + m.stack + '/' + (m.segs - 1) + ' 后5节间距=[' +
    m.gaps.slice(-5).map(function (x) { return x.toFixed(1); }).join(',') + ']');
  ok(m.segs === m.colors + 1, label + '：segPos 节数 = colors + 1（尾巴节）',
    'segPos=' + m.segs + ' colors=' + m.colors);
  ok(m.arc >= m.need, label + '：轨迹弧长足够（' + m.arc.toFixed(0) + ' ≥ ' + m.need + '）',
    '弧长 ' + m.arc.toFixed(1) + ' < 需求 ' + m.need);
  var lo = cfg.SEG_SPACING * 0.8, hi = cfg.SEG_SPACING * 1.2;
  var bad = [];
  m.gaps.forEach(function (g, i) { if (g < lo || g > hi) bad.push('idx' + (i + 1) + '=' + g.toFixed(1)); });
  ok(bad.length === 0, label + '：节间距在 [' + lo + ',' + hi + '] 内（弦长容差）',
    '越界: ' + bad.join(' '));
  return m;
}

// ---------------- T1 buildTrail 单元行为 ----------------
function t1() {
  section('T1 buildTrail：密度与弧长');
  var srv = new CS.Snake(1000, 1000, 20, 0, KEYS);
  for (var i = 0; i < 400; i++) srv.update(33);
  var d = snapOf(srv);
  var need = (d.colors.length + 1) * cfg.SEG_SPACING;
  var trail = CS.buildPredictTrail(d.segPos, d.x, d.y, d.angle, need);

  // 弧长
  var acc = 0, px = d.x, py = d.y;
  for (i = 0; i < trail.length; i++) {
    acc += Math.sqrt(Math.pow(trail[i].x - px, 2) + Math.pow(trail[i].y - py, 2));
    px = trail[i].x; py = trail[i].y;
  }
  ok(acc >= need + CS.PREDICT_TRAIL_MARGIN - 1,
    '弧长含安全余量（' + acc.toFixed(0) + ' ≥ ' + (need + CS.PREDICT_TRAIL_MARGIN) + '）',
    '实际 ' + acc.toFixed(1));

  // 密度：相邻轨迹点间距应 ≈ TRAIL_STEP，不得出现 SEG_SPACING 级别的大跳
  var maxStep = 0;
  for (i = 1; i < trail.length; i++) {
    var dd = Math.sqrt(Math.pow(trail[i].x - trail[i - 1].x, 2) + Math.pow(trail[i].y - trail[i - 1].y, 2));
    if (dd > maxStep) maxStep = dd;
  }
  ok(maxStep <= cfg.TRAIL_STEP + 0.5,
    '轨迹密度对齐 TRAIL_STEP（最大步长 ' + maxStep.toFixed(2) + ' ≤ ' + cfg.TRAIL_STEP + '）',
    '最大步长 ' + maxStep.toFixed(2));

  // 退化：节心全部重合（刚出生）时仍能产出可用轨迹
  var born = new CS.Snake(500, 500, 8, Math.PI / 3, KEYS);
  var db = snapOf(born);
  var needB = (db.colors.length + 1) * cfg.SEG_SPACING;
  var tb = CS.buildPredictTrail(db.segPos, db.x, db.y, db.angle, needB);
  var accB = 0; px = db.x; py = db.y;
  for (i = 0; i < tb.length; i++) {
    accB += Math.sqrt(Math.pow(tb[i].x - px, 2) + Math.pow(tb[i].y - py, 2));
    px = tb[i].x; py = tb[i].y;
  }
  ok(accB >= needB, '节心全重合（刚出生）时沿 angle 反向外推出足够轨迹（' + accB.toFixed(0) + '）',
    '弧长 ' + accB.toFixed(1) + ' < ' + needB);

  // 健壮性：head 与 segPos[0] 不同源（head 已被校正而 segPos 是旧序列）时，
  // 必须丢弃首个节心，不能把这段假位移当轨迹注入（否则轨迹前段被污染、逐次累积退化）。
  var d2 = snapOf(srv);
  var far = { x: d2.x + 500, y: d2.y };          // 只挪 head，segPos 保持原位（异常输入）
  var t2p = CS.buildPredictTrail(d2.segPos, far.x, far.y, d2.angle, need);
  var firstStep = Math.sqrt(Math.pow(t2p[0].x - far.x, 2) + Math.pow(t2p[0].y - far.y, 2));
  ok(firstStep <= cfg.TRAIL_STEP + 0.5,
    'head 与 segPos[0] 不同源时不注入假位移（首步 ' + firstStep.toFixed(2) + 'px）',
    '首步 ' + firstStep.toFixed(2) + ' 远大于 TRAIL_STEP，说明假位移被当轨迹');
}

// ---------------- T2 出生不久 colors 暴涨（原始复现场景）----------------
function t2() {
  section('T2 出生不久 colors 从 5 节暴涨到 40 节（原始 bug 场景）');
  var srv = new CS.Snake(1000, 1000, 5, 0, KEYS);
  for (var i = 0; i < 30; i++) srv.update(33); // 只跑 1 秒，轨迹很短
  var p = new CS.SelfPredictor();
  p.attach(snapOf(srv), KEYS);
  assertHealthy(p.snake, 'attach(5节)');

  for (i = 0; i < 35; i++) srv.grow('red');    // 服务器判定连吃到 40 节
  p.reconcile(snapOf(srv));
  assertHealthy(p.snake, 'reconcile(40节)');

  for (i = 0; i < 60; i++) p.update(16.7, 0);
  assertHealthy(p.snake, '再跑60帧');
}

// ---------------- T3 hardSnap 后紧接 colors 暴涨（最严重组合）----------------
function t3() {
  section('T3 hardSnap 后紧接 colors 暴涨（最严重组合）');
  var srv = new CS.Snake(1000, 1000, 5, 0, KEYS);
  for (var i = 0; i < 20; i++) srv.update(33);
  var p = new CS.SelfPredictor();
  p.attach(snapOf(srv), KEYS);

  var d = snapShifted(srv, 300, 0);             // 强制 hardSnap（整体平移 300px）
  p.reconcile(d);
  ok(p.hardSnaps === 1, '偏差 300px 触发一次硬对齐', 'hardSnaps=' + p.hardSnaps);

  for (i = 0; i < 40; i++) srv.grow('blue');    // 紧接着暴涨到 45 节
  p.reconcile(snapOf(srv));
  assertHealthy(p.snake, 'hardSnap+暴涨(45节)');
}

// ---------------- T4 长蛇掉头（轨迹被快速消耗）----------------
function t4() {
  section('T4 长蛇（30节）持续掉头 150 帧');
  var srv = new CS.Snake(1000, 1000, 30, 0, KEYS);
  for (var i = 0; i < 600; i++) srv.update(33);
  var p = new CS.SelfPredictor();
  p.attach(snapOf(srv), KEYS);
  assertHealthy(p.snake, 'attach(30节)');
  for (i = 0; i < 150; i++) p.update(16.7, Math.PI); // 一直往反方向拽
  assertHealthy(p.snake, '掉头150帧');
}

// ---------------- T5 反复 hardSnap 不累积退化 ----------------
function t5() {
  section('T5 连续 8 次 hardSnap 不累积退化');
  var srv = new CS.Snake(1000, 1000, 25, 0, KEYS);
  for (var i = 0; i < 500; i++) srv.update(33);
  var p = new CS.SelfPredictor();
  p.attach(snapOf(srv), KEYS);

  // 服务器与客户端施加**同一个**目标角：真实链路中服务器会收到同样的 input。
  // （若只让客户端转而服务器直行，软校正的角度项会持续对抗，头部剧烈摆动、
  //   弦长被压缩 —— 那是测试构造失真，不是预测层缺陷。）
  var STEER = Math.PI * 0.9;
  for (var r = 0; r < 8; r++) {
    for (i = 0; i < 5; i++) { srv.setTargetAngle(STEER); srv.update(16.7); }
    p.reconcile(snapShifted(srv, 200, 0));      // 整体平移 200px → 必然 hardSnap
    for (i = 0; i < 5; i++) p.update(16.7, STEER);
  }
  assertHealthy(p.snake, '8次hardSnap后');
  ok(p.hardSnaps >= 1, 'hardSnap 确实被触发（' + p.hardSnaps + ' 次）');
  ok(p.snake.colorKeys === KEYS, 'hardSnap 走 attach 时色池未丢失',
    'colorKeys=' + (p.snake.colorKeys && p.snake.colorKeys.length));

  // 与「纯本地蛇同样操作」的基线对照：预测体不应比本地蛇更差。
  // 这比固定阈值更可靠 —— 弦长收缩是运动模型固有几何，本地蛇同样会发生。
  var loc = new CS.Snake(1000, 1000, 25, 0, KEYS);
  for (i = 0; i < 500; i++) loc.update(33);
  for (i = 0; i < 40; i++) { loc.setTargetAngle(STEER); loc.update(16.7); }
  var mLoc = measure(loc), mPred = measure(p.snake);
  ok(mPred.stack <= mLoc.stack,
    '预测体堆叠节数不比本地蛇差（预测 ' + mPred.stack + ' ≤ 本地 ' + mLoc.stack + '）');
  ok(Math.min.apply(null, mPred.gaps) >= Math.min.apply(null, mLoc.gaps) - 1,
    '预测体最小节间距不比本地蛇差（预测 ' +
    Math.min.apply(null, mPred.gaps).toFixed(1) + ' vs 本地 ' +
    Math.min.apply(null, mLoc.gaps).toFixed(1) + '）');
}

// ---------------- T6 消除变短不产生异常 ----------------
function t6() {
  section('T6 colors 大幅变短（消除）');
  var srv = new CS.Snake(1000, 1000, 30, 0, KEYS);
  for (var i = 0; i < 500; i++) srv.update(33);
  var p = new CS.SelfPredictor();
  p.attach(snapOf(srv), KEYS);
  srv.colors = srv.colors.slice(0, 5);
  srv.computeBody();
  p.reconcile(snapOf(srv));
  assertHealthy(p.snake, 'reconcile(缩到5节)');
  for (i = 0; i < 60; i++) p.update(16.7, 0);
  assertHealthy(p.snake, '再跑60帧');
}

// ---------------- 主流程 ----------------
console.log('本机预测体身体完整性回归（v3.0.2）');
t1(); t2(); t3(); t4(); t5(); t6();

console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) { console.log('失败项：' + failedNames.join(' / ')); process.exit(1); }
process.exit(0);
