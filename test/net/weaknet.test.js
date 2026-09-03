'use strict';
/**
 * weaknet.test.js — 弱网条件下的传输层验证（v3.1）
 *
 * 这个测试要回答**整个 UDP 重构的立论问题**：
 *   「弱网丢包下，UDP + 冗余打散真的比不打散、比单份更好吗？」
 *
 * 之前的测试只证明了「通」和「能降级」，从未证明「更好」——
 * 而「更好」恰恰是做这次重构的全部理由。若不成立，整条 UDP 路径
 * 应该被推翻而不是保留。
 *
 * ---------------------------------------------------------------------------
 * 为什么丢包模型必须是「时间相关」的
 * ---------------------------------------------------------------------------
 * 若每个包独立以概率 p 丢弃，则同一帧的 N 个副本各自独立存活，
 * 「x3 同时发」与「x3 打散」的帧到达率在数学上**完全相同**。
 * 此时打散是纯浪费，而测试会显示两者无差异 ——
 * 结论「打散有用」将变成不可证伪的信仰。
 *
 * 真实丢包成窗口出现（基站切换 / 缓冲溢出 / Wi-Fi 干扰），宽度典型 20~100ms。
 * 本测试用「周期性坏窗口」建模，并**保留均匀丢包作对照组**：
 * 若对照组里打散也显示出优势，说明模型偏袒了打散，实验设计有问题。
 *
 * 分两层验证，共用 netemProxy.js 的同一个 LossChannel：
 *   L1 模型层（数千帧）—— 提供统计功效，结论稳定不 flake
 *   L2 真机层（真 socket + 真 UdpEndpoint.sendFrame）—— 证明真实打散调度
 *      确实按模型行为，模型不是另一套虚构
 *
 * 运行：node test/net/weaknet.test.js
 */
var path = require('path');
var dgram = require('dgram');
var M = require(path.join(__dirname, 'netemProxy.js'));
var LossChannel = M.LossChannel;
var UdpEndpoint = require(path.join(__dirname, '..', '..', 'server', 'udp.js'));
var baseConfig = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
var CS = globalThis.CS, B = CS.bin, BP = CS.binProtocol;

var pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
function pct(x) { return (x * 100).toFixed(1) + '%'; }

// 帧窗口取生产值，让实验条件与线上一致
var INTERVAL = baseConfig.TICK_MS * baseConfig.SNAP_EVERY;
var DUP = baseConfig.UDP_DUP;
var SPREAD_WIN = INTERVAL * 0.8;   // 与 udp.js:sendFrame 的 deadline 同源

// ---------------- 发送策略（副本时刻） ----------------
function tsSingle(f) { return [f * INTERVAL]; }
function tsSame(f) {
  var t = f * INTERVAL, a = [];
  for (var i = 0; i < DUP; i++) a.push(t);
  return a;
}
function tsSpread(f) {
  var t = f * INTERVAL, a = [];
  for (var i = 0; i < DUP; i++) a.push(t + Math.round(SPREAD_WIN * i / DUP));
  return a;
}

/**
 * 跑 N 帧，返回帧到达率。
 * 一帧只要有任一副本到达就算到达 —— 这正是幂等下行的语义：
 * 副本内容完全相同，收到一份就够，不需要重组。
 */
function frameArrival(tsFn, chOpts, frames) {
  var ch = new LossChannel(chOpts);
  var arrived = 0;
  for (var f = 0; f < frames; f++) {
    var ts = tsFn(f), got = false;
    for (var i = 0; i < ts.length; i++) if (ch.passes(ts[i])) got = true;
    if (got) arrived++;
  }
  return { rate: arrived / frames, ch: ch };
}

/**
 * 连续丢帧的分布 —— 玩家感知的是「卡顿时长」，不是平均到达率。
 * 返回 { worst, hist, longRuns }：
 *   hist     连续丢 N 帧的发生次数
 *   longRuns 连续丢 ≥2 帧的总次数（肉眼可见的顿卡）
 *
 * **注意 worst 受坏窗口宽度的物理约束**：窗口 60ms 比帧窗口 33ms 还宽时，
 * 一个窗口必然覆盖连续 2 帧的全部副本，任何打散策略都不可能把 worst 压到 1。
 * 所以打散的收益要看**分布**而非最大值 —— 实测同为 worst=2 时，
 * 单份是「658 次丢 2 帧 / 211 次丢 1 帧」，打散是「180 次丢 2 帧 / 620 次丢 1 帧」。
 */
function gapStats(tsFn, chOpts, frames) {
  var ch = new LossChannel(chOpts);
  var cur = 0, worst = 0, hist = {}, longRuns = 0;
  function flush() {
    if (cur > 0) {
      hist[cur] = (hist[cur] || 0) + 1;
      if (cur >= 2) longRuns++;
    }
    cur = 0;
  }
  for (var f = 0; f < frames; f++) {
    var ts = tsFn(f), got = false;
    for (var i = 0; i < ts.length; i++) if (ch.passes(ts[i])) got = true;
    if (got) flush();
    else { cur++; if (cur > worst) worst = cur; }
  }
  flush();
  return { worst: worst, hist: hist, longRuns: longRuns };
}

// ---------------- L1.1 突发丢包：打散必须优于同时发 ----------------
function l1Burst() {
  section('L1.1 突发窗口丢包：冗余打散 vs 同时发 vs 单份');
  var FRAMES = 4000;
  var burst = { periodMs: 150, durationMs: 60, loss: 0.95 };
  var opt = function (seed) { return { seed: seed, burst: burst }; };

  var single = frameArrival(tsSingle, opt(5), FRAMES);
  var same = frameArrival(tsSame, opt(5), FRAMES);
  var spread = frameArrival(tsSpread, opt(5), FRAMES);

  console.log('       单份 ' + pct(single.rate) + ' / x' + DUP + '同时 ' +
    pct(same.rate) + ' / x' + DUP + '打散 ' + pct(spread.rate) +
    '（坏窗口 ' + burst.durationMs + 'ms，实测注入丢包 ' + pct(single.ch.lossRate()) + '）');

  // 前提断言：注入真的生效了。缺这条，信道静默失效时下面全部变成空断言
  ok(single.ch.lossRate() > 0.25,
    '弱网注入确实生效（实测丢包 ' + pct(single.ch.lossRate()) + ' > 25%）',
    '注入失效则后续对比无意义');

  // 立论断言 1：冗余有价值
  ok(same.rate > single.rate,
    '冗余（即使同时发）优于单份：' + pct(single.rate) + ' → ' + pct(same.rate));

  // 立论断言 2：**打散才是关键**，这是重构里最容易被写错、且写错后
  // 完全没有报错的一环（实测踩过：链式调度漂移导致三份挤在同一毫秒）
  var gain = spread.rate - same.rate;
  ok(gain > 0.05,
    '**打散显著优于同时发**（+' + (gain * 100).toFixed(1) + 'pp，阈值 5pp）',
    '打散 ' + pct(spread.rate) + ' vs 同时 ' + pct(same.rate));

  // 卡顿分布：平均到达率会掩盖体验，玩家感知的是「连续丢几帧」。
  // 度量的是**长卡顿的发生次数**而非最大值 —— 坏窗口(60ms)比帧窗口(33ms)还宽时，
  // 一个窗口必然吃掉连续 2 帧的全部副本，worst 被物理约束在 2，
  // 任何打散策略都压不下去。断言 worst 变小是在断言一件不可能的事。
  var gSingle = gapStats(tsSingle, opt(5), FRAMES);
  var gSpread = gapStats(tsSpread, opt(5), FRAMES);
  console.log('       连续丢帧分布：单份 ' + JSON.stringify(gSingle.hist) +
    ' → 打散 ' + JSON.stringify(gSpread.hist));
  console.log('       长卡顿(≥2帧=' + (2 * INTERVAL) + 'ms)次数：单份 ' +
    gSingle.longRuns + ' → 打散 ' + gSpread.longRuns +
    '（最长均为 ' + gSingle.worst + ' 帧，受窗口宽度物理约束）');
  ok(gSpread.longRuns < gSingle.longRuns * 0.5,
    '**打散把长卡顿次数砍掉一半以上**（' + gSingle.longRuns + ' → ' +
    gSpread.longRuns + '）',
    '这比平均到达率更贴近玩家感知');
}

// ---------------- L1.2 对照组：均匀丢包下打散不应有优势 ----------------
function l1Uniform() {
  section('L1.2 对照组 · 均匀丢包：打散**不应**有优势（检验模型未偏袒）');
  var FRAMES = 4000;
  var opt = function (seed) { return { seed: seed, loss: 0.38 }; };

  var single = frameArrival(tsSingle, opt(5), FRAMES);
  var same = frameArrival(tsSame, opt(5), FRAMES);
  var spread = frameArrival(tsSpread, opt(5), FRAMES);

  console.log('       单份 ' + pct(single.rate) + ' / x' + DUP + '同时 ' +
    pct(same.rate) + ' / x' + DUP + '打散 ' + pct(spread.rate));

  // 这条是**实验设计的自检**：均匀丢包下每个副本独立，
  // 打散与同时发在数学上必须等价。若这里也出现优势，
  // 说明信道模型隐含了偏袒打散的机制，L1.1 的结论不可信。
  ok(Math.abs(spread.rate - same.rate) < 0.02,
    '均匀丢包下打散与同时发等价（差 ' +
    ((spread.rate - same.rate) * 100).toFixed(1) + 'pp < 2pp）',
    '出现差异说明模型偏袒了打散，L1.1 结论不可信');

  // 冗余本身在均匀丢包下收益更大（每份独立 ⇒ 1-p^3）
  ok(same.rate > single.rate + 0.2,
    '均匀丢包下冗余收益显著（' + pct(single.rate) + ' → ' + pct(same.rate) + '）');
}

// ---------------- L1.3 窗口宽度扫描：给出适用边界 ----------------
function l1Sweep() {
  section('L1.3 坏窗口宽度扫描：打散的适用边界');
  var FRAMES = 3000;
  var widths = [10, 20, INTERVAL, 60, 100];
  var gains = [];
  console.log('       窗口宽   单份     x' + DUP + '同时   x' + DUP + '打散   打散增益');
  widths.forEach(function (d) {
    var burst = { periodMs: 150, durationMs: d, loss: 0.95 };
    var o = function () { return { seed: 5, burst: burst }; };
    var s = frameArrival(tsSingle, o(), FRAMES).rate;
    var sa = frameArrival(tsSame, o(), FRAMES).rate;
    var sp = frameArrival(tsSpread, o(), FRAMES).rate;
    gains.push(sp - sa);
    console.log('       ' + (d + 'ms').padStart(6) + '  ' + pct(s).padStart(7) +
      '  ' + pct(sa).padStart(7) + '  ' + pct(sp).padStart(7) +
      '  +' + ((sp - sa) * 100).toFixed(1) + 'pp');
  });

  // 打散的增益应当在各种窗口宽度下都存在，而不是只在某个精心挑选的参数上成立
  var minGain = Math.min.apply(null, gains);
  ok(minGain > 0.03,
    '打散增益在全部窗口宽度下都成立（最小 +' + (minGain * 100).toFixed(1) + 'pp）',
    '只在个别参数下成立说明结论不稳健');

  // 窗口窄于帧窗口时，副本能完全跨出坏窗口 ⇒ 到达率应接近满
  var narrow = { periodMs: 150, durationMs: 10, loss: 0.95 };
  var spNarrow = frameArrival(tsSpread, { seed: 5, burst: narrow }, FRAMES).rate;
  ok(spNarrow > 0.98,
    '窗口(10ms) 窄于打散跨度时到达率近满（' + pct(spNarrow) + '）',
    '这是打散的最佳工况');
}

// ---------------- L1.4 上行幂等性：丢包后必须最终一致 ----------------
function l1Idempotent() {
  section('L1.4 上行幂等性：绝对角度 vs 增量在丢包下的终态');
  var FRAMES = 2000;
  var burst = { periodMs: 150, durationMs: 60, loss: 0.95 };

  // 模拟一串转向意图
  var intents = [];
  for (var f = 0; f < FRAMES; f++) {
    intents.push(Math.sin(f * 0.03) * Math.PI);
  }

  // 绝对角度：服务器取最后一个到达的值 ⇒ 丢包只造成"反应慢"，不造成"错位"
  var chA = new LossChannel({ seed: 9, burst: burst });
  var srvAbs = 0;
  for (f = 0; f < FRAMES; f++) {
    var ts = tsSpread(f);
    for (var i = 0; i < ts.length; i++) {
      if (chA.passes(ts[i])) { srvAbs = intents[f]; break; }
    }
  }

  // 增量：服务器累加每个到达的差值 ⇒ 丢一个包就永久偏差，且会发散
  var chB = new LossChannel({ seed: 9, burst: burst });
  var srvDelta = 0, prev = 0;
  for (f = 0; f < FRAMES; f++) {
    var d = intents[f] - prev; prev = intents[f];
    var ts2 = tsSpread(f);
    for (var j = 0; j < ts2.length; j++) {
      if (chB.passes(ts2[j])) { srvDelta += d; break; }
    }
  }

  var truth = intents[FRAMES - 1];
  var errAbs = Math.abs(srvAbs - truth);
  var errDelta = Math.abs(srvDelta - truth);
  console.log('       注入丢包 ' + pct(chA.lossRate()) + '；真值 ' +
    truth.toFixed(3) + ' rad；绝对角度误差 ' + errAbs.toFixed(4) +
    '，增量误差 ' + errDelta.toFixed(3));

  // 这是「上行为何必须保持绝对量语义」的量化证据（架构文档 §7.1 不变量 2）。
  //
  // 注意误差为 0 是**结构性的**而非侥幸：绝对角度下服务器只保留"最后到达的值"，
  // 只要最后一帧的任一副本到达，终态就精确等于真值。丢包只造成"反应慢"
  // （中间某几帧的转向没被采纳），不造成"错位"。
  ok(errAbs < 0.02,
    '**绝对角度在 ' + pct(chA.lossRate()) + ' 丢包下终态无偏差**（误差 ' +
    errAbs.toFixed(4) + ' rad）');
  ok(errDelta > 0.05 && errDelta > errAbs * 10,
    '增量语义会累积永久偏差（误差 ' + errDelta.toFixed(3) + ' rad ≈ ' +
    (errDelta * 180 / Math.PI).toFixed(1) + '°）',
    '这就是上行不得改为增量的原因');
}

// ---------------- L1.5 IP 分片放大效应 ----------------
function l1Fragment() {
  section('L1.5 IP 分片放大效应：为何 1a 瘦身是 1b 的硬前提');
  var FRAMES = 4000;
  var LINK_LOSS = 0.02;   // 温和的 2% 均匀丢包
  var FRAGS = 14;         // 19662 字节 / 1472 ≈ 14 片（重构前的实测值）

  // 两组各自独立的信道实例：不能共用一个 —— 分片组会消耗 14 倍的 RNG，
  // 共用会让两组落在完全不同的随机序列上，对比就不同源了。
  // 同种子 + 各自实例 ⇒ 两组面对**统计同分布**的链路。
  var chFrag = new LossChannel({ seed: 3, loss: LINK_LOSS });
  var lostFrag = 0;
  for (var f = 0; f < FRAMES; f++) {
    var whole = true;
    // 分片几乎同时发出，故同一时刻判定；缺任一片则整包在内核报废，
    // 上层收到的是「什么都没收到」，没有部分可用性
    for (var i = 0; i < FRAGS; i++) {
      if (!chFrag.passes(f * INTERVAL)) whole = false;
    }
    if (!whole) lostFrag++;
  }
  var fragLoss = lostFrag / FRAMES;

  var chOne = new LossChannel({ seed: 3, loss: LINK_LOSS });
  var lostOne = 0;
  for (f = 0; f < FRAMES; f++) if (!chOne.passes(f * INTERVAL)) lostOne++;
  var singleLoss = lostOne / FRAMES;

  // 理论值 1-(1-p)^14 ≈ 24.7%，用来校验模型没跑偏
  var theory = 1 - Math.pow(1 - LINK_LOSS, FRAGS);
  console.log('       链路丢包 ' + pct(LINK_LOSS) + '：' + FRAGS +
    ' 分片 → 整帧损失 ' + pct(fragLoss) + '（理论 ' + pct(theory) +
    '）；单包 → ' + pct(singleLoss));

  ok(Math.abs(fragLoss - theory) < 0.03,
    '分片损失率吻合理论值 1-(1-p)^' + FRAGS + '（' + pct(fragLoss) +
    ' vs ' + pct(theory) + '）');
  ok(fragLoss > singleLoss * 5,
    '**分片把 ' + pct(LINK_LOSS) + ' 链路丢包放大成 ' + pct(fragLoss) +
    ' 整帧损失**（' + (fragLoss / singleLoss).toFixed(1) + '×）',
    '这是「不瘦身则 UDP 比 TCP 还差」的根据');
  ok(baseConfig.UDP_SNAP_CAP <= 1472,
    'UDP_SNAP_CAP(' + baseConfig.UDP_SNAP_CAP + ') ≤ 1472 ⇒ 生产配置永不分片');
}

// ---------------- L2 真机：真实 sendFrame 穿过弱网 ----------------
//
// L1 全是模型。这一层用**真实的 UdpEndpoint.sendFrame**（含真实的链式打散
// 调度、真实 setTimeout 抖动）把包穿过真实 socket + 弱网代理，
// 验证「真实打散调度确实产生了跨越坏窗口的时间分布」。
//
// 不在这层做统计对比（真 socket 跑几千帧要几分钟且必然 flake），
// 只验证一件事：**打散后的副本时刻分布，宽度足以跨出坏窗口**。
function l2Real(done) {
  section('L2 真机：真实 sendFrame 的副本时间分布（穿过弱网代理）');

  var cfg = Object.assign({}, baseConfig, {
    UDP_PORT: 0, UDP_HOST: '127.0.0.1', UDP_DUP: DUP
  });
  var ep = new UdpEndpoint(cfg, {});

  ep.listen(function () {
    var srvPort = ep.port();
    // 下行注入温和丢包：既要验证代理串在链路上，又要让多数副本到达以便测时刻
    var px = new M.WeakNetProxy({
      serverHost: '127.0.0.1', serverPort: srvPort,
      down: { seed: 31, loss: 0.05 }
    });

    px.listen(function () {
      var recv = [];        // 到达时刻
      var downSeen = 0;     // 代理观测到的服务器发包数（丢弃判定之前）
      var cli = null;
      var rebuilds = 0, proxyRebuilds = 0;
      var token = ep.createSession('wc1', 'r1');
      var w = new B.BinWriter(8);
      w.u8(UdpEndpoint.MAGIC_HELLO); w.u32(token); w.finishCrc16();
      var hello = Buffer.from(w.bytes());

      px.onDown = function () { downSeen++; };

      // 打洞需要**整条回环 socket 链重建**而非原地多重试。
      // Windows 回环 UDP 约 7% 概率某只 socket 永久黑洞；本链路有 client、
      // proxy.sock、proxy.upstream、endpoint 四只，仅重建客户端不能修复代理黑洞。
      // 真实网络没有这种现象，所以这只是 CI 环境适配，不掩盖真实缺陷 ——
      // 代码真有问题时整组重建几次也一样失败。
      bindAndPunch();

      function bindAndPunch() {
        cli = dgram.createSocket('udp4');
        cli.on('error', function () {});
        cli.on('message', function (buf) {
          if (buf[0] === UdpEndpoint.MAGIC_HACK) return;
          recv.push(Date.now());
        });
        cli.bind(0, '127.0.0.1', function () {
          var tries = 0;
          (function punch() {
            if (ep.isReady('wc1')) { afterPunch(); return; }
            if (tries >= 10) {
              try { cli.close(); } catch (e) {}
              if (rebuilds < 4) {
                rebuilds++;
                bindAndPunch();
                return;
              }
              // 真实链路是 client → proxy.sock → proxy.upstream → endpoint；黑洞可能
              // 落在代理任一 socket，单独重建客户端仍无效。整组 client+proxy 重建。
              if (proxyRebuilds < 3) {
                proxyRebuilds++;
                rebuilds = 0;
                px.close();
                px.listen(function () { bindAndPunch(); });
                return;
              }
              afterPunch();
              return;
            }
            tries++;
            try { cli.send(hello, px.port(), '127.0.0.1'); } catch (e) {}
            setTimeout(punch, 25);
          })();
        });
      }

      function afterPunch() {
        ok(ep.isReady('wc1') === true,
          '经弱网代理完成打洞（服务器会话地址 = 代理地址）',
          '客户端 socket 重建 ' + rebuilds + ' 次、代理重建 ' + proxyRebuilds + ' 次后仍失败');
        if (!ep.isReady('wc1')) { cleanup(); return; }

        var frame = BP.encSnapBin({ tick: 7, ack: 1, timeMs: 0, entries: [] });

        // 采样多帧后取**跨度中位数**：单帧样本会被一次调度抖动或一次丢包带偏。
        // 中位数让「打散是否生效」这个判断不依赖某一帧的运气。
        var SAMPLES = 5;
        var spans = [], dupCounts = [];
        var i = 0;
        (function sampleOne() {
          if (i >= SAMPLES) { afterSamples(); return; }
          i++;
          recv.length = 0; downSeen = 0;
          ep.sendFrame('wc1', frame);
          setTimeout(function () {
            dupCounts.push(downSeen);
            if (recv.length >= 2) spans.push(recv[recv.length - 1] - recv[0]);
            sampleOne();
          }, 120);
        })();

        function afterSamples() {
          var maxDup = Math.max.apply(null, dupCounts);
          ok(maxDup >= 2,
            '代理观测到服务器发出多份副本（峰值 ' + maxDup + ' 份，UDP_DUP=' + DUP + '）');
          ok(spans.length >= 3,
            '取得足够跨度样本（' + spans.length + '/' + SAMPLES + ' 帧收到 ≥2 份）',
            '注入 5% 丢包下多数帧应至少到 2 份');

          if (spans.length >= 3) {
            spans.sort(function (a, b) { return a - b; });
            var med = spans[Math.floor(spans.length / 2)];
            console.log('       真实副本到达跨度（' + spans.length + ' 帧）: [' +
              spans.join(', ') + '] ms，中位数 ' + med +
              '（帧窗口 ' + INTERVAL + 'ms，打散目标 ' + Math.round(SPREAD_WIN) + 'ms）');

            // 核心断言：真实调度产生的时间跨度必须足以跨出定时器 tick。
            // 这把 L1 的模型结论与真实代码栈钉在一起 ——
            // 若打散退化成「同步连发」，跨度会变成 0，断言立刻失败。
            // **已用故障注入验证过**：把 sendFrame 的链式调度换成同步 for 循环
            // 连发，此处实测跨度 0ms 并准确报错。
            ok(med >= 6,
              '**真实副本跨度中位数 ' + med + 'ms ≥ 6ms**（跨得过定时器 tick，不是同时发）',
              '趋近 0 说明打散调度失效');
            ok(med <= INTERVAL * 1.5,
              '副本未溢出到下一帧窗口（' + med + 'ms ≤ ' +
              Math.round(INTERVAL * 1.5) + 'ms）',
              '溢出则不再是本帧的冗余，纯浪费带宽');
          }
          cleanup();
        }
      }

      function cleanup() {
        try { if (cli) cli.close(); } catch (e) {}
        px.close();
        ep.close(function () { done(); });
      }
    });
  });
}

// ---------------- 主流程 ----------------
console.log('弱网传输层验证（v3.1）');
console.log('帧窗口 ' + INTERVAL + 'ms（TICK_MS=' + baseConfig.TICK_MS +
  ' × SNAP_EVERY=' + baseConfig.SNAP_EVERY + '），UDP_DUP=' + DUP);

l1Burst();
l1Uniform();
l1Sweep();
l1Idempotent();
l1Fragment();
l2Real(function () {
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
});
