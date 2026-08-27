'use strict';
/**
 * run-all.js — 联机自动回归总入口（本地联机多人自动测试流程）
 * 运行：node test/net/run-all.js
 *
 * 一条命令在本地全自动完成多人联机回归（真实 ws 服务器 + 脚本化机器人客户端，
 * 不依赖浏览器/外网）。覆盖 docs/architecture/01-online-multiplayer.md §9.2 的 5 个场景：
 *   S1 正常局：4 客户端匹配 → 倒计时 → 全程输入 → 对局 over，全局断言贯穿
 *   S2 掉线局：1 客户端中途断开 → 其余端收到死亡 event + win 结算
 *   S3 补位局：仅 2 客户端，等待超时后 AI 补位开局
 *   S4 重排局：over 后同一连接再次 join 进入新房间
 *   S5 健壮性：畸形/超大/未知类型消息不崩服务器，正常客户端仍可匹配
 *
 * 每个场景使用独立服务器实例（随机端口 + 缩小的时间参数），全套目标 ≤ 60s。
 */
var path = require('path');
var WebSocket = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));

var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils'].forEach(function (f) { require(path.join(JS, f + '.js')); });
require(path.join(JS, 'net', 'protocol.js'));
var createServer = require(path.join(__dirname, '..', '..', 'server', 'index.js')).createServer;
var BotClient = require('./botClient');

var CS = globalThis.CS;
var P = CS.protocol;
var cfg = CS.config;

var passed = 0, failed = 0;
var failedNames = [];
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); failedNames.push(name); }
}
function section(t) { console.log('\n[' + t + ']'); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** 场景服务器参数：全部时间缩小，随机端口 */
function testConfig(extra) {
  return Object.assign({
    PORT: 0, HOST: '127.0.0.1',
    COUNTDOWN_MS: 300, MATCH_MAX_MS: 6000, OVER_LINGER_MS: 100,
    MATCH_TIMEOUT_MS: 600, ROOM_SIZE: 4, MIN_HUMANS: 2
  }, extra || {});
}

function startServer(overrides) {
  return new Promise(function (resolve) {
    var srv = createServer(testConfig(overrides));
    srv.listen(function () { resolve(srv); });
  });
}

function botUrl(srv) { return 'ws://127.0.0.1:' + srv.port(); }

function makeBot(srv, name, seed, behavior) {
  return new BotClient({
    url: botUrl(srv), name: name, behavior: behavior || 'wander',
    rng: CS.utils.makeRng(seed)
  });
}

/** 连接 + join 一批机器人 */
function connectBots(srv, names, behavior) {
  var bots = names.map(function (n, i) { return makeBot(srv, n, 1000 + i, behavior); });
  return Promise.all(bots.map(function (b) { return b.connect(); })).then(function () {
    bots.forEach(function (b) { b.join(); });
    return bots;
  });
}

/** 全局断言：快照流健康（tick 单调 / ack 不超前 / 坐标在界内 / 死蛇不复活） */
function assertSnapHealth(bot, label) {
  var snaps = bot.snaps;
  var mono = true, ackOk = true, inBounds = true, noRevive = true;
  var deadSeen = {};
  var W = bot.matched.W, H = bot.matched.H;
  for (var i = 0; i < snaps.length; i++) {
    var s = snaps[i];
    if (i > 0 && s.tk <= snaps[i - 1].tk) mono = false;
    if (s.ack > bot.seq) ackOk = false;
    for (var k = 0; k < s.sn.length; k++) {
      var sn = s.sn[k];
      if (sn.x < -60 || sn.x > W + 60 || sn.y < -60 || sn.y > H + 60) inBounds = false;
      if (deadSeen[sn.id] && sn.al) noRevive = false;
      if (!sn.al) deadSeen[sn.id] = true;
    }
  }
  ok(mono, label + '：快照 tick 单调递增（' + snaps.length + ' 帧）');
  ok(ackOk, label + '：快照 ack 不超前于已发 seq');
  ok(inBounds, label + '：全部蛇坐标在地图范围内');
  ok(noRevive, label + '：死蛇不复活（同 id 不出现 al 0→1）');
}

// ---------------- S1 正常局 ----------------
function scenarioNormal() {
  section('S1 正常局：4 客户端满编对局');
  return startServer().then(function (srv) {
    return connectBots(srv, ['甲', '乙', '丙', '丁']).then(function (bots) {
      return Promise.all(bots.map(function (b) {
        return b.waitFor(function (x) { return x.matched; }, 5000, 'matched');
      })).then(function () {
        ok(bots.every(function (b) { return b.roomId === bots[0].roomId; }), '4 客户端同房间');
        ok(bots[0].matched.players.length === 4, 'matched 含 4 名玩家');
        ok(bots.every(function (b) { return b.queuedMsgs.length >= 1; }), '匹配前收到 queued 位次播报');
        return Promise.all(bots.map(function (b) {
          return b.waitFor(function (x) { return x.started; }, 5000, 'start');
        }));
      }).then(function () {
        return Promise.all(bots.map(function (b) {
          return b.waitFor(function (x) { return x.snaps.length >= 5; }, 5000, '快照流');
        }));
      }).then(function () {
        ok(true, '对局开始，快照流持续（≥5 帧/端）');
        return Promise.all(bots.map(function (b) {
          return b.waitFor(function (x) { return x.over; }, 30000, 'over');
        }));
      }).then(function () {
        bots.forEach(function (b, i) {
          var reason = b.over.reason;
          ok(['dead', 'win', 'timeout'].indexOf(reason) >= 0,
            '客户端' + i + ' 收到 over（reason=' + reason + '）');
          var me = b.over.ranks.filter(function (r) { return r.id === b.playerId; })[0];
          ok(me && me.rank >= 1 && typeof me.score === 'number',
            '客户端' + i + ' ranks 含本人名次（第 ' + (me && me.rank) + ' 名）');
          assertSnapHealth(b, '客户端' + i);
        });
        // 至少一端见证了 AI 补位（快照蛇数 > 4）
        var maxSnakes = Math.max.apply(null, bots.map(function (b) {
          return Math.max.apply(null, b.snaps.map(function (s) { return s.sn.length; }));
        }));
        ok(maxSnakes > 4, '场上除 4 真人外还有 AI 蛇（峰值 ' + maxSnakes + ' 条）');
        bots.forEach(function (b) { b.close(); });
        return new Promise(function (r) { srv.close(r); });
      });
    });
  }).catch(function (e) {
    ok(false, 'S1 场景异常', e.message);
  });
}

// ---------------- S2 掉线局 ----------------
function scenarioDrop() {
  section('S2 掉线局：中途断开判负');
  return startServer().then(function (srv) {
    return connectBots(srv, ['留守', '逃跑']).then(function (bots) {
      var stay = bots[0], drop = bots[1];
      return Promise.all(bots.map(function (b) {
        return b.waitFor(function (x) { return x.started && x.snaps.length >= 3; }, 8000, '开局');
      })).then(function () {
        drop.close(); // 逃跑者掉线
        return stay.waitFor(function (x) {
          return x.events.some(function (e) { return e.k === 'death' && e.id === drop.playerId; });
        }, 5000, '对端死亡事件');
      }).then(function () {
        ok(true, '留守端收到掉线者 death 事件（尸体掉落判负）');
        return stay.waitFor(function (x) { return x.over; }, 8000, 'over');
      }).then(function () {
        ok(stay.over.reason === 'win', '留守端结算 reason = win', 'reason=' + stay.over.reason);
        var dropRow = stay.over.ranks.filter(function (r) { return r.id === drop.playerId; })[0];
        ok(dropRow && dropRow.alive === false, 'ranks 中掉线者标记为死亡');
        stay.close();
        return new Promise(function (r) { srv.close(r); });
      });
    });
  }).catch(function (e) {
    ok(false, 'S2 场景异常', e.message);
  });
}

// ---------------- S3 补位局 ----------------
function scenarioBotFill() {
  section('S3 补位局：2 人超时 AI 补位');
  return startServer().then(function (srv) {
    return connectBots(srv, ['孤独甲', '孤独乙']).then(function (bots) {
      return Promise.all(bots.map(function (b) {
        return b.waitFor(function (x) { return x.matched; }, 10000, '超时补位 matched');
      })).then(function () {
        ok(bots[0].matched.players.length === 2, 'matched 仅 2 名真人（AI 补位）');
        return Promise.all(bots.map(function (b) {
          return b.waitFor(function (x) { return x.snaps.length >= 3; }, 8000, '快照');
        }));
      }).then(function () {
        bots.forEach(function (b, i) {
          var snakeCount = b.snaps[0].sn.length;
          ok(snakeCount >= 2 + cfg.MP_AI_START_COUNT,
            '客户端' + i + ' 首帧快照含 AI 补位（共 ' + snakeCount + ' 条蛇）');
        });
        bots.forEach(function (b) { b.close(); });
        return new Promise(function (r) { srv.close(r); });
      });
    });
  }).catch(function (e) {
    ok(false, 'S3 场景异常', e.message);
  });
}

// ---------------- S4 重排局 ----------------
function scenarioRejoin() {
  section('S4 重排局：结算后再次匹配');
  return startServer({ MATCH_MAX_MS: 3000 }).then(function (srv) {
    return connectBots(srv, ['回头客', '回头乙']).then(function (bots) {
      return Promise.all(bots.map(function (b) {
        return b.waitFor(function (x) { return x.over; }, 20000, '首局 over');
      })).then(function () {
        var firstRoom = bots[0].roomId;
        bots.forEach(function (b) { b.matched = null; b.roomId = null; b.join(); }); // 再次排队
        return Promise.all(bots.map(function (b) {
          return b.waitFor(function (x) { return x.matched; }, 10000, '再次 matched');
        })).then(function (vals) {
          ok(vals.every(function (v) { return v; }), '双端结算后再次匹配成功');
          ok(bots[0].roomId !== firstRoom, '进入新房间（' + firstRoom + ' → ' + bots[0].roomId + '）');
          bots.forEach(function (b) { b.close(); });
          return new Promise(function (r) { srv.close(r); });
        });
      });
    });
  }).catch(function (e) {
    ok(false, 'S4 场景异常', e.message);
  });
}

// ---------------- S5 健壮性 ----------------
function scenarioRobust() {
  section('S5 健壮性：畸形/超大/未知消息');
  return startServer().then(function (srv) {
    var url = botUrl(srv);
    function rawSend(payload) {
      return new Promise(function (resolve) {
        var ws = new WebSocket(url);
        var result = { closed: false, errorMsg: null };
        ws.on('open', function () { ws.send(payload); });
        ws.on('message', function (d) {
          var m = P.decode(d.toString());
          if (m && m.t === 'error') result.errorMsg = m.code;
        });
        ws.on('close', function () { result.closed = true; resolve(result); });
        setTimeout(function () { try { ws.close(); } catch (e) {} resolve(result); }, 1500);
      });
    }
    return rawSend('garbage{{{not json').then(function (r1) {
      ok(r1.closed, '畸形 JSON：连接被关闭');
      return rawSend('x'.repeat(5000));
    }).then(function (r2) {
      ok(r2.closed, '超大消息：连接被关闭');
      return rawSend(JSON.stringify({ t: 'no_such_type' }));
    }).then(function (r3) {
      ok(r3.errorMsg === 'unknown', '未知类型：收到 error(unknown)');
      return rawSend(JSON.stringify({ t: 'join', ver: 999, name: '穿越者' }));
    }).then(function (r4) {
      ok(r4.errorMsg === 'ver', '协议版本不符：收到 error(ver)');
      // 服务器仍然健康：正常客户端可以完整匹配
      return connectBots(srv, ['正常人', '正常乙']);
    }).then(function (bots) {
      return Promise.all(bots.map(function (b) {
        return b.waitFor(function (x) { return x.started; }, 10000, '正常对局');
      })).then(function () {
        ok(true, '乱序攻击后服务器健康，正常客户端完成匹配开局');
        bots.forEach(function (b) { b.close(); });
        return new Promise(function (r) { srv.close(r); });
      });
    });
  }).catch(function (e) {
    ok(false, 'S5 场景异常', e.message);
  });
}

// ---------------- 主流程 ----------------
function main() {
  var t0 = Date.now();
  console.log('联机自动回归（目标 ≤ 60s）');
  scenarioNormal()
    .then(scenarioDrop)
    .then(scenarioBotFill)
    .then(scenarioRejoin)
    .then(scenarioRobust)
    .then(function () {
      var cost = ((Date.now() - t0) / 1000).toFixed(1);
      console.log('\n========================================');
      console.log('结果：' + passed + ' 通过，' + failed + ' 失败（耗时 ' + cost + 's）');
      if (failed) { console.log('失败项：' + failedNames.join(' / ')); process.exit(1); }
      process.exit(0);
    })
    .catch(function (e) {
      console.error('运行器异常：', e);
      process.exit(1);
    });
}

main();
