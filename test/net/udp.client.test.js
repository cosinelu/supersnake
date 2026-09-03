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
['protocol', 'transport', 'binCodec', 'binProtocol', 'udpTransport', 'wsTransport']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var CS = globalThis.CS, B = CS.bin, BP = CS.binProtocol, cfg = CS.config;
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

  sock.inject(ackBytes(0x1234));
  ok(accel.available === true, '收到 ack 后 available=true');
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
  var states = [];
  var accel = new CS.UdpAccel({
    socketFactory: function () { return sock; },
    onStateChange: function (a) { states.push(a); }
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

    // 网络恢复：收到新包应自动重新激活
    sock.inject(BP.encSnapBin({ tick: 500, ack: 0, timeMs: 0, entries: [] }));
    ok(accel.active === true, '**收到新下行后自动恢复 UDP**（无需重新握手）');
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
    blocks: [{ bid: 1, x: 10, y: 20, c: 'red' }]
  });
  ok(T.meta[3] && T.meta[3].nm === '蜡笔小新', 'meta 已缓存昵称');
  ok(T._metaBlocks && T._metaBlocks.length === 1, 'meta 携带色块全量校正基线');

  // 构造一条二进制快照（其中 name 为 null，计分为 0）
  var s = new CS.Snake(1000, 800, 8, 1.0, cfg.COLOR_KEYS.slice());
  for (var i = 0; i < 80; i++) s.update(33);
  var e = {
    id: 3, name: 'x', isPlayer: true, alive: true, kills: 0, elimScore: 0,
    elimTotal: 0, maxLen: 8, survivalScore: 0, mpBonusScore: 0,
    bittenUntil: 0, slowUntil: 0, snake: s
  };
  var dec = BP.decSnapBin(BP.encSnapBin({ tick: 9, ack: 1, timeMs: 5000, entries: [{ e: e, lite: false }] }));
  ok(dec.sn[0].name === null, '二进制快照本身不含昵称（已移出每帧）');
  ok(dec.sn[0].kills === 0, '二进制快照不含计分（已移出每帧）');

  var merged = T._mergeMeta(dec);
  ok(merged.sn[0].name === '蜡笔小新', '**合并后昵称回填**');
  ok(merged.sn[0].kills === 2 && merged.sn[0].elimScore === 340, '合并后计分回填');
  ok(merged.sn[0].maxLen === 25 && merged.sn[0].mpBonusScore === 5, '合并后全部计分字段回填');

  // 同构性：与 JSON 路径的 deSnake 字段名一致
  var jsonSnake = CS.protocol.deSnake(CS.protocol.serSnake(e));
  var missing = [];
  ['id', 'name', 'isPlayer', 'alive', 'x', 'y', 'angle', 'speed', 'colors', 'segPos',
    'kills', 'elimScore', 'elimTotal', 'maxLen', 'survivalScore', 'mpBonusScore']
    .forEach(function (k) {
      if (!(k in merged.sn[0])) missing.push(k);
      if (!(k in jsonSnake)) missing.push('json:' + k);
    });
  ok(missing.length === 0,
    '**与 JSON 路径字段完全同构**（上层零改动可消费两条通道）',
    '缺失 ' + missing.join(','));

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

  // 服务器只下发 wt 信息、而平台又拿不到 socket 时，同样必须降级而不是抛错
  var T3 = new CS.WsTransport({
    url: 'ws://127.0.0.1:1',
    WebSocketImpl: function () { return fakeWs; },
    udpSocketFactory: function () { return null; }
  });
  T3._setupUdp({ wtPort: 8093, wtToken: 7, wtPath: '/wt' });
  ok(T3.udp === null, '只有 wt 信息但平台不支持时也静默降级');

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

  var events = [];
  var fakeWs = { send: function () {}, close: function () {}, readyState: 1 };
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
    snapIntervalMs: 33
  });
  ok(T.udp !== null, '拿到 socket 时建立加速旁路');
  ok(T.udpKind === 'wt',
    '**通道类型取自工厂自报的 channelKind**（udpKind=' + T.udpKind + '）',
    '若这里重判平台，node 下会误判成 udp');
  ok(T.udp.token === 22,
    '**用的是 wtToken 而非 udpToken**（token=' + T.udp.token + '）',
    '两个端点会话表独立，token 不可混用');

  // 走**真实的 _setActive** 触发，而不是直接调回调 ——
  // 直接调回调等于绕过实现，那样测的是测试自己的代码。
  T.udp._setActive(true);
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

  done();
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
              console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
              process.exit(fail === 0 ? 0 : 1);
            });
          });
        });
      });
    });
  });
});
