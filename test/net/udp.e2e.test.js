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

var UDP_SAFE_MTU = 1472;   // MTU 1500 − IP 20 − UDP 8：超过即触发 IP 分片

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
  PORT: 0, HOST: '127.0.0.1', UDP_PORT: 0, UDP_HOST: '127.0.0.1',
  TICK_MS: 33,
  MIN_HUMANS: 1, MATCH_TIMEOUT_MS: 300, COUNTDOWN_MS: 120,
  MATCH_MAX_MS: 20000, SNAP_EVERY: 1, TCP_SNAP_EVERY: 2,
  UDP_DUP: 3, LOWFREQ_MS: 300
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
    var matched = null, binFrames = [], jsonSnaps = 0, metaCount = 0, started = false;
    var cli = dgram.createSocket('udp4');
    var acked = false;

    cli.on('message', onUdp);
    function onUdp(buf) {
      if (buf[0] === UdpEndpoint.MAGIC_HACK) { acked = true; return; }
      var dec = BP.decSnapBin(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
      if (dec) binFrames.push(dec);
    }

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
        // 打洞要**重试 + 必要时重建 socket**。
        // Windows 回环 UDP 约 7% 概率一对 socket 完全通不了（永久黑洞，
        // 裸 dgram 对照同样存在，与本项目代码无关），重试 1 秒也不恢复，
        // 唯一有效的是整只 socket 重建。真实网络没有这种黑洞。
        var rebuilds = 0;
        bindAndPunch();
        function bindAndPunch() {
          cli.bind(0, '127.0.0.1', function () {
            var t = 0;
            (function punch() {
              if (acked) return;
              if (t >= 8) {
                if (rebuilds < 3) {
                  rebuilds++;
                  try { cli.close(); } catch (e) {}
                  cli = dgram.createSocket('udp4');
                  cli.on('message', onUdp);
                  bindAndPunch();
                }
                return;
              }
              t++;
              cli.send(mkHello(m.udpToken), m.udpPort, '127.0.0.1');
              setTimeout(punch, 25);
            })();
          });
        }
      } else if (m.t === 'start') {
        started = true;
      } else if (m.t === 'snap') {
        jsonSnaps++;
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
      // 故意让逻辑序号有缺口，证明服务端沿用客户端 frameId，而不是每收到一包自造 +1。
      // 每个 id 发 3 份只是模拟生产冗余；端点必须去重为 3 个逻辑输入。
      [1, 6, 12].forEach(function (frameId) {
        for (var copy = 0; copy < 3; copy++) {
          cli.send(Buffer.from(BP.encInputFrag(matched.udpToken, frameId, TARGET, 0)),
            matched.udpPort, '127.0.0.1');
        }
      });

      setTimeout(function () {
        var h = room.humans[connId];
        ok(Math.abs(h.angle - TARGET) < 0.01,
          '**上行 UDP 输入已写入房间**（h.angle=' + h.angle.toFixed(3) + '）',
          '期望 ' + TARGET);
        ok(h.lastSeq === 12,
          '**服务端 ack 基线沿用跨通道共享 frameId=12**（不是按收包数自造序号）');
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

          // 先制造 count>255 的色块突发：二进制不得截断或发超 MTU，必须单帧回退 TCP 全量。
          var overflowJsonBefore = jsonSnaps;
          var burstBlocks = [];
          for (var bi = 0; bi < 260; bi++) {
            burstBlocks.push({ x: 100 + bi, y: 200 + bi, color: 'red', kind: 'color', phase: 0 });
          }
          room.game.spawner.blocks = burstBlocks;
          setTimeout(function () {
            ok((room._overflowCount || 0) > 0,
              '**加速帧超 count/MTU 预算时触发 TCP 全量兜底**');
            ok(jsonSnaps > overflowJsonBefore,
              '超限帧经 WSS 收到 JSON 全量（不静默截断 add/del）');

            // 已激活后再模拟客户端检测到下行停滞：必须经 WSS 控制面让服务端
            // 停止抑制 TCP。只改客户端 active 布尔会导致两边都以为对方会发帧。
            var jsonBefore = jsonSnaps;
            ws.send(P.encode(P.accel(false)));
            setTimeout(function () {
              ok(srv.udp.isReady(connId) === false,
                '**客户端暂停加速后服务端立即撤销 ready**');
              ok(jsonSnaps > jsonBefore,
                '**已激活 → 停滞后真正恢复 TCP JSON 下行**（新增 ' + (jsonSnaps - jsonBefore) + ' 帧）');

              // 安全恢复先 mode=2 双发：完整二进制帧可达前，TCP 不能被停掉。
              var binBefore = binFrames.length, probeJsonBefore = jsonSnaps;
              // 模拟约 33 秒 TCP 回落后的共享序号：TCP seq=1012 被房间采纳后应同步
              // 到端点，随后恢复的加速 frameId=1013 不能因相对旧基线 12 前跳过大而冻结。
              ws.send(P.encode(P.input(1012, 1.7, 0)));
              ws.send(P.encode(P.accel(2)));
              setTimeout(function () {
                cli.send(Buffer.from(BP.encInputFrag(matched.udpToken, 1013, 1.8, 0)),
                  matched.udpPort, '127.0.0.1');
              }, 60);
              setTimeout(function () {
                ok(srv.udp.isReady(connId) === true && srv.hub.needsTcp(connId) === true,
                  '恢复探测期服务端同时启用加速与 TCP');
                ok(binFrames.length > binBefore && jsonSnaps > probeJsonBefore,
                  '**mode=2 探测期二进制与 TCP 快照同时到达**');
                ok(room.humans[connId].lastSeq === 1013 &&
                   Math.abs(room.humans[connId].angle - 1.8) < 0.01,
                  '**长时间 TCP 回落后首个加速输入仍连续生效**（seq=1013）');

                ws.send(P.encode(P.accel(true)));
                setTimeout(function () {
                  ok(srv.udp.isReady(connId) === true && srv.hub.needsTcp(connId) === false,
                    '完整快照确认后切回纯加速下行');
                  try { cli.close(); } catch (e) {}
                  try { ws.close(); } catch (e) {}
                  srv.close(function () { next(); });
                }, 120);
              }, 180);
            }, 180);
          }, 160);
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
    var jsonSnaps = 0, tcpStamps = [], matched = null, started = false;
    ws.on('open', function () { ws.send(P.encode(P.join('TCP玩家'))); });
    ws.on('message', function (data) {
      var m = P.decode(data.toString());
      if (!m) return;
      if (m.t === 'matched') matched = m;
      else if (m.t === 'start') started = true;
      else if (m.t === 'snap') {
        jsonSnaps++;
        if (started) tcpStamps.push(Date.now());
      }
    });
    setTimeout(function () {
      ok(matched !== null, '匹配成功');
      ok(started === true, '对局已开始');
      // 客户端故意不打洞 → 服务器 isReady=false → 必须走 TCP JSON
      ok(jsonSnaps > 5, '**未打洞时下行走 TCP JSON**（' + jsonSnaps + ' 帧）',
        '只收到 ' + jsonSnaps + ' 帧');
      if (tcpStamps.length >= 5) {
        var tcpSpan = tcpStamps[tcpStamps.length - 1] - tcpStamps[0];
        var tcpMeasured = tcpSpan / (tcpStamps.length - 1);
        var tcpExpected = CFG.TICK_MS * CFG.TCP_SNAP_EVERY;
        ok(tcpMeasured >= tcpExpected * 0.70 && tcpMeasured <= tcpExpected * 1.30,
          '**TCP 保底实测约 15Hz**（间隔 ' + tcpMeasured.toFixed(1) + 'ms）',
          '期望约 ' + tcpExpected + 'ms；若接近 33ms 说明全量 JSON 又被提到 30Hz');
      }
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
    }, 1300);
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
    }, 1300);
  });
}

// ---------------- 场景 D：快照频率契约 + 带宽预算（v3.1 1a.6） ----------------
//
// 这个场景**故意不用 CFG**，而是加载 server/config.js 的生产真值。
// 理由是踩过的坑：UDP 曾经绑在 127.0.0.1 上，CI 全绿、日志无异常、
// 客户端静默降级，公网一个包都不走。凡是「配置项的真实取值」本身就是
// 交付内容的地方，测试必须读生产配置，不能自己造一份。
//
// 断言的是**实测帧率与实测字节数**而不是配置字段：只比对 SNAP_EVERY 的数值，
// 等于把「取模那行代码写对了」当成前提，而它恰恰是可能写错的地方。
//
// 提频到 30Hz 后带宽翻倍，冗余 ×3 又翻三倍，所以必须把预算钉成断言 ——
// 否则「哪天蛇变长了/蛇数上调了」会悄悄撞上 UDP_SNAP_CAP 触发降级，
// 表现是远处的蛇没身体，而没有任何报错。
function scenarioSnapRate(next) {
  section('D. 快照频率契约 + 带宽预算（用生产 config，断言实测值）');
  var prod = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
  var expectInterval = prod.TICK_MS * prod.SNAP_EVERY;
  var expectTcpInterval = prod.TICK_MS * prod.TCP_SNAP_EVERY;

  ok(prod.SNAP_EVERY >= 1 && prod.SNAP_EVERY === Math.floor(prod.SNAP_EVERY),
    '生产 SNAP_EVERY 是正整数（' + prod.SNAP_EVERY + '）');
  ok(prod.TCP_SNAP_EVERY >= prod.SNAP_EVERY &&
     prod.TCP_SNAP_EVERY === Math.floor(prod.TCP_SNAP_EVERY),
    '生产 TCP_SNAP_EVERY 是不快于加速通道的正整数（' + prod.TCP_SNAP_EVERY + '）');

  // 两条通道各按自己的真实间隔推导缓冲。
  require(path.join(__dirname, '..', '..', 'js', 'net', 'interpolation.js'));
  var delay = CS.deriveInterpDelay(expectInterval);
  var tcpDelay = CS.deriveInterpDelay(expectTcpInterval);
  ok(delay > expectInterval,
    '加速通道插值延迟(' + delay + 'ms) > 快照间隔(' + expectInterval + 'ms)');
  ok(tcpDelay >= 118 && tcpDelay <= 121,
    'TCP 保底恢复约 120ms 缓冲（' + tcpDelay + 'ms），不拿 70ms 硬扛队头阻塞');

  // 只覆盖时间/端口参数，**保留生产的 TICK_MS / SNAP_EVERY / UDP_DUP / UDP_SNAP_CAP**
  var cfg = Object.assign({}, prod, {
    PORT: 0, HOST: '127.0.0.1', UDP_PORT: 0, UDP_HOST: '127.0.0.1',
    MIN_HUMANS: 1, MATCH_TIMEOUT_MS: 300, COUNTDOWN_MS: 120,
    MATCH_MAX_MS: 20000, LOWFREQ_MS: 1000
  });
  var srv = createServer(cfg);
  srv.listen(function () {
    var ws = new WebSocket('ws://127.0.0.1:' + srv.port());
    var stamps = [], started = false;
    var udpBytes = 0, udpPkts = 0, maxPkt = 0, uniqTicks = {};
    var acked = false, matched = null;
    var cli = dgram.createSocket('udp4');

    cli.on('message', onUdp);
    function onUdp(buf) {
      if (buf[0] === UdpEndpoint.MAGIC_HACK) { acked = true; return; }
      udpBytes += buf.length + 28;   // + IP(20) + UDP(8) 头，量的是真实链路开销
      udpPkts++;
      if (buf.length > maxPkt) maxPkt = buf.length;
      var dec = BP.decSnapBin(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
      if (dec) uniqTicks[dec.tk] = 1;
    }

    ws.on('open', function () { ws.send(P.encode(P.join('频率玩家'))); });
    ws.on('message', function (data) {
      var m = P.decode(data.toString());
      if (!m) return;
      if (m.t === 'matched') {
        matched = m;
        ok(m.snapIntervalMs === expectTcpInterval,
          '兼容字段 snapIntervalMs 指向 TCP 保底间隔（' + m.snapIntervalMs + 'ms）',
          '期望 ' + expectTcpInterval);
        ok(m.tcpSnapIntervalMs === expectTcpInterval,
          'matched 下发 TCP 实际间隔（' + m.tcpSnapIntervalMs + 'ms）');
        ok(m.accelSnapIntervalMs === expectInterval,
          'matched 下发加速通道实际间隔（' + m.accelSnapIntervalMs + 'ms）');
        ok(m.tcpSnapEvery === prod.TCP_SNAP_EVERY && m.accelSnapEvery === prod.SNAP_EVERY,
          'matched 下发两条通道的 tick 步长（TCP=' + m.tcpSnapEvery +
          ' / accel=' + m.accelSnapEvery + '）');
        ok(m.udpDup === prod.UDP_DUP,
          'matched 下发冗余份数（' + m.udpDup + '）供客户端统计副本丢失率');
        // 打洞（Windows 回环黑洞需要重建 socket，见场景 A 注释）
        var rebuilds = 0;
        bindAndPunch();
        function bindAndPunch() {
          cli.bind(0, '127.0.0.1', function () {
            var t = 0;
            (function punch() {
              if (acked) return;
              if (t >= 8) {
                if (rebuilds < 3) {
                  rebuilds++;
                  try { cli.close(); } catch (e) {}
                  cli = dgram.createSocket('udp4');
                  cli.on('message', onUdp);
                  bindAndPunch();
                }
                return;
              }
              t++;
              cli.send(mkHello(m.udpToken), m.udpPort, '127.0.0.1');
              setTimeout(punch, 25);
            })();
          });
        }
      } else if (m.t === 'start') { started = true; }
      else if (m.t === 'snap' && started) stamps.push(Date.now());
    });

    // 先等打洞完成，再开始计量窗口（否则前半段全走 TCP，带宽数字失真）
    setTimeout(function () {
      ok(acked === true, 'UDP 打洞成功（带宽计量前提）');
      udpBytes = 0; udpPkts = 0; maxPkt = 0; uniqTicks = {};
      var winStart = Date.now();

      var SAMPLE_MS = 2000;
      setTimeout(function () {
        var winSec = (Date.now() - winStart) / 1000;
        var uniq = Object.keys(uniqTicks).length;

        // ---- 帧率（用 UDP 唯一 tick 数，这是玩家真正拿到的权威帧数）----
        ok(uniq >= 10, '采样到足够 UDP 快照（' + uniq + ' 个唯一 tick）');
        if (uniq >= 10) {
          var measured = (winSec * 1000) / uniq;
          // 容差 ±35%：定时器抖动 + 序列化开销，比对的是量级不是精度。
          // 关键在于能区分 33ms 与 66ms —— 相差一倍，任何合理容差都能分开。
          var lo = expectInterval * 0.65, hi = expectInterval * 1.35;
          ok(measured >= lo && measured <= hi,
            '**实测帧间隔 ' + measured.toFixed(1) + 'ms 落在 ' + expectInterval + 'ms 附近**',
            '允许 ' + lo.toFixed(0) + '~' + hi.toFixed(0));
          var halfRate = expectInterval * 2;
          ok(Math.abs(measured - halfRate) > Math.abs(measured - expectInterval),
            '实测更接近 ' + expectInterval + 'ms 而非 ' + halfRate + 'ms（未隔帧发送）');
          console.log('       实测下行 ' + (1000 / measured).toFixed(1) + ' Hz，插值延迟 ' + delay + 'ms');
        }

        // ---- 冗余份数：UDP_DUP 是功能约定，被「省带宽」偷偷砍掉过 ----
        var dupRatio = uniq ? udpPkts / uniq : 0;
        ok(dupRatio >= (prod.UDP_DUP - 0.5),
          '每帧冗余份数 ≈ UDP_DUP(' + prod.UDP_DUP + ')，实测 ' + dupRatio.toFixed(2),
          udpPkts + ' 包 / ' + uniq + ' 帧');

        // ---- 永不分片：这是 UDP 路径的硬约束，破了比 TCP 还糟 ----
        ok(maxPkt <= UDP_SAFE_MTU,
          '**单包永不分片**（峰值 ' + maxPkt + ' ≤ ' + UDP_SAFE_MTU + ' 字节）');
        ok(maxPkt <= prod.UDP_SNAP_CAP,
          '峰值未超 UDP_SNAP_CAP(' + prod.UDP_SNAP_CAP + ')，未触发 lite 降级');

        // ---- 带宽预算：30Hz × 3 份的实测人均下行 ----
        // 预算 40KB/s 与 load.js 的 TCP 阈值同源（架构文档 §7）。
        // 单人局（1 真人 + AI）是最小场景，满编时会更高，
        // 所以这里是**下限保护**：连这个都超了，满编必然爆。
        var kbps = udpBytes / 1024 / winSec;
        ok(kbps <= 40,
          '**人均下行 ' + kbps.toFixed(1) + ' KB/s ≤ 40 KB/s 预算**',
          udpBytes + ' 字节 / ' + winSec.toFixed(2) + 's');
        console.log('       人均下行 ' + kbps.toFixed(1) + ' KB/s（含 IP+UDP 头，' +
          prod.UDP_DUP + ' 份冗余），均包 ' +
          (udpPkts ? Math.round(udpBytes / udpPkts - 28) : 0) + ' 字节');

        // ---- 降级计数：撞硬约束会静默降级，必须显式检查 ----
        var room = null;
        for (var rid in srv.matchmaker.rooms) room = srv.matchmaker.rooms[rid];
        var degrade = room && room._degradeCount || 0;
        ok(degrade === 0, '未发生 lite 降级（_degradeCount=' + degrade + '）');

        try { cli.close(); } catch (e) {}
        try { ws.close(); } catch (e) {}
        srv.close(function () { next(); });
      }, SAMPLE_MS);
    }, 900);
  });
}

// ---------------- 主流程 ----------------
console.log('UDP 通道端到端（v3.1 M1b）');
scenarioUdp(function () {
  scenarioFallback(function () {
    scenarioDisabled(function () {
      scenarioSnapRate(function () {
        console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
        process.exit(fail === 0 ? 0 : 1);
      });
    });
  });
});
