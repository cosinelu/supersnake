'use strict';
/**
 * input.test.js — 摇杆输入不卡死回归（v3.0.2）
 * 运行：node test/net/input.test.js
 *
 * 背景（docs/design/01-game-design.md §3.7）：早期摇杆是「单指独占锁」
 * （onTouchStart 遇 active 直接 return、onTouchMove 要求 id 匹配），存在三类
 * **输入永久卡死**，用户表现为「我能动，对方很难动，但她能看到画面在动」：
 *   断点1 A 按着 → B 触屏被忽略 → 抬起 A → B 仍在屏却永不响应
 *   断点2 倒计时（matching 态）按住手指 → 开局后只有 touchmove 在流 → 整局锁死
 *   断点3 matched 时代码强制释放摇杆 → 代码态与手指物理态脱钩
 *
 * 放大器：onlineMatch.update 的 `if (ang !== null && selfAlive)` —— 角度为 null 就整帧
 * 不上行，服务器沿用旧角度让蛇直行，玩家感受为「蛇不听话一直往前撞」。
 *
 * 另覆盖 server/room.js 的 seq 回退隐患：客户端重连后 seq 从 0 重新计数，
 * 若服务端简单地「seq < lastSeq 就丢」，该玩家输入会被永久丢弃。
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'joystick',
  'ai', 'multiplayer', 'game'].forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'transport', 'headlessGame', 'interpolation', 'prediction', 'netMatch', 'onlineMatch']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS;

var passed = 0, failed = 0, failedNames = [];
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); failedNames.push(name); }
}
function section(t) { console.log('\n[' + t + ']'); }

function mkJoy() {
  var j = new CS.Joystick();
  j.setBase(82, 638, 52);   // 与 game.syncJoystick 的横屏取值一致
  return j;
}

// ---------------- 断点1：多点触控接管 ----------------
function t1() {
  section('断点1 多点触控：A 按着 → B 触屏 → 抬起 A');
  var j = mkJoy();
  j.onTouchStart(300, 400, 'A');
  ok(j.currentAngle() !== null, 'A 按下后有角度');
  j.onTouchStart(500, 300, 'B');           // B 加入（A 仍接管）
  ok(j.touchId === 'A', 'A 仍是接管者（避免两指互抢抖动）');
  j.onTouchEnd('A');                       // A 抬起 → 应转交给 B
  ok(j.active === true, 'A 抬起后摇杆仍激活（转交给 B）');
  ok(j.touchId === 'B', '控制权转交给 B', 'touchId=' + j.touchId);
  j.onTouchMove(600, 200, 'B');
  ok(j.currentAngle() !== null, 'B 拖动产生角度（原实现此处被吞）');

  // 非接管者抬起不应影响操作
  var j2 = mkJoy();
  j2.onTouchStart(300, 400, 'A');
  j2.onTouchStart(500, 300, 'B');
  j2.onTouchEnd('B');
  ok(j2.active && j2.touchId === 'A', '非接管者(B)抬起不影响 A 的操作');

  // 全部离屏才真正释放
  var j3 = mkJoy();
  j3.onTouchStart(300, 400, 'A');
  j3.onTouchStart(500, 300, 'B');
  j3.onTouchEnd('A'); j3.onTouchEnd('B');
  ok(!j3.active && j3.currentAngle() === null, '全部手指离屏后摇杆释放');
}

// ---------------- 断点2：非 play 态按住 → 开局 ----------------
function t2() {
  section('断点2 倒计时按住手指 → 进入 play → 拖动');
  var g = new CS.Game(1280, 720);
  g.setState('matching');
  g.onTouchStart(400, 400, 't1');           // matching 态按下（走按钮分支，但触点应被登记）
  ok(!!g.joystick.touches['t1'], 'matching 态也登记在屏触点');
  g.setState('play');                       // 开局：应自动 latch 仍按住的手指
  ok(g.joystick.active === true, '进入 play 自动接管已按住的手指（latchExisting）');
  g.onTouchMove(500, 300, 't1');
  ok(g.joystick.currentAngle() !== null, '开局后拖动立即生效（原实现整局锁死）');

  // 手指抬起后不应残留
  g.onTouchEnd('t1');
  ok(!g.joystick.active && g.joystick.currentAngle() === null, '抬起后正常释放');
}

// ---------------- 断点3：代码强制释放后手指仍在屏 ----------------
function t3() {
  section('断点3 代码强制释放摇杆后，手指仍在屏上继续拖');
  var j = mkJoy();
  j.onTouchStart(300, 400, 'X');
  j.release();                              // 模拟 onlineMatch._onMatched 的释放
  ok(!!j.touches['X'], 'release() 保留在屏触点集合（不清物理状态）');
  j.onTouchMove(400, 300, 'X');
  ok(j.currentAngle() !== null, 'release 后拖动自动重新接管（原实现被吞）');

  // reset() 才是硬清零
  var j2 = mkJoy();
  j2.onTouchStart(300, 400, 'X');
  j2.reset();
  ok(Object.keys(j2.touches).length === 0, 'reset() 清空触点集合（场景切换用）');
}

// ---------------- 在线控制器：_onMatched 后仍能上行输入 ----------------
function t4() {
  section('在线链路：_onMatched 释放摇杆后输入仍能上行');
  function FakeT() { this.sent = []; }
  FakeT.prototype.onAll = function () {};
  FakeT.prototype.sendInput = function (a) { this.sent.push(a); };
  FakeT.prototype.dispose = function () {};
  FakeT.prototype.cancelMatch = function () {};
  FakeT.prototype.connect = function () {};

  var g = new CS.Game(1280, 720);
  var t = new FakeT();
  var om = new CS.OnlineMatch(g, { transport: t, nick: 'me' });
  g.online = om;

  g.setState('matching');
  g.onTouchStart(600, 300, 'f1');            // 倒计时期间按住
  om._onMatched({ playerId: 1, players: [{ id: 1, name: 'me' }], countdownMs: 0, W: 4800, H: 3200, walls: [] });
  ok(!!g.joystick.touches['f1'], '_onMatched 后仍记得手指在屏');

  g.setState('play');
  ok(g.joystick.active === true, 'play 态自动接管该手指');

  // 让 remote 处于可上行状态（存活），跑几帧看是否真的发包
  om.remote = { playerEntry: { alive: true }, renderSample: function () {}, timeMs: 0 };
  om._attached = false;
  for (var i = 0; i < 6; i++) om.update(16.7);
  ok(t.sent.length > 0, '输入成功上行（' + t.sent.length + ' 次）',
    '一次都没发 → 卡死复现');
}

// ---------------- server: seq 回退不导致永久失效 ----------------
function t5() {
  section('server room.handleInput：seq 回退处理');
  var Room = require(path.join(__dirname, '..', '..', 'server', 'room.js'));
  var baseConfig = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
  var cfg = Object.assign({}, baseConfig, { COUNTDOWN_MS: 0 });

  CS.resetMultiplayerIds();
  var room = new Room({
    players: [{ connId: 'c1', name: 'P1', send: function () {} }],
    config: cfg, onEmpty: function () {}
  });
  room.start();
  room.step(1);                       // countdown(0) → running
  var h = room.humans['c1'];

  room.handleInput('c1', { seq: 100, a: 1.0 });
  ok(h.lastSeq === 100 && h.angle === 1.0, '正常输入被接受（seq=100）');

  // 小幅乱序：丢弃
  room.handleInput('c1', { seq: 98, a: 2.0 });
  ok(h.angle === 1.0 && h.lastSeq === 100, '小幅乱序包被丢弃（seq=98 < 100）',
    'angle=' + h.angle + ' lastSeq=' + h.lastSeq);

  // 大幅回退（重连后 seq 归零）：必须接受并重置基线，否则输入永久失效
  room.handleInput('c1', { seq: 1, a: 3.0 });
  ok(h.angle === 3.0 && h.lastSeq === 1,
    '重连后 seq 归零被接受并重置基线（防输入永久失效）',
    'angle=' + h.angle + ' lastSeq=' + h.lastSeq);

  // 重置后继续递增正常工作
  room.handleInput('c1', { seq: 2, a: 4.0 });
  ok(h.angle === 4.0, '基线重置后后续输入正常');

  // 异常跳变仍被拦
  room.handleInput('c1', { seq: 99999, a: 5.0 });
  ok(h.angle === 4.0, '异常跳变（seq=99999）被忽略', 'angle=' + h.angle);

  room.destroy();
}

// ---------------- 键盘优先级不受影响 ----------------
function t6() {
  section('回归：键盘优先级与死区');
  var j = mkJoy();
  j.onTouchStart(300, 400, 'A');
  var touchAngle = j.currentAngle();
  j.keysDown['w'] = { x: 0, y: -1 };
  ok(j.currentAngle() === Math.atan2(-1, 0), '键盘优先于摇杆');
  delete j.keysDown['w'];
  ok(j.currentAngle() === touchAngle, '松开键盘回落到摇杆角度');

  // 死区内不产生新角度
  var j2 = mkJoy();
  j2.onTouchStart(j2.baseX + 2, j2.baseY + 2, 'A'); // 死区内
  ok(j2.currentAngle() === null, '死区内按下不产生角度');
}

console.log('摇杆输入不卡死回归（v3.0.2）');
t1(); t2(); t3(); t4(); t5(); t6();

console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) { console.log('失败项：' + failedNames.join(' / ')); process.exit(1); }
process.exit(0);
