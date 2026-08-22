'use strict';
/**
 * spawner.js — 色块刷新器（v2：世界像素坐标，DOM 无关）
 *  - 每隔 SPAWN_INTERVAL_MS 检查一次：未被吃掉的色块保留，只在空位补足到目标数量；
 *  - 目标数量 ≈ 世界面积 / BLOCK_AREA_DIV（90000），并夹在 [BLOCKS_MIN, BLOCKS_MAX]；
 *  - 生成采用拒绝采样 + 最小间距约束（简化版 Poisson disk）：
 *      与已有色块距离 ≥ BLOCK_MIN_DIST(140px)、与蛇身距离 ≥ BLOCK_SNAKE_DIST(80px)、
 *      不压墙（含边界内缩 BLOCK_EDGE_MARGIN）；最多尝试 SPAWN_TRIES(50) 次，失败则本轮跳过；
 *  - 只从已解锁颜色（unlockedKeys）中刷新。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var u = CS.utils;

  function Spawner(walls, snake) {
    this.walls = walls;
    this.snake = snake;
    this.blocks = []; // {x, y, color, phase}（世界坐标）
    this.timer = 0;
    this.others = []; // 其他活蛇数组（多人模式由 multiplayer 挂活引用，刷新时同样避让）
    this.unlockedKeys = cfg.COLOR_KEYS.slice(); // 默认全部；game 会按本局解锁数覆盖
    var area = walls.W * walls.H;
    this.target = u.clamp(Math.round(area / cfg.BLOCK_AREA_DIV), cfg.BLOCKS_MIN, cfg.BLOCKS_MAX);
  }

  /** 每帧调用；到达刷新间隔时补足色块 */
  Spawner.prototype.update = function (dt) {
    this.timer += dt;
    if (this.timer < cfg.SPAWN_INTERVAL_MS) return;
    this.timer = 0;
    var guard = 0;
    while (this.blocks.length < this.target && guard++ < this.target) {
      if (!this.spawnOne()) break; // 拒绝采样失败，本轮跳过
    }
  };

  /** 立即补足（开局调用一次） */
  Spawner.prototype.fillNow = function () {
    var guard = 0;
    while (this.blocks.length < this.target && guard++ < this.target * 2) {
      if (!this.spawnOne()) break;
    }
  };

  /** 尝试生成一个色块，成功返回 true */
  Spawner.prototype.spawnOne = function () {
    var w = this.walls, s = this.snake, m = cfg.BLOCK_EDGE_MARGIN;
    for (var tries = 0; tries < cfg.SPAWN_TRIES; tries++) {
      var x = m + Math.random() * (w.W - 2 * m);
      var y = m + Math.random() * (w.H - 2 * m);
      if (w.pointInWall(x, y, cfg.BLOCK_RADIUS + 6)) continue;        // 不压墙
      if (s.distTo(x, y) < cfg.BLOCK_SNAKE_DIST) continue;            // 离蛇 ≥80px
      var nearOther = false;
      for (var oi = 0; oi < this.others.length; oi++) {               // 多人：其他活蛇同样避让
        if (this.others[oi].distTo(x, y) < cfg.BLOCK_SNAKE_DIST) { nearOther = true; break; }
      }
      if (nearOther) continue;
      var ok = true;
      for (var i = 0; i < this.blocks.length; i++) {
        if (u.dist(x, y, this.blocks[i].x, this.blocks[i].y) < cfg.BLOCK_MIN_DIST) { ok = false; break; }
      }
      if (!ok) continue;                                              // 与已有色块 ≥140px
      this.blocks.push({
        x: x, y: y,
        color: this.unlockedKeys[Math.floor(Math.random() * this.unlockedKeys.length)],
        phase: Math.random() * Math.PI * 2 // 脉动相位
      });
      return true;
    }
    return false;
  };

  /**
   * 收集被蛇压到的色块（蛇头与身体节圆形重叠都算）。
   * @returns {Array} 被收集的色块
   */
  Spawner.prototype.collectAt = function (snake) {
    var got = [];
    var rest = [];
    for (var i = 0; i < this.blocks.length; i++) {
      var b = this.blocks[i];
      if (snake.overlaps(b.x, b.y, cfg.BLOCK_RADIUS)) got.push(b);
      else rest.push(b);
    }
    this.blocks = rest;
    return got;
  };

  CS.Spawner = Spawner;
})(typeof window !== 'undefined' ? window : globalThis);
