'use strict';
/**
 * udp.client.test.js — 客户端 UDP 加速层回归（v3.1 M1b）
 *
 * 对应设计：docs/architecture/02-udp-transport.md §3.3、§4.3
 *
 * 守护的核心不变量：
 *   1. 上行冗余**在帧内时间打散**（同一毫秒连发等于没发）
 *   2. 下行去重正确处理 uint16 tick 环回
 *   3. 握手超时 / 下行停滞 → 自动回落 TCP，且 TCP 路径不受影响
 *   4. 二进制快照 + 低频 meta 合并后与 JSON snap **同构**（上层零感知）
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles',
  'ai', 'multiplayer'].forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'transport', 'binCodec', 'binProtocol', 'udpTransport', 'interpolation',
  'netMatch', 'wsTransport'].forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS, B = CS.bin, BP = CS.binProtocol, P = CS.protocol, cfg = CS.config;
var MAGIC_HACK = 0x4B;

var pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

/** 假 socket：记录全部发送，可注入下行 */
function mkFakeSocket(log) {
  var handler = null;
  return {
    onMessage: function (cb) { handler = cb; },
    send: function (u8) { log.push({ t: Date.now(), u8: u8.slice ? u8.slice() : u8 }); },
    close: function () {},
    inject: function (u8) { if (handler) handler(u8); }
  };
}
function ackBytes(token) {
  var w = new B.BinWriter(8);
  w.u8(MAGIC_HACK); w.u32(token); w.finishCrc16();
  return w.bytes();
}

// ---------------- T1 握手与可用性 ----------------
function t1(done) {
  section('T1 握手与可用性判定');
  var log = [];
  var sock = mkFakeSocket(log);
  var states = [];
  var accel = new CS.UdpAccel({
    socketFactory: function () { return sock; },
    onStateChange: function (a) { states.push(a); }
  });

  ok(accel.attach({ udpPort: 0, udpToken: 1 }) === false, '缺少端口时 attach 失败（走 TCP）');
  ok(accel.attach({ udpPort: 9999, udpToken: 0x1234 }) === true, '信息完整时 attach 成功');
  ok(log.length === 1, 'attach 后立即发出 hello 打洞');
  ok(log[0].u8[0] === 0x48, 'hello 的 magic 正确');
  ok(accel.active === false, '未收到 ack 前 active=false（此时应走 TCP）');
  ok(accel.sendInput(1.0, 0) === false, '**未激活时 sendInput 返回 false**（调用方据此走 TCP）');

  var badCrc = ackBytes(0x1234).slice(); badCrc[badCrc.length - 1] ^= 0xFF;
  sock.inject(badCrc);
  sock.inject(ackBytes(0x9999));
  ok(accel.available === false && accel.lastRecvAt === 0,
    '**CRC 错误或 token 不匹配的 ACK 均不得激活/续命**');

  sock.inject(ackBytes(0x1234));
  ok(accel.available === true, '收到完整合法 ack 后 available=true');
  ok(accel.active === true, 'active=true');
  ok(states[states.length - 1] === true, '状态变化已回调');

  accel.dispose();
  done();
}

// ---------------- T2 上行冗余打散 ----------------
function t2(done) {
  section('T2 上行冗余打散（核心）');
  var log = [];
  var sock = mkFakeSocket(log);
  var accel = new CS.UdpAccel({
    socketFactory: function () { return sock; },
    dup: 3, frameIntervalMs: 33
  });
  accel.attach({ udpPort: 9999, udpToken: 7 });
  sock.inject(ackBytes(7));
  log.length = 0;

  var t0 = Date.now();
  ok(accel.sendInput(2.5, 1) === true, '激活后 sendInput 返回 true');
  ok(log.length === 1, '首份立即发出');

  setTimeout(function () {
    // 份数是**功能约定**（抗丢包），不能因定时器漂移/窗口到期被砍。
    // 曾偶发只发出 2 份：deadline 检查放在「发完一份后」，
    // 漂移导致越过窗口就把最后一份丢了 —— 为省带宽牺牲冗余是本末倒置。
    ok(log.length === 3, '共发出 dup=3 份，份数不因定时器漂移被砍（' + log.length + '）');
    if (log.length === 3) {
      var d1 = log[1].t - log[0].t, d2 = log[2].t - log[0].t;
      console.log('       发送间隔：0 / ' + d1 + ' / ' + d2 + ' ms（帧窗口 33ms）');
      // 判据按真实目的：落在不同定时器 tick + 不溢出到下一帧。
      // 要求**最小间隔**而非仅「严格递增」：间隔 1ms 跨不过定时器分辨率
      // （Windows 约 15.6ms），等于没打散。服务器侧曾实测到 0/24/24。
      var MIN_GAP = 5;
      ok(d1 >= MIN_GAP && (d2 - d1) >= MIN_GAP,
        '相邻副本间隔 ≥' + MIN_GAP + 'ms（0 / ' + d1 + ' / ' + d2 + '）',
        '间隔 ' + d1 + ' 与 ' + (d2 - d1) + 'ms，过近则跨不过定时器 tick');
      ok(d2 <= 33 * 1.6, '副本落在本帧窗口内（' + d2 + 'ms）', '溢出到下一帧');
    }
    // 三份内容应完全相同（同一帧的副本）
    if (log.length === 3) {
      var same = true;
      for (var i = 0; i < log[0].u8.length; i++) {
        if (log[1].u8[i] !== log[0].u8[i] || log[2].u8[i] !== log[0].u8[i]) same = false;
      }
      ok(same, '三份副本内容完全一致（同一帧的冗余）');
    }
    // frameId 应递增
    log.length = 0;
    accel.sendInput(2.6, 0);
    var f1 = BP.decInputFrag(log[0].u8);
    ok(f1 && f1.frameId === 2, 'frameId 逐帧递增（' + (f1 ? f1.frameId : 'N/A') + '）');
    ok(f1 && Math.abs(f1.angle - 2.6) < 0.001, 'angle 正确编码');

    // dup=1 时不应有额外副本
    accel.dispose();
    var log2 = [];
    var sock2 = mkFakeSocket(log2);
    var a2 = new CS.UdpAccel({ socketFactory: function () { return sock2; }, dup: 1 });
    a2.attach({ udpPort: 1, udpToken: 9 });
    sock2.inject(ackBytes(9));
    log2.length = 0;
    a2.sendInput(1, 0);
    setTimeout(function () {
      ok(log2.length === 1, 'dup=1 时只发一份（关闭冗余，' + log2.length + '）');
      a2.dispose();
      done();
    }, 60);
  }, 80);
}

// ---------------- T3 下行去重（含 uint16 环回） ----------------
function t3(done) {
  section('T3 下行去重与 tick 环回');
  var log = [];
  var sock = mkFakeSocket(log);
  var got = [];
  var accel = new CS.UdpAccel({
    socketFactory: function () { return sock; },
    onSnap: function (d) { got.push(d.tk); }
  });
  accel.attach({ udpPort: 1, udpToken: 5 });
  sock.inject(ackBytes(5));

  function snapAt(tick) {
    return BP.encSnapBin({ tick: tick, ack: 0, timeMs: 0, entries: [] });
  }
  sock.inject(snapAt(100));
  sock.inject(snapAt(100));      // 冗余副本
  sock.inject(snapAt(100));      // 冗余副本
  sock.inject(snapAt(101));
  sock.inject(snapAt(99));       // 迟到的旧帧
  sock.inject(snapAt(105));

  ok(got.length === 3, '冗余副本被去重（收到 ' + got.length + ' 帧，注入 6 份）');
  ok(got.join(',') === '100,101,105', '只保留递增的新帧（' + got.join(',') + '）');
  ok(accel.stats.dupDropped === 3, '统计到 3 次丢弃（' + accel.stats.dupDropped + '）');

  // uint16 环回：65534 → 65535 → 0 → 1 应全部被接受
  got.length = 0;
  accel.lastRecvTick = -1;
  [65534, 65535, 0, 1].forEach(function (tk) { sock.inject(snapAt(tk)); });
  ok(got.join(',') === '65534,65535,0,1',
    '**tick 环回后仍正确判序**（' + got.join(',') + '）',
    '环回处理错误会让对局在 36 分钟后卡死');

  accel.dispose();
  done();
}

// ---------------- T4 停滞回落 ----------------
function t4(done) {
  section('T4 下行停滞 → 回落 TCP');
  var log = [];
  var sock = mkFakeSocket(log);
  var states = [], probes = [];
  var accel = new CS.UdpAccel({
    socketFactory: function () { return sock; },
    onStateChange: function (a) { states.push(a); },
    onProbe: function (a) { probes.push(a); }
  });
  accel.attach({ udpPort: 1, udpToken: 3 });
  sock.inject(ackBytes(3));
  ok(accel.active === true, '握手后 active');

  // 伪造「很久没收到下行」
  accel.lastRecvAt = Date.now() - 2000;
  setTimeout(function () {
    ok(accel.active === false, '**停滞超时后 active=false**（调用方自动走 TCP）');
    ok(accel.sendInput(1, 0) === false, '停滞后 sendInput 返回 false');
    ok(accel.stats.fallbacks >= 1, '记录了回落次数（' + accel.stats.fallbacks + '）');

    // keepalive ACK 只有 7B，不能单独证明完整快照路径恢复；先进入服务器双发探测。
    sock.inject(ackBytes(3));
    ok(accel.active === false, '**回落后仅收到 hello_ack 不立即停 TCP**');
    ok(probes[probes.length - 1] === true, 'hello_ack 触发安全双发探测窗');

    // 只有完整二进制快照真的到达才恢复 active。
    sock.inject(BP.encSnapBin({ tick: 500, ack: 0, timeMs: 0, entries: [] }));
    ok(accel.active === true, '**收到完整下行快照后才恢复 UDP**');
    accel.dispose();
    done();
  }, 320);
}

// ---------------- T5 与 WsTransport 集成：meta 合并同构 ----------------
function t5(done) {
  section('T5 二进制快照 + meta 合并后与 JSON snap 同构');
  var T = new CS.WsTransport({ url: 'ws://127.0.0.1:1', WebSocketImpl: function () {
    return { send: function () {}, close: function () {}, readyState: 0 };
  } });

  // 模拟低频 meta 到达
  T._onMeta({
    t: 'meta', tk: 1,
    sn: [{ id: 3, nm: '蜡笔小新', kl: 2, es: 340, et: 12, ml: 25, sv: 87, mb: 5 }],
    blocks: [{ bid: 1, x: 10, y: 20, c: 'red', k: 'color', r: null, rr: 0 }]
  });
  ok(T.meta[3] && T.meta[3].nm === '蜡笔小新', 'meta 已缓存昵称');
  ok(T._blocksById[1] && T._blocksById[1].color === 'red', 'meta 已整体建立色块全量基线');

  // 构造一条真实二进制快照：删除旧色块、新增彩色星，并携带移动流星。
  var s = new CS.Snake(1000, 800, 8, 1.0, cfg.COLOR_KEYS.slice());
  for (var i = 0; i < 80; i++) s.update(33);
  var e = {
    id: 3, name: 'x', isPlayer: true, alive: true, kills: 0, elimScore: 0,
    elimTotal: 0, maxLen: 8, survivalScore: 0, mpBonusScore: 0,
    bittenUntil: 0, slowUntil: 0, snake: s
  };
  var dec = BP.decSnapBin(BP.encSnapBin({
    tick: 9, ack: 1, timeMs: 5000, entries: [{ e: e, lite: false }],
    blockAdd: [{ bid: 2, x: 30, y: 40, color: null, kind: 'grab' }],
    blockDel: [1],
    meteors: [{ x: -40, y: 300, vx: 140, vy: 0, color: 'green', phase: 1.2,
      trail: [{ x: -50, y: 300 }, { x: -45, y: 300 }] }]
  }));
  ok(dec.sn[0].name === null, '二进制快照本身不含昵称（已移出每帧）');
  ok(dec.sn[0].kills === 0, '二进制快照不含计分（已移出每帧）');
  ok(dec.blockAdd[0].kind === 'grab' && dec.blockAdd[0].color === null,
    '二进制色块保留特殊 kind 与 null color');
  ok(dec.meteors.length === 1 && dec.meteors[0].x === -40,
    '二进制快照保留移动流星及负坐标');

  // UDP/WT 与 wss 无跨通道顺序保证：首个二进制帧可能先于 1Hz meta。
  var Tpre = new CS.WsTransport({ url: 'ws://127.0.0.1:1', WebSocketImpl: function () {
    return { send: function () {}, close: function () {}, readyState: 0 };
  } });
  var preMerged = Tpre._mergeMeta(dec);
  var preName = CS.protocol.deSnake(preMerged.sn[0]).name;
  ok(typeof preName === 'string' && preName.length > 0,
    '**meta 尚未到达时仍提供非空昵称，首帧 HUD 不崩**');
  Tpre.dispose();

  var merged = T._mergeMeta(dec);
  var mergedSnake = CS.protocol.deSnake(merged.sn[0]);
  ok(mergedSnake.name === '蜡笔小新', '**规范化后昵称回填**');
  ok(mergedSnake.kills === 2 && mergedSnake.elimScore === 340, '规范化后计分回填');
  ok(mergedSnake.maxLen === 25 && mergedSnake.mpBonusScore === 5, '规范化后全部计分字段回填');
  ok(merged.bl.length === 1 && CS.protocol.deBlock(merged.bl[0]).kind === 'grab',
    '色块增量合成为 JSON 路径可消费的全量 bl');
  ok(merged.mt.length === 1 && CS.protocol.deMeteor(merged.mt[0]).color === 'green',
    '流星规范化为 JSON 路径可消费的 mt');

  // 最终判据必须进入真实消费者，而不是只比较两份字段列表。
  var rm = new CS.RemoteMatch(3, { interpDelayMs: 0 });
  var applyErr = null;
  try { rm.applySnap(merged, Date.now()); } catch (err) { applyErr = err; }
  ok(applyErr === null, '**规范化结果可直接穿过 RemoteMatch.applySnap**', applyErr && applyErr.message);
  ok(rm.playerEntry && rm.playerEntry.name === '蜡笔小新', 'RemoteMatch 已建立本机 Entry');
  ok(rm.blocks.length === 1 && rm.blocks[0].kind === 'grab', 'RemoteMatch 保留特殊道具语义');
  ok(rm.meteors.length === 1 && rm.meteors[0].vx === 140, 'RemoteMatch 保留移动流星');

  // 迟到的旧 meta 不得把较新的二进制增量回滚。
  T._onMeta({ t: 'meta', tk: 8, sn: [],
    blocks: [{ bid: 1, x: 10, y: 20, c: 'red', k: 'color' }] });
  ok(T._blocksById[2] && !T._blocksById[1],
    '**迟到 meta 不回滚较新的色块增量基线**');

  // 偶发 TCP 全量（探测双发 / 超限回退）必须同步 bid 基线，恢复加速后继续打补丁。
  var tcpSnap = { tk: 10, bl: [P.serBlock({ bid: 3, x: 50, y: 60, color: 'blue', kind: 'color' })] };
  T._syncBlocksFromTcp(tcpSnap);
  ok(T._blocksById[3] && Object.keys(T._blocksById).length === 1,
    'TCP 全量快照用 bid 重建二进制增量基线');

  // 跨通道乱序：tick=10 的 TCP 全量先到后，迟到的 tick=9 增量不得回滚它。
  var staleDec = BP.decSnapBin(BP.encSnapBin({
    tick: 9, ack: 0, timeMs: 5050, entries: [],
    blockAdd: [{ bid: 5, x: 90, y: 100, color: 'red', kind: 'color' }],
    blockDel: [3]
  }));
  var staleMerged = T._mergeMeta(staleDec);
  ok(staleMerged.bl.length === 1 && P.deBlock(staleMerged.bl[0]).bid === 3 && T._blockTick === 10,
    '**迟到加速增量不回滚较新的 TCP/meta 色块基线**');

  var dec2 = BP.decSnapBin(BP.encSnapBin({
    tick: 11, ack: 0, timeMs: 5100, entries: [],
    blockAdd: [{ bid: 4, x: 70, y: 80, color: 'yellow', kind: 'color' }],
    blockDel: [3]
  }));
  var merged2 = T._mergeMeta(dec2);
  ok(merged2.bl.length === 1 && P.deBlock(merged2.bl[0]).bid === 4,
    '**恢复加速后从 TCP 新基线继续应用 add/del**');

  T.dispose();
  done();
}

// ---------------- T6 UDP 关闭时不影响 TCP ----------------
function t6(done) {
  section('T6 UDP 不可用时 TCP 路径完好');
  var sent = [];
  var fakeWs = { send: function (d) { sent.push(d); }, close: function () {}, readyState: 1 };
  var T = new CS.WsTransport({
    url: 'ws://127.0.0.1:1',
    WebSocketImpl: function () { return fakeWs; },
    udp: false               // 显式关闭（回滚点）
  });
  T.ws = fakeWs;
  ok(T.udpEnabled === false, 'udp:false 时加速层被禁用');

  T._setupUdp({ udpPort: 1234, udpToken: 5 });
  ok(T.udp === null, '即使 matched 带回 udp 信息也不建立旁路');

  T.sendInput(1.23, 0);
  ok(sent.length === 1, '输入走 TCP 发出');
  var msg = CS.protocol.decode(sent[0]);
  ok(msg && msg.t === 'input' && Math.abs(msg.a - 1.23) < 0.01, 'TCP 输入内容正确');
  ok(T.seq === 1, 'TCP 路径的 seq 正常递增');

  // 输入序号必须跨物理通道共享：早期只走几帧 UDP 后回落，TCP 不能从 1 重来。
  var udpLog = [], tcpLog = [], seqSock = mkFakeSocket(udpLog);
  var seqWs = { send: function (d) { tcpLog.push(P.decode(d)); }, close: function () {}, readyState: 1 };
  var Tseq = new CS.WsTransport({
    url: 'ws://127.0.0.1:1', WebSocketImpl: function () { return seqWs; },
    udpSocketFactory: function () { return seqSock; }
  });
  Tseq.ws = seqWs;
  Tseq._setupUdp({ udpPort: 9, udpToken: 55, accelSnapIntervalMs: 33,
    accelSnapEvery: 1, udpDup: 1 });
  seqSock.inject(ackBytes(55));
  udpLog.length = 0; tcpLog.length = 0;
  for (var si = 0; si < 4; si++) Tseq.sendInput(0.2 + si, 0);
  var udpSeqs = udpLog.map(function (r) {
    var f = BP.decInputFrag(r.u8); return f && f.frameId;
  });
  Tseq.udp._setActive(false);
  Tseq.sendInput(1.5, 0);
  var tcpInputs = tcpLog.filter(function (m) { return m && m.t === P.C2S.INPUT; });
  ok(udpSeqs.join(',') === '1,2,3,4', '加速输入使用共享逻辑 seq（' + udpSeqs.join(',') + '）');
  ok(tcpInputs.length === 1 && tcpInputs[0].seq === 5,
    '**早期加速回落后 TCP 紧接 seq=5，不冻结 INPUT_SEQ_RESET_GAP 帧**');
  Tseq.dispose();

  // 平台无任何加速能力时（旧浏览器：既无裸 UDP 也无 WebTransport）静默走 TCP。
  //
  // 注意断言的写法：v3.1 阶段 1d 起 socket 工厂**在 _setupUdp 内部按 matched
  // 信息选定**（浏览器分支要看服务器有没有下发 wtPort），所以不能像早先那样
  // 在外面设 `T2.udpFactory = null` —— 那个赋值会被覆盖，断言变成空的。
  // 正确做法是注入一个「明确返回 null」的工厂来模拟无能力平台。
  var T2 = new CS.WsTransport({
    url: 'ws://127.0.0.1:1',
    WebSocketImpl: function () { return fakeWs; },
    udpSocketFactory: function () { return null; }   // 平台无可用 socket
  });
  T2._setupUdp({ udpPort: 1234, udpToken: 5 });
  ok(T2.udp === null, '无平台加速能力时静默降级（旧浏览器场景）');

  // 服务器只下发 wt 信息、而平台又拿不到 socket 时，同样必须降级而不是抛错。
  // 注入工厂要自报 wt，否则 _setupUdp 会按裸 UDP 选端口，测试就不再对应此场景。
  var noWtSocket = function () { return null; };
  noWtSocket.channelKind = 'wt';
  var T3 = new CS.WsTransport({
    url: 'ws://127.0.0.1:1',
    WebSocketImpl: function () { return fakeWs; },
    udpSocketFactory: noWtSocket
  });
  T3._setupUdp({ wtPort: 8093, wtToken: 7, wtPath: '/wt' });
  ok(T3.udp === null, '只有 wt 信息但平台不支持时也静默降级');
  ok(T3.accelDiag.reason === 'factory_unavailable' && T3.accelDiag.phase === 'factory',
    '**静默回落仍保留可诊断原因**（' + T3.accelDiag.reason + '）');

  T.dispose(); T2.dispose(); T3.dispose();
  done();
}

// ---------------- T7 通道可观测性 ----------------
//
// 为什么这组断言值得存在：加速通道**设计成静默降级** —— 打不通就走 wss、
// 玩家无感。产品行为是对的，但代价是「有没有吃到 UDP 收益」不可观测。
// 网页版曾经整个阶段都在走 wss+JSON 而无人察觉，正是因为
// `udp` 事件被发出来却没有任何消费者。
//
// 所以断言两件事：
//   1. 事件必须带**通道类型**，不能只报 active 布尔 ——
//      否则页面无法区分「WebTransport」与「裸 UDP」
//   2. `offered` 必须与「实际生效」分开记 ——
//      「服务器没下发」和「下发了但没用上」是两种完全不同的故障，
//      合成一个布尔就没法定位了
function t7(done) {
  section('T7 通道可观测性（静默降级必须可见）');

  var events = [], control = [];
  var fakeWs = { send: function (s) { control.push(P.decode(s)); }, close: function () {}, readyState: 1 };
  // 注入一个自报 channelKind='wt' 的工厂，模拟浏览器选中 WebTransport。
  // 这里能这么测，正是因为通道类型改成了**由工厂自报**而不是调用方重判平台 ——
  // 若还是在 _setupUdp 里判 wx/node，本测试跑在 node 上就永远只能测到裸 UDP 分支。
  var wtFactory = function () {
    return { onMessage: function () {}, send: function () {}, close: function () {} };
  };
  wtFactory.channelKind = 'wt';
  var T = new CS.WsTransport({
    url: 'ws://127.0.0.1:1',
    WebSocketImpl: function () { return fakeWs; },
    udpSocketFactory: wtFactory
  });
  T.ws = fakeWs;
  T.onAll({ udp: function (m) { events.push(m); } });

  // 服务器同时下发裸 UDP 与 WT，工厂标注为 wt ⇒ 应选 WT 的 port/token
  T._setupUdp({
    udpPort: 8092, udpToken: 11,
    wtPort: 8093, wtToken: 22, wtPath: '/wt',
    snapIntervalMs: 66, tcpSnapIntervalMs: 66,
    accelSnapIntervalMs: 33, accelSnapEvery: 1, udpDup: 3
  });
  ok(T.udp !== null, '拿到 socket 时建立加速旁路');
  ok(T.udpKind === 'wt',
    '**通道类型取自工厂自报的 channelKind**（udpKind=' + T.udpKind + '）',
    '若这里重判平台，node 下会误判成 udp');
  ok(T.udp.token === 22,
    '**用的是 wtToken 而非 udpToken**（token=' + T.udp.token + '）',
    '两个端点会话表独立，token 不可混用');
  ok(T.udp.frameIntervalMs === 33 && T.udp.tickStep === 1,
    '**加速旁路采用自己的 30Hz 间隔**（不是兼容字段的 TCP 66ms）');
  ok(T.udp.expectedDup === 3, '客户端拿到服务端冗余份数，诊断可计算副本丢失率');
  ok(T.udp.diag.state === 'connecting' && T.udp.diag.target.indexOf(':8093') >= 0,
    '建立期间暴露 connecting 状态与实际目标 authority');

  // 走**真实的 _setActive** 触发，而不是直接调回调 ——
  // 直接调回调等于绕过实现，那样测的是测试自己的代码。
  T.udp._setActive(true);
  ok(T.udp.diag.state === 'active', '通道激活后诊断状态切为 active');
  ok(events.length > 0, '状态变化会向上抛 udp 事件');
  ok(events.length > 0 && events[events.length - 1].active === true,
    '事件带 active 状态');
  ok(events.length > 0 && events[events.length - 1].kind === 'wt',
    '**事件带通道类型 kind=wt** —— 只报 active 布尔的话页面说不清走的哪条',
    '实际 kind=' + (events.length ? events[events.length - 1].kind : 'none'));

  T.udp._setActive(false);
  ok(events.length >= 2 && events[events.length - 1].active === false,
    '降级时同样上报（active=false）');
  ok(events[events.length - 1].kind === 'wt',
    '降级事件仍带原通道类型（用于说明「从哪条掉下来的」）');
  ok(control.some(function (m) { return m && m.t === P.C2S.ACCEL && m.on === 0; }),
    '**降级状态经可靠 WSS 控制面同步给服务器**（不是只改客户端布尔值）');
  ok(control.some(function (m) { return m && m.t === P.C2S.ACCEL && m.on === 1; }),
    '加速恢复同样经 WSS 同步给服务器');

  T.dispose();

  // 只下发裸 UDP（小游戏 / node 场景）时 kind 应为 udp
  var events2 = [];
  var T2 = new CS.WsTransport({
    url: 'ws://127.0.0.1:1',
    WebSocketImpl: function () { return fakeWs; },
    udpSocketFactory: function () {
      return { onMessage: function () {}, send: function () {}, close: function () {} };
    }
  });
  T2.ws = fakeWs;
  T2.onAll({ udp: function (m) { events2.push(m); } });
  T2._setupUdp({ udpPort: 8092, udpToken: 11, snapIntervalMs: 33 });
  ok(T2.udpKind === 'udp', '只有裸 UDP 时 kind=udp（' + T2.udpKind + '）');
  T2.udp._setActive(true);
  ok(events2.length > 0 && events2[0].kind === 'udp', '事件反映裸 UDP 通道');
  T2.dispose();

  // IPv6 WSS authority 必须完整解析，并在 WT 目标中补回 []；旧正则会只截出一个 '['。
  var ipv6Factory = function () {
    return { onMessage: function () {}, send: function () {}, close: function () {} };
  };
  ipv6Factory.channelKind = 'wt';
  var T6 = new CS.WsTransport({
    url: 'wss://[2001:db8::1]:9443/ws', WebSocketImpl: function () { return fakeWs; },
    udpSocketFactory: ipv6Factory
  });
  T6._setupUdp({ wtPort: 8093, wtToken: 66, wtPath: '/wt' });
  ok(T6.udp && T6.udp.host === '2001:db8::1' && T6.udp.diag.target === '[2001:db8::1]:8093',
    '**IPv6 WSS 主机完整解析，不截断为左方括号**（' + (T6.udp && T6.udp.host) + '）');
  T6.dispose();

  done();
}

// ---------------- T8 网络质量统计 ----------------
function t8(done) {
  section('T8 RTT / 抖动 / 快照迟到与逻辑丢帧统计');
  var fakeWs = { send: function () {}, close: function () {}, readyState: 1, bufferedAmount: 321 };
  var T = new CS.WsTransport({
    url: 'ws://127.0.0.1:1',
    WebSocketImpl: function () { return fakeWs; }
  });
  T.ws = fakeWs;
  T.timing = {
    tickMs: 33, tcpIntervalMs: 66, accelIntervalMs: 33,
    tcpEvery: 2, accelEvery: 1, udpDup: 3
  };

  T._recordRtt(40);
  T._recordRtt(72);
  T._recordRtt(48);
  ok(T.rtt === 48 && T.rttMin === 40 && T.rttMax === 72,
    'WSS RTT 记录 current/min/max');
  ok(T.rttJitter > 0, 'WSS RTT 抖动由真实样本推导（' + T.rttJitter.toFixed(1) + 'ms）');

  var oldNow = Date.now, now = 1000;
  Date.now = function () { return now; };
  try {
    T._recordSnap({ tk: 2 }, 'tcp');
    now += 66; T._recordSnap({ tk: 4 }, 'tcp');
    // 跳过 tk=6，且 150ms 后才到 tk=8：既是逻辑缺帧，也是明显迟到/卡顿。
    now += 150; T._recordSnap({ tk: 8 }, 'tcp');
  } finally { Date.now = oldNow; }
  var d = T.diagnostics('tcp');
  ok(d.receivedFrames === 3 && d.missingFrames === 1,
    '**按 TCP tickStep=2 识别出 1 个逻辑快照缺失**');
  ok(d.arrivalP50Ms === 150 && d.arrivalMaxMs === 150,
    '快照到达间隔统计 p50/max（150ms）');
  ok(d.latePct === 50 && d.stalls === 0,
    '迟到率与长卡顿分开统计（迟到 50%，>2.5倍才算长卡顿）');
  ok(d.wsBufferedBytes === 321, '暴露 WebSocket.bufferedAmount（321 字节）');

  var missingBeforeSwitch = d.missingFrames;
  T._resetSnapBaseline('tcp');
  now = 5000; Date.now = function () { return now; };
  try { T._recordSnap({ tk: 100 }, 'tcp'); } finally { Date.now = oldNow; }
  ok(T.diagnostics('tcp').missingFrames === missingBeforeSwitch,
    '**通道恢复时重置到达基线，不把加速期间的正常空窗误报成 TCP 缺帧**');

  // 加速通道：tick 10 → 13 代表中间丢 2 个逻辑帧；副本仍独立统计。
  var sock = mkFakeSocket([]);
  var accel = new CS.UdpAccel({ socketFactory: function () { return sock; } });
  now = 2000; Date.now = function () { return now; };
  accel.attach({ udpPort: 9, udpToken: 1, host: '127.0.0.1',
    snapIntervalMs: 33, tickStep: 1, expectedDup: 3 });
  now = 2037;
  sock.inject(new Uint8Array([MAGIC_HACK]));
  ok(accel.available === false && accel.lastRecvAt === 0 && accel.stats.pathRttMs === 0,
    '**截断 ACK 不得激活通道或刷新停滞计时**');
  sock.inject(ackBytes(1));
  Date.now = oldNow;
  ok(accel.stats.pathRttMs === 37,
    '完整 ACK（长度/CRC/token 均正确）测得加速通道 RTT（37ms）');
  sock.inject(BP.encSnapBin({ tick: 10, ack: 0, timeMs: 0, entries: [] }));
  sock.inject(BP.encSnapBin({ tick: 10, ack: 0, timeMs: 0, entries: [] }));
  sock.inject(BP.encSnapBin({ tick: 13, ack: 0, timeMs: 0, entries: [] }));
  ok(accel.stats.recv === 2 && accel.stats.missingFrames === 2,
    '**加速通道按 tick 识别逻辑帧丢失**（收2、丢2）');
  ok(accel.stats.rawSnaps === 3 && accel.stats.dupDropped === 1,
    '原始副本与去重后逻辑帧分别计数');
  accel.dispose();
  T.dispose();

  // 浏览器 WebTransport writer.write() 的错误通过 Promise rejection 到达，try/catch 抓不到。
  // 必须让 socket 通知 UdpAccel 回落，否则上行会继续被误判为“已由 WT 承载”。
  var prevWT = globalThis.WebTransport;
  function RejectingWT() {
    this.ready = Promise.resolve();
    this.closed = new Promise(function () {});
    this.datagrams = {
      createWritable: function () { return { getWriter: function () { return {
        write: function () { return Promise.reject(new Error('write failed')); }
      }; } }; },
      readable: { getReader: function () { return {
        read: function () { return new Promise(function () {}); }
      }; } }
    };
    this.close = function () {};
  }
  globalThis.WebTransport = RejectingWT;
  var wtFactory = CS.udpSocketFactories.webTransport({ host: '127.0.0.1', wtPort: 9, wtPath: '/wt' });
  var wtStates = [];
  var wtAccel = new CS.UdpAccel({
    socketFactory: wtFactory,
    onStateChange: function (v) { wtStates.push(v); }
  });
  wtAccel.attach({ udpPort: 9, udpToken: 77 });
  globalThis.WebTransport = prevWT;
  setTimeout(function () {
    var falseCount = wtStates.filter(function (v) { return v === false; }).length;
    ok(wtAccel.stats.socketErrors === 1 && falseCount === 1,
      '**WebTransport 异步写拒绝只通知一次回落，且无未处理拒绝/定时器重复通知**');
    ok(wtAccel.diag.state === 'terminal' && wtAccel.diag.reason === 'write_rejected' &&
      wtAccel.diag.phase === 'write',
      '**异步写失败留下稳定诊断枚举**（' + wtAccel.diag.reason + '/' + wtAccel.diag.phase + '）');
    wtAccel.dispose();
    done();
  }, 350);
}

// ---------------- 主流程 ----------------
console.log('客户端 UDP 加速层回归（v3.1 M1b）');
t1(function () {
  t2(function () {
    t3(function () {
      t4(function () {
        t5(function () {
          t6(function () {
            t7(function () {
              t8(function () {
                console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
                process.exit(fail === 0 ? 0 : 1);
              });
            });
          });
        });
      });
    });
  });
});
