'use strict';
/**
 * team.test.js — 团队战模式（2v2v2v2v2）回归测试（v3.2）
 * 运行：node test/net/team.test.js
 *
 * 覆盖 docs/design/02-team-mode.md §9 的三组核心断言：
 *   A. 碰撞免疫：同队 head→body / head→head 双方存活、无咬断；
 *      异队 head→body 撞者死、被撞者 +1 击杀 + 咬断；异队 head→head 双双淘汰。
 *   B. 匹配分组：_buildTeams 同 teamCode 同队 / solo 两两配对 / 落单自成 1 人队 /
 *      同 code 第 3 人降级；_formTeam 补满 5×2（单人 = 本人 + 1 AI 队友 + 4 个纯 AI 队）；
 *      满 5 队立即开局。
 *   C. 队伍胜负与观战：本人死而队友活 → you_died 转观战、暂不结算；整队淘汰 → over(dead)；
 *      仅剩 1 队 → 该队 over(win) 且带 teams 排行；超时 → 按队伍总分排名、非第一队 over(lose)。
 *
 * 纯 Node 运行，不走真实网络：碰撞用 HeadlessGame + 手工布局的 Snake 直接调 collide()；
 * 匹配/胜负用 Matchmaker + Room，send 用记录桩捕获 matched/event/over。
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
var SRVR = path.join(__dirname, '..', '..', 'server');

['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'ai', 'multiplayer']
  .forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'transport', 'headlessGame']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });
var Matchmaker = require(path.join(SRVR, 'matchmaker.js'));
var baseCfg = require(path.join(SRVR, 'config.js'));

var CS = globalThis.CS;
var cfg = CS.config;

var passed = 0, failed = 0, failedNames = [];
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); failedNames.push(name); }
}
function section(t) { console.log('\n[' + t + ']'); }

// 颜色模式：循环 4 色，任意删一节都不可能凑出 4 连（避免被咬后意外消除干扰长度断言）
var PAT = ['red', 'blue', 'green', 'orange'];
var KEYS = cfg.COLOR_KEYS.slice(0, 4);

/**
 * 构造一条位置/身体完全可控的蛇：头在 (x,y)，身体沿 dir 方向按 SEG_SPACING 排开。
 * collide() 只读 s.x/s.y（头）与 segPos[k]（身体），因此手工铺开 segPos 即可精确摆位。
 */
function makeSnake(x, y, len, dir) {
  var s = new CS.Snake(x, y, len, 0, KEYS);
  s.colors = [];
  for (var i = 0; i < len; i++) s.colors.push(PAT[i % PAT.length]);
  s.x = x; s.y = y;
  var dx = Math.cos(dir), dy = Math.sin(dir);
  s.segPos = [{ x: x, y: y }];
  for (var j = 1; j < s.totalLength(); j++) {
    s.segPos.push({ x: x + dx * cfg.SEG_SPACING * j, y: y + dy * cfg.SEG_SPACING * j });
  }
  return s;
}

/** 造一个无内部墙、带真实 spawner 的无头宿主 + Multiplayer（碰撞单元测试用） */
function freshMp() {
  var g = new CS.HeadlessGame({ wallSegments: 0 });
  g.walls.rects = []; // 清空内部墙：碰撞断言只受头/身体影响，杜绝墙体干扰
  g.spawner = new CS.Spawner(g.walls, null);
  g.spawner.unlockedKeys = g.unlockedKeys;
  g.mp = new CS.Multiplayer(g);
  return g;
}

// 身体相对头的延伸方向
var LEFT = Math.PI, RIGHT = 0, UP = -Math.PI / 2;

// ---------------- A. 碰撞免疫 ----------------
section('A. 碰撞免疫（同队免死 / 异队照常）');
(function () {
  // A1 同队 head→body：A 头压住 B 的 segPos[2]，同队 → 双方存活、无击杀、无咬断
  var g1 = freshMp();
  var A1 = g1.mp.addPlayer(makeSnake(2040, 1400, 6, UP), 'A1', 0);    // 头 = B 的 segPos[2]
  var B1 = g1.mp.addPlayer(makeSnake(2100, 1400, 6, LEFT), 'B1', 0);  // 身体左伸，segPos[2]=(2040,1400)
  g1.mp.collide();
  ok(A1.alive && B1.alive, 'A1 同队头撞身体：双方均存活');
  ok(B1.kills === 0, 'A1 同队头撞身体：被撞者不计击杀');
  ok(B1.snake.length() === 6, 'A1 同队头撞身体：无咬断（长度不变）', 'len=' + B1.snake.length());

  // A2 同队 head→head：头距 15px < 20px，同队 → 双方存活
  var g2 = freshMp();
  var A2 = g2.mp.addPlayer(makeSnake(2000, 1400, 6, LEFT), 'A2', 0);
  var B2 = g2.mp.addPlayer(makeSnake(2015, 1400, 6, RIGHT), 'B2', 0);
  g2.mp.collide();
  ok(A2.alive && B2.alive, 'A2 同队头对头：双方均存活（免死）');

  // A3 异队 head→body：撞者死、被撞者 +1 击杀 + 被咬短一节
  var g3 = freshMp();
  var A3 = g3.mp.addPlayer(makeSnake(2040, 1400, 6, UP), 'A3', 0);
  var B3 = g3.mp.addPlayer(makeSnake(2100, 1400, 6, LEFT), 'B3', 1);  // 异队
  g3.mp.collide();
  ok(!A3.alive, 'A3 异队头撞身体：撞者死亡');
  ok(B3.alive, 'A3 异队头撞身体：被撞者存活');
  ok(B3.kills === 1, 'A3 异队头撞身体：被撞者 +1 击杀', 'kills=' + B3.kills);
  ok(B3.snake.length() === 5, 'A3 异队头撞身体：被撞者被咬短一节', 'len=' + B3.snake.length());

  // A4 异队 head→head：头距 15px < 20px，异队 → 双双淘汰
  var g4 = freshMp();
  var A4 = g4.mp.addPlayer(makeSnake(2000, 1400, 6, LEFT), 'A4', 0);
  var B4 = g4.mp.addPlayer(makeSnake(2015, 1400, 6, RIGHT), 'B4', 1); // 异队
  g4.mp.collide();
  ok(!A4.alive && !B4.alive, 'A4 异队头对头：双双淘汰');
})();

// ---------------- B. 匹配分组 ----------------
section('B. 匹配分组（_buildTeams / _formTeam）');

// 可变时间源（驱动 matchmaker.tick 的超时补位判定）
var NOW = 0;
function testConfig() {
  return Object.assign({}, baseCfg, { nowFn: function () { return NOW; } });
}
/** 队列成员桩 */
function qm(connId, teamCode) {
  return { connId: connId, name: 'p_' + connId, send: function () {}, mode: 'team', teamCode: teamCode || null, joinedAt: 0 };
}

// B1~B5：_buildTeams 纯函数分组规则
(function () {
  var mm = new Matchmaker(testConfig(), {});
  var t1 = mm._buildTeams([qm('a'), qm('b')]);
  ok(t1.length === 1 && t1[0].length === 2, 'B1 两个 solo 真人编为同队');

  var t2 = mm._buildTeams([qm('a', 'X'), qm('b', 'X')]);
  ok(t2.length === 1 && t2[0].length === 2 && t2[0][0].teamCode === 'X', 'B2 相同 teamCode 两人同队');

  var t3 = mm._buildTeams([qm('a', 'X'), qm('b', 'X'), qm('c'), qm('d'), qm('e')]);
  ok(t3.length === 3 && t3[0].length === 2 && t3[1].length === 2 && t3[2].length === 1,
    'B3 同 code 成队 + solo 两两配对 + 落单自成 1 人队',
    'teams=' + t3.map(function (t) { return t.length; }).join(','));

  var t4 = mm._buildTeams([qm('a')]);
  ok(t4.length === 1 && t4[0].length === 1, 'B4 单人 solo 自成 1 人队（待 AI 补队友）');

  var t5 = mm._buildTeams([qm('a', 'X'), qm('b', 'X'), qm('c', 'X')]);
  ok(t5.length === 2 && t5[0].length === 2 && t5[1].length === 1, 'B5 同 code 第 3 人降级为 solo 队');
})();

/** 驱动一场团队匹配（强制超时补位开局），返回 { room, sinks, mm } */
function formTeamRoom(members) {
  NOW = 0;
  var room = null, sinks = {};
  var mm = new Matchmaker(testConfig(), { onRoomCreated: function (r) { room = r; } });
  members.forEach(function (m) {
    var box = { events: [], overs: [], matched: null };
    sinks[m.connId] = box;
    mm.add({
      connId: m.connId, name: m.name, mode: 'team', teamCode: m.teamCode || null,
      send: function (msg) {
        if (msg.t === 'matched') box.matched = msg;
        else if (msg.t === 'event') box.events.push(msg);
        else if (msg.t === 'over') box.overs.push(msg);
      }
    });
  });
  NOW = baseCfg.TEAM_MATCH_TIMEOUT_MS + 1; // 越过匹配等待上限 → 超时以现有真人 + AI 补满开局
  mm.tick();
  return { room: room, sinks: sinks, mm: mm };
}
/** 取某队的全部 Entry */
function entriesOfTeam(room, tid) {
  return room.game.mp.allEntries().filter(function (e) { return e.teamId === tid; });
}

// B6：单人 → 超时补位建成 5×2，本人 + 1 AI 队友 + 4 个纯 AI 队
(function () {
  var r = formTeamRoom([{ connId: 'solo1', name: '独行侠' }]);
  ok(r.room && r.room.mode === 'team', 'B6 单人超时后建成团队房间');
  ok(r.room.game.mp.teamMode === true, 'B6 房间为 teamMode（AI 不重生）');
  ok(r.room.game.mp.allEntries().length === 10, 'B6 编制补满 10 槽（5×2）', 'n=' + r.room.game.mp.allEntries().length);
  var spec = r.room.teamSpecs;
  ok(spec.length === 5 && spec.every(function (t) { return t.length === 2; }), 'B6 teamSpecs 为 5×2');
  ok(spec[0][0].isHuman === true && spec[0][1].isHuman === false, 'B6 单人 = 本人 + 1 AI 队友');
  var pureAi = true;
  for (var t = 1; t < 5; t++) for (var s = 0; s < 2; s++) if (spec[t][s].isHuman) pureAi = false;
  ok(pureAi, 'B6 其余 4 队为纯 AI 队');
  var team0 = entriesOfTeam(r.room, 0);
  ok(team0.length === 2 && team0.filter(function (e) { return e.isPlayer; }).length === 1, 'B6 队0 含 1 真人 + 1 AI');
  var mt = r.sinks.solo1.matched;
  ok(mt && mt.mode === 'team' && mt.myTeam === 0, 'B6 matched 带 mode=team / myTeam=0');
  ok(Array.isArray(mt.teams) && mt.teams.length === 5 && mt.teams.every(function (t) { return t.length === 2; }),
    'B6 matched 带 5×2 队伍编制');
  r.mm.destroy();
})();

// B7：5 个好友房 × 2 → 第 9 人到达即凑满 5 队（4 队满编 + 1 队暂落单）立即开局；
//      落单队由 AI 补队友，第 10 人（与落单者同 code）留给下一局。
//      注：_buildTeams 贪心配对，「5 队」在第 9 人即可凑齐，故房间不等第 10 人。
(function () {
  NOW = 0;
  var room = null;
  var mm = new Matchmaker(testConfig(), { onRoomCreated: function (r) { room = r; } });
  var codes = ['A', 'B', 'C', 'D', 'E'];
  for (var i = 0; i < 10; i++) {
    mm.add({ connId: 'p' + i, name: 'P' + i, send: function () {}, mode: 'team', teamCode: codes[Math.floor(i / 2)] });
  }
  ok(room && room.mode === 'team', 'B7 凑满 5 队立即开局（无需超时）');
  ok(room.game.mp.allEntries().length === 10, 'B7 编制补满 10 槽');
  var fullHumanTeams = room.teamSpecs.filter(function (t) { return t[0].isHuman && t[1].isHuman; }).length;
  ok(fullHumanTeams === 4, 'B7 4 个好友房满编（各 2 真人）', 'full=' + fullHumanTeams);
  var humans = room.game.mp.allEntries().filter(function (e) { return e.isPlayer; }).length;
  ok(humans === 9, 'B7 本局 9 真人 + 1 AI（第 10 人留待下一局）', 'humans=' + humans);
  mm.destroy();
})();

// B8：9 个 solo → 贪心配对为 4 对 + 1 落单 = 5 队，凑满即开局；落单队由 AI 补队友（9 真人 + 1 AI）
(function () {
  NOW = 0;
  var room = null;
  var mm = new Matchmaker(testConfig(), { onRoomCreated: function (r) { room = r; } });
  for (var i = 0; i < 9; i++) {
    mm.add({ connId: 'q' + i, name: 'Q' + i, send: function () {}, mode: 'team', teamCode: null });
  }
  ok(room && room.mode === 'team', 'B8 9 solo 贪心凑满 5 队立即开局');
  ok(room.game.mp.allEntries().length === 10, 'B8 编制补满 10 槽');
  var humans = room.game.mp.allEntries().filter(function (e) { return e.isPlayer; }).length;
  ok(humans === 9, 'B8 9 真人 + 1 AI（落单队补位）', 'humans=' + humans);
  mm.destroy();
})();

// ---------------- C. 队伍胜负与观战 ----------------
section('C. 队伍胜负与观战（room._checkPlayerDeaths / _checkOver）');

// C1 观战：本人死而队友活 → you_died 转观战、暂不结算；整队淘汰 → 双方 over(dead)
(function () {
  var r = formTeamRoom([{ connId: 's1', name: '观甲', teamCode: 'S' }, { connId: 's2', name: '观乙', teamCode: 'S' }]);
  var room = r.room;
  ok(r.sinks.s1.matched.myTeam === 0 && r.sinks.s2.matched.myTeam === 0, 'C1 同 teamCode 两人编入同队（队0）');

  room.game.mp.kill(room.humans.s1.entry); // 本人先死，队友仍活
  room._checkPlayerDeaths();
  var died = r.sinks.s1.events.filter(function (m) { return m.k === 'you_died'; });
  ok(died.length === 1 && died[0].team === 0, 'C1 本人死/队友活 → 收到 you_died（team=0）转观战');
  ok(r.sinks.s1.overs.length === 0, 'C1 队友仍活 → 暂不结算（无 over）');

  room.game.mp.kill(room.humans.s2.entry); // 队友也阵亡 → 整队淘汰
  room._checkPlayerDeaths();
  ok(r.sinks.s1.overs.length === 1 && r.sinks.s1.overs[0].reason === 'dead', 'C1 整队淘汰 → 本人收到 over(dead)');
  ok(r.sinks.s2.overs.length === 1 && r.sinks.s2.overs[0].reason === 'dead', 'C1 整队淘汰 → 队友收到 over(dead)');
  r.mm.destroy();
})();

// C2 淘汰计数 + 仅剩 1 队 → 该队 WIN（带 teams 排行）
(function () {
  var r = formTeamRoom([{ connId: 'w1', name: '胜甲', teamCode: 'W' }, { connId: 'w2', name: '胜乙', teamCode: 'W' }]);
  var room = r.room;
  ok(room.game.mp.aliveTeamCount() === 5, 'C2 初始 5 队存活');

  room.humans.w1.entry.elimScore = 100; // 队0 制造领先分，避免平分导致排名不确定
  for (var tid = 1; tid <= 4; tid++) {  // 逐队淘汰 1..4（每队 2 条 AI）
    entriesOfTeam(room, tid).forEach(function (e) { room.game.mp.kill(e); });
  }
  ok(room.game.mp.aliveTeamCount() === 1, 'C2 队1-4 全灭 → 仅剩 1 队');

  room._checkOver();
  var o1 = r.sinks.w1.overs[r.sinks.w1.overs.length - 1];
  var o2 = r.sinks.w2.overs[r.sinks.w2.overs.length - 1];
  ok(o1 && o1.reason === 'win', 'C2 仅剩本队 → 本人 over(win)');
  ok(o2 && o2.reason === 'win', 'C2 仅剩本队 → 队友 over(win)');
  ok(Array.isArray(o1.teams) && o1.teams.length === 5, 'C2 over 带 5 队排行', 'teams=' + (o1.teams && o1.teams.length));
  var t0 = o1.teams.filter(function (t) { return t.id === 0; })[0];
  ok(t0 && t0.rank === 1 && t0.aliveCount === 2, 'C2 本队 rank=1 且 2 人存活');
  ok(o1.teams[0].id === 0, 'C2 队排行第一为队0（总分最高）');
  r.mm.destroy();
})();

// C3 超时 → 按队伍总分排名，非第一队 LOSE
(function () {
  var r = formTeamRoom([{ connId: 't1', name: '时甲', teamCode: 'T' }, { connId: 't2', name: '时乙', teamCode: 'T' }]);
  var room = r.room;
  room.humans.t1.entry.elimScore = 10;            // 队0 = 10
  entriesOfTeam(room, 1)[0].elimScore = 50;       // 队1 = 50（全场最高）
  room.game.mp.timeMs = room.config.MATCH_MAX_MS; // 触发超时
  room._checkOver();
  var ot = r.sinks.t1.overs[r.sinks.t1.overs.length - 1];
  ok(ot && ot.reason === 'lose', 'C3 超时且本队非第一 → 本人 over(lose)');
  ok(ot.teams && ot.teams[0].id === 1 && ot.teams[0].score === 50, 'C3 队排行第一为得分最高的队1');
  var t0 = ot.teams.filter(function (t) { return t.id === 0; })[0];
  ok(t0 && t0.rank === 2, 'C3 本队 rank=2（按总分）');
  r.mm.destroy();
})();

// ---------------- 汇总 ----------------
console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) { console.log('失败项：' + failedNames.join(' / ')); process.exit(1); }
process.exit(0);
