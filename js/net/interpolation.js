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

  /** TCP 完整 tick 与二进制 uint16 tick → 单调 tick；state 只保存上次原始/展开值 */
  function normalizeTick16(state, rawTick) {
    var raw = rawTick | 0;
    var low = raw & 0xFFFF;
    if (state.lastRawTick == null) {
      state.lastRawTick = raw;
      state.lastNormTick = raw;
      return raw;
    }
    var delta = (low - (state.lastRawTick & 0xFFFF)) & 0xFFFF;
    var norm = delta < 0x8000
      ? state.lastNormTick + delta
      : state.lastNormTick - (0x10000 - delta);
    if (norm >= state.lastNormTick) {
      state.lastRawTick = raw;
      state.lastNormTick = norm;
    }
    return norm;
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
  function InterpBuffer(delayMs, tickMs) {
    this.delay = delayMs || 120;
    this.snapIntervalMs = 0; // 0 = 未从服务器获知
    this.cap = 30;           // 与旧行为一致（15Hz 下约 2 秒历史）
    this.tickMs = tickMs || (CS.config && CS.config.SERVER_TICK_MS) || 33;
    this._timeBaseMs = null; // tick×tickMs → 本地时钟的锚点；取观测到的最小网络偏移
    this.lastRawTick = null; // 原始 tick（二进制会 16 位截断，JSON 不截断）
    this.lastNormTick = null; // 展开后的单调 tick（跨 65536 回绕仍递增）
    this._highBaseMs = 0;      // 持续高时延候选锚点
    this._highBaseSince = 0;
    this.snaps = []; // [{ time(权威时间线的本地等价), recvTime, byId, meteors, tick(单调) }]
    // 缓冲是否够用必须可观测：renderT 越过最新帧时先短外推，
    // 但 latestClamps 仍按原始耗尽统计，不能把问题粉饰掉。
    this.stats = { samples: 0, interpolated: 0, latestClamps: 0, oldestClamps: 0, extrapolated: 0 };
    this.lastLeadMs = 0;     // 最新快照相对 renderT 还领先多少；负数 = 缓冲已耗尽
    this._lastBracketKind = 'none';
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

  /** 把 TCP 完整 tick 与二进制 uint16 tick 展开为同一条单调序号（回绕安全） */
  InterpBuffer.prototype._normalizeTick = function (rawTick) {
    return normalizeTick16(this, rawTick);
  };

  InterpBuffer.prototype._shiftTimeBase = function (base) {
    var delta = base - this._timeBaseMs;
    if (!delta) return;
    this._timeBaseMs = base;
    for (var i = 0; i < this.snaps.length; i++) this.snaps[i].time += delta;
  };

  /**
   * 把服务器 tick 映射到本地渲染时钟。
   *
   * 不能用「每帧实际到达时刻」直接排列：TCP 队头阻塞解除后，多个快照会同一毫秒
   * 批量到达，按收包时刻回放就会把等待期间的运动压缩成一帧，远端蛇看起来瞬移。
   * tick 是服务器固定模拟步长，天然等间隔；这里只估计网络偏移，把权威时间线
   * 平移到本地时钟。时延下降立即前锚；时延上升必须持续一段时间才后锚，避免一次
   * TCP 突发把整条时间线打乱。
   */
  InterpBuffer.prototype._snapTime = function (tick, nowMs) {
    var tickAbs = tick * this.tickMs;
    var base = nowMs - tickAbs;
    if (this._timeBaseMs === null) {
      this._timeBaseMs = base;
      return tickAbs + this._timeBaseMs;
    }
    if (base < this._timeBaseMs && Math.abs(this._timeBaseMs - base) < 10000) {
      this._shiftTimeBase(base);
      this._highBaseMs = 0;
      this._highBaseSince = 0;
      return tickAbs + this._timeBaseMs;
    }

    var shiftThreshold = (CS.config && CS.config.REMOTE_CLOCK_SHIFT_MS) || 120;
    var reanchorMs = (CS.config && CS.config.REMOTE_REANCHOR_MS) || 1000;
    if (base > this._timeBaseMs + shiftThreshold) {
      if (!this._highBaseSince || base > this._highBaseMs) {
        if (!this._highBaseSince) this._highBaseSince = nowMs;
        this._highBaseMs = Math.max(this._highBaseMs || 0, base);
      }
      if (nowMs - this._highBaseSince >= reanchorMs) {
        this._shiftTimeBase(this._highBaseMs);
        this._highBaseMs = 0;
        this._highBaseSince = 0;
      }
    } else {
      this._highBaseMs = 0;
      this._highBaseSince = 0;
    }
    return tickAbs + this._timeBaseMs;
  };

  /**
   * 收到一帧快照（snap 为协议结构；反序列化在 push 内完成，后续零解析成本）。
   * @param {object} snap protocol.snap 消息
   * @param {number} nowMs 本地接收时刻（Date.now 风格）
   * @param {function} deSnake protocol.deSnake
   * @param {function} [deMeteor] protocol.deMeteor；提供后移动流星进入同一时间线
   */
  InterpBuffer.prototype.push = function (snap, nowMs, deSnake, deMeteor) {
    var normTick = this._normalizeTick(snap.tk);
    var last = this.snaps[this.snaps.length - 1];
    if (last && normTick < last.tick) return false; // 跨通道迟到的旧帧，先判序再付解析成本
    var byId = {};
    for (var i = 0; i < snap.sn.length; i++) {
      var d = deSnake(snap.sn[i]);
      byId[d.id] = d;
    }
    var meteors = [];
    if (deMeteor && snap.mt) {
      for (i = 0; i < snap.mt.length; i++) {
        var m = deMeteor(snap.mt[i]);
        // 协议 v3 起服务端保证稳定 mid；缺省键仅为旧测试/旧 JSON 数据兜底。
        m._key = m.mid != null ? String(m.mid) : ('legacy-' + i);
        meteors.push(m);
      }
    }
    var item = { time: this._snapTime(normTick, nowMs), recvTime: nowMs, byId: byId, meteors: meteors, tick: normTick };
    if (last && last.tick === item.tick) {
      // TCP/加速探测期可能同 tick 双通道到达；同帧替换，不能把时间线插出两个并列点。
      this.snaps[this.snaps.length - 1] = item;
    } else {
      this.snaps.push(item);
    }
    // 保留最近约 2 秒历史（帧数由 cap 折算，见 deriveCap）。
    // **不能写死帧数**：30 帧在 15Hz 是 2 秒，在 30Hz 只剩 1 秒，
    // 提频等于悄悄砍掉一半历史窗口。
    while (this.snaps.length > this.cap) this.snaps.shift();
    return true;
  };

  /** 取渲染时刻的前后两帧快照（不足两帧时返回 [最新, 最新]） */
  InterpBuffer.prototype._bracket = function (renderT) {
    var ss = this.snaps;
    if (!ss.length) { this._lastBracketKind = 'none'; return null; }
    this.lastLeadMs = ss[ss.length - 1].time - renderT;
    if (ss.length === 1 || renderT >= ss[ss.length - 1].time) {
      this._lastBracketKind = 'latest';
      return [ss[ss.length - 1], ss[ss.length - 1], 0];
    }
    for (var i = ss.length - 1; i >= 1; i--) {
      if (ss[i - 1].time <= renderT) {
        var span = ss[i].time - ss[i - 1].time;
        this._lastBracketKind = 'interpolate';
        return [ss[i - 1], ss[i], span > 0 ? (renderT - ss[i - 1].time) / span : 0];
      }
    }
    this._lastBracketKind = 'oldest';
    return [ss[0], ss[0], 0];
  };

  /** 整体平移点列（短外推时身体/拖尾必须跟随，不允许只移动头部或本体） */
  function shiftPoints(points, dx, dy) {
    var out = [];
    for (var i = 0; i < (points || []).length; i++) {
      out.push({ x: points[i].x + dx, y: points[i].y + dy });
    }
    return out;
  }

  /** 流星显示态：普通括号插值；越过最新帧时按速度短外推 */
  function sampleMeteor(a, b, t, overMs) {
    var x, y, angleDx, angleDy;
    if (overMs > 0) {
      x = b.x + b.vx * overMs / 1000;
      y = b.y + b.vy * overMs / 1000;
    } else if (a && a !== b) {
      x = a.x + (b.x - a.x) * t;
      y = a.y + (b.y - a.y) * t;
    } else {
      x = b.x; y = b.y;
    }
    angleDx = x - b.x; angleDy = y - b.y;
    return {
      mid: b.mid, x: x, y: y, vx: b.vx, vy: b.vy,
      color: b.color, phase: b.phase, trail: shiftPoints(b.trail, angleDx, angleDy)
    };
  }

  /**
   * 采样一帧插值结果：{ snakes: {id: ...}, meteors: [...] }
   * 兼容旧调用方：返回值本身仍可直接按 snake id 索引（snakes 字段是同一对象）。
   * 节心插值要求两帧节数一致（变长/消除瞬间取较新帧，一跳可接受）。
   */
  InterpBuffer.prototype.sample = function (nowMs) {
    var renderT = nowMs - this.delay;
    var br = this._bracket(renderT);
    if (!br) return null;
    this.stats.samples++;
    if (this._lastBracketKind === 'latest') this.stats.latestClamps++;
    else if (this._lastBracketKind === 'oldest') this.stats.oldestClamps++;
    else if (this._lastBracketKind === 'interpolate') this.stats.interpolated++;
    var s0 = br[0], s1 = br[1], t = Math.max(0, Math.min(1, br[2]));
    var maxExtra = (CS.config && CS.config.REMOTE_EXTRAPOLATE_MS) || 260;
    var overMs = this._lastBracketKind === 'latest'
      ? Math.min(maxExtra, Math.max(0, renderT - s1.time)) : 0;
    if (overMs > 0) this.stats.extrapolated++;

    var out = {};
    for (var id in s1.byId) {
      var b = s1.byId[id], a = s0.byId[id];
      if (!a || a === b) {
        if (overMs > 0) {
          var dx = Math.cos(b.angle) * (b.speed || 0) * overMs / 1000;
          var dy = Math.sin(b.angle) * (b.speed || 0) * overMs / 1000;
          out[id] = {
            id: b.id, name: b.name, isPlayer: b.isPlayer, alive: b.alive,
            x: b.x + dx, y: b.y + dy, angle: b.angle, speed: b.speed,
            colors: b.colors, segPos: shiftPoints(b.segPos, dx, dy),
            kills: b.kills, elimScore: b.elimScore, elimTotal: b.elimTotal, maxLen: b.maxLen,
            bittenUntil: b.bittenUntil, slowUntil: b.slowUntil,
            extrapolated: overMs
          };
        } else {
          out[id] = b;
        }
        continue;
      }
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
        bittenUntil: b.bittenUntil, slowUntil: b.slowUntil,
        extrapolated: 0
      };
    }

    var meteors = [];
    var aByKey = {}, i;
    for (i = 0; i < (s0.meteors || []).length; i++) aByKey[s0.meteors[i]._key] = s0.meteors[i];
    for (i = 0; i < (s1.meteors || []).length; i++) {
      var mb = s1.meteors[i];
      meteors.push(sampleMeteor(aByKey[mb._key], mb, t, overMs));
    }

    // 旧测试与旧调用方期望 sample(...)[id] 直接取蛇；附加字段不可枚举，
    // 避免 RemoteMatch 的 for..in 把 meteors/snakes 当成蛇 id。
    Object.defineProperty(out, 'snakes', { value: out, enumerable: false });
    Object.defineProperty(out, 'meteors', { value: meteors, enumerable: false });
    return out;
  };

  CS.InterpBuffer = InterpBuffer;
  CS.lerpAngle = lerpAngle;
  CS.normalizeTick16 = normalizeTick16;
  CS.deriveInterpDelay = deriveDelay;
  CS.deriveInterpCap = deriveCap;
  if (typeof module !== 'undefined' && module.exports) module.exports = InterpBuffer;
})(typeof window !== 'undefined' ? window : globalThis);
