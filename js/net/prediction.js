'use strict';
/**
 * prediction.js — 本机玩家蛇预测 + 软校正（v3.0 M4；v3.0.2 修复轨迹重建）
 *
 * 设计见 docs/architecture/01-online-multiplayer.md §5.4：
 * 玩家输入立刻在本地生效（零操作延迟），服务器快照带回权威状态后软校正：
 *  - 偏差 < HARD_SNAP_PX（默认 80px）：按 CORRECT_RATE（默认 10%/帧）收敛，绝不瞬移；
 *  - 偏差 ≥ HARD_SNAP_PX（极少见：丢包爆发/被咬瞬间）：直接对齐权威状态；
 *  - 颜色序列/速度以服务器为准（吃块/消除/咬断都是服务器裁决）。
 *
 * 预测体是一个真正的 CS.Snake 实例（与服务器同一套运动模型）。
 *
 * **轨迹重建（§5.4.1，v3.0.2 修复「头抛弃身体」）**：
 * 快照只带节心（间距 SEG_SPACING=30px），而 trail 采样步长是 TRAIL_STEP=3px。
 * 早期实现直接把 segPos 当 trail，弧长恰好等于身体长度、余量为零 —— colors 一变长
 * （吃块/流星注入/尸体色块）轨迹立刻不够，computeBody 沿轨迹排布时尾部全部节堆在
 * 轨迹末点，表现为「头带着几节移动，身体留在原地」。
 * 修复：细分插值 + 尾部外推补足弧长，并在 colors 变长时重新校验（不能只在 attach 做）。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var u = CS.utils;

  var HARD_SNAP_PX = 80;   // 偏差超过该值直接对齐（防长时间错误漂移）
  var CORRECT_RATE = 0.1;  // 每帧收敛剩余偏差的 10%
  var TRAIL_MARGIN = 90;   // 轨迹弧长安全余量（px）：> trimTrail 的 60px，留一档安全垫

  /** 身体所需弧长（含恒在的尾巴节） */
  function needArcFor(colorCount) {
    return (colorCount + 1) * cfg.SEG_SPACING;
  }

  /** 轨迹弧长（从头部算起，沿 trail 累加） */
  function trailArc(s) {
    var acc = 0, px = s.x, py = s.y;
    for (var i = 0; i < s.trail.length; i++) {
      acc += u.dist(px, py, s.trail[i].x, s.trail[i].y);
      px = s.trail[i].x; py = s.trail[i].y;
    }
    return acc;
  }

  /**
   * 由权威节心序列重建一条「密度与弧长都够用」的轨迹（§5.4.1）。
   *
   * 为什么不能直接用 segPos：节心间距 30px ≫ TRAIL_STEP 3px，且首尾弧长恰好 = 身体长度，
   * 余量为零；computeBody 沿轨迹排布，轨迹一耗尽剩余节全部堆在末点。
   *
   * **起点一致性**：正常快照里 segPos[0] 就是头部坐标。但若调用方给出的 head 与
   * segPos[0] 不一致（异常快照/测试构造），从 head 走向 segPos[0] 的那段位移是「假轨迹」，
   * 会污染轨迹前段、破坏头与第 1 节的弦长关系，且每次 attach 累积一次退化。
   * 因此这里显式丢弃与 head 明显偏离的首个节心，以 head 为唯一权威起点。
   *
   * @param {{x:number,y:number}[]} segPos 权威节心（含头，头在前）
   * @param {number} headX 轨迹起点 = 头部世界坐标
   * @param {number} headY
   * @param {number} angle 头部朝向（节心不足时沿其反方向外推）
   * @param {number} needArc 身体所需弧长（不含余量）
   * @returns {{x:number,y:number}[]} trail（trail[0] 最新、靠近头部）
   */
  function buildTrail(segPos, headX, headY, angle, needArc) {
    var target = needArc + TRAIL_MARGIN;
    var step = cfg.TRAIL_STEP;
    var pts = [];
    var acc = 0;
    var px = headX, py = headY;

    // 起点一致性：segPos[0] 应等于头部。偏离超过一个节距说明 head 与 segPos 不同源
    // （head 已被校正/瞬移而 segPos 仍是旧序列），此时跳过它，避免注入假位移。
    var start = 0;
    if (segPos && segPos.length &&
        u.dist(headX, headY, segPos[0].x, segPos[0].y) > cfg.SEG_SPACING) {
      start = 1;
    }

    // 1) 沿节心序列细分插值，把密度对齐到 TRAIL_STEP
    for (var i = start; segPos && i < segPos.length && acc < target; i++) {
      var nx = segPos[i].x, ny = segPos[i].y;
      var d = u.dist(px, py, nx, ny);
      if (d < 1e-6) continue;               // 重合点（刚出生时节心全堆叠）跳过
      var n = Math.max(1, Math.ceil(d / step));
      for (var k = 1; k <= n && acc < target; k++) {
        var t = k / n;
        pts.push({ x: px + (nx - px) * t, y: py + (ny - py) * t });
        acc += d / n;
      }
      px = nx; py = ny;
    }

    // 2) 弧长仍不足 → 沿尾部方向外推（节心不足 2 点时用 angle 的反方向）
    if (acc < target) {
      var dx, dy;
      if (pts.length >= 2) {
        var a = pts[pts.length - 2], b = pts[pts.length - 1];
        dx = b.x - a.x; dy = b.y - a.y;
      } else {
        dx = -Math.cos(angle); dy = -Math.sin(angle); // 头朝 angle，身体在反方向
      }
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) { dx = -Math.cos(angle); dy = -Math.sin(angle); len = 1; }
      dx /= len; dy /= len;
      var lx = pts.length ? pts[pts.length - 1].x : headX;
      var ly = pts.length ? pts[pts.length - 1].y : headY;
      var guard = 0;
      while (acc < target && guard++ < 5000) { // guard：防御 step 异常导致死循环
        lx += dx * step; ly += dy * step;
        pts.push({ x: lx, y: ly });
        acc += step;
      }
    }

    if (!pts.length) pts.push({ x: headX, y: headY }); // 极端兜底：至少 1 点
    return pts;
  }

  function SelfPredictor() {
    this.snake = null;       // 本地预测蛇（CS.Snake 实例）
    this._corr = { x: 0, y: 0 };  // 待收敛的位置偏差
    this._corrAngle = 0;     // 待收敛的角度偏差
    this.lastErr = 0;        // 最近一次 reconcile 的偏差（监控/测试用）
    this.hardSnaps = 0;      // 硬对齐次数（应极少；监控用）
    this.trailRebuilds = 0;  // 轨迹补足次数（监控：频繁触发说明预测与权威长期不同步）
    this._colorKeys = null;  // 记住色池：hardSnap 内部走 attach 时不丢
  }

  /**
   * 用权威快照（deSnake 结果）初始化/重建预测体。
   * @param {object} d protocol.deSnake 的本机玩家蛇
   * @param {string[]} [colorKeys] 已解锁颜色池（保底补砖用；省略则沿用上次）
   */
  SelfPredictor.prototype.attach = function (d, colorKeys) {
    var s = Object.create(CS.Snake.prototype);
    s.x = d.x; s.y = d.y;
    s.angle = d.angle; s.targetAngle = d.angle;
    s.speed = d.speed;
    s.colors = d.colors.slice();
    s.colorKeys = colorKeys || this._colorKeys || cfg.COLOR_KEYS;
    this._colorKeys = s.colorKeys;
    // 轨迹重建：细分插值 + 尾部外推，保证密度与弧长都够用（§5.4.1）
    s.trail = buildTrail(d.segPos, d.x, d.y, d.angle, needArcFor(s.colors.length));
    s.segPos = [];
    s.selfPullCd = 0;
    s.computeBody();
    s.trimTrail();
    this.snake = s;
    this._corr = { x: 0, y: 0 };
    this._corrAngle = 0;
  };

  /** 每帧本地推进：写入最新输入 → 运动学积分 → 应用一份软校正 */
  SelfPredictor.prototype.update = function (dtMs, angle) {
    var s = this.snake;
    if (!s) return;
    if (typeof angle === 'number') s.setTargetAngle(angle);
    s.update(dtMs);
    // 软校正：位置/角度各收敛剩余偏差的 10%，收敛到 0.1px 内清零
    if (Math.abs(this._corr.x) > 0.1 || Math.abs(this._corr.y) > 0.1) {
      s.x += this._corr.x * CORRECT_RATE;
      s.y += this._corr.y * CORRECT_RATE;
      this._corr.x *= (1 - CORRECT_RATE);
      this._corr.y *= (1 - CORRECT_RATE);
      s.computeBody();
    } else { this._corr.x = 0; this._corr.y = 0; }
    if (Math.abs(this._corrAngle) > 0.001) {
      s.angle = u.normAngle(s.angle + this._corrAngle * CORRECT_RATE);
      this._corrAngle *= (1 - CORRECT_RATE);
    } else { this._corrAngle = 0; }
  };

  /**
   * 收到本机蛇权威快照（deSnake 结果）时的 reconcile：
   * 颜色序列/速度直接以服务器为准；位置/角度按偏差大小软校正或硬对齐。
   *
   * colors 变长（吃块/流星注入/尸体色块）是「头抛弃身体」的主要触发路径：
   * 身体变长后轨迹弧长可能不够，必须重新校验并补足（§5.4.1 规则 4）。
   */
  SelfPredictor.prototype.reconcile = function (d) {
    var s = this.snake;
    if (!s) { this.attach(d); return; }
    // 颜色序列（吃块/消除/咬断/流星注入全是服务器裁决，直接采纳）
    if (s.colors.join() !== d.colors.join()) {
      s.colors = d.colors.slice();
      s.computeBody();
    }
    s.speed = d.speed;
    var dx = d.x - s.x, dy = d.y - s.y;
    var err = Math.sqrt(dx * dx + dy * dy);
    this.lastErr = err;
    if (err >= HARD_SNAP_PX) {
      this.attach(d, this._colorKeys); // 硬对齐（丢包爆发/长卡顿后的自救）
      this.hardSnaps++;
      return;
    }
    // 轨迹弧长校验：不足则用权威节心重建（colors 变长时必然走到这里）
    var need = needArcFor(s.colors.length);
    if (trailArc(s) < need + 1) {
      s.trail = buildTrail(d.segPos, s.x, s.y, s.angle, need);
      s.computeBody();
      s.trimTrail();
      this.trailRebuilds++;
    }
    this._corr.x += dx;
    this._corr.y += dy;
    this._corrAngle += u.normAngle(d.angle - s.angle);
  };

  /** 当前预测视图（供渲染：与 Snake 同形） */
  SelfPredictor.prototype.view = function () { return this.snake; };

  CS.SelfPredictor = SelfPredictor;
  CS.PREDICT_HARD_SNAP_PX = HARD_SNAP_PX;
  CS.PREDICT_TRAIL_MARGIN = TRAIL_MARGIN;
  CS.buildPredictTrail = buildTrail;   // 导出供测试直接验证
  CS.predictTrailArc = trailArc;
  if (typeof module !== 'undefined' && module.exports) module.exports = SelfPredictor;
})(typeof window !== 'undefined' ? window : globalThis);
