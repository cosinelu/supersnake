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
var path = require('path');
var WebSocket = require('ws');

var JS = path.join(__dirname, '..', 'js');
require(path.join(JS, 'net', 'protocol.js'));
var P = globalThis.CS.protocol;

var baseConfig = require('./config');
var Matchmaker = require('./matchmaker');

var nextConnId = 1;

/**
 * @param {object} [overrides] 覆盖 server/config 任意字段（测试用小参数/随机端口）
 * @returns {{ httpServer, wss, matchmaker, config, port:()=>number, close:fn }}
 */
function createServer(overrides) {
  var config = Object.assign({}, baseConfig, overrides || {});
  var httpServer = http.createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('supersnake online server\n');
  });
  var wss = new WebSocket.Server({
    server: httpServer,
    maxPayload: config.MAX_MSG_BYTES,
    perMessageDeflate: true // 快照 JSON 高重复度，deflate 压 5~10 倍（浏览器原生协商）
  });
  var conns = {}; // connId → { id, ws, name, roomId }

  var matchmaker = new Matchmaker(config, {
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
    config: config,
    listen: function (cb) {
      httpServer.listen(config.PORT, config.HOST, cb);
    },
    port: function () { return httpServer.address().port; },
    close: function (cb) {
      clearInterval(mmTimer);
      matchmaker.destroy();
      for (var cid in conns) { try { conns[cid].ws.terminate(); } catch (e) {} }
      wss.close(function () { httpServer.close(cb || function () {}); });
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
