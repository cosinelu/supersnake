'use strict';
/**
 * integration.js — M2 验收：真实 ws 服务器 + 双 WsTransport 客户端全链路
 * 运行：node test/net/integration.js
 * 验证浏览器联机将使用的真实客户端模块（js/net/wsTransport.js，注入 Node ws 实现）
 * 走通 连接 → join → queued → matched → start → snap/input 往返 → over/drop。
 */
var path = require('path');
var WebSocket = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));

var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils'].forEach(function (f) { require(path.join(JS, f + '.js')); });
require(path.join(JS, 'net', 'protocol.js'));
require(path.join(JS, 'net', 'transport.js'));
require(path.join(JS, 'net', 'wsTransport.js'));
require(path.join(JS, 'net', 'netMatch.js'));
var createServer = require(path.join(__dirname, '..', '..', 'server', 'index.js')).createServer;

var CS = globalThis.CS;
var P = CS.protocol;

var passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function makeClient(srv, name) {
  var t = new CS.WsTransport({
    url: 'ws://127.0.0.1:' + srv.port(),
    WebSocketImpl: WebSocket,
    heartbeatMs: 400
  });
  t._log = { matched: null, started: false, snaps: 0, over: null, dropped: false, queued: 0 };
  t.remote = null; // RemoteMatch 视图
  t.onAll({
    matched: function (m) {
      t._log.matched = m;
      t.remote = new CS.RemoteMatch(m.playerId);
    },
    start: function () { t._log.started = true; },
    queued: function () { t._log.queued++; },
    snap: function (s) { t._log.snaps++; if (t.remote) t.remote.applySnap(s); },
    over: function (o) { t._log.over = o; },
    drop: function () { t._log.dropped = true; }
  });
  t._name = name;
  return t;
}

function waitFor(pred, timeoutMs, label) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    var timer = setInterval(function () {
      if (pred()) { clearInterval(timer); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error('超时: ' + label)); }
    }, 20);
  });
}

function main() {
  var srv = createServer({
    PORT: 0, COUNTDOWN_MS: 300, MATCH_MAX_MS: 4000, OVER_LINGER_MS: 100,
    MATCH_TIMEOUT_MS: 500, MIN_HUMANS: 2, ROOM_SIZE: 4
  });
  srv.listen(function () {
    var a = makeClient(srv, '客户端A');
    var b = makeClient(srv, '客户端B');
    a.connect();
    b.connect();
    a.on('open', function () { a.joinMatch('客户端A'); });
    b.on('open', function () { b.joinMatch('客户端B'); });

    waitFor(function () { return a._log.started && b._log.started; }, 10000, '双端开局')
      .then(function () {
        ok(a._log.queued >= 1 && b._log.queued >= 1, '双端收到 queued 位次播报');
        ok(a._log.matched.roomId === b._log.matched.roomId, '双端同房间');
        ok(a._log.matched.players.length === 2, 'matched 含 2 名真人');
        // 以下两条读的是生产 config 的真值（本测试不覆盖这两个字段）：
        // 环境变量降配时测试必须跟着红，而不是继续绿。
        ok(a._log.matched.tcpSnapIntervalMs === 33,
          '**TCP 快照默认 30Hz（生产 config TCP_SNAP_EVERY=1）**',
          '实际 ' + a._log.matched.tcpSnapIntervalMs + 'ms');
        ok(a._log.matched.debugHud === false,
          '**matched 缺省 debugHud=false（official 行为；DEBUG_HUD 环境变量未设）**');
        // 上行输入 1 秒
        var iv = setInterval(function () {
          a.sendInput(Math.random() * 6.28, false);
          b.sendInput(Math.random() * 6.28, false);
        }, 50);
        return sleep(1000).then(function () { clearInterval(iv); });
      })
      .then(function () {
        ok(a._log.snaps >= 10 && b._log.snaps >= 10, '双端快照流（A=' + a._log.snaps + ' B=' + b._log.snaps + ' 帧）');
        ok(a.remote && a.remote.playerEntry && a.remote.playerEntry.name === '客户端A',
          'A 的 RemoteMatch 锁定本机 Entry');
        ok(a.remote.bots.some(function (e) { return e.name === '客户端B'; }),
          'A 视图中可见 B（bots 含另一真人）');
        ok(a.remote.blocks.length > 0, 'A 视图色块非空');
        ok(a.rtt >= 0 && a.rtt < 5000, '心跳 pong 更新 RTT（' + a.rtt + 'ms）');
        // 真实链路的字节计数：1 秒快照流 + join/input 之后必须非零。
        // 这是 HUD KB/s 的唯一数据源，坏了 HUD 会恒显示 0。
        ok(a.bytes.rx > 1000 && a.bytes.tx > 0,
          'WsTransport 真实收发字节计数（rx=' + a.bytes.rx + ' tx=' + a.bytes.tx + '）');
        return waitFor(function () { return a._log.over && b._log.over; }, 15000, '双端 over');
      })
      .then(function () {
        ok(true, '双端对局结束（A=' + a._log.over.reason + ' B=' + b._log.over.reason + '）');
        // drop：服务器侧主动断开全部连接 → 客户端收 drop（判负提示）
        srv.matchmaker.destroy();
        srv.wss.clients.forEach(function (ws) { ws.terminate(); });
        return sleep(300);
      })
      .then(function () {
        ok(a._log.dropped && b._log.dropped, '连接中断双端收到 drop（掉线判负入口）');
        a.dispose(); b.dispose();
        srv.close(function () {
          // 第二阶段：DEBUG_HUD=true 的环境（dev 形态），matched 必须下发 true。
          // 只断言 false 会漏掉「标志永远为 false」的坏实现。
          var srv2 = createServer({
            PORT: 0, COUNTDOWN_MS: 100, MATCH_TIMEOUT_MS: 300,
            MIN_HUMANS: 1, ROOM_SIZE: 4, DEBUG_HUD: true
          });
          srv2.listen(function () {
            var c = makeClient(srv2, '调试员');
            c.connect();
            c.on('open', function () { c.joinMatch('调试员'); });
            waitFor(function () { return !!c._log.matched; }, 8000, 'dev 形态 matched')
              .then(function () {
                ok(c._log.matched.debugHud === true,
                  '**DEBUG_HUD=true 时 matched 下发 debugHud=true（dev 行为）**');
                c.dispose();
                srv2.close(function () {
                  console.log('\n========================================');
                  console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
                  process.exit(failed ? 1 : 0);
                });
              })
              .catch(function (e) { console.error(e.message); process.exit(1); });
          });
        });
      })
      .catch(function (e) {
        ok(false, '集成测试异常', e.message);
        console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
        process.exit(1);
      });
  });
}

main();
