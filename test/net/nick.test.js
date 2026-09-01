'use strict';
/**
 * nick.test.js — 在线对战昵称唯一性测试（v3.1）
 * 运行：node test/net/nick.test.js
 * 背景：同一浏览器多标签页共享 localStorage，两个客户端会带完全相同的昵称进匹配；
 *       服务器必须在建房时去重（·2 ·3 …），且 AI 昵称不得与真人撞名。
 * 覆盖：Matchmaker._dedupeNames（同名/三名同名/12 字上限截断）+ addPlayer 昵称保留。
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');

['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'ai', 'multiplayer']
  .forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'transport', 'headlessGame']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS;
var baseConfig = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
var Matchmaker = require(path.join(__dirname, '..', '..', 'server', 'matchmaker.js'));

var passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

/** 用 n 个同名连接直接成团（ROOM_SIZE=n），返回 matched 消息里的 players 名单 */
function formWithNames(names) {
  var config = Object.assign({}, baseConfig, { ROOM_SIZE: names.length, COUNTDOWN_MS: 100 });
  var mm = new Matchmaker(config, {});
  var matchedMsg = null;
  names.forEach(function (name, i) {
    mm.add({
      connId: 'c' + i, name: name,
      send: function (obj) { if (obj.t === 'matched') matchedMsg = obj; }
    });
  });
  var out = matchedMsg ? matchedMsg.players.map(function (p) { return p.name; }) : null;
  mm.destroy();
  return out;
}

section('Matchmaker 建房昵称去重');
(function () {
  var names = formWithNames(['我1234', '我1234']);
  ok(names && names.length === 2, '双同名成团下发名单', JSON.stringify(names));
  ok(names && names[0] === '我1234' && names[1] === '我1234·2',
    '第二人追加 ·2 后缀', JSON.stringify(names));

  var three = formWithNames(['蛇王', '蛇王', '蛇王']);
  ok(three && three[0] === '蛇王' && three[1] === '蛇王·2' && three[2] === '蛇王·3',
    '三同名依次 ·2 ·3', JSON.stringify(three));

  var mixed = formWithNames(['阿猫', '阿狗']);
  ok(mixed && mixed[0] === '阿猫' && mixed[1] === '阿狗', '不同名不加后缀', JSON.stringify(mixed));

  // 12 字上限：基部截断到 10 字 + ·2
  var long12 = '一二三四五六七八九十甲乙'; // 12 字
  var longRes = formWithNames([long12, long12]);
  ok(longRes && longRes[1].length <= 12 && longRes[1] === long12.slice(0, 10) + '·2',
    '超长基部截断后加后缀（≤12 字）', JSON.stringify(longRes));

  // 预置名与后缀名撞车：'蛇王' '蛇王' '蛇王·2' → 第二人让出 ·2，第三人拿 ·2
  var tricky = formWithNames(['蛇王', '蛇王', '蛇王·2']);
  ok(tricky && new Set(tricky).size === 3, '后缀名撞车仍能全员唯一', JSON.stringify(tricky));
})();

section('真人昵称对 AI 昵称池保留');
(function () {
  CS.resetMultiplayerIds();
  var g = new CS.HeadlessGame({});
  var aiName = CS.config.AI_NICKNAMES[0]; // 取池子里第一个名，强制撞名场景
  g.setup([aiName]);
  ok(g.mp.usedNames[aiName] === true, 'addPlayer 把真人昵称登记进 usedNames');
  var botNames = g.mp.bots.map(function (b) { return b.name; });
  ok(botNames.indexOf(aiName) === -1, 'AI 不会取与真人相同的名字', JSON.stringify(botNames));
  // 真人被淘汰后名字仍保留（kill 只释放 AI 名）
  var human = g.mp.players[0];
  g.mp.kill(human);
  ok(g.mp.usedNames[aiName] === true, '真人淘汰后昵称仍保留（结算名单一致）');
})();

console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
