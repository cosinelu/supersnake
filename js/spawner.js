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
    this.blocks = []; // {x, y, color, phase, kind}（世界坐标）
    this.timer = 0;
    this.meteors = [];   // 流星砖块：{x,y,vx,vy,color,ttl,trail,phase}（移动实体）
    this.meteorTimer = 0;
    this.others = []; // 其他活蛇数组（多人模式由 multiplayer 挂活引用，刷新时同样避让）
    this.unlockedKeys = cfg.COLOR_KEYS.slice(); // 默认全部；game 会按本局解锁数覆盖
    this.specialChance = cfg.ITEM_SPECIAL_CHANCE; // 每帧由 game/mp 按存活时间更新（越后期越高）
    var area = walls.W * walls.H;
    this.target = u.clamp(Math.round(area / cfg.BLOCK_AREA_DIV), cfg.BLOCKS_MIN, cfg.BLOCKS_MAX);
  }

  /** 按权重抽取一个特殊道具 kind（wild/bomb/slow/clear/clear3/rand1-3）；供刷新与阵亡掉落共用 */
  Spawner.prototype.randomSpecialKind = function () {
    var w = cfg.ITEM_WEIGHTS, total = 0, k;
    for (k in w) total += w[k];
    var r = Math.random() * total;
    for (k in w) { r -= w[k]; if (r <= 0) return k; }
    return 'wild';
  };

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
      // 不压边界墙带（相机已放开余量可见，道具不能叠在上面）
      var edgePad = cfg.WALL_THICK + cfg.BLOCK_RADIUS + 10;
      if (x < edgePad || x > w.W - edgePad || y < edgePad || y > w.H - edgePad) continue;
      if (w.pointInWall(x, y, cfg.BLOCK_RADIUS + 22)) continue;       // 不压内部墙（加大余量）
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
      // 决定类型：默认普通色块；按当前 specialChance 改为特殊道具（按权重抽取，越后期概率越高）
      var kind = 'color';
      if (Math.random() < this.specialChance) kind = this.randomSpecialKind();
      // clear / clear3 携带目标颜色（消除该色）；其余特殊道具 color=null
      var color = null;
      if (kind === 'color' || kind === 'clear' || kind === 'clear3') {
        color = this.unlockedKeys[Math.floor(Math.random() * this.unlockedKeys.length)];
      }
      this.blocks.push({
        x: x, y: y,
        kind: kind,
        color: color,
        rarity: cfg.ITEM_RARITY[kind] || null, // 稀有度边框用（普通色块为 null）
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

  /**
   * 阵亡掉落：在 (x,y) 处直接放入一个随机特殊道具（带稀有度边框）。
   * clear / clear3 随机一个已解锁颜色作为目标色。
   * @param {number} x,y 世界坐标
   * @param {string} kind 道具类型（来自 randomSpecialKind）
   */
  Spawner.prototype.addDroppedItem = function (x, y, kind) {
    var color = null;
    if (kind === 'clear' || kind === 'clear3') {
      color = this.unlockedKeys[Math.floor(Math.random() * this.unlockedKeys.length)];
    }
    this.blocks.push({
      x: x, y: y,
      kind: kind,
      color: color,
      rarity: cfg.ITEM_RARITY[kind] || null,
      phase: Math.random() * Math.PI * 2
    });
  };

  /**
   * 生成一颗流星砖块：只从上下左右四个正方向之一，平行于地图边、从一侧直飞到对侧。
   * 出生在对应边缘（屏幕外一点），沿该正方向匀速直线飞向对侧边缘；
   * 出生位置在蛇附近 ±band 的带内，保证流星会经过玩家区域、有机会命中身体注入中段。
   */
  Spawner.prototype.spawnMeteor = function (snake) {
    var W = this.walls.W, H = this.walls.H;
    var dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    var d = dirs[Math.floor(Math.random() * 4)];
    var band = 420; // 在蛇附近 ±band 进入，保证流星经过玩家区域
    var spd = cfg.METEOR_SPEED * (0.5 + Math.random() * 0.8); // 每颗流星速度随机（有的快有的慢）
    var mx, my, vx, vy;
    if (d.x !== 0) { // 水平：从左/右边缘进入，朝对侧飞，y 取蛇附近
      mx = d.x > 0 ? -40 : W + 40;
      my = u.clamp(snake.y + (Math.random() * 2 - 1) * band, 40, H - 40);
      vx = d.x * spd; vy = 0;
    } else { // 垂直：从上/下边缘进入，朝对侧飞，x 取蛇附近
      mx = u.clamp(snake.x + (Math.random() * 2 - 1) * band, 40, W - 40);
      my = d.y > 0 ? -40 : H + 40;
      vx = 0; vy = d.y * spd;
    }
    this.meteors.push({
      x: mx, y: my, vx: vx, vy: vy,
      color: this.unlockedKeys[Math.floor(Math.random() * this.unlockedKeys.length)],
      ttl: cfg.METEOR_TTL_MS,
      trail: [],
      phase: Math.random() * Math.PI * 2
    });
  };

  /**
   * 每帧更新流星：直线匀速移动（无归向）+ 碰撞检测。
   * 命中任意身体节 → 返回注入事件 [{idx, x, y, color}]，由 game 调用 snake.insertAt 注入中段。
   * 未命中且出界/超时则消失。
   * @returns {Array} 本帧发生的注入事件
   */
  Spawner.prototype.updateMeteors = function (dtMs, snake) {
    this.meteorTimer -= dtMs;
    if (this.meteorTimer <= 0 && this.meteors.length < cfg.METEOR_MAX) {
      this.meteorTimer = cfg.METEOR_INTERVAL_MS;
      this.spawnMeteor(snake);
    }
    var events = [], dt = dtMs / 1000;
    for (var i = this.meteors.length - 1; i >= 0; i--) {
      var m = this.meteors[i];
      m.trail.push({ x: m.x, y: m.y });
      if (m.trail.length > 6) m.trail.shift();
      m.x += m.vx * dt; m.y += m.vy * dt;
      m.ttl -= dtMs;
      var hit = snake.segIndexAt(m.x, m.y, cfg.METEOR_HIT_R);
      if (hit >= 0) {
        events.push({ idx: hit, x: m.x, y: m.y, color: m.color });
        this.meteors.splice(i, 1);
        continue;
      }
      if (m.ttl <= 0 || m.x < -80 || m.y < -80 || m.x > this.walls.W + 80 || m.y > this.walls.H + 80) {
        this.meteors.splice(i, 1);
      }
    }
    return events;
  };

  CS.Spawner = Spawner;
})(typeof window !== 'undefined' ? window : globalThis);
