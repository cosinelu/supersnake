'use strict';
/**
 * interpolation.js — 他人蛇快照插值缓冲（v3.0 M4）
 *
 * 设计见 docs/architecture/01-online-multiplayer.md §5.4：
 * 渲染始终落后权威时刻 delayMs（默认 120ms，约 2 个快照间隔），
 * 在两帧快照间对位置/角度/节心做线性插值（角度走最短弧）。
 *
 * 用法：RemoteMatch.applySnap 时 push(buffer, snap)；每帧渲染前调用
 * sampleInto(buffer, entries, nowMs) 把插值结果写回 Entry 视图（原位更新，引用稳定）。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var u = CS.utils;

  /** 最短弧角度插值 */
  function lerpAngle(a, b, t) {
    return u.normAngle(a + u.normAngle(b - a) * t);
  }

  function InterpBuffer(delayMs) {
    this.delay = delayMs || 120;
    this.snaps = []; // [{ time(本地接收时刻), byId: {id: deSnake} }] 按时间升序
  }

  /**
   * 收到一帧快照（snap 为协议结构；deSnake 在 push 内完成，后续零解析成本）。
   * @param {object} snap protocol.snap 消息
   * @param {number} nowMs 本地接收时刻（Date.now 风格）
   * @param {function} deSnake protocol.deSnake
   */
  InterpBuffer.prototype.push = function (snap, nowMs, deSnake) {
    var byId = {};
    for (var i = 0; i < snap.sn.length; i++) {
      var d = deSnake(snap.sn[i]);
      byId[d.id] = d;
    }
    this.snaps.push({ time: nowMs, byId: byId, tick: snap.tk });
    // 只保留最近 1 秒（15Hz 下 ~15 帧），渲染延迟永远落在这个窗口内
    while (this.snaps.length > 30) this.snaps.shift();
  };

  /** 取渲染时刻的前后两帧快照（不足两帧时返回 [最新, 最新]） */
  InterpBuffer.prototype._bracket = function (renderT) {
    var ss = this.snaps;
    if (!ss.length) return null;
    if (ss.length === 1 || renderT >= ss[ss.length - 1].time) {
      return [ss[ss.length - 1], ss[ss.length - 1], 0];
    }
    for (var i = ss.length - 1; i >= 1; i--) {
      if (ss[i - 1].time <= renderT) {
        var span = ss[i].time - ss[i - 1].time;
        return [ss[i - 1], ss[i], span > 0 ? (renderT - ss[i - 1].time) / span : 0];
      }
    }
    return [ss[0], ss[0], 0];
  };

  /**
   * 采样一帧插值结果：{ id: {x,y,angle,segPos, ...静态字段取较新帧} }
   * 节心插值要求两帧节数一致（变长/消除瞬间取较新帧，一跳可接受）。
   */
  InterpBuffer.prototype.sample = function (nowMs) {
    var br = this._bracket(nowMs - this.delay);
    if (!br) return null;
    var s0 = br[0], s1 = br[1], t = Math.max(0, Math.min(1, br[2]));
    var out = {};
    for (var id in s1.byId) {
      var b = s1.byId[id], a = s0.byId[id];
      if (!a || a === b) { out[id] = b; continue; }
      var segPos = b.segPos;
      if (a.segPos.length === b.segPos.length) {
        segPos = [];
        for (var i = 0; i < b.segPos.length; i++) {
          segPos.push({
            x: a.segPos[i].x + (b.segPos[i].x - a.segPos[i].x) * t,
            y: a.segPos[i].y + (b.segPos[i].y - a.segPos[i].y) * t
          });
        }
      }
      out[id] = {
        id: b.id, name: b.name, isPlayer: b.isPlayer, alive: b.alive,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle: lerpAngle(a.angle, b.angle, t),
        speed: b.speed,
        colors: b.colors, segPos: segPos,
        kills: b.kills, elimScore: b.elimScore, elimTotal: b.elimTotal, maxLen: b.maxLen,
        bittenUntil: b.bittenUntil, slowUntil: b.slowUntil
      };
    }
    return out;
  };

  CS.InterpBuffer = InterpBuffer;
  CS.lerpAngle = lerpAngle;
  if (typeof module !== 'undefined' && module.exports) module.exports = InterpBuffer;
})(typeof window !== 'undefined' ? window : globalThis);
