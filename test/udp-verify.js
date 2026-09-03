'use strict';
/**
 * udp-verify.js — UDP 传输层的**真实公网**端到端验证（手动排障工具）
 *
 * 与 wss-verify.js 同定位：不进 CI（需要真服务器 + 需要等 20s 匹配），
 * 部署后手动跑一次确认 UDP 链路真的在工作。
 *
 * 用法:
 *   node udp-verify.js <ws-url> <udp-host>
 *
 *   udp-host 是**服务器公网 IP**（不能是回环，见下），ws-url 可以走回环。
 *   地址不写在本文件里：与 wss-verify.js 同规矩，由 argv 传入，避免本地/测试/
 *   正式串台（scripts/check-hygiene.sh 会拦硬编码地址）。
 *
 * 为什么必须验证「真实公网」而不是回环：
 *   服务器上 `ss -ulnp` 显示 0.0.0.0:8092 在监听、ufw 放行、CI 全绿，
 *   但云平台控制台那层防火墙（SSH 改不了）会把包吃掉，**一个 UDP 包都不会到**。
 *   这种情况下客户端只会静默降级 TCP，从任何日志都看不出异常。
 *
 * 判定失败时的排查顺序（实践得来）：
 *   1. 本机 UDP 出网是否被封 —— 先 `dig @8.8.8.8`（UDP:53）。很多企业网/代理
 *      环境封掉全部 UDP 出网，此时**任何本地验证都无意义**，需换手机热点，
 *      或者干脆把本脚本 scp 到服务器上、连它自己的公网 IP 跑。
 *   2. 服务器网卡是否收到包 —— `sudo tcpdump -ni any udp port 8092`。
 *      0 packets captured 就说明卡在网络路径（云防火墙），不是应用层。
 *   3. 应用层是否绑对地址 —— UDP 必须绑 0.0.0.0（UDP_HOST），
 *      不能跟着 HOST 走 127.0.0.1（那是给 nginx 反代的 TCP 用的）。
 */
var path = require('path');
var dgram = require('dgram');

var WS_URL = process.argv[2];
var UDP_HOST = process.argv[3];
if (!WS_URL || !UDP_HOST) {
  console.error('用法: node udp-verify.js <ws-url> <udp-host>');
  console.error('  ws-url   例: ws://127.0.0.1:<tcp端口>/ws  或  wss://<域名>/ws');
  console.error('  udp-host 服务器**公网 IP**（UDP 无反代，必须直连；回环无法验证网络路径）');
  process.exit(2);
}

var ROOT = path.join(__dirname, '..');
var WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws'));
var JS = path.join(ROOT, 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles',
  'ai', 'multiplayer'].forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'binCodec', 'binProtocol'].forEach(function (f) {
  require(path.join(JS, 'net', f + '.js'));
});
var CS = globalThis.CS, B = CS.bin, BP = CS.binProtocol;

var MAGIC_HELLO = 0x48;   // 'H'
var MAGIC_HACK = 0x4B;    // 'K'
var UDP_SAFE = 1472;      // MTU 1500 − IP 20 − UDP 8

var t0 = Date.now();
function el() { return ((Date.now() - t0) / 1000).toFixed(1) + 's'; }

var ws = new WebSocket(WS_URL, { handshakeTimeout: 10000 });
var sock = null, token = null, udpPort = 0, frameId = 0, inputTimer = null;
var st = {
  ack: false, binF: 0, binB: 0, maxBin: 0, dup: 0, seen: {},
  binGaps: [], binLast: 0, jsonF: 0, jsonB: 0, maxSnakes: 0
};

ws.on('error', function (e) {
  console.log('  ✗ ws 连接失败: ' + e.message);
  process.exit(2);
});
ws.on('open', function () {
  console.log('  ' + WS_URL + '  →  udp ' + UDP_HOST);
  console.log('[' + el() + '] ws 已连接，join（单人局需等 20s AI 补位）');
  ws.send(JSON.stringify({ t: 'join', ver: 1, name: 'UdpVerify' }));
});
ws.on('message', function (d) {
  var m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
  if (m.t === 'matched') {
    token = m.udpToken; udpPort = m.udpPort;
    console.log('[' + el() + '] matched  udpPort=' + udpPort +
      '  token=' + (token != null ? 'ok' : '**未下发**') +
      '  snapIntervalMs=' + m.snapIntervalMs);
    if (!udpPort || token == null) {
      console.log('    ✗ 服务器未下发 UDP 参数 —— 检查 UDP_ENABLED 是否为 0');
      finish();
      return;
    }
    openUdp();
  } else if (m.t === 'start') { startInput(); }
  else if (m.t === 'snap') { st.jsonF++; st.jsonB += Buffer.byteLength(d); }
  else if (m.t === 'over') { console.log('[' + el() + '] over ' + m.reason); }
});

/** hello / keepalive：magic1 + token4 + crc16 = 7 字节（与 udpTransport 一致） */
function hello(tk) {
  var w = new B.BinWriter(8);
  w.u8(MAGIC_HELLO); w.u32(tk >>> 0); w.finishCrc16();
  return Buffer.from(w.bytes());
}

function openUdp() {
  sock = dgram.createSocket('udp4');
  sock.on('error', function (e) { console.log('  udp err ' + e.message); });
  sock.on('message', function (buf) {
    var now = Date.now();
    if (buf.length === 7 && buf[0] === MAGIC_HACK) {
      if (!st.ack) { st.ack = true; console.log('[' + el() + '] ✓ 打洞成功（hello_ack）'); }
      return;
    }
    var dec = null;
    try { dec = BP.decSnapBin(new Uint8Array(buf)); } catch (e) {}
    if (!dec) return;
    // 冗余副本：同一 tk 收到多次，取首次、其余计入去重
    if (st.seen[dec.tk]) { st.dup++; return; }
    st.seen[dec.tk] = 1;
    st.binF++; st.binB += buf.length;
    if (buf.length > st.maxBin) st.maxBin = buf.length;
    var nS = dec.sn ? dec.sn.length : 0;
    if (nS > st.maxSnakes) st.maxSnakes = nS;
    if (st.binLast) st.binGaps.push(now - st.binLast);
    st.binLast = now;
    if (st.binF === 1) {
      console.log('[' + el() + '] ✓ 首个二进制快照 ' + buf.length + ' 字节，蛇 ' + nS +
        ' 条，tk=' + dec.tk);
    }
  });
  sock.bind(0, function () {
    console.log('[' + el() + '] 本地 udp:' + sock.address().port + ' → ' +
      UDP_HOST + ':' + udpPort + '，开始打洞');
    punch(0);
  });
}
function punch(n) {
  if (!sock || st.ack || n > 15) return;   // 3s 内重试 15 次
  sock.send(hello(token), udpPort, UDP_HOST);
  setTimeout(function () { punch(n + 1); }, 200);
}
function startInput() {
  var a = 0;
  inputTimer = setInterval(function () {
    a += 0.004;    // 缓慢转向：别自己撞墙，否则对局早结束、样本不够
    if (sock && st.ack) {
      frameId = (frameId + 1) & 0xFFFF;
      sock.send(Buffer.from(BP.encInputFrag(token, frameId, a, 0)), udpPort, UDP_HOST);
    } else if (ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'input', seq: ++frameId, a: a, bo: 0 }));
    }
  }, 33);
}
function pct(arr, q) {
  if (!arr.length) return 0;
  var s = arr.slice().sort(function (x, y) { return x - y; });
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}
function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }

var done = false;
function finish() {
  if (done) return;
  done = true;
  if (inputTimer) clearInterval(inputTimer);
  console.log('');
  console.log('================ 结果 ================');
  console.log('打洞           : ' + (st.ack ? '✓ 成功' : '✗ 失败'));
  console.log('二进制快照(UDP): ' + st.binF + ' 帧' +
    (st.binF ? '，均 ' + (st.binB / st.binF).toFixed(0) + ' / 峰 ' + st.maxBin + ' 字节' : ''));
  if (st.binF) {
    console.log('  冗余副本去重 : ' + st.dup + ' 个（UDP_DUP=3 → 约 2× 帧数）');
    console.log('  帧间隔 avg/p50/p95/max : ' + avg(st.binGaps).toFixed(1) + ' / ' +
      pct(st.binGaps, 0.5) + ' / ' + pct(st.binGaps, 0.95) + ' / ' +
      (st.binGaps.length ? Math.max.apply(null, st.binGaps) : 0) + ' ms');
    console.log('  场上蛇数峰值 : ' + st.maxSnakes);
    console.log('  永不分片     : ' + (st.maxBin <= UDP_SAFE
      ? '✓ 峰值 ' + st.maxBin + ' ≤ ' + UDP_SAFE
      : '✗ 峰值 ' + st.maxBin + ' 超 ' + UDP_SAFE + '，会触发 IP 分片'));
  }
  console.log('JSON 快照(TCP) : ' + st.jsonF + ' 帧（>0 说明期间走过降级路径）');
  var pass = st.ack && st.binF > 0 && st.maxBin <= UDP_SAFE;
  console.log('');
  console.log(pass ? '>>> UDP 链路验证通过' : '>>> 验证未通过（排查顺序见本文件头注释）');
  try { ws.close(); } catch (e) {}
  if (sock) try { sock.close(); } catch (e) {}
  process.exit(pass ? 0 : 1);
}
setTimeout(finish, 46000);
