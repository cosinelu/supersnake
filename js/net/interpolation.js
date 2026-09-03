'use strict';
/**
 * interpolation.js — 他人蛇快照插值缓冲（v3.0 M4，v3.1 起延迟自适应）
 *
 * 设计见 docs/architecture/01-online-multiplayer.md §5.4：
 * 渲染始终落后权威时刻 delayMs，在两帧快照间对位置/角度/节心做线性插值
 * （角度走最短弧）。
 *
 * **三个频率互相独立**（v3.1 明确）：
 *   服务器模拟 TICK_MS(30Hz) → 快照下行 TICK_MS×SNAP_EVERY(可配) → 客户端渲染 rAF(60Hz+)
 * 渲染循环从不等待网络；本层只负责把「离散且稀疏的权威帧」补成连续运动。
 *
 * 用法：RemoteMatch.applySnap 时 push(buffer, snap)；每帧渲染前调用
 * sampleInto(buffer, entries, nowMs) 把插值结果写回 Entry 视图（原位更新，引用稳定）。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var u = CS.utils;

  // 延迟推导参数（见 deriveDelay 注释）
  var INTERVAL_MULT = 1.5;   // 至少跨越 1 个快照间隔才可能有前后两帧可插
  var JITTER_MS = 20;        // 与快照频率无关的抖动余量
  var DELAY_MIN = 50, DELAY_MAX = 400;
  var HISTORY_MS = 2000;     // 缓冲保留的历史时长
  var CAP_MIN = 10, CAP_MAX = 120;

  /** 最短弧角度插值 */
  function lerpAngle(a, b, t) {
    return u.normAngle(a + u.normAngle(b - a) * t);
  }

  /**
   * 由快照间隔推导渲染延迟。
   *
   * **必须自适应，不能写死**：延迟的物理意义是「等够 1 个快照间隔，
   * 保证手上总有前后两帧可插」，所以它是快照频率的函数。
   * 旧代码硬编码 120ms 是按 15Hz（66ms）调出来的；若快照提到 30Hz(33ms)
   * 而延迟不动，就变成白等 ~86ms —— 提频带来的响应收益被缓冲吃光，
   * 手感反而比 15Hz 更钝（这正是「先自适应、再提频」的原因）。
   *
   * 公式：interval × 1.5 + 20
   *   - 1.5 倍间隔：1 倍是「刚好有前一帧」，t≈0，任何抖动都会越过最新帧
   *     被钳制成卡顿；1.5 倍留半帧余量
   *   - +20ms 固定项：网络抖动与快照频率无关，不该随提频一起缩水
   * 15Hz(66) → 119ms（与旧硬编码 120 实质等同，提频前后行为连续）
   * 30Hz(33) →  70ms
   */
  function deriveDelay(snapIntervalMs) {
    var iv = snapIntervalMs > 0 ? snapIntervalMs : 66;
    var d = Math.round(iv * INTERVAL_MULT) + JITTER_MS;
    return Math.max(DELAY_MIN, Math.min(DELAY_MAX, d));
  }

  /** 缓冲保留帧数：按「固定历史时长」折算，否则提频后窗口会缩短一半 */
  function deriveCap(snapIntervalMs) {
    var iv = snapIntervalMs > 0 ? snapIntervalMs : 66;
    return Math.max(CAP_MIN, Math.min(CAP_MAX, Math.ceil(HISTORY_MS / iv)));
  }

  /**
   * @param {number} [delayMs] 显式渲染延迟；缺省 120（旧默认）。
   *   通常不直接传，而是 new 完调用 setSnapInterval(matched.snapIntervalMs)。
   */
  function InterpBuffer(delayMs) {
    this.delay = delayMs || 120;
    this.snapIntervalMs = 0; // 0 = 未从服务器获知
    this.cap = 30;           // 与旧行为一致（15Hz 下约 2 秒历史）
    this.snaps = []; // [{ time(本地接收时刻), byId: {id: deSnake} }] 按时间升序
  }

  /**
   * 按服务器下发的快照间隔（matched.snapIntervalMs）重算延迟与缓冲窗口。
   * 幂等，可在对局中调用（服务器若动态调频，这里跟着变即可）。
   */
  InterpBuffer.prototype.setSnapInterval = function (intervalMs) {
    if (!(intervalMs > 0)) return false;
    this.snapIntervalMs = intervalMs;
    this.delay = deriveDelay(intervalMs);
    this.cap = deriveCap(intervalMs);
    while (this.snaps.length > this.cap) this.snaps.shift();
    return true;
  };

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
    // 保留最近约 2 秒历史（帧数由 cap 折算，见 deriveCap）。
    // **不能写死帧数**：30 帧在 15Hz 是 2 秒，在 30Hz 只剩 1 秒，
    // 提频等于悄悄砍掉一半历史窗口。
    while (this.snaps.length > this.cap) this.snaps.shift();
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
  CS.deriveInterpDelay = deriveDelay;
  CS.deriveInterpCap = deriveCap;
  if (typeof module !== 'undefined' && module.exports) module.exports = InterpBuffer;
})(typeof window !== 'undefined' ? window : globalThis);
