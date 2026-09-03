'use strict';
/**
 * room.test.js — 无头对局（HeadlessGame）+ 协议 + LocalTransport/RemoteMatch 的 Node 集成测试
 * 运行：node test/net/room.test.js
 * 覆盖：M0.5（协议编解码/量化精度/本地数据源一致性）、M1.4（无头整局/确定性/性能基准）
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');

['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'ai', 'multiplayer']
  .forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'transport', 'headlessGame', 'localTransport', 'netMatch']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS;
var cfg = CS.config, P = CS.protocol;

var passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); failedNames.push(name); }
}
var failedNames = [];
function section(t) { console.log('\n[' + t + ']'); }

/** 以固定种子跑一局无头对局，返回 { game, snapJson }（确定性复现用） */
function runSeededMatch(seed, ticks, playerNames) {
  var orig = Math.random;
  Math.random = CS.utils.makeRng(seed);
  CS.resetMultiplayerIds();
  try {
    var g = new CS.HeadlessGame({});
    g.setup(playerNames || ['甲', '乙', '丙', '丁']);
    for (var i = 0; i < ticks; i++) g.tick(33);
    var snap = P.snap(ticks, 0, g.mp.timeMs, g.mp.allEntries(), g.spawner.blocks, g.spawner.meteors);
    return { game: g, snapJson: JSON.stringify(snap) };
  } finally {
    Math.random = orig;
  }
}

// ---------------- 1. 协议编解码 ----------------
section('协议编解码');
(function () {
  // 客户端消息构造
  var j = P.join('测试玩家');
  ok(P.PROTO_VER === 2, '**外层协议版本随二进制 v2 一起升级，禁止新旧端混跑**');
  ok(j.t === 'join' && j.ver === P.PROTO_VER && j.name === '测试玩家', 'join 消息构造');
  var inp = P.input(7, Math.PI, true);
  ok(inp.t === 'input' && inp.seq === 7 && inp.bo === 1, 'input 消息构造（seq/boost）');

  // encode/decode 往返
  var m = P.decode(P.encode(j));
  ok(m && m.t === 'join' && m.name === '测试玩家', 'encode/decode 往返一致');
  ok(P.decode('not json') === null, '畸形 JSON 返回 null');
  ok(P.decode('{"noType":1}') === null, '缺 t 字段返回 null');
  ok(P.decode('x'.repeat(70000)) === null, '超长消息返回 null');

  // 量化精度
  ok(P.qCoord(123.4) === 123 && P.qCoord(123.6) === 124, '坐标量化到 1px');
  ok(Math.abs(P.qAngle(1.2345678) - 1.235) < 1e-9, '角度量化到 0.001rad');
  ok(P.qCoord(-0.4) === 0, '坐标量化负零安全');

  // 快照序列化/反序列化往返（用真实对局状态）
  var r = runSeededMatch(42, 10);
  var snap = JSON.parse(r.snapJson);
  ok(snap.t === 'snap' && snap.tk === 10 && Array.isArray(snap.sn) && snap.sn.length >= 4,
    '快照结构完整（snakes ≥ 4 真人）', 'sn=' + snap.sn.length);
  var d0 = P.deSnake(snap.sn[0]);
  var e0 = r.game.mp.allEntries()[0];
  ok(d0.id === e0.id && d0.name === e0.name && d0.colors.length === e0.snake.colors.length,
    'deSnake 还原 id/name/colors');
  ok(Math.abs(d0.x - e0.snake.x) < 1.1 && Math.abs(d0.y - e0.snake.y) < 1.1,
    '坐标往返精度损失 < 1.1px', 'dx=' + Math.abs(d0.x - e0.snake.x));
  ok(Math.abs(d0.angle - e0.snake.angle) < 0.0011, '角度往返精度损失 < 0.0011rad');
  ok(d0.segPos.length === e0.snake.segPos.length, '节心数组长度一致（含尾巴节）');
  var b0 = P.deBlock(snap.bl[0]);
  ok(typeof b0.x === 'number' && typeof b0.kind === 'string', 'deBlock 还原色块');
})();

// ---------------- 2. 无头对局整局 ----------------
section('无头对局整局（4 真人无输入 + AI）');
(function () {
  var r = runSeededMatch(7, 3000); // 99 秒模拟
  var g = r.game, mp = g.mp;
  ok(mp.players.length === 4, '4 名真人全部注册');
  ok(mp.bots.length >= cfg.MP_AI_START_COUNT, 'AI 初始编制 = ' + cfg.MP_AI_START_COUNT, 'bots=' + mp.bots.length);
  ok(mp.timeMs === 3000 * 33, 'timeMs 随 tick 推进');
  ok(g.spawner.grabEnabled === true, '彩色星投放已启用');
  ok(g.spawner.blocks.length > 0 && g.spawner.blocks.length <= cfg.MP_BLOCKS_MAX + 60,
    '色块数量在合理区间（含尸体/道具掉落）', 'blocks=' + g.spawner.blocks.length);
  var totalKills = 0, someDeath = false;
  mp.allEntries().forEach(function (e) {
    totalKills += e.kills;
    if (!e.alive) someDeath = true;
    ok(e.elimScore >= 0 && e.elimTotal >= 0, 'Entry ' + e.id + ' 计分非负');
  });
  ok(someDeath, '3000 tick 内发生淘汰（无输入真人应撞墙/被撞）');
  ok(mp.respawned > 0, 'AI 淘汰后自动补编（respawned=' + mp.respawned + '）');
  var lb = mp.leaderboard();
  ok(lb.length === mp.alivePlayerCount() + mp.aliveBotCount(), '排行榜覆盖全部活蛇');
})();

// ---------------- 3. 确定性复现 ----------------
section('确定性复现（同种子双跑一致）');
(function () {
  var a = runSeededMatch(2024, 1500);
  var b = runSeededMatch(2024, 1500);
  ok(a.snapJson === b.snapJson, '同种子 1500 tick 后快照 JSON 完全一致',
    'len a=' + a.snapJson.length + ' b=' + b.snapJson.length);
  var c = runSeededMatch(2025, 1500);
  ok(c.snapJson !== a.snapJson, '异种子结果不同（随机源确实生效）');
})();

// ---------------- 4. 性能基准 ----------------
section('性能基准');
(function () {
  var t0 = Date.now();
  runSeededMatch(99, 3000);
  var cost = Date.now() - t0;
  ok(cost < 3000, '3000 tick（8+ 蛇房）模拟耗时 < 3s', 'cost=' + cost + 'ms');
})();

// ---------------- 5. LocalTransport → RemoteMatch 数据流 ----------------
section('LocalTransport → RemoteMatch 数据流（本地联机管线）');
(function () {
  var orig = Math.random;
  Math.random = CS.utils.makeRng(555);
  CS.resetMultiplayerIds();
  try {
    var lt = new CS.LocalTransport({ tickMs: 33 });
    var gotMatched = null, gotStart = null, snaps = [], events = [], over = null;
    lt.onAll({
      matched: function (m) { gotMatched = m; },
      start: function (s) { gotStart = s; },
      snap: function (s) { snaps.push(s); },
      event: function (e) { events.push(e); },
      over: function (o) { over = o; }
    });
    lt.joinMatch('本机玩家');
    ok(gotMatched && gotMatched.playerId > 0 && gotMatched.W > 0, 'joinMatch 后立即 matched（含 playerId/地图尺寸）');
    ok(gotStart && gotStart.tick === 0, 'matched 后 start');

    // 模拟输入：先直行 100 tick，再转向
    for (var i = 0; i < 100; i++) lt.pump(33);
    lt.sendInput(Math.PI / 2, false);
    var seqAfterInput = lt._inputSeq;
    for (i = 0; i < 500; i++) lt.pump(33);

    ok(snaps.length > 0, '收到快照流（' + snaps.length + ' 帧）');
    var mono = true;
    for (i = 1; i < snaps.length; i++) if (snaps[i].tk <= snaps[i - 1].tk) mono = false;
    ok(mono, '快照 tick 单调递增');
    ok(snaps[snaps.length - 1].ack >= seqAfterInput, '快照 ack 不落后于已发输入 seq');

    // RemoteMatch 消费
    var rm = new CS.RemoteMatch(gotMatched.playerId);
    for (i = 0; i < snaps.length; i++) rm.applySnap(snaps[i]);
    ok(rm.playerEntry && rm.playerEntry.name === '本机玩家', 'RemoteMatch 找到本机玩家 Entry');
    ok(rm.bots.length >= cfg.MP_AI_START_COUNT, 'RemoteMatch.bots 覆盖其余蛇（AI 编制）', 'bots=' + rm.bots.length);
    ok(typeof rm.playerEntry.snake.length === 'function' && rm.playerEntry.snake.length() >= 1,
      '蛇视图方法面可用（length()）');
    ok(typeof rm.playerEntry.snake.headDir === 'function', '蛇视图方法面可用（headDir()）');
    ok(rm.leaderboard().length >= 1, '排行榜接口可用');
    ok(rm.blocks.length > 0, '色块视图非空');
    ok(rm.timeMs === snaps[snaps.length - 1].tm, 'timeMs 与快照一致');

    // 死亡结算（无输入转向可能已撞墙；未死则强制跑到底）
    for (i = 0; i < 3000 && !over; i++) lt.pump(33);
    ok(over && over.reason === P.OVER_REASON.DEAD && Array.isArray(over.ranks),
      '玩家死亡后收到 over（dead + ranks）');
    if (over) {
      var me = over.ranks.filter(function (r) { return r.id === gotMatched.playerId; })[0];
      ok(me && me.rank >= 1 && typeof me.score === 'number', 'ranks 含本人名次与分数');
    }
    lt.dispose();
  } finally {
    Math.random = orig;
  }
})();

// ---------------- 汇总 ----------------
console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) { console.log('失败项：' + failedNames.join(' / ')); process.exit(1); }
