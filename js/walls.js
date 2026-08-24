'use strict';
/**
 * walls.js — 世界墙壁模型（v2：世界像素坐标，DOM 无关）
 * 规则：
 *  - 世界边界即墙（[0,W]x[0,H] 之外），蛇头碰到立即游戏结束；
 *  - 内部墙壁为矩形组合（一字形 / L 形 / 2x2 方块，由 WALL_UNIT 单元矩形拼成）；
 *  - 避开出生点周围 SPAWN_SAFE_RADIUS 圆形安全区；
 *  - 墙壁总面积 ≤ 世界面积 WALL_MAX_RATIO；段与段之间保留 ≥ WALL_GAP 间隙（留通道、不封死）；
 *  - 内部墙距世界边界 ≥ WALL_EDGE_MARGIN。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;

  function Walls(W, H, spawn) {
    this.W = W;             // 世界宽（px）
    this.H = H;             // 世界高（px）
    this.spawn = spawn;     // {x,y} 蛇出生点（世界坐标）
    this.rects = [];        // 内部墙矩形 [{x,y,w,h}]
    this.area = 0;          // 内部墙总面积（px²）
  }

  // ---------------- 几何判定 ----------------

  /** 圆 (cx,cy,r) 是否与矩形相交 */
  function circleRect(cx, cy, r, rect) {
    var nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
    var ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
    var dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  /** 两矩形（各自可外扩 pad）是否相交 */
  function rectsOverlap(a, b, pad) {
    return a.x - pad < b.x + b.w && a.x + a.w + pad > b.x &&
           a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;
  }

  /**
   * 撞墙判定：蛇头圆与世界边界 / 内部墙相交。
   * @returns {boolean}
   */
  Walls.prototype.hitsCircle = function (cx, cy, r) {
    if (cx - r < 0 || cy - r < 0 || cx + r > this.W || cy + r > this.H) return true; // 边界
    for (var i = 0; i < this.rects.length; i++) {
      if (circleRect(cx, cy, r, this.rects[i])) return true;
    }
    return false;
  };

  /** 点 (x,y) 是否落在任一内部墙内（可外扩 pad，用于色块生成避让） */
  Walls.prototype.pointInWall = function (x, y, pad) {
    pad = pad || 0;
    for (var i = 0; i < this.rects.length; i++) {
      var r = this.rects[i];
      if (x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad) return true;
    }
    return false;
  };

  /** 矩形是否侵犯出生点安全区（安全圆外扩蛇节半径） */
  Walls.prototype.rectHitsSafeZone = function (rect) {
    return circleRect(this.spawn.x, this.spawn.y, cfg.SPAWN_SAFE_RADIUS + cfg.SEG_RADIUS, rect);
  };

  // ---------------- 墙段生成 ----------------

  /**
   * 生成候选墙段（返回矩形数组）。三种形状：
   *   一字形：len(3~6) 个单元横/竖排 → 1 个矩形；
   *   L 形：两臂各 2~4 个单元 → 2 个矩形；
   *   2x2 方块 → 1 个矩形。
   */
  function makeSegment(W, H) {
    var U = cfg.WALL_UNIT, m = cfg.WALL_EDGE_MARGIN;
    var shape = Math.floor(Math.random() * 3);
    var rects = [];
    var ax, ay, i;
    if (shape === 0) {          // 一字形
      var len = 3 + Math.floor(Math.random() * 4);
      var horiz = Math.random() < 0.5;
      ax = m + Math.random() * Math.max(1, W - 2 * m - (horiz ? len * U : U));
      ay = m + Math.random() * Math.max(1, H - 2 * m - (horiz ? U : len * U));
      rects.push(horiz ? { x: ax, y: ay, w: len * U, h: U } : { x: ax, y: ay, w: U, h: len * U });
    } else if (shape === 1) {   // L 形
      var a1 = 2 + Math.floor(Math.random() * 3);
      var a2 = 2 + Math.floor(Math.random() * 3);
      var dx = Math.random() < 0.5 ? 1 : -1;
      var dy = Math.random() < 0.5 ? 1 : -1;
      ax = m + Math.random() * Math.max(1, W - 2 * m - a1 * U);
      ay = m + Math.random() * Math.max(1, H - 2 * m - a2 * U);
      if (dx < 0) ax += (a1 - 1) * U; // 方向归一：矩形坐标始终为包围盒左上
      if (dy < 0) ay += (a2 - 1) * U;
      rects.push({ x: ax, y: ay, w: a1 * U, h: U });  // 横臂
      rects.push({ x: ax, y: ay, w: U, h: a2 * U });  // 竖臂（与横臂共拐角）
    } else {                    // 2x2 方块
      ax = m + Math.random() * Math.max(1, W - 2 * m - 2 * U);
      ay = m + Math.random() * Math.max(1, H - 2 * m - 2 * U);
      rects.push({ x: ax, y: ay, w: 2 * U, h: 2 * U });
    }
    return rects;
  }

  /** 矩形是否越出"边界内缩 WALL_EDGE_MARGIN"的可放置区 */
  Walls.prototype.rectInBounds = function (r) {
    var m = cfg.WALL_EDGE_MARGIN;
    return r.x >= m && r.y >= m && r.x + r.w <= this.W - m && r.y + r.h <= this.H - m;
  };

  /**
   * 生成内部墙壁。
   * @param {number} segmentCount 目标墙段数
   * @returns {number} 实际放置的段数
   */
  Walls.prototype.generateWalls = function (segmentCount) {
    var maxArea = this.W * this.H * cfg.WALL_MAX_RATIO;
    var placed = 0;
    for (var s = 0; s < segmentCount; s++) {
      var done = false;
      for (var tries = 0; tries < 40 && !done; tries++) {
        var rects = makeSegment(this.W, this.H);
        if (!rects.length) continue;
        var area = 0, ok = true, i, j;
        for (i = 0; i < rects.length; i++) area += rects[i].w * rects[i].h;
        if (this.area + area > maxArea) break; // 预算耗尽
        for (i = 0; i < rects.length && ok; i++) {
          var r = rects[i];
          if (!this.rectInBounds(r) || this.rectHitsSafeZone(r)) { ok = false; break; }
          for (j = 0; j < this.rects.length; j++) {
            if (rectsOverlap(r, this.rects[j], cfg.WALL_GAP)) { ok = false; break; }
          }
        }
        if (!ok) continue;
        for (i = 0; i < rects.length; i++) this.rects.push(rects[i]);
        this.area += area;
        placed++;
        done = true;
      }
    }
    return placed;
  };

  /**
   * 动态新增一段障碍墙（随时间生成，让地图越来越复杂）。
   * 复用 makeSegment 生成候选，并避开：边界内缩区、出生安全区、已有墙（保留 WALL_GAP）、
   * 总面积预算（WALL_MAX_RATIO）、所有蛇身节点（snakePoints）。
   * 与 generateWalls 不同：只尝试放 1 段，且必须避开当前蛇身（避免凭空生成在蛇身上致死）。
   * @param {Array<{x:number,y:number}>} snakePoints 需避让的蛇身节点（玩家 + AI），可为空
   * @param {number} [maxRects] 矩形总数上限（含初始段），超出则跳过
   * @returns {boolean} 是否成功放置
   */
  Walls.prototype.addRandomWall = function (snakePoints, maxRects) {
    if (maxRects != null && this.rects.length >= maxRects) return false;
    var maxArea = this.W * this.H * cfg.WALL_MAX_RATIO;
    for (var tries = 0; tries < 40; tries++) {
      var rects = makeSegment(this.W, this.H);
      var area = 0, ok = true, i, j, r;
      for (i = 0; i < rects.length; i++) area += rects[i].w * rects[i].h;
      if (this.area + area > maxArea) return false; // 面积预算耗尽
      for (i = 0; i < rects.length && ok; i++) {
        r = rects[i];
        if (!this.rectInBounds(r) || this.rectHitsSafeZone(r)) { ok = false; break; }
        for (j = 0; j < this.rects.length; j++) {
          if (rectsOverlap(r, this.rects[j], cfg.WALL_GAP)) { ok = false; break; }
        }
        if (ok && snakePoints) {
          for (var p = 0; p < snakePoints.length; p++) {
            if (circleRect(snakePoints[p].x, snakePoints[p].y, cfg.SEG_RADIUS + cfg.WALL_SPAWN_SNAKE_PAD, r)) { ok = false; break; }
          }
        }
      }
      if (!ok) continue;
      for (i = 0; i < rects.length; i++) this.rects.push(rects[i]);
      this.area += area;
      return true;
    }
    return false;
  };

  CS.Walls = Walls;
  CS.walls = { circleRect: circleRect, rectsOverlap: rectsOverlap }; // 测试可用
})(typeof window !== 'undefined' ? window : globalThis);
