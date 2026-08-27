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
  var buf = new CS.InterpBuffer(120);
  // t=1000 帧 A：x=100；t=1066 帧 B：x=133（模拟 30px/tick 移动）
  buf.push({ tk: 1, sn: [fakeSnapSnake(1, 100, 500, 0, 6)] }, 1000, P.deSnake);
  buf.push({ tk: 2, sn: [fakeSnapSnake(1, 133, 500, 0, 6)] }, 1066, P.deSnake);

  // 渲染时刻 = now - 120：now=1153 → renderT=1033（A/B 中点）
  var s = buf.sample(1153);
  ok(s && s[1], '采样返回蛇数据');
  ok(Math.abs(s[1].x - 116.5) < 0.6, '位置插值到中点', 'x=' + s[1].x);
  ok(Math.abs(s[1].segPos[2].x - (100 - 2 * cfg.SEG_SPACING + 16.5)) < 0.6, '节心同步插值');

  // 超出最新帧：钳制到最新（不外插，避免穿墙）
  s = buf.sample(99999);
  ok(Math.abs(s[1].x - 133) < 0.01, '渲染时刻超过最新帧 → 钳制到最新快照');

  // 角度最短弧：350° → 10° 中点应为 0°（而非 180°）
  var buf2 = new CS.InterpBuffer(120);
  var a350 = -Math.PI / 18, a10 = Math.PI / 18;
  buf2.push({ tk: 1, sn: [fakeSnapSnake(1, 0, 0, a350, 3)] }, 1000, P.deSnake);
  buf2.push({ tk: 2, sn: [fakeSnapSnake(1, 0, 0, a10, 3)] }, 1066, P.deSnake);
  var s2 = buf2.sample(1153);
  ok(Math.abs(s2[1].angle) < 0.01, '角度插值走最短弧（350°→10° 中点≈0°）', 'angle=' + s2[1].angle);

  // 节数变化（消除/变长瞬间）：取较新帧不插值
  var buf3 = new CS.InterpBuffer(120);
  buf3.push({ tk: 1, sn: [fakeSnapSnake(1, 100, 0, 0, 6)] }, 1000, P.deSnake);
  buf3.push({ tk: 2, sn: [fakeSnapSnake(1, 133, 0, 0, 3)] }, 1066, P.deSnake);
  var s3 = buf3.sample(1153);
  ok(s3[1].segPos.length === 3 && Math.abs(s3[1].x - 116.5) < 0.6,
    '节数变化时节心取较新帧、头部正常插值', 'len=' + s3[1].segPos.length + ' x=' + s3[1].x);
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
  Math.random = orig;
})();

// ---------------- RemoteMatch + 插值联动 ----------------
section('RemoteMatch 插值渲染采样');
(function () {
  require(path.join(JS, 'net', 'netMatch.js'));
  var rm = new CS.RemoteMatch(99, { interpDelayMs: 120 }); // 本机 id=99（不在快照里）
  function wireSnap(id, x) {
    return { t: 'snap', tk: 1, ack: 0, tm: 0, bl: [], mt: [],
      sn: [{ id: id, nm: '对手', pl: 1, al: 1, x: Math.round(x), y: 500, a: 0, sp: 150,
             co: 'r', sg: [Math.round(x), 500], kl: 0, es: 0, et: 0, ml: 1, bt: 0, sl: 0 }] };
  }
  rm.applySnap(wireSnap(7, 100), 1000);
  rm.applySnap(wireSnap(7, 133), 1066);
  rm.renderSample(1153); // renderT=1033 → 中点
  var bot = rm.bots[0];
  ok(bot && Math.abs(bot.snake.x - 116.5) < 0.6, '对手蛇渲染位 = 插值中点', 'x=' + (bot && bot.snake.x));
  rm.renderSample(99999);
  ok(Math.abs(rm.bots[0].snake.x - 133) < 0.01, '超出最新帧钳制到最新');
})();

// ---------------- 汇总 ----------------
console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) process.exit(1);
