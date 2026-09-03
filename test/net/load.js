'use strict';
/**
 * load.js — 联机服务器压测（M6.4）：真实 ws 服务 + N 个机器人客户端并发对局
 *
 * 用法：node test/net/load.js [clients=100] [durationSec=15]
 *   node test/net/load.js 100 15     # 100 客户端（≈25 房间）跑 15 秒
 *
 * 度量：
 *   - 匹配成功率、房间数、人均快照速率（标称值由 server/config.js 推导，不写死）
 *   - 下行带宽（人均 KB/s，deflate 后真实线上字节）
 *   - 服务器进程 RSS 增量、tick 推进是否饿死（房间 tickCount 增长）
 *
 * 通过阈值（默认参数下）：
 *   - 全部客户端 matched 且收到快照
 *   - 人均快照速率 ≥ 标称的 65%（定时器抖动容差）
 *   - 人均下行 ≤ 40 KB/s（预算见架构文档 §7）
 *
 * **这条路径量的是 TCP JSON 保底通道**：机器人客户端不打洞，
 * 所以拿到的是最坏情况带宽。UDP 二进制路径的实测值见
 * `test/net/udp.e2e.test.js` 场景 D（同为 30Hz 时约为此值的 1/4）。
 */
var path = require('path');
var zlib = require('zlib');
var createServer = require(path.join(__dirname, '..', '..', 'server', 'index.js')).createServer;
var BotClient = require(path.join(__dirname, 'botClient.js'));
require(path.join(__dirname, '..', '..', 'js', 'net', 'protocol.js'));
var P = globalThis.CS.protocol;
// 标称快照频率从生产配置推导：SNAP_EVERY 改了这里要跟着变，
// 写死「15Hz / ≥10 帧」会在提频后变成一条永远通过的空断言。
var PROD = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
var NOMINAL_HZ = 1000 / (PROD.TICK_MS * PROD.SNAP_EVERY);
var MIN_HZ = NOMINAL_HZ * 0.65;

var CLIENTS = parseInt(process.argv[2], 10) || 100;
var DURATION_S = parseInt(process.argv[3], 10) || 15;

function fmt(n) { return Math.round(n * 10) / 10; }

/** 该玩家在房间里是否仍存活（测量窗口内阵亡的端不计入速率，阵亡停发快照是预期行为） */
function botAlive(room, playerId) {
  for (var cid in room.humans) {
    var h = room.humans[cid];
    if (h.entry.id === playerId) return h.entry.alive;
  }
  return false;
}

async function main() {
  var srv = createServer({ PORT: 0, HOST: '127.0.0.1', MATCH_TIMEOUT_MS: 4000, COUNTDOWN_MS: 500 });
  await new Promise(function (res) { srv.httpServer.listen(0, '127.0.0.1', res); });
  var url = 'ws://127.0.0.1:' + srv.port();
  console.log('[load] 服务器 ' + url + '，客户端 ' + CLIENTS + '，时长 ' + DURATION_S + 's');

  var rss0 = process.memoryUsage().rss;
  var bots = [];
  var bytes = []; // 每客户端下行字节

  // 分批连接（每批 20，间隔 100ms，避免握手风暴影响测量）
  for (var i = 0; i < CLIENTS; i++) {
    var b = new BotClient({ url: url, name: '压测' + i, behavior: 'wander', inputIntervalMs: 60 });
    bytes[i] = 0;
    await b.connect();
    (function (idx, bot) {
      bot.ws.on('message', function (d) { bytes[idx] += d.length; });
    })(i, b);
    b.join();
    bots.push(b);
    if (i % 20 === 19) await new Promise(function (r) { setTimeout(r, 100); });
  }

  // 等全部 matched（最后一波可能走超时补位局）
  var t0 = Date.now();
  await Promise.all(bots.map(function (b, i) {
    return b.waitFor(function (bb) { return !!bb.matched; }, 15000, 'bot' + i + ' matched');
  }));
  console.log('[load] 全部 matched 用时 ' + (Date.now() - t0) + 'ms，房间数 ' +
    Object.keys(srv.matchmaker.rooms).length);

  // 测量窗口：清零计数后跑 DURATION_S（排除 stagger 建连期的污染；阵亡端单独统计）
  for (var j0 = 0; j0 < bots.length; j0++) { bots[j0].snaps.length = 0; bytes[j0] = 0; }
  await new Promise(function (r) { setTimeout(r, DURATION_S * 1000); });

  // 收尾统计
  var rooms = srv.matchmaker.rooms;
  var activeRooms = Object.keys(rooms).length;
  var liveN = 0, deadN = 0, snapTotalLive = 0, bytesLive = 0, errTotal = 0;
  for (var j = 0; j < bots.length; j++) {
    var room = bots[j].roomId && rooms[bots[j].roomId];
    var alive = room && room.state === 'running' && bots[j].matched &&
      !bots[j].over && botAlive(room, bots[j].playerId);
    if (alive) { liveN++; snapTotalLive += bots[j].snaps.length; bytesLive += bytes[j]; }
    else deadN++;
    errTotal += bots[j].errors.length;
    bots[j].close();
  }
  var rss1 = process.memoryUsage().rss;
  var basis = Math.max(1, liveN);
  var perClientSnapRate = snapTotalLive / basis / DURATION_S;
  var perClientKBsRaw = (bytesLive / basis / DURATION_S) / 1024; // 解压后载荷（ws message 事件给出的就是解压后数据）
  // 线上字节估算：对最近一帧快照实测 deflate 压缩率折算
  var wireRatio = 0.3;
  for (var sj = 0; sj < bots.length; sj++) {
    if (bots[sj].snaps.length) {
      var raw = P.encode(bots[sj].snaps[bots[sj].snaps.length - 1]);
      wireRatio = zlib.deflateRawSync(raw).length / raw.length;
      break;
    }
  }
  var perClientKBsWire = perClientKBsRaw * wireRatio;

  // tick 饿死检测：所有运行中房间 tickCount 应达到理论值的 70%（Windows 定时器粒度有补帧抖动）
  var starved = 0;
  for (var rid2 in rooms) {
    if (rooms[rid2].state === 'running' &&
        rooms[rid2].tickCount < DURATION_S * 1000 / rooms[rid2].config.TICK_MS * 0.7) starved++;
  }

  console.log('');
  console.log('========== 压测报告 ==========');
  console.log('并发客户端      ' + CLIENTS + '（' + activeRooms + ' 房间，存活端 ' + liveN + ' / 阵亡端 ' + deadN + '）');
  console.log('存活端人均快照  ' + fmt(perClientSnapRate) + ' 帧/s（标称 ' + fmt(NOMINAL_HZ) + '）');
  console.log('存活端人均下行  ' + fmt(perClientKBsWire) + ' KB/s 线上（解压载荷 ' + fmt(perClientKBsRaw) + ' KB/s × 压缩率 ' + fmt(wireRatio * 100) + '%）  [TCP JSON 保底通道]');
  console.log('服务器 RSS 增量 ' + fmt((rss1 - rss0) / 1048576) + ' MB');
  console.log('tick 饿死房间   ' + starved);
  console.log('客户端错误      ' + errTotal);

  var fails = [];
  if (liveN === 0) fails.push('无存活客户端（全部提前阵亡，无法测量）');
  if (perClientSnapRate < MIN_HZ) {
    fails.push('存活端人均快照速率 ' + fmt(perClientSnapRate) +
      ' < 标称 ' + fmt(NOMINAL_HZ) + ' 的 65%（' + fmt(MIN_HZ) + '）');
  }
  if (perClientKBsWire > 40) fails.push('存活端人均下行（线上估算）> 40 KB/s');
  if (starved > 0) fails.push('存在 tick 饿死房间');
  if (errTotal > 0) fails.push('客户端出现协议错误');

  srv.close(function () {});
  if (fails.length) {
    console.log('结果：FAIL —— ' + fails.join('；'));
    process.exit(1);
  }
  console.log('结果：PASS');
  process.exit(0);
}

main().catch(function (e) { console.error('[load] 异常：', e); process.exit(1); });
