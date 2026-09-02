'use strict';
/**
 * udp.test.js — 服务器 UDP 端点回归（v3.1 M1b）
 *
 * 对应设计：docs/architecture/02-udp-transport.md §3、§4
 *
 * 守护的核心不变量：
 *   1. 三道校验（magic / token / crc+语义）全部生效，垃圾流量进不来
 *   2. frameId 去重语义与 room.js 一致，**含「大幅回退＝重新计数」**
 *      （缺这条会让重连玩家输入永久失效 —— 既有教训）
 *   3. 地址跟随：NAT 重绑定 / 网络切换后仍能识别同一玩家
 *   4. 冗余副本**在帧内时间打散**，不是同一毫秒连发
 *   5. 任何畸形输入都不得让进程崩溃（这层直接暴露在公网）
 */
var path = require('path');
var dgram = require('dgram');
var UdpEndpoint = require(path.join(__dirname, '..', '..', 'server', 'udp.js'));
var baseConfig = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
var CS = globalThis.CS, B = CS.bin, BP = CS.binProtocol;

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

// ---------------- T1 会话表与令牌 ----------------
function t1() {
  section('T1 会话表与令牌');
  var ep = new UdpEndpoint(baseConfig, {});
  var t1a = ep.createSession('c1', 'r1');
  var t2a = ep.createSession('c2', 'r1');
  ok(typeof t1a === 'number' && t1a >= 0 && t1a <= 0xFFFFFFFF, '令牌是 32bit 无符号数');
  ok(t1a !== t2a, '不同连接的令牌不同');
  ok(ep.sessions[t1a].connId === 'c1', '令牌可反查 connId');
  ok(ep.byConn['c1'] === t1a, 'connId 可正查令牌');

  // 重复建会话应替换旧的，不泄漏
  var t1b = ep.createSession('c1', 'r2');
  ok(ep.sessions[t1a] === undefined, '重建会话时旧令牌被回收（不泄漏）');
  ok(ep.byConn['c1'] === t1b, '重建后映射指向新令牌');

  ok(ep.isReady('c1') === false, '未完成握手时 isReady=false（上层应走 TCP）');

  ep.dropSession('c1');
  ok(ep.sessions[t1b] === undefined && ep.byConn['c1'] === undefined, 'dropSession 清理干净');
}

// ---------------- T2 frameId 去重（与 room.js 语义一致） ----------------
function t2() {
  section('T2 frameId 去重语义');
  var ep = new UdpEndpoint(baseConfig, {});
  var tk = ep.createSession('c1', 'r1');
  var s = ep.sessions[tk];

  ok(ep._acceptFrame(s, 100) === true, '首个 frameId 无条件采纳');
  ok(ep._acceptFrame(s, 101) === true, '递增采纳');
  ok(ep._acceptFrame(s, 101) === false, '**重复副本被丢弃**（冗余的正常情况）');
  ok(ep._acceptFrame(s, 100) === false, '小幅回退被丢弃（网络乱序）');
  ok(ep._acceptFrame(s, 105) === true, '小幅超前采纳');
  ok(ep._acceptFrame(s, 105 + baseConfig.INPUT_MAX_SEQ_JUMP + 1) === false,
    '异常跳变被丢弃（作弊/损坏）');

  // 关键：大幅回退必须重置基线，否则重连玩家输入永久失效
  s.lastFrameId = 5000;
  ok(ep._acceptFrame(s, 0) === true,
    '**大幅回退（重连后归零）被接受并重置基线**');
  ok(s.lastFrameId === 0, '基线已拉回，后续正常递增可继续', '基线 ' + s.lastFrameId);
  ok(ep._acceptFrame(s, 1) === true, '重置后继续递增正常工作');
}

// ---------------- T3 限速 ----------------
function t3() {
  section('T3 每源限速');
  var ep = new UdpEndpoint(Object.assign({}, baseConfig, { UDP_RATE_LIMIT: 10 }), {});
  var okCount = 0;
  for (var i = 0; i < 30; i++) if (ep._rateOk('1.2.3.4:5555')) okCount++;
  ok(okCount === 10, '超出速率后拒绝（放行 ' + okCount + '/30，上限 10）');
  ok(ep._rateOk('9.9.9.9:1111') === true, '不同源独立计数（不误伤他人）');
}

// ---------------- T4 端到端：握手 / 输入 / 校验 ----------------
function t4(done) {
  section('T4 端到端收发（真实 socket）');
  var got = [];
  var cfg = Object.assign({}, baseConfig, { UDP_PORT: 0, HOST: '127.0.0.1', UDP_DUP: 3 });
  var ep = new UdpEndpoint(cfg, {
    onInput: function (connId, inp) { got.push({ connId: connId, inp: inp }); }
  });

  ep.listen(function () {
    var port = ep.port();
    var token = ep.createSession('c1', 'r1');
    var cli = dgram.createSocket('udp4');
    var acks = 0;
    var frames = [];
    cli.on('message', function (buf) {
      if (buf[0] === UdpEndpoint.MAGIC_HACK) acks++;
      else frames.push({ t: Date.now(), len: buf.length });
    });

    cli.bind(0, '127.0.0.1', function () {
      // 1) 握手
      cli.send(mkHello(token), port, '127.0.0.1');

      setTimeout(function () {
        ok(acks === 1, '握手收到 hello_ack（' + acks + '）');
        ok(ep.isReady('c1') === true, '握手后 isReady=true');

        // 2) 合法输入
        cli.send(Buffer.from(BP.encInputFrag(token, 1, 1.23, 0)), port, '127.0.0.1');
        // 3) 重复副本（冗余）——应只生效一次
        cli.send(Buffer.from(BP.encInputFrag(token, 1, 1.23, 0)), port, '127.0.0.1');
        // 4) 错误 token
        cli.send(Buffer.from(BP.encInputFrag(token ^ 0xFFFF, 2, 2.0, 0)), port, '127.0.0.1');
        // 5) 篡改 CRC
        var bad = Buffer.from(BP.encInputFrag(token, 3, 2.0, 0));
        bad[5] ^= 0xFF;
        cli.send(bad, port, '127.0.0.1');
        // 6) 垃圾 magic
        cli.send(Buffer.from([0x00, 1, 2, 3, 4, 5, 6, 7]), port, '127.0.0.1');
        // 7) 空包与超长包（不得崩溃）
        cli.send(Buffer.alloc(0), port, '127.0.0.1');
        cli.send(Buffer.alloc(2000, 0x49), port, '127.0.0.1');

        setTimeout(function () {
          ok(got.length === 1, '仅合法输入被接受（收到 ' + got.length + ' 条）');
          ok(got[0] && got[0].connId === 'c1', '正确解析出 connId');
          ok(got[0] && Math.abs(got[0].inp.angle - 1.23) < 0.001,
            'angle 精度正确（' + (got[0] ? got[0].inp.angle.toFixed(4) : 'N/A') + '）');
          ok(ep.stats.dropToken >= 1, '错误 token 被拒（' + ep.stats.dropToken + '）');
          ok(ep.stats.dropCrc >= 1, 'CRC 篡改被拒（' + ep.stats.dropCrc + '）');
          ok(ep.stats.dropMagic >= 1, '垃圾 magic 被拒（' + ep.stats.dropMagic + '）');
          ok(ep.stats.dropSeq >= 1, '重复副本被去重（' + ep.stats.dropSeq + '）');

        // 8) 地址跟随：换一个源端口发包，仍应识别为同一玩家
        var cli2 = dgram.createSocket('udp4');
        var frames2 = [];
        cli2.on('message', function (buf) {
          if (buf[0] !== UdpEndpoint.MAGIC_HACK) frames2.push({ t: Date.now(), len: buf.length });
        });
        cli2.bind(0, '127.0.0.1', function () {
          cli2.send(Buffer.from(BP.encInputFrag(token, 50, 0.5, 1)), port, '127.0.0.1');
          setTimeout(function () {
            ok(got.length === 2, '换源端口后仍被接受（NAT 重绑定/网络切换）',
              '收到 ' + got.length + ' 条');
            ok(got[1] && got[1].connId === 'c1', '地址跟随后仍映射到同一 connId');
            ok(got[1] && got[1].inp.boost === 1, 'boost 位正确传递');

            // 9) 下行冗余打散。
            // 注意必须在 cli2 上收：上一步的地址跟随已把会话地址更新为 cli2，
            // 下行本来就该发往最新地址（NAT 重绑定后旧地址已失效）——
            // 在 cli 上收不到反而是地址跟随生效的证据。
            var frame = BP.encSnapBin({ tick: 1, ack: 1, timeMs: 0, entries: [] });
            frames.length = 0; frames2.length = 0;
            ep.sendFrame('c1', frame);
            setTimeout(function () {
              ok(frames2.length === 3, '下行发出 UDP_DUP=3 份（收到 ' + frames2.length + '）');
              ok(frames.length === 0, '下行发往**最新地址**，旧地址不再收包（地址跟随生效）',
                '旧地址收到 ' + frames.length + ' 份');
              if (frames2.length === 3) {
                var d1 = frames2[1].t - frames2[0].t;
                var d2 = frames2[2].t - frames2[0].t;
                var frameMs = cfg.TICK_MS * (cfg.SNAP_EVERY || 1);
                console.log('       副本间隔：0 / ' + d1 + ' / ' + d2 +
                  ' ms（帧窗口 ' + frameMs + 'ms）');
                // 判据按**真实目的**定：副本要跨越不同时间片（抗突发丢包），
                // 且必须落在本帧窗口内 —— 溢出到下一帧就不再是本帧的冗余，纯浪费带宽。
                // 不断言绝对值：Node 的 setTimeout 系统性偏慢（目标 22ms 实测 33ms）。
                ok(d1 > 0 && d2 > d1, '副本跨越不同时间片（0 < ' + d1 + ' < ' + d2 + '）');
                ok(d2 <= frameMs * 1.5, '全部副本落在本帧窗口内（末份 ' + d2 +
                  'ms ≤ ' + Math.round(frameMs * 1.5) + 'ms）', '溢出到下一帧了');
              }
              cli.close(); cli2.close();
              ep.close(function () { done(); });
            }, 120);
          }, 60);
        });
        }, 80);
      }, 80);
    });
  });
}

// ---------------- T5 会话清理 ----------------
function t5() {
  section('T5 会话超时清理');
  var ep = new UdpEndpoint(Object.assign({}, baseConfig, { UDP_SESSION_TTL_MS: 50 }), {});
  var tk = ep.createSession('c1', 'r1');
  ep.sessions[tk].lastSeen = Date.now() - 200;
  var tk2 = ep.createSession('c2', 'r1');
  ep._sweep();
  ok(ep.sessions[tk] === undefined, '超时会话被清理');
  ok(ep.sessions[tk2] !== undefined, '活跃会话保留');
  ok(ep.byConn['c1'] === undefined, '反向映射同步清理（不泄漏）');
}

// ---------------- 主流程 ----------------
console.log('服务器 UDP 端点回归（v3.1 M1b）');
t1(); t2(); t3(); t5();
t4(function () {
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
});
