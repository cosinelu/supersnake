'use strict';
/**
 * index.js — 联机服务器入口（v3.0）：WebSocket 连接管理 + 匹配路由
 *
 * 运行：node server/index.js            （生产：systemd 守护，Nginx /ws 反代到 127.0.0.1:8090）
 * 测试：require 后调 createServer(overrides) 拿到 { server, wss, matchmaker, port, close }，
 *       传 port: 0 随机空闲端口。
 *
 * 消息路由（协议见 js/net/protocol.js）：
 *   join   → matchmaker.add（幂等，重复 join 忽略）
 *   cancel → matchmaker.remove
 *   input  → 所在房间 handleInput
 *   ping   → pong
 * 连接关闭 → 队列中则移除；对局中则 room.handleDrop（掉线判负）。
 * 畸形/超大消息 → error 回复并断开（1002）。
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var WebSocket = require('ws');

var JS = path.join(__dirname, '..', 'js');
require(path.join(JS, 'net', 'protocol.js'));
var P = globalThis.CS.protocol;

var baseConfig = require('./config');
var Matchmaker = require('./matchmaker');
var UdpEndpoint = require('./udp');
var WebTransportEndpoint = require('./webtransport');
var TransportHub = require('./transportHub');

var nextConnId = 1;

// ---------------- 静态文件托管（仓库根目录；同端口出页面+ws，Windows 免 Nginx） ----------------
var STATIC_ROOT = path.join(__dirname, '..');
var MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

/** GET 静态服务：/ → index.html；路径穿越防护；仅白名单扩展名 */
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end(); return;
  }
  var urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  urlPath = path.posix.normalize(urlPath); // 先归一化（/js/../x → /x），防伪装穿越
  // 白名单：只出页面入口与前端资源（不暴露 server/ test/ docs/ 等目录）
  if (urlPath !== '/index.html' && urlPath.indexOf('/js/') !== 0 && urlPath !== '/favicon.ico') {
    res.writeHead(404); res.end('not found'); return;
  }
  var file = path.normalize(path.join(STATIC_ROOT, urlPath));
  if (file.indexOf(STATIC_ROOT) !== 0) { res.writeHead(403); res.end(); return; } // 防 ../ 穿越
  var ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/**
 * @param {object} [overrides] 覆盖 server/config 任意字段（测试用小参数/随机端口）
 * @returns {{ httpServer, wss, matchmaker, config, port:()=>number, close:fn }}
 */
function createServer(overrides) {
  var config = Object.assign({}, baseConfig, overrides || {});
  var httpServer = http.createServer(serveStatic);
  var wss = new WebSocket.Server({
    server: httpServer,
    maxPayload: config.MAX_MSG_BYTES,
    perMessageDeflate: true // 快照 JSON 高重复度，deflate 压 5~10 倍（浏览器原生协商）
  });
  var conns = {}; // connId → { id, ws, name, roomId }

  // 加速通道（v3.1）：上下行走二进制 + 冗余打散；TCP 全程保留作控制/保底通道。
  //   裸 UDP（udp.js）        → 微信小游戏 / Node
  //   WebTransport（webtransport.js）→ 浏览器（无裸 UDP 能力）
  // 两者由 TransportHub 聚合成**与 UdpEndpoint 同构**的一个对象 ⇒ room.js 零改动。
  // UDP_ENABLED=0 / WT_ENABLED=0 可分别关掉，全关即回退纯 TCP（回滚点，§4.3）。
  var onAccelInput = function (connId, inp) {
    var c = conns[connId];
    var room = c && c.roomId && matchmaker.rooms[c.roomId];
    // 复用 TCP 路径同一个入口：判定逻辑零改动，只是换了传输层。
    // frameId 去重已在端点内做过（与 room 的 seq 语义一致），
    // 这里给 seq 传 lastSeq+1 让 room 无条件采纳，避免二次去重把包吃掉。
    if (room && room.humans[connId]) {
      room.handleInput(connId, {
        seq: room.humans[connId].lastSeq + 1, a: inp.angle, bo: inp.boost
      });
    }
  };

  var udp = config.UDP_ENABLED ? new UdpEndpoint(config, { onInput: onAccelInput }) : null;
  var wt = config.WT_ENABLED ? new WebTransportEndpoint(config, {
    onInput: onAccelInput,
    onError: function (err) {
      // WT 起不来不阻断服务：浏览器退回 wss，对局照常
      console.error('[supersnake] WebTransport 未启用：' + (err && err.message || err));
    }
  }) : null;
  var hub = (udp || wt) ? new TransportHub({ udp: udp, wt: wt }) : null;

  var matchmaker = new Matchmaker(config, {
    udp: hub,   // 传聚合层：接口与 UdpEndpoint 同构，room.js 无感
    onRoomCreated: function (room) {
      for (var cid in room.humans) {
        if (conns[cid]) conns[cid].roomId = room.id;
      }
      room.run(); // 生产/集成测试：真实时钟驱动（单元测试不经过本回调，手动 step）
    },
    onRoomEmpty: function (room) {
      room.destroy();
      for (var cid in conns) if (conns[cid].roomId === room.id) conns[cid].roomId = null;
    }
  });

  function send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(P.encode(obj));
  }

  wss.on('connection', function (ws) {
    var connId = 'c' + (nextConnId++);
    var conn = { id: connId, ws: ws, name: null, roomId: null };
    conns[connId] = conn;

    ws.on('message', function (data) {
      if (data.length > config.MAX_MSG_BYTES) {
        send(ws, { t: P.S2C.ERROR, code: 'too_big', msg: '消息过大' });
        ws.close(1002);
        return;
      }
      var msg = P.decode(data.toString());
      if (!msg) {
        send(ws, { t: P.S2C.ERROR, code: 'bad_msg', msg: '无法解析的消息' });
        ws.close(1002);
        return;
      }
      switch (msg.t) {
        case P.C2S.JOIN:
          if (msg.ver !== P.PROTO_VER) {
            send(ws, { t: P.S2C.ERROR, code: 'ver', msg: '协议版本不匹配，请刷新页面' });
            return;
          }
          conn.name = msg.name || ('玩家' + connId);
          var oldRoom = conn.roomId && matchmaker.rooms[conn.roomId];
          if (oldRoom && oldRoom.state !== 'over') return; // 对局中重复 join：忽略
          conn.roomId = null; // 上一局已结算（或房间已回收）：允许再次匹配
          matchmaker.add({
            connId: connId, name: conn.name,
            send: function (obj) { send(ws, obj); }
          });
          break;
        case P.C2S.CANCEL:
          matchmaker.remove(connId);
          break;
        case P.C2S.INPUT: {
          var room = conn.roomId && matchmaker.rooms[conn.roomId];
          if (room) room.handleInput(connId, msg);
          break;
        }
        case P.C2S.PING:
          send(ws, { t: P.S2C.PONG, ts: msg.ts });
          break;
        default:
          send(ws, { t: P.S2C.ERROR, code: 'unknown', msg: '未知消息类型: ' + msg.t });
      }
    });

    ws.on('close', function () {
      matchmaker.remove(connId);
      var room = conn.roomId && matchmaker.rooms[conn.roomId];
      if (room) room.handleDrop(connId);
      if (hub) hub.dropSession(connId);   // 两条通道的会话都清，避免令牌泄漏
      delete conns[connId];
    });
    ws.on('error', function () { /* close 事件随后处理清理 */ });
  });

  // 匹配超时检查（补位局）
  var mmTimer = setInterval(function () { matchmaker.tick(); }, 500);

  return {
    httpServer: httpServer,
    wss: wss,
    matchmaker: matchmaker,
    udp: udp,
    wt: wt,
    hub: hub,
    config: config,
    listen: function (cb) {
      httpServer.listen(config.PORT, config.HOST, function () {
        // 加速通道起不来**一律不阻断服务**：降级为纯 TCP，游戏照常可玩。
        // 这是刻意的 —— WT 依赖 native addon 与证书文件，
        // 任一缺失都不该让整个服务器起不来。
        var pending = 0, fired = false;
        function oneDone() {
          if (--pending <= 0 && !fired) { fired = true; if (cb) cb(); }
        }
        if (udp) {
          pending++;
          try { udp.listen(oneDone); } catch (e) { udp = null; oneDone(); }
        }
        if (wt) {
          pending++;
          try {
            wt.listen(function (err) {
              if (err) wt = null;   // 起不来就当没有这条通道
              oneDone();
            });
          } catch (e) { wt = null; oneDone(); }
        }
        if (pending === 0 && !fired) { fired = true; if (cb) cb(); }
      });
    },
    port: function () { return httpServer.address().port; },
    udpPort: function () { return udp ? udp.port() : 0; },
    wtPort: function () { return wt ? wt.port() : 0; },
    close: function (cb) {
      clearInterval(mmTimer);
      matchmaker.destroy();
      for (var cid in conns) { try { conns[cid].ws.terminate(); } catch (e) {} }
      var done = function () { wss.close(function () { httpServer.close(cb || function () {}); }); };
      var left = (udp ? 1 : 0) + (wt ? 1 : 0);
      if (left === 0) { done(); return; }
      var step = function () { if (--left <= 0) done(); };
      if (udp) udp.close(step);
      if (wt) wt.close(step);
    }
  };
}

if (require.main === module) {
  var srv = createServer();
  srv.listen(function () {
    console.log('[supersnake] online server listening on ' + srv.config.HOST + ':' + srv.config.PORT);
  });
}

module.exports = { createServer: createServer };
