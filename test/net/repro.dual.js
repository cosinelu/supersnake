'use strict';
/**
 * repro.dual.js — 双客户端 OnlineMatch 全栈复现（真实 ws 服务器 + 真实客户端管线）
 *
 * 复现用户报告：互见位置不一致 / 看不到对方的蛇。
 * 方法：两个 CS.Game + OnlineMatch（WsTransport 走真网络），模拟 rAF 驱动 game.update，
 * 对照「A 屏幕上 B 的位置」与「B 自己的真实位置」，以及服务器权威位置。
 *
 * 运行：node test/net/repro.dual.js
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'joystick', 'ai', 'multiplayer', 'game']
  .forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'transport', 'headlessGame', 'interpolation', 'prediction', 'netMatch', 'wsTransport', 'onlineMatch']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });
var WebSocket = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));
var createServer = require(path.join(__dirname, '..', '..', 'server', 'index.js')).createServer;

var CS = globalThis.CS;

function makeClient(url, nick) {
  var game = new CS.Game(1280, 720);
  var om = new CS.OnlineMatch(game, {
    transport: new CS.WsTransport({ url: url, WebSocketImpl: WebSocket }),
    nick: nick
  });
  game.mode = 'multi';
  game.online = om;
  game.setState('matching');
  om.begin();
  return { game: game, om: om };
}

async function main() {
  var srv = createServer({ PORT: 0, HOST: '127.0.0.1', MATCH_TIMEOUT_MS: 1500, COUNTDOWN_MS: 500 });
  await new Promise(function (r) { srv.httpServer.listen(0, '127.0.0.1', r); });
  var url = 'ws://127.0.0.1:' + srv.port();

  var A = makeClient(url, '主机A');
  var B = makeClient(url, '主机B');
  console.log('两端已 join，等待匹配开局…');

  // 模拟 rAF：16ms 驱动双方 game.update；A 持续转向（模拟真实玩家操作）
  var steerAngle = 0, steerTick = 0;
  A.game.joystick.currentAngle = function () { return steerAngle; }; // 等价于玩家一直拖着摇杆
  var timer = setInterval(function () {
    steerTick++;
    if (steerTick % 30 === 0) steerAngle += 1.2; // 每 ~0.5s 换一次方向
    A.game.update(16.7);
    B.game.update(16.7);
  }, 16);

  // 等双方都进 play
  var t0 = Date.now();
  while ((A.game.state !== 'play' || B.game.state === 'matching') && Date.now() - t0 < 15000) {
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  console.log('A 状态:', A.game.state, ' B 状态:', B.game.state);
  if (A.game.state !== 'play' || B.game.state !== 'play') {
    console.log('REPRO 失败：未都进入 play');
    clearInterval(timer); srv.close(function () { process.exit(1); });
  }

  // 跑 4 秒真实时间后采样
  await new Promise(function (r) { setTimeout(r, 4000); });

  function report(name, C, other) {
    var r = C.om.remote;
    var view = null;
    for (var i = 0; i < r.bots.length; i++) {
      if (r.bots[i].id === other.om.playerId) view = r.bots[i];
    }
    if (!view) { console.log(name, '：找不到对方 Entry（playerId=' + other.om.playerId + '）bots=', r.bots.map(function (b) { return b.id; })); return null; }
    return {
      viewX: Math.round(view.snake.x), viewY: Math.round(view.snake.y),
      viewAlive: view.alive, viewLen: view.snake.length(),
      realX: Math.round(other.game.snake.x), realY: Math.round(other.game.snake.y)
    };
  }

  var ra = report('A 屏幕上的 B', A, B);
  var rb = report('B 屏幕上的 A', B, A);

  // 服务器权威位置
  var room = null;
  for (var rid in srv.matchmaker.rooms) room = srv.matchmaker.rooms[rid];
  var auth = {};
  if (room) {
    for (var cid in room.humans) {
      var h = room.humans[cid];
      auth[h.entry.id] = { x: Math.round(h.entry.snake.x), y: Math.round(h.entry.snake.y), alive: h.entry.alive };
    }
  }

  console.log('');
  console.log('=== 位置对照（4 秒采样点）===');
  if (ra) console.log('A 屏看 B: view=(' + ra.viewX + ',' + ra.viewY + ') alive=' + ra.viewAlive +
    ' | B 自己=(' + ra.realX + ',' + ra.realY + ') | 服务器权威=' + JSON.stringify(auth[B.om.playerId]));
  if (rb) console.log('B 屏看 A: view=(' + rb.viewX + ',' + rb.viewY + ') alive=' + rb.viewAlive +
    ' | A 自己=(' + rb.realX + ',' + rb.realY + ') | 服务器权威=' + JSON.stringify(auth[A.om.playerId]));

  // 再追踪 3 秒，每秒采样一次，看视图是否跟随
  console.log('');
  console.log('=== 连续 3 秒追踪（A 屏看 B vs B 自己）===');
  for (var k = 0; k < 3; k++) {
    await new Promise(function (r) { setTimeout(r, 1000); });
    var v = null;
    for (var i = 0; i < A.om.remote.bots.length; i++) {
      if (A.om.remote.bots[i].id === B.om.playerId) v = A.om.remote.bots[i];
    }
    console.log('t+' + (k + 1) + 's  A屏B=(' + (v ? Math.round(v.snake.x) + ',' + Math.round(v.snake.y) : 'N/A') + ')' +
      '  B自己=(' + Math.round(B.game.snake.x) + ',' + Math.round(B.game.snake.y) + ')' +
      '  B存活=' + (v && v.alive) + '  B的远端缓冲=' + (A.om.remote._interp ? A.om.remote._interp.snaps.length : 'none') + '帧');
  }

  clearInterval(timer);
  A.om.dispose(); B.om.dispose();
  srv.close(function () { process.exit(0); });
}

main().catch(function (e) { console.error(e); process.exit(1); });
