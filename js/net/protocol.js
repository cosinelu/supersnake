'use strict';
/**
 * protocol.js — 联机对战协议（v3.0，两端共享：浏览器挂 CS.protocol，Node 可 require）
 *
 * 设计见 docs/architecture/01-online-multiplayer.md §5.1。
 * 消息一律 JSON 文本帧，带 t（type）字段。v1 为全量快照 + 坐标/角度量化（1px / 0.001rad）
 * + 扁平数组 + 1 字符颜色短码，传输层叠加 permessage-deflate（见 server/index.js），
 * 后续升级二进制/增量时只改本文件。
 *
 * 快照键名采用短键以控制 JSON 体积：
 *   snap:  { t, tk(tick), ack, tm(timeMs), sn[snakes], bl[blocks], mt[meteors] }
 *   snake: { id, nm, pl(isPlayer), al(alive), x, y, a(angle), sp(speed),
 *            co[colors], sg[[x,y]节心含尾巴节], kl(kills), es(elimScore), et(elimTotal),
 *            ml(maxLen), bt(bittenUntil), sl(slowUntil) }
 *   block: { x, y, c(color|null), k(kind), r(rarity|null), ph(phase), ttl, rr(收集半径) }
 *   meteor:{ x, y, vx, vy, c, ph, tr[[x,y]轨迹] }
 */
(function (root) {
  var CS = root.CS = root.CS || {};

  // v2：二进制快照升级为 BIN_VER=2（kind/null color/meteors），不允许新旧两端混跑。
  var PROTO_VER = 2;

  // ---------------- 消息类型 ----------------
  // 客户端 → 服务器
  var C2S = {
    JOIN: 'join',       // { t, ver, name }
    CANCEL: 'cancel',   // { t }
    INPUT: 'input',     // { t, seq, a(angle), bo(boost 0/1) }
    PING: 'ping',       // { t, ts }
    ACCEL: 'accel'      // { t, on(0/1/2) } TCP / 加速 / 双发探测
  };
  // 服务器 → 客户端
  var S2C = {
    QUEUED: 'queued',   // { t, pos, need }
    MATCHED: 'matched', // { t, roomId, playerId, players:[{id,name}], countdownMs, W, H }
    START: 'start',     // { t, tick }
    SNAP: 'snap',       // { t, tk, ack, tm, sn, bl, mt }
    EVENT: 'event',     // { t, k(event kind), ... }（见 EVENT_KIND）
    OVER: 'over',       // { t, reason, ranks:[{id,name,score,rank,alive}] }
    PONG: 'pong',       // { t, ts }
    ERROR: 'error'      // { t, code, msg }
  };
  // event.kind 离散事件（驱动粒子/音效/播报，客户端不自行判定）
  var EVENT_KIND = {
    DEATH: 'death',       // { k, id, by(击杀者id|null), x, y, drop(尸体掉色块数) }
    ELIM: 'elim',         // { k, id, segs:[{x,y,c,chain}], combo }
    ITEM: 'item',         // { k, id, kind, color, x, y }（吃到特殊道具）
    TOAST: 'toast',       // { k, id, kind, color }（等价于单机 setItemToast，仅 id=接收者本人时展示）
    GRAB: 'grab',         // { k, id, bonus }（彩色星被吃；bonus>0 表示真人加分）
    GRAB_SPAWN: 'grab_spawn', // { k, x, y }（彩色星出现，播报表+小地图涟漪）
    METEOR: 'meteor',     // { k, id, idx, color, x, y }（流星注入）
    BITE: 'bite',         // { k, id(被咬者), seg, x, y, color }
    SELF_PULL: 'self_pull',// { k, id, x, y, color }
    WALL: 'wall'          // { k, x, y, w, h }（动态墙体新增，客户端补画）
  };
  // over.reason
  var OVER_REASON = {
    DEAD: 'dead',             // 你死了（按名次结算）
    WIN: 'win',               // 你是最后存活者
    TIMEOUT: 'timeout',       // 对局到时，按总分
    OPPONENT_LEFT: 'op_left', // 对手全部掉线
    DROPPED: 'dropped'        // 你掉线被判负（连接中断时本地合成，非服务器下发）
  };

  // ---------------- 量化 ----------------
  /** 坐标量化到 1px（远程渲染足够；配合 permessage-deflate 控制带宽） */
  function qCoord(v) { return Math.round(v); }
  /** 角度量化到 0.001rad（≈0.057°） */
  function qAngle(v) { return Math.round(v * 1000) / 1000; }

  // ---------------- 颜色短码（1 字符，快照体积优化） ----------------
  var COLOR_SHORT = { red: 'r', blue: 'b', green: 'g', orange: 'o', purple: 'u', yellow: 'y', teal: 't', pink: 'k', wild: 'w' };
  var COLOR_LONG = {};
  (function () { for (var k in COLOR_SHORT) COLOR_LONG[COLOR_SHORT[k]] = k; })();
  function cShort(c) { return COLOR_SHORT[c] || 'r'; }
  function cLong(s) { return COLOR_LONG[s] || 'red'; }
  function packColors(colors) {
    var s = '';
    for (var i = 0; i < colors.length; i++) s += cShort(colors[i]);
    return s;
  }
  function unpackColors(s) {
    var arr = [];
    for (var i = 0; i < s.length; i++) arr.push(cLong(s[i]));
    return arr;
  }

  // ---------------- 编解码 ----------------
  function encode(msg) { return JSON.stringify(msg); }
  /** 解析失败返回 null（调用方对畸形消息做丢弃/踢出处理） */
  function decode(text) {
    if (typeof text !== 'string' || text.length > 65536) return null;
    try {
      var m = JSON.parse(text);
      return (m && typeof m.t === 'string') ? m : null;
    } catch (e) { return null; }
  }

  // ---------------- 客户端消息构造 ----------------
  function join(name) { return { t: C2S.JOIN, ver: PROTO_VER, name: String(name || '玩家').slice(0, 12) }; }
  function cancel() { return { t: C2S.CANCEL }; }
  function input(seq, angle, boost) { return { t: C2S.INPUT, seq: seq | 0, a: qAngle(angle), bo: boost ? 1 : 0 }; }
  function ping(ts) { return { t: C2S.PING, ts: ts }; }
  // on: 0=TCP only, 1=accelerated only, 2=probe (send both until a full datagram proves the path)
  function accel(mode) { return { t: C2S.ACCEL, on: mode === 2 ? 2 : (mode ? 1 : 0) }; }

  // ---------------- 快照序列化（服务器/LocalTransport 产出） ----------------

  /**
   * 序列化一条参赛蛇（Entry 或 RemoteEntry）。
   * sg 为扁平整数数组 [x0,y0,x1,y1,...]（含尾巴节），co 为 1 字符颜色短码串。
   * @param e Entry（见 multiplayer.js）：{ id, name, isPlayer, alive, kills, elimScore,
   *          elimTotal, maxLen, bittenUntil, slowUntil, snake }
   */
  function serSnake(e) {
    var s = e.snake;
    var sg = [];
    for (var i = 0; i < s.segPos.length; i++) {
      sg.push(qCoord(s.segPos[i].x), qCoord(s.segPos[i].y));
    }
    return {
      id: e.id, nm: e.name, pl: e.isPlayer ? 1 : 0, al: e.alive ? 1 : 0,
      x: qCoord(s.x), y: qCoord(s.y), a: qAngle(s.angle), sp: qCoord(s.speed),
      co: packColors(s.colors), sg: sg,
      kl: e.kills | 0, es: e.elimScore | 0, et: e.elimTotal | 0, ml: e.maxLen | 0,
      sv: e.survivalScore | 0, mb: e.mpBonusScore | 0, // 生存分/彩色星加成（HUD 计分显示）
      bt: e.bittenUntil | 0, sl: e.slowUntil | 0
    };
  }

  function serBlock(b) {
    return {
      // bid 让偶发 TCP 全量帧可重建二进制增量基线；旧客户端忽略未知字段。
      bid: b.__bid != null ? b.__bid : (b.bid != null ? b.bid : null),
      x: qCoord(b.x), y: qCoord(b.y),
      c: b.color ? cShort(b.color) : null, k: b.kind || 'color', r: b.rarity || null,
      ph: Math.round((b.phase || 0) * 100) / 100, ttl: b.ttl | 0, rr: b.rr || b.r || 0
    };
  }

  function serMeteor(m) {
    var tr = [];
    for (var i = 0; i < (m.trail || []).length; i++) tr.push(qCoord(m.trail[i].x), qCoord(m.trail[i].y));
    return { x: qCoord(m.x), y: qCoord(m.y), vx: qCoord(m.vx), vy: qCoord(m.vy), c: cShort(m.color), ph: Math.round((m.phase || 0) * 100) / 100, tr: tr };
  }

  /** 组装一帧快照 */
  function snap(tick, ack, timeMs, entries, blocks, meteors) {
    var sn = [];
    for (var i = 0; i < entries.length; i++) sn.push(serSnake(entries[i]));
    var bl = [];
    for (i = 0; i < blocks.length; i++) bl.push(serBlock(blocks[i]));
    var mt = [];
    for (i = 0; i < (meteors || []).length; i++) mt.push(serMeteor(meteors[i]));
    return { t: S2C.SNAP, tk: tick | 0, ack: ack | 0, tm: timeMs | 0, sn: sn, bl: bl, mt: mt };
  }

  function event(kind, data) {
    var m = { t: S2C.EVENT, k: kind };
    if (data) for (var k in data) m[k] = data[k];
    return m;
  }

  // ---------------- 反序列化（客户端 RemoteMatch 用） ----------------

  function deSnake(d) {
    var segPos = [];
    for (var i = 0; i + 1 < d.sg.length; i += 2) segPos.push({ x: d.sg[i], y: d.sg[i + 1] });
    return {
      id: d.id, name: d.nm, isPlayer: !!d.pl, alive: !!d.al,
      x: d.x, y: d.y, angle: d.a, speed: d.sp,
      colors: unpackColors(d.co), segPos: segPos,
      kills: d.kl, elimScore: d.es, elimTotal: d.et, maxLen: d.ml,
      survivalScore: d.sv, mpBonusScore: d.mb,
      bittenUntil: d.bt, slowUntil: d.sl
    };
  }

  function deBlock(d) {
    return { bid: d.bid, x: d.x, y: d.y, color: d.c ? cLong(d.c) : null, kind: d.k, rarity: d.r, phase: d.ph, ttl: d.ttl, r: d.rr || 0 };
  }

  function deMeteor(d) {
    var tr = [];
    for (var i = 0; i + 1 < (d.tr || []).length; i += 2) tr.push({ x: d.tr[i], y: d.tr[i + 1] });
    return { x: d.x, y: d.y, vx: d.vx, vy: d.vy, color: cLong(d.c), phase: d.ph, trail: tr };
  }

  CS.protocol = {
    PROTO_VER: PROTO_VER,
    C2S: C2S, S2C: S2C, EVENT_KIND: EVENT_KIND, OVER_REASON: OVER_REASON,
    qCoord: qCoord, qAngle: qAngle,
    encode: encode, decode: decode,
    join: join, cancel: cancel, input: input, ping: ping, accel: accel,
    serSnake: serSnake, serBlock: serBlock, serMeteor: serMeteor,
    snap: snap, event: event,
    deSnake: deSnake, deBlock: deBlock, deMeteor: deMeteor
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CS.protocol;
})(typeof window !== 'undefined' ? window : globalThis);
