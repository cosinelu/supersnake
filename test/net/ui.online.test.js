'use strict';
/**
 * ui.online.test.js — M5 联机 UI 管线回归（无浏览器：Game + OnlineMatch + LocalTransport 直驱）
 *
 * 覆盖：
 *  1. startOnline → matching 状态、matched 建图（墙体下发）
 *  2. 首帧快照 → 切 play、预测体挂接、game.snake 就位
 *  3. 帧循环（pump + update）→ HUD 计分同步、哑 spawner 刷新、插值/预测无崩溃
 *  4. 掉线判负 → mpResult.dropped 结算
 *  5. 正常死亡结算 → mpResult.rank/score 齐备 + 在线最佳持久化
 *  6. 取消匹配 → 回菜单、控制器释放
 *
 * 运行：node test/net/ui.online.test.js
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'joystick', 'ai', 'multiplayer', 'game']
  .forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'transport', 'headlessGame', 'localTransport', 'interpolation', 'prediction', 'netMatch', 'wsTransport', 'onlineMatch']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS;

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

/** 构造一个进入 matching 状态的在线对局（LocalTransport 手动泵） */
function makeOnline(nick) {
  var game = new CS.Game(1280, 720);
  var om = new CS.OnlineMatch(game, { transport: new CS.LocalTransport({ tickMs: 33, snapEvery: 2 }), nick: nick || '测试员' });
  game.mode = 'multi';
  game.online = om;
  game.setState('matching');
  om.begin(); // LocalTransport：同步 matched + start
  return { game: game, om: om };
}

/** 泵 n 个 tick（服务器模拟 + 客户端帧更新交替） */
function drive(ctx, n) {
  for (var i = 0; i < n; i++) {
    ctx.om.transport.pump(33);
    if (ctx.game.state === 'play') ctx.om.update(33);
    ctx.game.timeMs += 33; // update 顶部时间流（非 play 状态 game.update 提前返回，这里直推）
    ctx.game.particles.update(33);
  }
}

console.log('[M5 联机 UI 管线]');

// ---- 1. 匹配阶段 ----
var c1 = makeOnline();
ok(c1.game.state === 'matching', 'begin 后处于 matching 状态');
ok(!!c1.game.walls && c1.game.walls.W > 0, 'matched 建图：walls 就位');
ok(c1.game.walls.rects.length > 0, 'matched 下发初始墙体（' + c1.game.walls.rects.length + ' 段）');
ok(c1.game.mp === null || typeof c1.game.mp.leaderboard === 'function', 'mp 为 RemoteMatch 视图');
ok(/匹配成功|开局/.test(c1.om.status), '状态行显示匹配进展（' + c1.om.status + '）');
ok(c1.game.spawner && Array.isArray(c1.game.spawner.blocks), '哑 spawner 就位');
// 诊断 HUD 显隐：matched 缺字段（LocalTransport / 旧服务器）必须等同 false，
// 与 official 的目标行为一致 —— 显示诊断是 dev 的显式特权，不是缺省。
ok(c1.om.debugHud === false, 'matched 缺 debugHud 字段时按 false（official 行为）');

// ---- 2. 首帧快照 → play ----
drive(c1, 3);
ok(c1.game.state === 'play', '首帧快照后切入 play');
ok(c1.game.snake && c1.game.snake === c1.om.predictor.snake, 'game.snake = 预测蛇');
ok(c1.om._attached, '预测体已挂接');
ok(c1.game.snake.segPos.length === c1.game.snake.colors.length + 1, '预测蛇节数组形状正确（含尾巴节）');

// ---- 3. 帧循环：HUD 同步 + spawner 刷新 + 插值/预测稳定 ----
drive(c1, 90); // ~3s
var g = c1.game;
ok(g.elapsed > 1000, 'elapsed 跟随服务器 timeMs（' + g.elapsed + 'ms）');
ok(g.score === g.survivalScore + g.elimScore + g.mpBonusScore, '总分 = 生存+消除+加成（' + g.score + '）');
ok(g.survivalScore > 0, '生存分已从快照同步（' + g.survivalScore + '）');
ok(g.survivalScore >= 0 && g.elimScore >= 0, '分项计分非负');
ok(g.spawner.blocks.length > 0, '色块视图非空（' + g.spawner.blocks.length + '）');
ok(g.mp.bots.length >= 1, '对手视图（AI）非空（' + g.mp.bots.length + '）');
ok(typeof g.mp.leaderboard()[0].length === 'number', '排行榜接口可用');
ok(g.snake.x >= 0 && g.snake.x <= g.walls.W && g.snake.y >= 0 && g.snake.y <= g.walls.H, '预测蛇坐标在地图内');
ok(isFinite(g.camera.x) && isFinite(g.camera.y), '相机坐标有效');

// ---- 3b. HUD 诊断数据：1 秒节流 + 流量字段 ----
var hud1 = c1.om.netInfoHud();
ok(c1.om.netInfoHud() === hud1, 'netInfoHud 同秒返回同一缓存对象（HUD 1 秒刷新一次）');
ok(typeof hud1.下行KBs === 'number' && typeof hud1.上行KBs === 'number', 'netInfo 含上下行 KB/s');
ok(/↓\d/.test(c1.om.netSummary()), 'netSummary 单行摘要含下行流量（' + c1.om.netSummary() + '）');

// ---- 4. 掉线判负 ----
var c2 = makeOnline('掉线君');
drive(c2, 10);
c2.om._finish(CS.protocol.OVER_REASON.DROPPED, null, true);
ok(c2.game.state === 'over', '掉线后进入结算');
ok(c2.game.mpResult && c2.game.mpResult.dropped === true, 'mpResult 标记 dropped');
ok(c2.game.mpResult.online === true, 'mpResult 标记 online');

// ---- 5. 正常死亡结算 + 在线最佳持久化 ----
var c3 = makeOnline('勇士');
drive(c3, 10);
var fakeRanks = [
  { id: 999, name: 'AI', isPlayer: false, alive: true, score: 500, length: 30, kills: 2, rank: 1 },
  { id: c3.om.playerId, name: '勇士', isPlayer: true, alive: false, score: 120, length: 12, kills: 1, rank: 2 }
];
c3.om._finish(CS.protocol.OVER_REASON.DEAD, fakeRanks, false);
ok(c3.game.state === 'over', '死亡后进入结算');
ok(c3.game.mpResult.rank === 2, '名次取服务器 ranks（第 2 名）');
ok(c3.game.mpResult.finalLen === 12, '最终节数取 ranks');
ok(c3.game.mpResult.kills === 1, '击杀数取 ranks');
var ob = CS.storage.get('crayon_snake_web_online_best', null);
ok(ob && ob.len >= 0 && ob.score >= 0, '在线最佳已持久化（' + JSON.stringify(ob) + '）');

// ---- 6. 取消匹配 ----
var c4 = makeOnline('逃跑君');
c4.game.cancelOnline();
ok(c4.game.state === 'menu', '取消匹配回菜单');
ok(c4.game.online === null, '控制器已释放');
ok(c4.om._disposed === true, '传输已 dispose');

// ---- 7. 单机模式不受 online 影响（防护：online=null 时 updateMulti 原路径）----
var g5 = new CS.Game(1280, 720);
g5.startMulti();
for (var i = 0; i < 60; i++) g5.update(33);
ok(g5.state === 'play' && g5.mp && g5.mp.playerEntry, '本地多人对战不受影响');

// ---- 8. 通道切换必须同步切换真实插值间隔 ----
var ft = new CS.TransportBase();
ft.connect = function () { this._emit('open'); };
ft.joinMatch = function () {};
ft.cancelMatch = function () {};
ft.sendInput = function () {};
ft.accelDiag = {
  state: 'fallback', phase: 'hello', reason: 'hello_ack_timeout',
  target: 'https://dev-snake.pippocao.top:8093/wt',
  webTransportSupported: true, secureContext: true, helloSent: 5
};
ft.diagnostics = function () {
  return {
    rttMs: 48, rttP50Ms: 45, rttP95Ms: 72, rttJitterMs: 6,
    arrivalP50Ms: 66, arrivalP95Ms: 120, arrivalMaxMs: 180,
    arrivalJitterMs: 15, frameLossPct: 0, latePct: 12.5,
    stalls: 2, wsBufferedBytes: 0
  };
};
var g6 = new CS.Game(390, 844);
var om6 = new CS.OnlineMatch(g6, { transport: ft, nick: '分频测试' });
g6.online = om6;
om6.begin();
ft._emit('matched', {
  roomId: 'r', playerId: 1, players: [{ id: 1, name: '分频测试' }],
  countdownMs: 0, W: 2400, H: 1600, walls: [],
  snapIntervalMs: 66, tcpSnapIntervalMs: 66, accelSnapIntervalMs: 33,
  tcpSnapEvery: 2, accelSnapEvery: 1, udpDup: 3,
  udpPort: 8092, wtPort: 8093
});
ok(om6.channel.kind === 'tcp' && om6.channel.snapIntervalMs === 66,
  '初始 TCP 保底采用 66ms 快照间隔');
ok(om6.remote && om6.remote.interpDelayMs() >= 118,
  '**wss 使用约 120ms 插值缓冲**（不拿 70ms 硬扛 TCP 队头阻塞）');
ft._emit('udp', { active: true, kind: 'wt' });
ok(om6.channel.kind === 'wt' && om6.channel.snapIntervalMs === 33,
  'WebTransport 激活后切到 33ms 快照间隔');
ok(om6.remote.interpDelayMs() === 70,
  '加速通道使用 70ms 低延迟插值缓冲');
ft._emit('udp', { active: false, kind: 'wt' });
ok(om6.channel.kind === 'tcp' && om6.remote.interpDelayMs() >= 118,
  '**中途降级 wss 后真实插值缓冲恢复约 120ms**');
var ni6 = om6.netInfo();
ok(ni6.WSS延迟ms === 48 && ni6.快照迟到率 === 12.5 && ni6.插值延迟ms >= 118,
  'netInfo 暴露 RTT / 快照迟到率 / 当前插值延迟');
ok(ni6.WebTransport支持 === true && ni6.加速状态 === 'fallback' &&
  ni6.加速失败原因 === 'hello_ack_timeout' && ni6.加速目标.indexOf(':8093/wt') >= 0,
  '**netInfo 暴露 WebTransport 支持、失败阶段/原因和实际目标**');
ok(/WSS/.test(om6.netSummary()) && /48ms/.test(om6.netSummary()) && /WT超时/.test(om6.netSummary()),
  '手机 HUD 摘要包含实际协议、延迟与 WT 回落原因（' + om6.netSummary() + '）');
om6.dispose();

console.log('');
console.log('========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
