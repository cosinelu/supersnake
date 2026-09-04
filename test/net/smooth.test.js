'use strict';
/**
 * smooth.test.js — M4 流畅度模块测试：快照插值（interpolation）+ 本机预测软校正（prediction）
 * 运行：node test/net/smooth.test.js
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'ai', 'multiplayer']
  .forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'interpolation', 'prediction']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS;
var cfg = CS.config, u = CS.utils, P = CS.protocol;

var passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

function fakeSnapSnake(id, x, y, angle, segs) {
  var sg = [];
  for (var i = 0; i < segs; i++) sg.push(Math.round(x - i * cfg.SEG_SPACING), Math.round(y));
  return { id: id, nm: 's' + id, pl: 0, al: 1,
    x: Math.round(x), y: Math.round(y), a: angle, sp: 150, co: 'r', sg: sg,
    kl: 0, es: 0, et: 0, ml: 1, bt: 0, sl: 0 };
}

// ---------------- 1. 插值缓冲 ----------------
section('快照插值（InterpBuffer）');
(function () {
  var buf = new CS.InterpBuffer(120, 66); // 15Hz 快照：tick 间距 66ms
  // t=1000 帧 A：x=100；t=1066 帧 B：x=133（模拟 30px/tick 移动）
  buf.push({ tk: 1, sn: [fakeSnapSnake(1, 100, 500, 0, 6)] }, 1000, P.deSnake);
  buf.push({ tk: 2, sn: [fakeSnapSnake(1, 133, 500, 0, 6)] }, 1066, P.deSnake);

  // 渲染时刻 = now - 120：now=1153 → renderT=1033（A/B 中点）
  var s = buf.sample(1153);
  ok(s && s[1], '采样返回蛇数据');
  ok(Math.abs(s[1].x - 116.5) < 0.6, '位置插值到中点', 'x=' + s[1].x);
  ok(Math.abs(s[1].segPos[2].x - (100 - 2 * cfg.SEG_SPACING + 16.5)) < 0.6, '节心同步插值');

  // 超出最新帧：先按最新速度短外推（150px/s × 260ms = 39px），随后停住。
  // 不能在缓冲耗尽时直接冻结，否则 TCP 抖动会表现成「停一下、再跳一下」。
  s = buf.sample(99999);
  ok(Math.abs(s[1].x - 172) < 0.01, '渲染时刻超过最新帧 → 按速度短外推并有上限', 'x=' + s[1].x);
  ok(Math.abs(s[1].segPos[2].x - (133 - 2 * cfg.SEG_SPACING + 39)) < 0.01,
    '短外推整体平移节心（不会头身分离）');
  ok(s[1].extrapolated === cfg.REMOTE_EXTRAPOLATE_MS, 'HUD/断言可区分外推与正常插值');

  // 角度最短弧：350° → 10° 中点应为 0°（而非 180°）
  var buf2 = new CS.InterpBuffer(120, 66);
  var a350 = -Math.PI / 18, a10 = Math.PI / 18;
  buf2.push({ tk: 1, sn: [fakeSnapSnake(1, 0, 0, a350, 3)] }, 1000, P.deSnake);
  buf2.push({ tk: 2, sn: [fakeSnapSnake(1, 0, 0, a10, 3)] }, 1066, P.deSnake);
  var s2 = buf2.sample(1153);
  ok(Math.abs(s2[1].angle) < 0.01, '角度插值走最短弧（350°→10° 中点≈0°）', 'angle=' + s2[1].angle);

  // 节数变化（消除/变长瞬间）：取较新帧不插值
  var buf3 = new CS.InterpBuffer(120, 66);
  buf3.push({ tk: 1, sn: [fakeSnapSnake(1, 100, 0, 0, 6)] }, 1000, P.deSnake);
  buf3.push({ tk: 2, sn: [fakeSnapSnake(1, 133, 0, 0, 3)] }, 1066, P.deSnake);
  var s3 = buf3.sample(1153);
  ok(s3[1].segPos.length === 3 && Math.abs(s3[1].x - 116.5) < 0.6,
    '节数变化时节心取较新帧、头部正常插值', 'len=' + s3[1].segPos.length + ' x=' + s3[1].x);
})();

// ---------------- 1a. 服务器 tick 时间线与移动实体 ----------------
section('权威 tick 时间线与移动实体插值');
(function () {
  // 两帧真实权威间隔 66ms，但 TCP 队头阻塞后同一毫秒到达。
  // 若按收包时刻排列，这两帧会被压缩成一次硬跳；必须按 tick 还原节奏。
  var burst = new CS.InterpBuffer(100, 66);
  burst.push({ tk: 10, sn: [fakeSnapSnake(8, 100, 500, 0, 4)], mt: [] }, 2000, P.deSnake, P.deMeteor);
  burst.push({ tk: 11, sn: [fakeSnapSnake(8, 133, 500, 0, 4)], mt: [] }, 2000, P.deSnake, P.deMeteor);
  var early = burst.sample(2000);   // renderT=1900：仍在第一帧前，取第一帧
  var mid = burst.sample(2067);     // 第二帧同毫秒到达会重锚：renderT=1967，处于两帧中点
  ok(Math.abs(early[8].x - 100) < 0.01, '批量到达不提前跳到较新帧', 'x=' + early[8].x);
  ok(Math.abs(mid[8].x - 116.5) < 0.6, '批量到达仍按 tick 间隔均匀回放', 'x=' + mid[8].x);

  function meteorSnap(tick, x) {
    return { tk: tick, sn: [], mt: [{
      id: 42, x: x, y: 300, vx: 140, vy: 0, c: 'g', ph: 1.2,
      tr: [x - 20, 300, x - 10, 300]
    }] };
  }
  var mbuf = new CS.InterpBuffer(100, 66);
  mbuf.push(meteorSnap(10, 100), 3000, P.deSnake, P.deMeteor);
  mbuf.push(meteorSnap(11, 109), 3066, P.deSnake, P.deMeteor);
  var ms = mbuf.sample(3133); // renderT=3033：权威时间线中点
  ok(ms.meteors.length === 1 && ms.meteors[0].mid === 42, '流星按稳定 mid 关联');
  ok(Math.abs(ms.meteors[0].x - 104.5) < 0.6, '流星在两帧间连续插值', 'x=' + ms.meteors[0].x);
  ok(Math.abs(ms.meteors[0].trail[1].x - 94.5) < 0.6, '流星拖尾随本体同步插值');

  var stalled = mbuf.sample(99999);
  ok(Math.abs(stalled.meteors[0].x - (109 + 140 * cfg.REMOTE_EXTRAPOLATE_MS / 1000)) < 0.01,
    '流星缓冲耗尽后按速度短外推并封顶', 'x=' + stalled.meteors[0].x);
})();

// ---------------- 1a2. tick 回绕与持续高时延重锚 ----------------
section('tick 回绕与持续高时延重锚');
(function () {
  // 二进制快照 tick 是 uint16；TCP 是完整 int。跨过 65535 后也必须保持单调，
  // 否则通道切换/回绕时远端画面会冻结。
  var wrap = new CS.InterpBuffer(70, 33);
  var ticks = [65534, 65535, 0, 1];
  for (var wi = 0; wi < ticks.length; wi++) {
    ok(wrap.push({ tk: ticks[wi], sn: [fakeSnapSnake(9, 100 + wi * 5, 500, 0, 3)], mt: [] },
      1000 + wi * 33, P.deSnake, P.deMeteor) === true,
      'tick ' + ticks[wi] + ' 被接受（含 16 位回绕）');
  }
  ok(wrap.snaps.length === 4 && wrap.snaps[3].time - wrap.snaps[2].time === 33,
    '回绕后权威时间线仍按 33ms 递增', 'dt=' + (wrap.snaps[3].time - wrap.snaps[2].time));
  ok(wrap.push({ tk: 65535, sn: [fakeSnapSnake(9, 0, 500, 0, 3)], mt: [] }, 1200, P.deSnake) === false,
    '跨通道迟到的旧 tick 不回滚插值缓冲');

  // 首帧低时延、后续持续高时延：不能永远拿旧锚点外推；持续 1 秒后后移时间线。
  var slow = new CS.InterpBuffer(70, 33);
  slow.push({ tk: 1, sn: [fakeSnapSnake(10, 100, 500, 0, 3)], mt: [] }, 1000, P.deSnake, P.deMeteor);
  slow.push({ tk: 2, sn: [fakeSnapSnake(10, 105, 500, 0, 3)], mt: [] }, 1033, P.deSnake, P.deMeteor);
  var base0 = slow._timeBaseMs;
  for (var si = 3; si < 60; si++) {
    slow.push({ tk: si, sn: [fakeSnapSnake(10, 100 + si * 5, 500, 0, 3)], mt: [] },
      1000 + (si - 1) * 33 + 500, P.deSnake, P.deMeteor);
  }
  ok(slow._timeBaseMs > base0, '持续高时延超过重锚窗口后，时间线后移而不是永久外推',
    base0 + ' → ' + slow._timeBaseMs);
})();

// ---------------- 1b. 插值延迟自适应（v3.1 1a.6） ----------------
section('插值延迟自适应（deriveDelay / setSnapInterval）');
(function () {
  var dd = CS.deriveInterpDelay, dc = CS.deriveInterpCap;

  // 核心回归：15Hz 推导值必须实质等同于旧硬编码 120ms。
  // 这条断言的意义是「提频改造不得改变提频前的行为」——
  // 若 15Hz 下手感变了，说明公式跑偏，而不是提频带来的差异。
  ok(Math.abs(dd(66) - 120) <= 2, '15Hz(66ms) 推导延迟 ≈ 旧硬编码 120ms', 'got=' + dd(66));
  ok(dd(33) < dd(66), '30Hz 延迟严格小于 15Hz（提频必须换来更低延迟）',
    '33→' + dd(33) + ' / 66→' + dd(66));
  ok(dd(33) === 70, '30Hz(33ms) 推导延迟 = 70ms（33×1.5+20）', 'got=' + dd(33));

  // 延迟必须 > 1 个快照间隔，否则渲染时刻常越过最新帧被钳制 → 卡顿
  [16, 33, 50, 66, 100, 200].forEach(function (iv) {
    ok(dd(iv) > iv, '间隔 ' + iv + 'ms：延迟 > 1 个间隔（保证有前后两帧可插）',
      'delay=' + dd(iv));
  });

  // 边界钳制：极端值不许推出荒谬延迟
  ok(dd(1) >= 50, '极小间隔被钳到下限 50ms', 'got=' + dd(1));
  ok(dd(100000) <= 400, '极大间隔被钳到上限 400ms', 'got=' + dd(100000));
  ok(dd(0) === dd(66) && dd(-5) === dd(66), '非法/缺失间隔回退到 15Hz 默认值');

  // 缓冲窗口按「固定历史时长」折算，不是固定帧数 ——
  // 写死 30 帧的话，15Hz 是 2 秒历史、30Hz 只剩 1 秒，提频等于悄悄砍窗口
  ok(dc(33) > dc(66), '快照间隔减半 → 缓冲帧数增加（历史时长恒定）',
    '33→' + dc(33) + ' / 66→' + dc(66));
  ok(Math.abs(dc(66) * 66 - dc(33) * 33) <= 66, '两种频率的历史时长基本相等',
    (dc(66) * 66) + 'ms vs ' + (dc(33) * 33) + 'ms');

  // setSnapInterval：幂等 + 非法值不污染既有状态
  var b = new CS.InterpBuffer();
  ok(b.delay === 120 && b.cap === 30, '未调用 setSnapInterval 时保持旧默认（120ms / 30 帧）');
  ok(b.setSnapInterval(33) === true && b.delay === 70, 'setSnapInterval(33) 生效');
  b.setSnapInterval(33);
  ok(b.delay === 70 && b.snapIntervalMs === 33, '重复调用幂等');
  ok(b.setSnapInterval(0) === false && b.delay === 70, '非法间隔被拒且不改动现值');

  // 调小间隔后已缓存的超额帧要立刻裁掉（否则窗口约束形同虚设）
  var b2 = new CS.InterpBuffer();
  b2.setSnapInterval(66);
  for (var i = 0; i < b2.cap + 5; i++) {
    b2.push({ tk: i, sn: [fakeSnapSnake(1, i * 10, 0, 0, 3)] }, 1000 + i * 66, P.deSnake);
  }
  ok(b2.snaps.length === b2.cap, 'push 超出 cap 时裁掉最旧帧', 'len=' + b2.snaps.length);
  var before = b2.snaps.length;
  b2.setSnapInterval(200); // 间隔变大 → cap 变小 → 应立即裁剪
  ok(b2.snaps.length === b2.cap && b2.snaps.length < before,
    '调大间隔后立即裁剪到新 cap', before + ' → ' + b2.snaps.length);

  // 30Hz 端到端：同样的两帧间隔（33ms）下插值仍落在中点
  var b3 = new CS.InterpBuffer();
  b3.setSnapInterval(33);
  b3.push({ tk: 1, sn: [fakeSnapSnake(1, 100, 500, 0, 6)] }, 2000, P.deSnake);
  b3.push({ tk: 2, sn: [fakeSnapSnake(1, 116, 500, 0, 6)] }, 2033, P.deSnake);
  // renderT = now - 70 → now = 2016.5 + 70 = 2086.5 落在 A/B 中点
  var s30 = b3.sample(2086.5);
  ok(s30 && Math.abs(s30[1].x - 108) < 0.6, '30Hz 下插值到两帧中点', 'x=' + (s30 && s30[1].x));
})();

// ---------------- 1c. RemoteMatch 透传快照间隔 ----------------
section('RemoteMatch 快照间隔透传');
(function () {
  require(path.join(JS, 'net', 'netMatch.js'));
  var rm = new CS.RemoteMatch(1, { snapIntervalMs: 33 });
  ok(rm.interpDelayMs() === 70, '构造时传 snapIntervalMs 即生效', 'delay=' + rm.interpDelayMs());
  var rm2 = new CS.RemoteMatch(1);
  ok(rm2.interpDelayMs() === 120, '未传时保持旧默认 120ms');
  ok(rm2.setSnapInterval(33) === true && rm2.interpDelayMs() === 70, '对局中可改（服务器动态调频）');
  var rm3 = new CS.RemoteMatch(1, { interpDelayMs: 0 });
  ok(rm3.interpDelayMs() === 0 && rm3.setSnapInterval(33) === false,
    '插值关闭时 setSnapInterval 为空操作，不抛异常');
})();

// ---------------- 2. 本机预测 ----------------
section('本机预测（SelfPredictor）');
(function () {
  var orig = Math.random;
  Math.random = CS.utils.makeRng(77);
  // 参考蛇（扮演服务器权威）
  var ref = new CS.Snake(1000, 1000, 6, 0.3, cfg.COLOR_KEYS.slice(0, 4));
  ref.speed = 150;
  for (var i = 0; i < 100; i++) ref.update(33); // 先跑一段让轨迹自然

  // 从参考蛇序列化出快照 → attach 预测体
  function snapOf(snake) {
    return P.deSnake(P.serSnake({
      id: 1, name: 'me', isPlayer: true, alive: true,
      kills: 0, elimScore: 0, elimTotal: 0, maxLen: 6, bittenUntil: 0, slowUntil: 0,
      snake: snake
    }));
  }
  var pred = new CS.SelfPredictor();
  pred.attach(snapOf(ref), cfg.COLOR_KEYS.slice(0, 4));
  ok(pred.snake && pred.snake.length() === 6, 'attach 重建预测体（节数一致）');
  ok(Math.abs(pred.snake.x - ref.x) < 1.1, 'attach 位置对齐（量化精度内）');

  // 双侧同输入推进 90 帧：预测应与权威几乎无漂移
  var angle = 0.3;
  for (i = 0; i < 90; i++) {
    if (i === 30) angle = 1.2;
    if (i === 60) angle = -0.8;
    ref.setTargetAngle(angle);
    ref.update(33);
    pred.update(33, angle);
    if (i % 2 === 1) pred.reconcile(snapOf(ref)); // 模拟 15Hz 快照
  }
  var err = u.dist(pred.snake.x, pred.snake.y, ref.x, ref.y);
  ok(err < 5, '同输入 90 帧漂移 < 5px（运动模型一致）', 'err=' + err.toFixed(2) + 'px');

  // 软校正：服务器突然偏差 +40px（模拟一次判定差异）→ 收敛且无瞬移
  var fake = snapOf(ref);
  fake.x += 40; // 服务器说你在 40px 外（一次性偏差）
  pred.reconcile(fake);
  ok(pred.hardSnaps === 0, '40px 偏差不触发硬对齐（< 80px 阈值）');
  var maxJump = 0, prevX = pred.snake.x, prevY = pred.snake.y;
  for (i = 0; i < 60; i++) {
    // 权威端继续前进（快照随动），预测端同输入推进 + 周期性 reconcile
    ref.setTargetAngle(angle);
    ref.update(33);
    pred.update(33, angle);
    if (i % 2 === 1) pred.reconcile(snapOf(ref));
    var jump = u.dist(pred.snake.x, pred.snake.y, prevX, prevY);
    if (jump > maxJump) maxJump = jump;
    prevX = pred.snake.x; prevY = pred.snake.y;
  }
  var normalStep = 150 * 0.033; // 正常单帧位移 ≈ 5px
  ok(maxJump < normalStep + 8, '软校正无瞬移（单帧位移 ≤ 正常步长+8px）', 'maxJump=' + maxJump.toFixed(2));
  var finalErr = u.dist(pred.snake.x, pred.snake.y, ref.x, ref.y);
  ok(finalErr < 5, '60 帧后收敛到权威位置（<5px）', 'finalErr=' + finalErr.toFixed(2));

  // 硬对齐：200px 偏差（极端丢包）→ attach 重建
  var fake2 = snapOf(ref);
  fake2.x += 200;
  pred.reconcile(fake2);
  ok(pred.hardSnaps === 1 && Math.abs(pred.snake.x - (ref.x + 200)) < 1.1, '200px 偏差触发硬对齐');

  // 颜色序列以服务器为准（消除瞬间）
  var fake3 = snapOf(pred.snake);
  fake3.colors = ['blue', 'blue'];
  pred.reconcile(fake3);
  ok(pred.snake.colors.length === 2 && pred.snake.colors[0] === 'blue', '颜色序列直接采纳服务器版本');

  // 回归：软校正必须整体平移 trail，不能只挪头。
  // 只挪 x/y 会让 computeBody 从新头走回旧 trail，视觉上就是「头身分离」。
  var p2 = new CS.SelfPredictor();
  p2.attach(snapOf(ref), cfg.COLOR_KEYS.slice(0, 4));
  p2.snake.speed = 0;
  var beforeHead = { x: p2.snake.x, y: p2.snake.y };
  var beforeTrail = { x: p2.snake.trail[5].x, y: p2.snake.trail[5].y };
  var shifted = snapOf(p2.snake);
  shifted.x += 40; shifted.y -= 20;
  p2.reconcile(shifted);
  p2.update(0);
  var headDx = p2.snake.x - beforeHead.x, headDy = p2.snake.y - beforeHead.y;
  var trailDx = p2.snake.trail[5].x - beforeTrail.x;
  var trailDy = p2.snake.trail[5].y - beforeTrail.y;
  ok(Math.abs(headDx - trailDx) < 1e-6 && Math.abs(headDy - trailDy) < 1e-6,
    '**软校正让头与整条 trail 同量平移**（不会把头从身体轨迹上拉开）',
    'head=(' + headDx + ',' + headDy + ') trail=(' + trailDx + ',' + trailDy + ')');

  // 回归：30Hz 权威帧若持续带同一 15px 时延偏差，最新残差应替换旧值，
  // 不能每 33ms 累加。旧实现会积到约 79px，并让蛇每帧反向移动 5.4px。
  var p3 = new CS.SelfPredictor();
  p3.attach(snapOf(ref), cfg.COLOR_KEYS.slice(0, 4));
  p3.snake.speed = 150;
  var prevPX = p3.snake.x, minStep = Infinity, maxPending = 0;
  for (i = 0; i < 180; i++) {
    p3.update(16.67, 0);
    if (i % 2 === 1) {
      var stale = snapOf(p3.snake);
      stale.x = p3.snake.x - 15;
      p3.reconcile(stale);
    }
    var stepX = p3.snake.x - prevPX;
    prevPX = p3.snake.x;
    if (stepX < minStep) minStep = stepX;
    if (Math.abs(p3._corr.x) > maxPending) maxPending = Math.abs(p3._corr.x);
  }
  ok(maxPending <= 15.1,
    '**30Hz 重复权威偏差不会积分膨胀**（pending ≤15px，实测 ' + maxPending.toFixed(1) + '）');
  ok(minStep >= -0.01,
    '**固定 15px 网络时延下预测蛇不反向抖动**（最小步进 ' + minStep.toFixed(2) + 'px）',
    '旧实现为 -5.39px/帧');
  ok(p3.maxNeckGap <= cfg.SEG_SPACING + 0.1,
    '头到首节间距始终受控（max ' + p3.maxNeckGap.toFixed(1) + 'px）');
  Math.random = orig;
})();

// ---------------- RemoteMatch + 插值联动 ----------------
section('RemoteMatch 插值渲染采样');
(function () {
  require(path.join(JS, 'net', 'netMatch.js'));
  var rm = new CS.RemoteMatch(99, { interpDelayMs: 120, tickMs: 66 }); // 本机 id=99（不在快照里）
  function wireSnap(id, x, tick) {
    return { t: 'snap', tk: tick, ack: 0, tm: 0, bl: [], mt: [{
      id: 9, x: 1000 + (tick - 1) * 9, y: 700, vx: 140, vy: 0, c: 'g', ph: 0,
      tr: [990 + (tick - 1) * 9, 700]
    }],
      sn: [{ id: id, nm: '对手', pl: 1, al: 1, x: Math.round(x), y: 500, a: 0, sp: 150,
             co: 'r', sg: [Math.round(x), 500], kl: 0, es: 0, et: 0, ml: 1, bt: 0, sl: 0 }] };
  }
  rm.applySnap(wireSnap(7, 100, 1), 1000);
  rm.applySnap(wireSnap(7, 133, 2), 1066);
  ok(rm.applySnap(wireSnap(7, 0, 1), 1100) === false,
    'RemoteMatch 自身拒绝旧 tick，不先污染 blocks/meteors/视图');
  rm.renderSample(1153); // renderT=1033 → 中点
  var bot = rm.bots[0];
  ok(bot && Math.abs(bot.snake.x - 116.5) < 0.6, '对手蛇渲染位 = 插值中点', 'x=' + (bot && bot.snake.x));
  ok(rm.meteors.length === 1 && Math.abs(rm.meteors[0].x - 1004.5) < 0.6,
    'RemoteMatch 每帧输出流星插值位置（真实消费链）', 'x=' + (rm.meteors[0] && rm.meteors[0].x));
  rm.renderSample(99999);
  ok(Math.abs(rm.bots[0].snake.x - 172) < 0.01, '超出最新帧短外推后停在上限', 'x=' + rm.bots[0].snake.x);

  var noInterp = new CS.RemoteMatch(99, { interpDelayMs: 0 });
  ok(noInterp.applySnap(wireSnap(7, 100, 65535), 2000) === true, '插值关闭时接受回绕前 tick');
  ok(noInterp.applySnap(wireSnap(7, 105, 0), 2033) === true && noInterp.tick === 65536,
    '插值关闭时也展开 uint16 tick 回绕，不永久拒绝新快照', 'tick=' + noInterp.tick);
})();

// ---------------- 汇总 ----------------
console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) process.exit(1);
