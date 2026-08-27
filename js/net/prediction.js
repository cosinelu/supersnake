'use strict';
/**
 * prediction.js — 本机玩家蛇预测 + 软校正（v3.0 M4）
 *
 * 设计见 docs/architecture/01-online-multiplayer.md §5.4：
 * 玩家输入立刻在本地生效（零操作延迟），服务器快照带回权威状态后软校正：
 *  - 偏差 < HARD_SNAP_PX（默认 80px）：按 CORRECT_RATE（默认 10%/帧）收敛，绝不瞬移；
 *  - 偏差 ≥ HARD_SNAP_PX（极少见：丢包爆发/被咬瞬间）：直接对齐权威状态；
 *  - 颜色序列/速度以服务器为准（吃块/消除/咬断都是服务器裁决）。
 *
 * 预测体是一个真正的 CS.Snake 实例（与服务器同一套运动模型），
 * 轨迹用快照节心近似重建（节间距 SEG_SPACING ≈ TRAIL_STEP 的整数倍，形状高度接近）。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var u = CS.utils;

  var HARD_SNAP_PX = 80;   // 偏差超过该值直接对齐（防长时间错误漂移）
  var CORRECT_RATE = 0.1;  // 每帧收敛剩余偏差的 10%

  function SelfPredictor() {
    this.snake = null;       // 本地预测蛇（CS.Snake 实例）
    this._corr = { x: 0, y: 0 };  // 待收敛的位置偏差
    this._corrAngle = 0;     // 待收敛的角度偏差
    this.lastErr = 0;        // 最近一次 reconcile 的偏差（监控/测试用）
    this.hardSnaps = 0;      // 硬对齐次数（应极少；监控用）
  }

  /**
   * 用权威快照（deSnake 结果）初始化/重建预测体。
   * @param {object} d protocol.deSnake 的本机玩家蛇
   * @param {string[]} colorKeys 已解锁颜色池（保底补砖用）
   */
  SelfPredictor.prototype.attach = function (d, colorKeys) {
    var s = Object.create(CS.Snake.prototype);
    s.x = d.x; s.y = d.y;
    s.angle = d.angle; s.targetAngle = d.angle;
    s.speed = d.speed;
    s.colors = d.colors.slice();
    s.colorKeys = colorKeys || cfg.COLOR_KEYS;
    // 轨迹近似：节心数组头在前、间距 SEG_SPACING，正好可当 trail 用
    s.trail = d.segPos.map(function (p) { return { x: p.x, y: p.y }; });
    if (!s.trail.length) s.trail = [{ x: d.x, y: d.y }];
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
      this.attach(d); // 硬对齐（丢包爆发/长卡顿后的自救）
      this.hardSnaps++;
      return;
    }
    this._corr.x += dx;
    this._corr.y += dy;
    this._corrAngle += u.normAngle(d.angle - s.angle);
  };

  /** 当前预测视图（供渲染：与 Snake 同形） */
  SelfPredictor.prototype.view = function () { return this.snake; };

  CS.SelfPredictor = SelfPredictor;
  CS.PREDICT_HARD_SNAP_PX = HARD_SNAP_PX;
  if (typeof module !== 'undefined' && module.exports) module.exports = SelfPredictor;
})(typeof window !== 'undefined' ? window : globalThis);
