// wss 端到端验证：真实 WebSocket 客户端连上去，跑一次完整握手 + 收首帧。
// 比 curl 可靠——curl 拿到 101 就懵了，退出码非 0 会造成误判。
// 用法: node wss-verify.js wss://snake.pippocao.top/ws
const WebSocket = require('ws');

const url = process.argv[2];
if (!url) { console.error('用法: node wss-verify.js <ws-url>'); process.exit(2); }

const ws = new WebSocket(url, { handshakeTimeout: 10000 });
const t0 = Date.now();
let got = false;

const timer = setTimeout(() => {
  if (!got) { console.log(`  ${url}\n    ✗ 超时：连上了但 12s 内无任何服务端消息`); ws.terminate(); process.exit(1); }
}, 12000);

ws.on('upgrade', (res) => {
  console.log(`  ${url}`);
  console.log(`    握手 HTTP ${res.statusCode} (${Date.now() - t0}ms)  server=${res.headers.server || '-'}`);
});

ws.on('open', () => {
  console.log(`    ✓ 连接已建立（TLS + Upgrade 全通）`);
  // 主动打个招呼，触发服务端回包
  try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (e) {}
});

ws.on('message', (data) => {
  got = true;
  clearTimeout(timer);
  const s = data.toString().slice(0, 160);
  console.log(`    ✓ 收到服务端首帧: ${s}`);
  ws.close();
  setTimeout(() => process.exit(0), 200);
});

ws.on('error', (err) => {
  clearTimeout(timer);
  console.log(`  ${url}\n    ✗ 错误: ${err.message}`);
  process.exit(1);
});
