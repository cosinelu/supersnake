'use strict';
/**
 * netMatch.js — 联机对局远程视图（v3.0）：把 snap/event 数据流维护成与 CS.Multiplayer
 * 同构的只读视图，renderer/game 多人分支无需分辨本地/联机（形状模仿，见
 * docs/architecture/01-online-multiplayer.md §5.5）。
 *
 * v1 为「最新快照直达」（无插值）；M4 将在此层内加 120ms 插值缓冲，对外形状不变。
 *
 * 视图对象：
 *   RemoteMatch.playerEntry   本机玩家 Entry 视图（按 playerId）
 *   RemoteMatch.bots          除本机外的全部 Entry 视图（真人 + AI，渲染/HUD 复用）
 *   RemoteMatch.allEntries() / leaderboard() / rankOf(e) / aliveSnakes() / timeMs
 *   Entry 视图字段与 multiplayer.Entry 对齐；snake 视图带 length()/totalLength()/
 *   headColor()/headDir()，segPos/colors/x/y/angle/speed 与本地 Snake 同形。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var P = CS.protocol;

  /** 蛇视图：快照数据 + 本地 Snake 的只读方法面 */
  function makeSnakeView(d) {
    var v = {
      x: d.x, y: d.y, angle: d.angle, targetAngle: d.angle, speed: d.speed,
      colors: d.colors, segPos: d.segPos,
      length: function () { return this.colors.length; },
      totalLength: function () { return this.colors.length + 1; },
      headColor: function () { return this.colors[0]; },
      headDir: function () { return { x: Math.cos(this.angle), y: Math.sin(this.angle) }; }
    };
    return v;
  }

  function makeEntryView(d) {
    return {
      id: d.id, name: d.name, isPlayer: d.isPlayer, alive: d.alive,
      kills: d.kills, elimScore: d.elimScore, elimTotal: d.elimTotal, maxLen: d.maxLen,
      bittenUntil: d.bittenUntil, slowUntil: d.slowUntil,
      snake: makeSnakeView(d)
    };
  }

  /** 快照原位更新（保留对象引用，M4 插值层挂在这里） */
  function updateEntryView(e, d) {
    e.name = d.name; e.isPlayer = d.isPlayer; e.alive = d.alive;
    e.kills = d.kills; e.elimScore = d.elimScore; e.elimTotal = d.elimTotal; e.maxLen = d.maxLen;
    e.bittenUntil = d.bittenUntil; e.slowUntil = d.slowUntil;
    var s = e.snake;
    s.x = d.x; s.y = d.y; s.angle = d.angle; s.targetAngle = d.angle; s.speed = d.speed;
    s.colors = d.colors; s.segPos = d.segPos;
  }

  /**
   * @param {number} [playerId] 本机玩家 Entry id（matched 消息给出）
   */
  function RemoteMatch(playerId) {
    this.playerId = playerId || 0;
    this.playerEntry = null;
    this.bots = [];          // 除本机外全部 Entry 视图
    this.entries = [];       // 全部 Entry 视图（按 id 升序）
    this.blocks = [];
    this.meteors = [];
    this.timeMs = 0;
    this.tick = 0;
    this.lastAck = 0;
    this._byId = {};
  }

  /** 应用一帧快照（protocol.snap 结构） */
  RemoteMatch.prototype.applySnap = function (snap) {
    this.tick = snap.tk;
    this.timeMs = snap.tm;
    this.lastAck = snap.ack;
    var i, d, e;
    for (i = 0; i < snap.sn.length; i++) {
      d = P.deSnake(snap.sn[i]);
      e = this._byId[d.id];
      if (e) updateEntryView(e, d);
      else { e = makeEntryView(d); this._byId[d.id] = e; this.entries.push(e); }
    }
    this.entries.sort(function (a, b) { return a.id - b.id; });
    this.playerEntry = this._byId[this.playerId] || null;
    this.bots = [];
    for (i = 0; i < this.entries.length; i++) {
      if (this.entries[i].id !== this.playerId) this.bots.push(this.entries[i]);
    }
    this.blocks = snap.bl.map(P.deBlock);
    this.meteors = snap.mt.map(P.deMeteor);
  };

  // ---- 与 CS.Multiplayer 同构的只读接口（renderer/game 复用） ----

  RemoteMatch.prototype.allEntries = function () { return this.entries.slice(); };

  RemoteMatch.prototype.aliveSnakes = function () {
    var arr = [];
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].alive) arr.push(this.entries[i].snake);
    }
    return arr;
  };

  RemoteMatch.prototype.leaderboard = function () {
    var arr = [];
    for (var i = 0; i < this.entries.length; i++) {
      var e = this.entries[i];
      if (e.alive) arr.push({ name: e.name, length: e.snake.length(), isPlayer: e.id === this.playerId });
    }
    arr.sort(function (a, b) {
      if (b.length !== a.length) return b.length - a.length;
      return (a.isPlayer ? 0 : 1) - (b.isPlayer ? 0 : 1);
    });
    return arr;
  };

  RemoteMatch.prototype.rankOf = function (entry) {
    var len = entry.snake.length();
    var rank = 1;
    for (var i = 0; i < this.entries.length; i++) {
      var e = this.entries[i];
      if (e !== entry && e.alive && e.snake.length() > len) rank++;
    }
    return rank;
  };

  CS.RemoteMatch = RemoteMatch;
  if (typeof module !== 'undefined' && module.exports) module.exports = RemoteMatch;
})(typeof window !== 'undefined' ? window : globalThis);
