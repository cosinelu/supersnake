'use strict';
/**
 * webtransport.test.js — 浏览器 WebTransport 通道回归（v3.1 阶段 1d）
 *
 * 对应设计：docs/architecture/02-udp-transport.md §7.4.1
 *
 * 守护的核心不变量：
 *   1. **会话语义与 UdpEndpoint 逐条一致** —— 两条通道共用同一套客户端逻辑，
 *      一旦语义漂移，客户端就要为两条通道分叉，而它们本该只是「管道不同」
 *   2. frameId 去重含「大幅回退＝重新计数」（缺它重连玩家输入永久失效）
 *   3. 冗余副本**帧内时间打散**，不是同一时刻连发
 *      （弱网实测打散比同时发帧到达率高 +10.2pp、长卡顿少 73%）
 *   4. 二进制帧解码结果与 JSON 路径**同构**（上层零感知）
 *   5. 任何畸形输入不得让进程崩溃（这层直接暴露在公网）
 *   6. **TransportHub 对 room.js 完全透明** —— 接口与 UdpEndpoint 同构
 *
 * ---------------------------------------------------------------------------
 * 证书策略：自签 + serverCertificateHashes
 * ---------------------------------------------------------------------------
 * 不能依赖 letsencrypt 真证书（CI 上没有）。自签走 hashes 路径还能顺带避开
 * 库那条「Non serverCertificateHashes verification is experimental」警告。
 * hashes 路径有硬要求：**ECDSA P-256 + 有效期 ≤14 天**。
 *
 * 需要 `openssl`（Node 无证书签发 API）。没有则**跳过并显式说明**，
 * 不假装通过 —— 静默跳过的测试比没有测试更危险。
 *
 * 运行：node test/net/webtransport.test.js
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');
var child = require('child_process');

// 前端模块：客户端 socket 工厂要从这里取（复用生产代码，不另写一份）
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils'].forEach(function (f) { require(path.join(JS, f + '.js')); });
['binCodec', 'binProtocol', 'udpTransport']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });

var SERVER = path.join(__dirname, '..', '..', 'server');
var WebTransportEndpoint = require(path.join(SERVER, 'webtransport.js'));
var TransportHub = require(path.join(SERVER, 'transportHub.js'));
var UdpEndpoint = require(path.join(SERVER, 'udp.js'));
var baseConfig = require(path.join(SERVER, 'config.js'));
var CS = globalThis.CS, B = CS.bin, BP = CS.binProtocol;

var pass = 0, fail = 0, skipped = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

var MAGIC_HELLO = WebTransportEndpoint.MAGIC_HELLO;
var MAGIC_HACK = WebTransportEndpoint.MAGIC_HACK;

// ---------------- 自签证书 ----------------

function haveOpenssl() {
  try {
    child.execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

/** @returns {{cert:Buffer, key:Buffer, hash:Buffer, dir:string}} */
function makeSelfSigned() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cert-'));
  var keyF = path.join(dir, 'k.pem'), crtF = path.join(dir, 'c.pem');
  // ECDSA P-256 + 13 天有效期：serverCertificateHashes 的硬要求
  child.execSync(
    'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes' +
    ' -keyout "' + keyF + '" -out "' + crtF + '" -days 13' +
    ' -subj "/CN=localhost"' +
    ' -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
    { stdio: 'ignore' }
  );
  var cert = fs.readFileSync(crtF), key = fs.readFileSync(keyF);
  var hash = crypto.createHash('sha256')
    .update(new crypto.X509Certificate(cert).raw).digest();
  return { cert: cert, key: key, hash: hash, dir: dir };
}

function testConfig(extra) {
  return Object.assign({}, baseConfig, {
    WT_PORT: 0, WT_HOST: '127.0.0.1',
    UDP_DUP: 3, TICK_MS: 33, SNAP_EVERY: 1
  }, extra || {});
}

function mkHello(token) {
  var w = new B.BinWriter(8);
  w.u8(MAGIC_HELLO); w.u32(token); w.finishCrc16();
  return w.bytes();
}

// ---------------- T1 会话语义与 UdpEndpoint 对齐（纯逻辑，无需网络） ----------------
function t1() {
  section('T1 会话语义与 UdpEndpoint 逐条对齐');
  var cfg = testConfig();
  var wte = new WebTransportEndpoint(cfg, {});
  var ude = new UdpEndpoint(cfg, {});

  // 令牌
  var t1a = wte.createSession('c1', 'r1');
  var t2a = wte.createSession('c2', 'r1');
  ok(typeof t1a === 'number' && t1a >= 0 && t1a <= 0xFFFFFFFF, '令牌是 32bit 无符号数');
  ok(t1a !== t2a, '不同连接的令牌不同');
  ok(wte.sessions[t1a].connId === 'c1', '令牌可反查 connId');
  ok(wte.byConn['c1'] === t1a, 'connId 可正查令牌');
  var t1b = wte.createSession('c1', 'r2');
  ok(wte.sessions[t1a] === undefined, '重建会话时旧令牌被回收（不泄漏）');
  ok(wte.isReady('c1') === false, '未握手时 isReady=false（上层应走 TCP/UDP）');
  wte.sessions[t1b].verified = true; wte.sessions[t1b].writer = {};
  ok(wte.isReady('c1') === true, '握手完成后 WT ready');
  wte.setClientActive('c1', false);
  ok(wte.isReady('c1') === false, '**客户端请求暂停后 WT 撤销 ready，服务端可回落 TCP**');
  wte.setClientActive('c1', true);
  ok(wte.isReady('c1') === true, '客户端恢复后 WT 重新 ready');

  // WebTransport 的 datagram 上限来自 QUIC 会话协商，不能拿 UDP_SNAP_CAP=1400 硬套。
  var writes = 0;
  wte.sessions[t1b].wt = { datagrams: { maxDatagramSize: 1200 }, close: function () {} };
  wte.sessions[t1b].writer = { write: function () { writes++; return Promise.resolve(); } };
  ok(wte.sendFrame('c1', new Uint8Array(1201)) === false && writes === 0,
    '**超过协商 maxDatagramSize 时同步拒绝，room 可同 tick 回退 TCP**');
  ok(wte.sendFrame('c1', new Uint8Array(1200)) === true && writes === 1,
    '不超过协商上限的 datagram 正常写入');
  wte.dropSession('c1');
  ok(wte.sessions[t1b] === undefined && wte.byConn['c1'] === undefined, 'dropSession 清理干净');

  // write() 是 Promise；异步拒绝必须撤销 ready，否则服务端会持续抑制 TCP。
  var failEp = new WebTransportEndpoint(testConfig({ UDP_DUP: 1 }), {});
  var failToken = failEp.createSession('cf', 'rf');
  var failSession = failEp.sessions[failToken];
  failSession.verified = true;
  failSession.wt = { datagrams: { maxDatagramSize: 1200 } };
  failSession.writer = { write: function () {
    return { catch: function (reject) { reject(new Error('closed')); } };
  } };
  ok(failEp.sendFrame('cf', new Uint8Array(10)) === true,
    '异步写入已入队时 sendFrame 返回 true');
  ok(failEp.isReady('cf') === false && failEp.stats.writeFail === 1,
    '**写入 Promise 拒绝后立即撤销假 ready，下一 TCP tick 自动接管**');

  // frameId 去重：**逐条比对两个端点的返回值**。
  // 这是本测试最重要的一组 —— 语义一旦漂移，客户端就得为两条通道分叉。
  var ws = wte.sessions[wte.createSession('cx', 'r1')];
  var us = ude.sessions[ude.createSession('cx', 'r1')];
  var jump = cfg.INPUT_MAX_SEQ_JUMP, gap = cfg.INPUT_SEQ_RESET_GAP;
  var cases = [
    [100, '首个 frameId 无条件采纳'],
    [101, '递增采纳'],
    [101, '重复副本被丢弃（冗余的正常情况）'],
    [100, '小幅回退被丢弃（网络乱序）'],
    [105, '小幅超前采纳'],
    [105 + jump + 1, '异常跳变被丢弃']
  ];
  var allSame = true;
  cases.forEach(function (c) {
    var a = wte._acceptFrame(ws, c[0]);
    var b = ude._acceptFrame(us, c[0]);
    if (a !== b) allSame = false;
    ok(a === b, 'WT 与 UDP 判定一致：' + c[1] + '（both=' + a + '）',
      'WT=' + a + ' UDP=' + b);
  });
  ok(allSame, '**全部去重分支两端点完全一致**（客户端无需分叉）');

  // 大幅回退＝客户端重新计数。缺这条会让重连玩家输入**永久**失效
  ws.lastFrameId = 5000; us.lastFrameId = 5000;
  var wa = wte._acceptFrame(ws, 0), ua = ude._acceptFrame(us, 0);
  ok(wa === true && ua === true, '**大幅回退（重连后归零）两端点都接受并重置基线**');
  ok(ws.lastFrameId === 0 && us.lastFrameId === 0, '基线都已拉回');

  // 长时间 TCP 回落期间端点本身收不到上行；可靠输入采纳后必须同步 frameId 基线。
  wte.syncInputSeq('cx', 1012);
  ude.syncInputSeq('cx', 1012);
  ok(wte._acceptFrame(ws, 1013) === true && ude._acceptFrame(us, 1013) === true,
    '**TCP 回落超过 INPUT_MAX_SEQ_JUMP 后，恢复的首个加速输入仍可连续采纳**');
}

// ---------------- T2 TransportHub 聚合语义 ----------------
function t2() {
  section('T2 TransportHub 对 room.js 透明（接口与 UdpEndpoint 同构）');
  var cfg = testConfig();

  // 只有 UDP
  var u = new UdpEndpoint(cfg, {});
  var hubU = new TransportHub({ udp: u, wt: null });
  var oU = hubU.offer('c1', 'r1');
  ok(oU === null || (oU && oU.port === 0),
    '未 listen 的 UDP 端点 offer 返回 null 或 port=0（不误报可用）');

  // 只有 WT
  var w = new WebTransportEndpoint(cfg, {});
  var hubW = new TransportHub({ udp: null, wt: w });
  ok(hubW.offer('c1', 'r1') === null, '未 listen 的 WT 端点 offer 返回 null');
  ok(hubW.isReady('c1') === false, '未打通时 isReady=false');
  ok(hubW.sendFrame('c1', new Uint8Array(4)) === false, '未打通时 sendFrame 返回 false');
  ok(hubW.channelOf('c1') === 'tcp', '无通道时 channelOf=tcp');

  // 两者都无
  var hubN = new TransportHub({ udp: null, wt: null });
  ok(hubN.enabled() === false, '两条通道皆无时 enabled=false');
  ok(hubN.offer('c1', 'r1') === null, '无通道时 offer 返回 null（客户端全程 TCP）');
  // dropSession 不得抛异常（连接关闭路径必经）
  var threw = false;
  try { hubN.dropSession('c1'); } catch (e) { threw = true; }
  ok(!threw, '无通道时 dropSession 不抛异常');

  // 接口同构性：Hub 必须实现 room.js 与控制面用到的全部方法
  var need = ['offer', 'isReady', 'sendFrame', 'setClientActive', 'needsTcp', 'syncInputSeq', 'dropSession'];
  var missing = need.filter(function (m) { return typeof hubN[m] !== 'function'; });
  ok(missing.length === 0,
    '**Hub 实现了 room.js 依赖的全部方法**（' + need.join('/') + '）',
    '缺: ' + missing.join(','));
  var udpMissing = need.filter(function (m) { return typeof u[m] !== 'function'; });
  var wtMissing = need.filter(function (m) { return typeof w[m] !== 'function'; });
  ok(udpMissing.length === 0 && wtMissing.length === 0,
    '两个端点各自也实现了同一组方法（可互换）',
    'udp 缺:' + udpMissing.join(',') + ' wt 缺:' + wtMissing.join(','));
}

// ---------------- T3 端到端：真 Http3Server + 真客户端 ----------------
function t3(done) {
  section('T3 端到端（真 Http3Server + 真 WebTransport 客户端）');
  if (!haveOpenssl()) {
    skipped++;
    console.log('  SKIP 本机无 openssl，跳过端到端（Node 无证书签发 API）');
    console.log('       → 服务器与 CI（ubuntu）均自带 openssl，那里会真正执行');
    done(); return;
  }

  var c = makeSelfSigned();
  var cfg = testConfig({ WT_CERT_PEM: c.cert, WT_KEY_PEM: c.key });
  var inputs = [];
  var ep = new WebTransportEndpoint(cfg, {
    onInput: function (connId, inp) { inputs.push({ connId: connId, inp: inp }); }
  });

  function cleanup(cb) {
    ep.close(function () {
      try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch (e) {}
      cb();
    });
  }

  ep.listen(function (err) {
    if (err) {
      ok(false, 'Http3Server 启动', err && err.message);
      cleanup(done); return;
    }
    ok(ep.listening === true, 'Http3Server 启动成功');
    ok(ep.port() > 0, '监听到端口（' + ep.port() + '）');

    var offer = ep.offer('c1', 'r1');
    ok(offer && offer.token != null && offer.path === '/wt',
      'offer 返回 token 与 path（' + (offer && offer.path) + '）');

    // 复用实现导出的入口解析 —— **不自己拼路径**：
    // 该包 exports 完全封闭（连 ./package.json 都不暴露），
    // 裸包名 import 又以调用方文件为解析基准（test/ 下会找不到）。
    // 测试自己拼一份的话，实现改了路径而测试仍指旧的 ⇒ 两套逻辑。
    import(WebTransportEndpoint.libEntryUrl()).then(function (mod) {
      return mod.quicheLoaded.then(function () { return mod; });
    }).then(function (mod) {
      // Windows 回环有约 7% 概率把整只 socket 变成永久黑洞（裸 dgram 对照
      // 同样存在，不是本项目代码的问题）。实测本文件 8 轮里 2 轮因此挂掉，
      // 表现是「打洞完全收不到 hello_ack」而后续断言连锁失败。
      // 唯一有效的对策是**整只客户端重建**，原地多重试无用 ——
      // 已验证 1 秒内 40 次重试也不恢复。
      //
      // 这不会掩盖真实缺陷：若打洞逻辑真的坏了，重建 3 次一样全失败。
      // 每次重建都换新 token，避免旧会话状态干扰。
      var MAX_TRY = 3;

      (function attempt(n) {
        var offerN = n === 1 ? offer : ep.offer('c1', 'r1');
        var factory = CS.udpSocketFactories.webTransport({
          host: '127.0.0.1', wtPort: ep.port(), wtPath: '/wt',
          certHashes: [{ algorithm: 'sha-256', value: c.hash }]
        });
        // 生产工厂用全局 WebTransport；Node 下注入库的实现
        var prevWT = globalThis.WebTransport;
        globalThis.WebTransport = mod.WebTransport;
        var sock = factory();
        globalThis.WebTransport = prevWT;

        if (n === 1) {
          ok(sock && typeof sock.send === 'function',
            '生产 socket 工厂返回可用 socket（同步返回，握手在内部异步完成）');
        }
        if (!sock) { cleanup(done); return; }

        var recv = [];
        sock.onMessage(function (u8) { recv.push({ u8: u8, t: Date.now() }); });
        // 打洞：工厂内部会把 ready 之前的发送排队，这里可以立刻发
        sock.send(mkHello(offerN.token));

        waitFor(function () { return recv.length > 0; }, 8000, function (okAck) {
          if (!okAck && n < MAX_TRY) {
            console.log('       （第 ' + n + ' 次打洞无响应，疑似回环黑洞，重建客户端重试）');
            try { sock.close(); } catch (e) {}
            ep.dropSession('c1');
            attempt(n + 1);
            return;
          }
          t3Body(mod, ep, sock, offerN, recv, inputs, c, cleanup, done,
            okAck, n);
        });
      })(1);
    }).catch(function (e) {
      ok(false, '客户端建立失败', e && e.message);
      cleanup(done);
    });
  });
}

/**
 * T3 主体：打洞成功后的全部断言。
 * 抽成独立函数是为了让上面的「回环黑洞重建重试」能包住整段握手，
 * 而不必把重试逻辑和断言逻辑缠在一起。
 */
function t3Body(mod, ep, sock, offer, recv, inputs, c, cleanup, done, okAck, tries) {
  var cfg = ep.config;
  ok(okAck, '收到下行（打洞握手完成）' +
    (tries > 1 ? '（重建 ' + tries + ' 次）' : ''));
  ok(recv.length > 0 && recv[0].u8[0] === MAGIC_HACK,
    '首个下行是 hello_ack（0x4B）',
    recv.length ? '实际 0x' + recv[0].u8[0].toString(16) : '无下行');
  ok(ep.isReady('c1') === true, '服务器认定该连接已就绪');
  ok(ep.stats.sessions >= 1, '服务器记录到会话（' + ep.stats.sessions + '）');

  // 上行输入
  sock.send(BP.encInputFrag(offer.token, 1, 1.234, 0));
  waitFor(function () { return inputs.length > 0; }, 4000, function (okIn) {
    ok(okIn && inputs.length > 0, '**上行输入到达服务器**');
    if (inputs.length) {
      ok(Math.abs(inputs[0].inp.angle - 1.234) < 0.02,
        '上行角度正确（' + inputs[0].inp.angle.toFixed(3) + '）');
      ok(inputs[0].connId === 'c1', '映射到正确的 connId');
    }

    // 重复副本必须被去重（冗余的正常情况）
    var before = inputs.length;
    sock.send(BP.encInputFrag(offer.token, 1, 1.234, 0));
    setTimeout(function () {
      ok(inputs.length === before, '重复 frameId 被去重（未重复投递）');

      // 下行：冗余份数 + 时间打散
      recv.length = 0;
      var frame = BP.encSnapBin({ tick: 7, ack: 1, timeMs: 0, entries: [] });
      ep.sendFrame('c1', frame);
      setTimeout(function () {
        var frames = recv.filter(function (r) { return r.u8[0] !== MAGIC_HACK; });
        ok(frames.length >= 2 && frames.length <= cfg.UDP_DUP,
          '下行发出 UDP_DUP=' + cfg.UDP_DUP + ' 份（收到 ' + frames.length + '）');
        if (frames.length >= 2) {
          var span = frames[frames.length - 1].t - frames[0].t;
          console.log('       副本到达跨度 ' + span + 'ms（帧窗口 ' +
            (cfg.TICK_MS * cfg.SNAP_EVERY) + 'ms）');
          // 打散判据与 udp.test.js 一致：要跨得过定时器 tick。
          // 同一时刻连发在突发丢包下等于没发（副本共命运）。
          ok(span >= 5, '**副本时间打散**（跨度 ' + span + 'ms ≥5ms，非同时发）',
            '趋近 0 说明打散调度失效');
        }
        // 解码同构：字段名要与协议实际设计一致。
        // 注意二进制路径用的是**色块增量**（blockAdd/blockDel，1a.4 的设计），
        // 不是 JSON 路径的全量 bl —— 全量由 1Hz 低频通道走 TCP 兜底。
        // wsTransport._mergeMeta 会把两者合并成与 JSON snap 同构的对象后
        // 才交给上层，所以上层零感知。
        if (frames.length) {
          var dec = BP.decSnapBin(frames[0].u8);
          ok(dec && dec.tk === 7 && dec.ack === 1,
            '二进制帧可解码且字段正确（tk=' + (dec && dec.tk) + '）');
          ok(dec && dec.t === 'snap' && Array.isArray(dec.sn),
            '解码结果带 snap 类型标记与 sn 数组（与 JSON 路径同名）');
          ok(dec && Array.isArray(dec.blockAdd) && Array.isArray(dec.blockDel),
            '带色块增量字段 blockAdd/blockDel（1a.4 增量同步）');
          // 与裸 UDP 路径逐字节一致 —— 两条通道只是管道不同，
          // 编码完全共用；若不一致说明某条通道偷偷改了编码
          var same = true, ref = BP.encSnapBin({ tick: 7, ack: 1, timeMs: 0, entries: [] });
          if (ref.length !== frames[0].u8.length) same = false;
          else for (var bi = 0; bi < ref.length; bi++) {
            if (ref[bi] !== frames[0].u8[bi]) { same = false; break; }
          }
          ok(same, '**WT 下行字节与裸 UDP 路径完全一致**（编码层共用）',
            '长度 ' + frames[0].u8.length + ' vs ' + ref.length);
        }

        t3b(ep, sock, offer, c, cleanup, done);
      }, 250);
    }, 200);
  });
}

/** T3 续：畸形输入健壮性 + 会话清理 */
function t3b(ep, sock, offer, c, cleanup, done) {
  section('T4 健壮性与清理');
  var before = ep.stats.rx;
  // 畸形输入：这层直接暴露在公网，任何畸形包都不得让进程崩溃
  var bad = [
    new Uint8Array(0),
    new Uint8Array([0]),
    new Uint8Array([MAGIC_HELLO, 1, 2]),                    // 长度不足
    new Uint8Array([MAGIC_HELLO, 0, 0, 0, 0, 0, 0]),        // crc 错
    new Uint8Array([0xFF, 1, 2, 3, 4, 5, 6, 7]),            // 未知 magic
    new Uint8Array(1500)                                     // 超大全零
  ];
  bad.forEach(function (b) { try { sock.send(b); } catch (e) {} });

  setTimeout(function () {
    ok(ep.listening === true, '**畸形输入未导致服务崩溃**（仍在监听）');
    ok(ep.stats.rx > before, '畸形包已被收到并计数（' + (ep.stats.rx - before) + ' 个）');
    ok(ep.stats.dropMagic + ep.stats.dropCrc + ep.stats.dropToken > 0,
      '畸形包被三道校验拦下（magic ' + ep.stats.dropMagic +
      ' / crc ' + ep.stats.dropCrc + ' / token ' + ep.stats.dropToken + '）');
    ok(ep.isReady('c1') === true, '合法会话未受畸形包影响');

    // dropSession 后立即失效
    ep.dropSession('c1');
    ok(ep.isReady('c1') === false, 'dropSession 后 isReady=false');
    ok(ep.sendFrame('c1', new Uint8Array(4)) === false, 'dropSession 后 sendFrame 返回 false');

    try { sock.close(); } catch (e) {}
    cleanup(done);
  }, 400);
}

/** 轮询等待条件（不用固定延时赌 —— 那会在慢机器上 flaky） */
function waitFor(cond, timeoutMs, cb) {
  var t0 = Date.now();
  (function poll() {
    if (cond()) { cb(true); return; }
    if (Date.now() - t0 > timeoutMs) { cb(false); return; }
    setTimeout(poll, 30);
  })();
}

// ---------------- T5 证书续期 ----------------
//
// 为什么这条必须做真实的双向对照、不能只断言「函数返回 true」：
//
// 我最初实现的是 `updateCert` 热换，测试断言它返回 true —— 全绿。
// 但双向对照立刻揭穿了：换证后用**新**证书 hash 连不上、用**旧**的照样连通，
// 服务器根本没换。查库源码找到根因：`Http3Server.updateCert` 的实现是
// `if (transport.updateCert) transport.updateCert(...)`，而这个方法
// **只有 http2 transport 实现了**，`-transport-http3-quiche` 里零命中。
// 条件不成立 ⇒ 静默跳过、不报错。**返回 true 只代表调用没炸。**
//
// 这正是本项目反复吃亏的那类问题：断言了「调用成功」而不是「效果发生」。
// 所以这里断言的是**新证书能连、旧证书连不上**——只有两者同时成立，
// 才排除了「压根没换」和「hash 校验没起作用」两种假绿灯。
//
// 证书 90 天到期而 certbot 每天检查，这个故障会等到续期那天才暴露，
// 表现为「昨天还好好的，今天全连不上」。
function t5(done) {
  section('T5 certbot 续期换证（重建端点，非热换）');

  if (!haveOpenssl()) {
    skipped++;
    console.log('  SKIP 无 openssl，无法生成第二张自签证书');
    done();
    return;
  }

  var a = makeSelfSigned();      // 初始证书
  var b = makeSelfSigned();      // 模拟续期后的新证书
  ok(Buffer.compare(a.hash, b.hash) !== 0,
    '两张自签证书的 sha256 不同（构成有效对照）');

  // 落盘成 certbot 那样的路径，让 _watchCert 能盯到
  var live = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-live-'));
  var certPath = path.join(live, 'fullchain.pem');
  var keyPath = path.join(live, 'privkey.pem');
  fs.writeFileSync(certPath, a.cert);
  fs.writeFileSync(keyPath, a.key);

  var ep = new WebTransportEndpoint(testConfig({
    WT_CERT: certPath, WT_KEY: keyPath,
    WT_CERT_WATCH_MS: 100,      // 测试里把轮询压到 100ms，生产是 60s
    WT_CERT_PEM: null, WT_KEY_PEM: null
  }), {});

  var cleanupFs = function () {
    [a.dir, b.dir, live].forEach(function (d) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    });
  };
  var finish = function () { ep.close(function () { cleanupFs(); done(); }); };

  ep.listen(function (err) {
    if (err) {
      ok(false, 'Http3Server 启动（从文件读证书）', err.message);
      cleanupFs(); done(); return;
    }
    ok(true, 'Http3Server 从 WT_CERT/WT_KEY 文件路径启动');
    ok(ep._certWatched === true, '**已挂上证书文件监听**（续期无需外部钩子）');

    var portBefore = ep.port();

    import(WebTransportEndpoint.libEntryUrl()).then(function (mod) {
      return mod.quicheLoaded.then(function () { return mod; });
    }).then(function (mod) {
      // 换证后旧会话必须作废：新端点的 QUIC 连接是全新的，
      // 若不清会让 isReady 给出假阳性、sendFrame 往死会话写。
      ep.createSession('stale', 'r0');

      // 模拟 certbot：替换两个文件（先 cert 后 key，与 certbot 顺序一致）
      fs.writeFileSync(certPath, b.cert);
      fs.writeFileSync(keyPath, b.key);

      waitFor(function () { return ep.stats.certReloads > 0; }, 15000, function (okReload) {
        ok(okReload, '**检测到文件变化并完成换证**（certReloads=' +
          ep.stats.certReloads + '）', '失败=' + ep.stats.certReloadFail);
        if (!okReload) { finish(); return; }

        ok(ep.stats.certReloadFail === 0, '换证过程无失败');
        ok(ep.listening === true, '换证后仍在监听（进程未重启，wss 通道不受影响）');
        ok(ep.port() === portBefore,
          '**端口保持不变（' + ep.port() + '）** —— 否则已下发的 wtPort 会全部失效',
          '重建时必须复用实际监听端口，不能回读可能为 0 的配置值');
        ok(ep.isReady('stale') === false,
          '旧会话已作废（新端点的 QUIC 连接是全新的）');

        // 决定性对照：新证书必须通、旧证书必须不通。
        // 只有两者同时成立，才排除「没换」与「hash 未校验」两种假绿灯。
        tryHash(mod, ep.port(), b.hash, 'newcert', function (newOk) {
          ok(newOk,
            '**用新证书 hash 能建立会话 ⇒ 换证真的生效了**',
            '连不上说明服务器仍持旧证书');
          tryHash(mod, ep.port(), a.hash, 'oldcert', function (oldOk) {
            ok(!oldOk,
              '**用旧证书 hash 已连不上 ⇒ 旧证书确已弃用**',
              '仍能连通说明 updateCert 是个 no-op（HTTP/3 下正是如此）');
            finish();
          });
        });
      });
    }).catch(function (e) {
      ok(false, '加载客户端库', e.message);
      finish();
    });
  });

  /** 用指定证书 hash 试连；复用生产工厂，不另造客户端 */
  function tryHash(mod, port, hash, connId, cb) {
    var token = ep.createSession(connId, 'rr');
    var factory = CS.udpSocketFactories.webTransport({
      host: '127.0.0.1', wtPort: port, wtPath: '/wt',
      certHashes: [{ algorithm: 'sha-256', value: hash }]
    });
    var prevWT = globalThis.WebTransport;
    globalThis.WebTransport = mod.WebTransport;
    var sock = factory();
    globalThis.WebTransport = prevWT;
    if (!sock) { cb(false); return; }

    var got = false;
    sock.onMessage(function () { got = true; });
    var w = new B.BinWriter(8);
    w.u8(MAGIC_HELLO); w.u32(token); w.finishCrc16();
    sock.send(w.bytes());
    // 6s：握手失败时库不会立刻 reject，只能等超时判定
    waitFor(function () { return got; }, 6000, function (okConn) {
      try { sock.close(); } catch (e) {}
      cb(okConn);
    });
  }
}

// ---------------- 主流程 ----------------
console.log('WebTransport 通道回归（v3.1 阶段 1d）');
t1();
t2();
t3(function () {
  t5(function () {
    console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败' +
      (skipped ? '，' + skipped + ' 组跳过' : ''));
    process.exit(fail === 0 ? 0 : 1);
  });
});
