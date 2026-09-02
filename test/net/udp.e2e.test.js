'use strict';
/**
 * udp.e2e.test.js — UDP 通道端到端（v3.1 M1b）
 *
 * 对应设计：docs/architecture/02-udp-transport.md §4
 *
 * 这个测试回答一个问题：**真的走通了吗？**
 * 前面的单元测试只证明各部件正确，这里用真实 ws + 真实 dgram 跑一局，
 * 断言：matched 带回 udp 接入信息 → 打洞成功 → 上行输入生效（服务器蛇转向）
 * → 下行收到二进制帧且可解码 → UDP 不可用时能回落 TCP。
 */
var path = require('path');
var dgram = require('dgram');
var WebSocket = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));
var createServer = require(path.join(__dirname, '..', '..', 'server', 'index.js')).createServer;
var CS = globalThis.CS, B = CS.bin, BP = CS.binProtocol;
var P = CS.protocol;
var UdpEndpoint = require(path.join(__dirname, '..', '..', 'server', 'udp.js'));

var pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

function mkHello(token) {
  var w = new B.BinWriter(8);
  w.u8(UdpEndpoint.MAGIC_HELLO); w.u32(token); w.finishCrc16();
  return Buffer.from(w.bytes());
}

var CFG = {
  PORT: 0, HOST: '127.0.0.1', UDP_PORT: 0,
  MIN_HUMANS: 1, MATCH_TIMEOUT_MS: 300, COUNTDOWN_MS: 120,
  MATCH_MAX_MS: 20000, SNAP_EVERY: 1, UDP_DUP: 3, LOWFREQ_MS: 300
};

// ---------------- 场景 A：UDP 全链路 ----------------
function scenarioUdp(next) {
  section('A. UDP 全链路（真 ws + 真 dgram）');
  var srv = createServer(CFG);
  srv.listen(function () {
    var wsPort = srv.port();
    ok(srv.udp !== null, '服务器创建了 UDP 端点');
    ok(srv.udpPort() > 0, 'UDP 端点已监听（端口 ' + srv.udpPort() + '）');

    var ws = new WebSocket('ws://127.0.0.1:' + wsPort);
    var matched = null, binFrames = [], metaCount = 0, started = false;
    var cli = dgram.createSocket('udp4');
    var acked = false;

    cli.on('message', function (buf) {
      if (buf[0] === UdpEndpoint.MAGIC_HACK) { acked = true; return; }
      var dec = BP.decSnapBin(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
      if (dec) binFrames.push(dec);
    });

    ws.on('open', function () {
      ws.send(P.encode(P.join('UDP玩家')));
    });

    ws.on('message', function (data) {
      var m = P.decode(data.toString());
      if (!m) return;
      if (m.t === 'matched') {
        matched = m;
        ok(typeof m.udpPort === 'number' && m.udpPort > 0,
          'matched 带回 udpPort（' + m.udpPort + '）');
        ok(typeof m.udpToken === 'number', 'matched 带回 udpToken');
        ok(typeof m.snapIntervalMs === 'number' && m.snapIntervalMs > 0,
          'matched 带回 snapIntervalMs（' + m.snapIntervalMs + '，客户端据此自适应缓冲）');
        cli.bind(0, '127.0.0.1', function () {
          cli.send(mkHello(m.udpToken), m.udpPort, '127.0.0.1');
        });
      } else if (m.t === 'start') {
        started = true;
      } else if (m.t === 'meta') {
        metaCount++;
      }
    });

    setTimeout(function () {
      ok(matched !== null, '匹配成功');
      ok(acked === true, 'UDP 打洞收到 hello_ack');
      ok(started === true, '对局已开始');

      // 上行：连发一串输入，观察服务器蛇是否转向
      var room = null;
      for (var rid in srv.matchmaker.rooms) room = srv.matchmaker.rooms[rid];
      ok(room !== null, '房间存在');
      var connId = room ? Object.keys(room.humans)[0] : null;
      var angBefore = room && room.humans[connId].entry.snake.angle;
      var TARGET = 2.0;
      for (var i = 1; i <= 12; i++) {
        cli.send(Buffer.from(BP.encInputFrag(matched.udpToken, i, TARGET, 0)),
          matched.udpPort, '127.0.0.1');
      }

      setTimeout(function () {
        var h = room.humans[connId];
        ok(Math.abs(h.angle - TARGET) < 0.01,
          '**上行 UDP 输入已写入房间**（h.angle=' + h.angle.toFixed(3) + '）',
          '期望 ' + TARGET);
        ok(srv.udp.isReady(connId) === true, '服务器认定该连接 UDP 就绪');

        setTimeout(function () {
          ok(binFrames.length > 0, '**下行收到二进制快照**（' + binFrames.length + ' 帧）');
          if (binFrames.length) {
            var f = binFrames[binFrames.length - 1];
            ok(f.sn.length >= 1, '快照含蛇数据（' + f.sn.length + ' 条）');
            ok(f.sn[0].segPos.length > 1, '本机蛇含完整身体（' +
              f.sn[0].segPos.length + ' 节）');
            ok(f.sn[0].lite === false, '本机蛇未被降级为 lite');
            var withBody = f.sn.filter(function (s) { return !s.lite; }).length;
            console.log('       完整档 ' + withBody + ' / ' + f.sn.length + ' 条');
          }
          // 冗余：UDP_DUP=3 时同一 tick 应收到多份
          var byTick = {};
          binFrames.forEach(function (f2) { byTick[f2.tk] = (byTick[f2.tk] || 0) + 1; });
          var maxDup = 0;
          for (var tk in byTick) if (byTick[tk] > maxDup) maxDup = byTick[tk];
          ok(maxDup >= 2, '同一 tick 收到多份冗余（最多 ' + maxDup + ' 份）');

          ok(metaCount > 0, '低频 meta 通道已发送（' + metaCount + ' 次，含色块全量校正）');

          // 蛇的名字走低频通道，快照里应为空
          if (binFrames.length) {
            ok(binFrames[0].sn[0].name === null,
              '昵称已移出每帧快照（走 1Hz 低频通道）');
          }

          try { cli.close(); } catch (e) {}
          try { ws.close(); } catch (e) {}
          srv.close(function () { next(); });
        }, 400);
      }, 250);
    }, 900);
  });
}

// ---------------- 场景 B：UDP 不可用时回落 TCP ----------------
function scenarioFallback(next) {
  section('B. UDP 未打洞时回落 TCP（保底通道）');
  var srv = createServer(CFG);
  srv.listen(function () {
    var ws = new WebSocket('ws://127.0.0.1:' + srv.port());
    var jsonSnaps = 0, matched = null, started = false;
    ws.on('open', function () { ws.send(P.encode(P.join('TCP玩家'))); });
    ws.on('message', function (data) {
      var m = P.decode(data.toString());
      if (!m) return;
      if (m.t === 'matched') matched = m;
      else if (m.t === 'start') started = true;
      else if (m.t === 'snap') jsonSnaps++;
    });
    setTimeout(function () {
      ok(matched !== null, '匹配成功');
      ok(started === true, '对局已开始');
      // 客户端故意不打洞 → 服务器 isReady=false → 必须走 TCP JSON
      ok(jsonSnaps > 5, '**未打洞时下行走 TCP JSON**（' + jsonSnaps + ' 帧）',
        '只收到 ' + jsonSnaps + ' 帧');
      var room = null;
      for (var rid in srv.matchmaker.rooms) room = srv.matchmaker.rooms[rid];
      var connId = room && Object.keys(room.humans)[0];
      ok(srv.udp.isReady(connId) === false, '服务器认定该连接 UDP 未就绪');

      // TCP 上行仍然生效
      ws.send(P.encode(P.input(1, 1.5, 0)));
      setTimeout(function () {
        ok(Math.abs(room.humans[connId].angle - 1.5) < 0.01,
          'TCP 上行输入仍正常生效（保底通道未被破坏）');
        try { ws.close(); } catch (e) {}
        srv.close(function () { next(); });
      }, 120);
    }, 900);
  });
}

// ---------------- 场景 C：UDP_ENABLED=0 完全回退 ----------------
function scenarioDisabled(next) {
  section('C. UDP_ENABLED=0 → 完全回退纯 TCP（回滚点）');
  var cfg = Object.assign({}, CFG, { UDP_ENABLED: false });
  var srv = createServer(cfg);
  srv.listen(function () {
    ok(srv.udp === null, '未创建 UDP 端点');
    ok(srv.udpPort() === 0, 'udpPort() 返回 0');
    var ws = new WebSocket('ws://127.0.0.1:' + srv.port());
    var matched = null, snaps = 0;
    ws.on('open', function () { ws.send(P.encode(P.join('纯TCP'))); });
    ws.on('message', function (data) {
      var m = P.decode(data.toString());
      if (!m) return;
      if (m.t === 'matched') matched = m;
      else if (m.t === 'snap') snaps++;
    });
    setTimeout(function () {
      ok(matched !== null, '匹配仍正常');
      ok(matched && matched.udpPort === undefined, 'matched 不含 udp 字段');
      ok(snaps > 5, '快照正常下发（' + snaps + ' 帧）');
      try { ws.close(); } catch (e) {}
      srv.close(function () { next(); });
    }, 900);
  });
}

// ---------------- 主流程 ----------------
console.log('UDP 通道端到端（v3.1 M1b）');
scenarioUdp(function () {
  scenarioFallback(function () {
    scenarioDisabled(function () {
      console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
      process.exit(fail === 0 ? 0 : 1);
    });
  });
});
