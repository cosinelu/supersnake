'use strict';
/**
 * renderer.js — 全部程序化 Canvas 2D 绘制（蜡笔手绘风，v2：相机视口 + 大地图）
 *  - 背景：浅奶油纸色 + 预生成的噪点平铺（离屏 canvas 只生成一次，document.createElement）；
 *  - 相机：视口区内 translate(-cam.x,-cam.y) 画世界，视口外裁剪；世界外区域压暗；
 *  - 手绘感：描边用 INK 深色，抖动用"固定种子伪随机"（同物每帧一致，不闪烁）；
 *  - 墙壁：边界为灰色排线墙带，内部墙为排线矩形；色块：带蜡笔笔触的圆角色块；
 *    蛇：圆形蜡笔节沿轨迹排布，末尾恒带 1 节深色小尾鳍（不可消除的尾巴节），
 *    蛇头表情眼睛朝向移动方向；
 *  - 右侧 HUD 面板：分数/目标/关卡/已解锁颜色预览 + 小地图（世界缩略 + 蛇头亮点）；
 *  - 摇杆：固定底座浮在视口区左下角，半透明手绘风。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var u = CS.utils;

  var noiseTile = null;

  /** 预生成纸张噪点 tile（只做一次） */
  function getNoiseTile() {
    if (noiseTile) return noiseTile;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var c = document.createElement('canvas');
    c.width = 160; c.height = 160;
    var g = c.getContext('2d');
    for (var i = 0; i < 420; i++) { // 纸面斑点
      g.fillStyle = Math.random() < 0.55 ? 'rgba(58,50,56,0.045)' : 'rgba(255,255,255,0.5)';
      g.beginPath();
      g.arc(Math.random() * 160, Math.random() * 160, Math.random() * 1.3 + 0.3, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = 'rgba(58,50,56,0.035)'; // 少许纸纤维
    g.lineWidth = 0.6;
    for (i = 0; i < 26; i++) {
      var x = Math.random() * 160, y = Math.random() * 160, a = Math.random() * Math.PI;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * (6 + Math.random() * 10), y + Math.sin(a) * (6 + Math.random() * 10));
      g.stroke();
    }
    noiseTile = c;
    return c;
  }

  /** 手绘风圆角矩形路径：四角按 (seedX,seedY) 做确定性抖动 */
  function wobblyRoundRect(ctx, x, y, w, h, r, seedX, seedY, wobble) {
    var j = wobble === undefined ? 1.2 : wobble;
    function ox(k) { return (u.hash2(seedX, seedY, k) - 0.5) * 2 * j; }
    function oy(k) { return (u.hash2(seedY, seedX, k + 9) - 0.5) * 2 * j; }
    ctx.beginPath();
    ctx.moveTo(x + r + ox(1), y + oy(1));
    ctx.lineTo(x + w - r + ox(2), y + oy(2));
    ctx.quadraticCurveTo(x + w + ox(3), y + oy(3), x + w + ox(4), y + r + oy(4));
    ctx.lineTo(x + w + ox(5), y + h - r + oy(5));
    ctx.quadraticCurveTo(x + w + ox(6), y + h + oy(6), x + w - r + ox(6), y + h + oy(7));
    ctx.lineTo(x + r + ox(7), y + h + oy(8));
    ctx.quadraticCurveTo(x + ox(8), y + h + oy(9), x + ox(9), y + h - r + oy(10));
    ctx.lineTo(x + ox(10), y + r + oy(11));
    ctx.quadraticCurveTo(x + ox(11), y + oy(12), x + r + ox(12), y + oy(13));
    ctx.closePath();
  }

  /** 在色块上叠加短笔触，模拟蜡笔涂抹纹理 */
  function crayonStrokes(ctx, x, y, w, h, seedX, seedY) {
    ctx.lineWidth = 1.1;
    ctx.lineCap = 'round';
    for (var i = 0; i < 4; i++) {
      var sx = x + 3 + u.hash2(seedX, seedY, 20 + i) * (w - 8);
      var sy = y + 3 + u.hash2(seedX, seedY, 30 + i) * (h - 8);
      var len = 3 + u.hash2(seedX, seedY, 40 + i) * (w * 0.45);
      var ang = (u.hash2(seedX, seedY, 50 + i) - 0.5) * 1.1; // 大致水平的涂抹
      ctx.strokeStyle = i % 2 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.10)';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len);
      ctx.stroke();
    }
  }

  /** 画一颗蜡笔色块（蛇身节 / 道具 / 预览色块共用），(px,py) 为左上 */
  function drawCrayonBlock(ctx, px, py, size, colorHex, seedX, seedY, opts) {
    opts = opts || {};
    var rot = opts.rot || 0;
    var scale = opts.scale || 1;
    ctx.save();
    ctx.translate(px + size / 2, py + size / 2);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-size / 2, -size / 2);
    var r = size * 0.28;
    wobblyRoundRect(ctx, 0, 0, size, size, r, seedX, seedY, opts.wobble);
    ctx.fillStyle = colorHex;
    ctx.fill();
    crayonStrokes(ctx, 0, 0, size, size, seedX, seedY);
    // 手绘描边：两遍微错位，制造"描了两次"的草图感
    // opts.stroke 可覆盖主描边粗细（蛇节用 SEG_STROKE≈3px，相邻节边界一眼可辨）
    var mainStroke = opts.stroke || Math.max(1.4, size * 0.07);
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = mainStroke;
    ctx.stroke();
    ctx.save();
    ctx.translate(0.8, -0.6);
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = Math.max(0.8, mainStroke * 0.55);
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  /** 排线填充（裁剪在已建立的路径内），墙壁质感 */
  function hatchClip(ctx, x, y, w, h, spacing) {
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgba(58,50,56,0.35)';
    ctx.lineWidth = 1;
    var step = spacing || 12;
    for (var d = -h; d < w + h; d += step) {
      ctx.beginPath();
      ctx.moveTo(x + d, y + h + 2);
      ctx.lineTo(x + d + h + 4, y - 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 内部墙矩形：灰色蜡笔底 + 斜线排线 */
  function drawWallRect(ctx, r, seed) {
    wobblyRoundRect(ctx, r.x, r.y, r.w, r.h, 8, seed, seed + 3, 2.2);
    ctx.fillStyle = cfg.WALL_FILL;
    ctx.fill();
    hatchClip(ctx, r.x, r.y, r.w, r.h, 14);
    wobblyRoundRect(ctx, r.x, r.y, r.w, r.h, 8, seed, seed + 3, 2.2);
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }

  /**
   * 边界墙：世界四周的排线墙带（带视口裁剪，只画可见带）。
   * 与内部墙一致的蜡笔排线视觉：灰色涂抹底 + 斜线排线 hatching + 深色抖动描边，
   * 一眼可读"这是墙不能碰"；撞界判定不变（逻辑仍在 walls.hitsCircle）。
   */
  function drawBoundary(ctx, walls, cam, vw, vh) {
    var T = cfg.WALL_THICK;
    var bands = [
      { x: -T, y: -T, w: walls.W + 2 * T, h: T },  // 上
      { x: -T, y: walls.H, w: walls.W + 2 * T, h: T }, // 下
      { x: -T, y: 0, w: T, h: walls.H },           // 左
      { x: walls.W, y: 0, w: T, h: walls.H }       // 右
    ];
    for (var i = 0; i < 4; i++) {
      var b = bands[i];
      if (b.x + b.w < cam.x || b.x > cam.x + vw || b.y + b.h < cam.y || b.y > cam.y + vh) continue;
      wobblyRoundRect(ctx, b.x, b.y, b.w, b.h, 10, 3 + i * 7, 9 + i * 5, 2.4);
      ctx.fillStyle = '#9A948A';   // 比内部墙更深的灰，明显区别于压暗背景
      ctx.fill();
      hatchClip(ctx, b.x, b.y, b.w, b.h, 9); // 排线更密
      wobblyRoundRect(ctx, b.x, b.y, b.w, b.h, 10, 3 + i * 7, 9 + i * 5, 2.4);
      ctx.strokeStyle = cfg.INK;
      ctx.lineWidth = 3.4;          // 更粗深色描边
      ctx.stroke();
    }
    // 世界内边缘：一道明显粗黑线，明确「可玩范围界线、碰即死」
    wobblyRoundRect(ctx, 0, 0, walls.W, walls.H, 6, 5, 5, 3.0);
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 3.4;
    ctx.stroke();
  }

  /** 万能色蛇节：白底蜡笔块 + 彩色描边 + 中心手绘星标（一眼可辨「万能、通配任何色」） */
  function drawWildSeg(ctx, px, py, size, seedX, seedY) {
    var r = size * 0.30;
    wobblyRoundRect(ctx, 0, 0, size, size, r, seedX, seedY, 1.1);
    ctx.fillStyle = '#FFFDF5';
    ctx.fill();
    crayonStrokes(ctx, 0, 0, size, size, seedX, seedY);
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = cfg.SEG_STROKE;
    ctx.stroke();
    ctx.save();
    ctx.translate(0.8, -0.6);
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = Math.max(0.8, cfg.SEG_STROKE * 0.55);
    ctx.stroke();
    ctx.restore();
    // 四角彩色小点（暗示「可匹配任意颜色」）
    var cols = ['#E8552F', '#4A7FD4', '#6FBF4A', '#F5A623'];
    for (var c = 0; c < 4; c++) {
      ctx.beginPath();
      ctx.arc(size * (0.3 + 0.4 * (c % 2)), size * (0.3 + 0.4 * (c < 2 ? 0 : 1)), size * 0.07, 0, Math.PI * 2);
      ctx.fillStyle = cols[c];
      ctx.fill();
    }
    starPath(ctx, size / 2, size / 2, size * 0.20, 0.3);
    ctx.fillStyle = '#FFD94A';
    ctx.fill();
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  /**
   * 特殊道具绘制（地图上的万能色/炸弹/减速）。普通色块由 drawCrayonBlock 处理。
   * @param {string} kind 'wild' | 'bomb' | 'slow'
   */
  function drawItemBlock(ctx, b, cx, cy, size, seedX, seedY, rot, pulse) {
    if (b.kind === 'wild') {
      // 万能色：白底圆块 + 星标 + 彩色环，明显区别于普通色块
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(pulse, pulse);
      drawCrayonBlock(ctx, -size / 2, -size / 2, size, '#FFFDF5', seedX, seedY, { rot: rot, wobble: 1.0, stroke: cfg.SEG_STROKE });
      var cols = ['#E8552F', '#4A7FD4', '#6FBF4A', '#F5A623'];
      for (var c = 0; c < 4; c++) {
        ctx.beginPath();
        ctx.arc(Math.cos(c * Math.PI / 2) * size * 0.34, Math.sin(c * Math.PI / 2) * size * 0.34, size * 0.10, 0, Math.PI * 2);
        ctx.fillStyle = cols[c];
        ctx.fill();
        ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1; ctx.stroke();
      }
      starPath(ctx, 0, 0, size * 0.26, 0.3);
      ctx.fillStyle = '#FFD94A'; ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1.3; ctx.stroke();
      ctx.restore();
    } else if (b.kind === 'bomb') {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(pulse, pulse);
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = '#3A3238';
      ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 2; ctx.stroke();
      // 引线火光
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.42);
      ctx.quadraticCurveTo(size * 0.18, -size * 0.62, size * 0.06, -size * 0.72);
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.beginPath(); ctx.arc(size * 0.06, -size * 0.72, size * 0.09, 0, Math.PI * 2);
      ctx.fillStyle = '#F5A623'; ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
    } else if (b.kind === 'slow') {
      // 减速：蓝绿圆 + 时钟指针
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(pulse, pulse);
      ctx.beginPath(); ctx.arc(0, 0, size * 0.44, 0, Math.PI * 2);
      ctx.fillStyle = '#2EC4B6'; ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -size * 0.26);
      ctx.moveTo(0, 0); ctx.lineTo(size * 0.20, size * 0.06);
      ctx.strokeStyle = '#FFFDF5'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * 尾巴节（v2.3+）：不可消除的尾巴节，一眼可辨「消不掉」。
   * 重做版：主体为深色圆润圆角蜡笔块（与颜色节统一风格，不突兀），
   * 朝外方向再叠一个小小的圆润尾尖（深色小半圆），整体可爱、不像尖三角。
   * @param {number} dx,dy 尾巴朝向单位向量（指向蛇尾外侧）
   */
  function drawTail(ctx, cx, cy, dx, dy, size, seedX, seedY) {
    var jx = (u.hash2(seedX, seedY, 60) - 0.5) * 2.0;
    var jy = (u.hash2(seedY, seedX, 70) - 0.5) * 2.0;
    // 主体：深色圆润圆角块（与颜色节同风格）
    drawCrayonBlock(ctx, cx - size / 2 + jx, cy - size / 2 + jy, size, cfg.TAIL_COLOR, seedX, seedY, {
      rot: (u.hash2(seedX, seedY, 3) - 0.5) * 0.4, wobble: 1.0
    });
    // 朝外小圆润尾尖（短、圆，不突兀）
    var tipX = cx + dx * size * 0.5, tipY = cy + dy * size * 0.5;
    ctx.beginPath();
    ctx.arc(tipX, tipY, size * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = cfg.TAIL_COLOR;
    ctx.fill();
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  /** 蛇头眼睛（朝向跟随移动方向 dir 单位向量） */
  function drawEyes(ctx, cx, cy, size, dir) {
    var fx = dir.x * size * 0.16, fy = dir.y * size * 0.16;  // 整体朝前移
    var pxp = -dir.y, pyp = dir.x;                            // 垂直方向
    var sep = size * 0.2, r = size * 0.13;
    for (var s = -1; s <= 1; s += 2) {
      var ex = cx + fx + pxp * sep * s;
      var ey = cy + fy + pyp * sep * s;
      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFDF5';
      ctx.fill();
      ctx.strokeStyle = cfg.INK;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex + dir.x * r * 0.45, ey + dir.y * r * 0.45, r * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = cfg.INK;
      ctx.fill();
    }
  }

  /** 五角星路径 */
  function starPath(ctx, cx, cy, r, rot) {
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var rr = i % 2 === 0 ? r : r * 0.45;
      var a = rot + i * Math.PI / 5 - Math.PI / 2;
      var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** 冠军皇冠涂鸦（多人结算第 1 名标题用）：三折尖顶 + 尖顶圆珠 */
  function drawCrown(ctx, cx, cy, w, h) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy + h / 2);
    ctx.lineTo(cx - w / 2, cy - h * 0.15);
    ctx.lineTo(cx - w * 0.22, cy + h * 0.12);
    ctx.lineTo(cx, cy - h / 2);
    ctx.lineTo(cx + w * 0.22, cy + h * 0.12);
    ctx.lineTo(cx + w / 2, cy - h * 0.15);
    ctx.lineTo(cx + w / 2, cy + h / 2);
    ctx.closePath();
    ctx.fillStyle = '#FFD94A';
    ctx.fill();
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 2.2;
    ctx.stroke();
    var tips = [[cx - w / 2, cy - h * 0.15], [cx, cy - h / 2], [cx + w / 2, cy - h * 0.15]];
    for (var i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(tips[i][0], tips[i][1] - 3, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFDF5';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 多人结算统计行的手绘小图标（纯 canvas 涂鸦，不用外部图）。
   * @param {string} kind medal/clock/star/spark/block/burst/snake
   * @param {number} s 图标外接尺寸（px）
   */
  function drawStatIcon(ctx, kind, cx, cy, s) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = cfg.INK;
    if (kind === 'medal') {            // 排名：绶带 + 圆牌奖章
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.26, cy - s * 0.5);
      ctx.lineTo(cx, cy - s * 0.08);
      ctx.lineTo(cx + s * 0.26, cy - s * 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy + s * 0.16, s * 0.36, 0, Math.PI * 2);
      ctx.fillStyle = '#FFD94A';
      ctx.fill();
      ctx.stroke();
      starPath(ctx, cx, cy + s * 0.16, s * 0.16, 0.3);
      ctx.fillStyle = '#C47F17';
      ctx.fill();
    } else if (kind === 'clock') {     // 存活时间 / 时间分：小闹钟
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFDF5';
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - s * 0.24);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + s * 0.18, cy + s * 0.08);
      ctx.stroke();
    } else if (kind === 'star') {      // 总分：大星星
      starPath(ctx, cx, cy, s * 0.48, 0.2);
      ctx.fillStyle = '#FFD94A';
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'spark') {     // 消除分：四角闪光
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.5);
      ctx.quadraticCurveTo(cx, cy, cx + s * 0.5, cy);
      ctx.quadraticCurveTo(cx, cy, cx, cy + s * 0.5);
      ctx.quadraticCurveTo(cx, cy, cx - s * 0.5, cy);
      ctx.quadraticCurveTo(cx, cy, cx, cy - s * 0.5);
      ctx.fillStyle = cfg.COLORS.purple;
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'block') {     // 累计消除方块：蜡笔小方块
      drawCrayonBlock(ctx, cx - s * 0.4, cy - s * 0.4, s * 0.8, cfg.COLORS.teal, 61, 13, { wobble: 0.8 });
    } else if (kind === 'burst') {     // 击杀数：爆炸尖角
      ctx.beginPath();
      for (var i = 0; i < 8; i++) {
        var a = i * Math.PI / 4 - Math.PI / 2;
        var rr = i % 2 === 0 ? s * 0.5 : s * 0.22;
        var px2 = cx + Math.cos(a) * rr, py2 = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
      }
      ctx.closePath();
      ctx.fillStyle = cfg.COLORS.red;
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'snake') {     // 最终节数：小蛇波浪线 + 头点
      ctx.strokeStyle = cfg.COLORS.green;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.45, cy + s * 0.15);
      ctx.quadraticCurveTo(cx - s * 0.2, cy - s * 0.35, cx + s * 0.05, cy + s * 0.1);
      ctx.quadraticCurveTo(cx + s * 0.25, cy + s * 0.4, cx + s * 0.4, cy - s * 0.05);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + s * 0.42, cy - s * 0.08, s * 0.15, 0, Math.PI * 2);
      ctx.fillStyle = cfg.COLORS.green;
      ctx.fill();
      ctx.strokeStyle = cfg.INK;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  function Renderer(ctx, screenW, screenH) {
    this.ctx = ctx;
    this.W = screenW;
    this.H = screenH;
  }

  Renderer.prototype.resize = function (w, h) {
    this.W = w;
    this.H = h;
  };

  Renderer.prototype.drawBackground = function () {
    var ctx = this.ctx;
    ctx.fillStyle = cfg.PAPER;
    ctx.fillRect(0, 0, this.W, this.H);
    var tile = getNoiseTile();
    if (tile) {
      for (var x = 0; x < this.W; x += 160) {
        for (var y = 0; y < this.H; y += 160) ctx.drawImage(tile, x, y);
      }
    }
  };

  // ---------------- 对局场景（相机视口区） ----------------

  Renderer.prototype.drawPlay = function (game) {
    var ctx = this.ctx, l = game.layout();
    var walls = game.walls, snake = game.snake, spawner = game.spawner;
    var cam = game.camera;
    var vw = l.areaW, vh = this.H;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, vw, vh);
    ctx.clip();                       // 世界内容裁剪在视口区
    ctx.translate(-cam.x, -cam.y);    // 相机变换

    // 世界外区域压暗（衬托可玩范围）
    var M = Math.max(vw, vh) + 80;
    ctx.fillStyle = 'rgba(58,50,56,0.10)';
    ctx.fillRect(-M, -M, walls.W + 2 * M, M);
    ctx.fillRect(-M, walls.H, walls.W + 2 * M, M);
    ctx.fillRect(-M, 0, M, walls.H);
    ctx.fillRect(walls.W, 0, M, walls.H);

    // 视口内的淡墨点阵（运动参照物，帮助感知移动）
    ctx.fillStyle = 'rgba(58,50,56,0.10)';
    var step = 140;
    var x0 = Math.max(0, Math.floor(cam.x / step) * step);
    var y0 = Math.max(0, Math.floor(cam.y / step) * step);
    var x1 = Math.min(walls.W, cam.x + vw);
    var y1 = Math.min(walls.H, cam.y + vh);
    for (var gx = x0; gx <= x1; gx += step) {
      for (var gy = y0; gy <= y1; gy += step) {
        ctx.beginPath();
        ctx.arc(gx, gy, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 边界墙 + 内部墙
    drawBoundary(ctx, walls, cam, vw, vh);
    for (var i = 0; i < walls.rects.length; i++) {
      var r = walls.rects[i];
      if (r.x + r.w < cam.x - 20 || r.x > cam.x + vw + 20 ||
          r.y + r.h < cam.y - 20 || r.y > cam.y + vh + 20) continue; // 视口裁剪
      drawWallRect(ctx, r, i + 11);
    }

    // 道具：普通色块 + 特殊道具（万能色/炸弹/减速）；略小、旋转 + 脉动
    var bs = cfg.BLOCK_RADIUS * 2;
    for (i = 0; i < spawner.blocks.length; i++) {
      var b = spawner.blocks[i];
      if (b.x < cam.x - 40 || b.x > cam.x + vw + 40 || b.y < cam.y - 40 || b.y > cam.y + vh + 40) continue;
      var pulse = 1 + 0.09 * Math.sin(game.timeMs / 280 + b.phase);
      var seedX = Math.round(b.x / 10), seedY = Math.round(b.y / 10);
      if (b.kind && b.kind !== 'color') {
        drawItemBlock(ctx, b, b.x, b.y, bs, seedX, seedY, (u.hash2(seedX, seedY, 7) - 0.5) * 0.55, pulse);
      } else {
        drawCrayonBlock(ctx, b.x - bs / 2, b.y - bs / 2, bs, cfg.COLORS[b.color], seedX, seedY, {
          rot: (u.hash2(seedX, seedY, 7) - 0.5) * 0.55,
          scale: pulse,
          wobble: 1.0
        });
      }
    }

    // 蛇：从尾画到头，头在最上层；节为圆形蜡笔块沿轨迹排布
    // 节间距 SEG_SPACING ≥ 直径+间隙，描边 SEG_STROKE 加粗加深——相邻节一眼可辨、可逐个数清
    // 多人对战：被咬的蛇附带 MP_BITE_FLASH_MS 毫秒的闪白 + 抖动反馈
    var playerFlash = 0;
    if (game.mode === 'multi' && game.mp && game.mp.playerEntry) {
      playerFlash = Math.max(0, game.mp.playerEntry.bittenUntil - game.mp.timeMs);
    }
    this.drawSnakeBody(snake, cam, vw, vh, 200, playerFlash);
    // 多人对战：AI 蛇（同一套蜡笔渲染）+ 头顶昵称标签
    if (game.mode === 'multi' && game.mp) {
      var bots = game.mp.bots;
      for (i = 0; i < bots.length; i++) {
        if (!bots[i].alive) continue;
        var botFlash = Math.max(0, bots[i].bittenUntil - game.mp.timeMs);
        this.drawSnakeBody(bots[i].snake, cam, vw, vh, 200 + bots[i].id * 131, botFlash);
      }
      this.drawNameLabels(game, cam, vw, vh);
    }

    // 粒子（世界坐标，随相机）
    this.drawParticles(game);

    ctx.restore();
  };

  /**
   * 画一条蛇的身体（玩家/AI 共用）：seedBase 区分不同蛇的手绘抖动种子。
   * segPos 比 colors 多 1 节：末尾恒为尾巴节（v2.3），画成深色蜡笔小尾鳍，
   * 一眼可辨"这节消不掉"；尾巴节不做闪白覆盖（不可被咬），但随全蛇一起抖动。
   * @param {number} flashMs 被咬反馈剩余毫秒（>0 时全节闪白 + 抖动，幅度随剩余时间衰减）
   */
  Renderer.prototype.drawSnakeBody = function (snake, cam, vw, vh, seedBase, flashMs) {
    var ctx = this.ctx;
    var ss = cfg.SEG_RADIUS * 2;
    var n = snake.segPos.length; // = colors.length + 1（末尾为尾巴节）
    var shake = flashMs > 0 ? Math.min(1, flashMs / cfg.MP_BITE_FLASH_MS) : 0;
    var tb = Math.floor((flashMs || 0) / 45); // 抖动时间桶：每 45ms 换一组确定性偏移
    for (var i = n - 1; i >= 0; i--) {
      var p = snake.segPos[i];
      var ox2 = 0, oy2 = 0;
      if (shake > 0) { // 被咬抖动（种子含时间桶，画面抖动但不随机闪烁）
        ox2 = (u.hash2(i + seedBase, tb, 91) - 0.5) * 7 * shake;
        oy2 = (u.hash2(tb, i + seedBase, 92) - 0.5) * 7 * shake;
      }
      var px = p.x + ox2, py = p.y + oy2;
      if (px < cam.x - 60 || px > cam.x + vw + 60 || py < cam.y - 60 || py > cam.y + vh + 60) continue;
      if (snake.colors[i] === 'wild') { // 万能色节：白底星标块（消除时通配任意相邻同色）
        ctx.save();
        ctx.translate(px - ss / 2, py - ss / 2);
        drawWildSeg(ctx, 0, 0, ss, seedBase + i, 41);
        ctx.restore();
        if (shake > 0) {
          ctx.save();
          ctx.globalAlpha = 0.6 * shake;
          ctx.save();
          ctx.translate(px - ss / 2, py - ss / 2);
          drawWildSeg(ctx, 0, 0, ss, seedBase + i, 41);
          ctx.restore();
          ctx.restore();
        }
        if (i === 0) drawEyes(ctx, px, py, ss, snake.headDir());
        continue;
      }
      if (i >= snake.colors.length) { // 尾巴节：深色圆润圆块 + 小尾尖，朝向 = 前一节 → 尾巴节
        var prev = snake.segPos[i - 1] ||
          { x: p.x - Math.cos(snake.angle) * cfg.SEG_SPACING, y: p.y - Math.sin(snake.angle) * cfg.SEG_SPACING };
        var tdx = p.x - prev.x, tdy = p.y - prev.y;
        var tl = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
        drawTail(ctx, px, py, tdx / tl, tdy / tl, ss, seedBase + i, 43);
        continue;
      }
      var rot = (u.hash2(i, 77, 3) - 0.5) * 0.5;
      var wob = i === 0 ? 0.8 : 1.2;
      drawCrayonBlock(ctx, px - ss / 2, py - ss / 2, ss, cfg.COLORS[snake.colors[i]], seedBase + i, 41, {
        rot: rot, wobble: wob, stroke: cfg.SEG_STROKE
      });
      if (shake > 0) { // 闪白覆盖（纸白蜡笔块，透明度随剩余时间衰减）
        ctx.save();
        ctx.globalAlpha = 0.6 * shake;
        drawCrayonBlock(ctx, px - ss / 2, py - ss / 2, ss, '#FFFDF5', seedBase + i, 41, {
          rot: rot, wobble: wob, stroke: cfg.SEG_STROKE
        });
        ctx.restore();
      }
      if (i === 0) drawEyes(ctx, px, py, ss, snake.headDir());
    }
  };

  /** 多人对战：头顶昵称小手绘标签（深色描边文字，无底板；玩家标签为「我」，蜡笔黄） */
  Renderer.prototype.drawNameLabels = function (game, cam, vw, vh) {
    var ctx = this.ctx;
    var es = game.mp.allEntries();
    ctx.save();
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (!e.alive) continue;
      var hx = e.snake.x, hy = e.snake.y - cfg.SEG_RADIUS - 8;
      if (hx < cam.x - 40 || hx > cam.x + vw + 40 || hy < cam.y - 40 || hy > cam.y + vh + 40) continue;
      ctx.lineWidth = 3;
      ctx.strokeStyle = cfg.INK;
      ctx.strokeText(e.name, hx, hy);
      ctx.fillStyle = e.isPlayer ? '#FFD94A' : '#FFFDF5';
      ctx.fillText(e.name, hx, hy);
    }
    ctx.restore();
  };

  // ---------------- 粒子 ----------------

  Renderer.prototype.drawParticles = function (game) {
    var ctx = this.ctx;
    for (var i = 0; i < game.particles.list.length; i++) {
      var p = game.particles.list[i];
      var t = p.life / p.maxLife; // 1 → 0
      if (p.type === 'crumb') {
        ctx.save();
        ctx.globalAlpha = Math.min(1, t * 1.6);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.strokeStyle = cfg.INK;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.restore();
      } else if (p.type === 'star') {
        var prog = 1 - t;
        var sc = p.scale || 1; // 连锁逐级放大
        ctx.save();
        ctx.globalAlpha = t;
        starPath(ctx, p.x, p.y, (8 + prog * 34) * sc, prog * 0.6);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = cfg.INK;
        ctx.lineWidth = 1.6 * Math.min(sc, 1.6);
        ctx.stroke();
        ctx.restore();
      } else if (p.type === 'text') {
        // 连锁文字：手绘风「N连锁！」，深色描边 + 蜡笔黄填充，上飘淡出
        ctx.save();
        ctx.globalAlpha = Math.min(1, t * 2.2); // 短暂停留，末尾淡出
        ctx.font = 'bold ' + Math.round(p.size) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(3, p.size * 0.16);
        ctx.strokeStyle = cfg.INK;
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = '#FFD94A';
        ctx.fillText(p.text, p.x, p.y);
        ctx.restore();
      }
    }
  };

  // ---------------- 小地图 ----------------

  /** HUD 内小地图：世界边界、墙、色块、视口框、蛇头亮点 */
  Renderer.prototype.drawMinimap = function (game, mx, my, mw) {
    var ctx = this.ctx, walls = game.walls;
    var scale = mw / walls.W;
    var mh = walls.H * scale;

    // 底
    wobblyRoundRect(ctx, mx, my, mw, mh, 4, 17, 29, 1.0);
    ctx.fillStyle = '#F3ECDD';
    ctx.fill();
    ctx.save();
    ctx.clip();

    // 边界墙带（与世界内一致的排线墙样式：灰底 + 斜线排线 + 细描边）
    var bt = Math.max(2.5, cfg.WALL_THICK * scale);
    var strips = [
      { x: mx, y: my, w: mw, h: bt },            // 上
      { x: mx, y: my + mh - bt, w: mw, h: bt },  // 下
      { x: mx, y: my, w: bt, h: mh },            // 左
      { x: mx + mw - bt, y: my, w: bt, h: mh }   // 右
    ];
    for (i = 0; i < 4; i++) {
      var st = strips[i];
      ctx.fillStyle = cfg.WALL_FILL;
      ctx.fillRect(st.x, st.y, st.w, st.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(st.x, st.y, st.w, st.h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(58,50,56,0.45)';
      ctx.lineWidth = 0.7;
      for (var d = -st.h; d < st.w + st.h; d += 4) {
        ctx.beginPath();
        ctx.moveTo(st.x + d, st.y + st.h + 1);
        ctx.lineTo(st.x + d + st.h + 2, st.y - 1);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = cfg.INK;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(st.x, st.y, st.w, st.h);
    }

    // 内部墙
    ctx.fillStyle = 'rgba(58,50,56,0.5)';
    for (var i = 0; i < walls.rects.length; i++) {
      var r = walls.rects[i];
      ctx.fillRect(mx + r.x * scale, my + r.y * scale, Math.max(1.5, r.w * scale), Math.max(1.5, r.h * scale));
    }
    // 色块
    for (i = 0; i < game.spawner.blocks.length; i++) {
      var b = game.spawner.blocks[i];
      ctx.fillStyle = cfg.COLORS[b.color];
      ctx.fillRect(mx + b.x * scale - 1, my + b.y * scale - 1, 2.5, 2.5);
    }
    // 视口框
    var l = game.layout();
    ctx.strokeStyle = 'rgba(58,50,56,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx + game.camera.x * scale, my + game.camera.y * scale,
      l.areaW * scale, this.H * scale);
    // 多人对战：AI 蛇亮点（各自头部颜色小点），画在玩家亮点下层
    if (game.mode === 'multi' && game.mp) {
      var bots = game.mp.bots;
      for (var bi = 0; bi < bots.length; bi++) {
        if (!bots[bi].alive) continue;
        var bsn = bots[bi].snake;
        ctx.beginPath();
        ctx.arc(mx + bsn.x * scale, my + bsn.y * scale, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = cfg.COLORS[bsn.headColor()] || '#8A8278';
        ctx.fill();
      }
    }
    // 蛇头亮点（描边高光点，大地图里一眼定位）
    var hx = mx + game.snake.x * scale, hy = my + game.snake.y * scale;
    ctx.beginPath();
    ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#FFD94A';
    ctx.fill();
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // 外框
    wobblyRoundRect(ctx, mx, my, mw, mh, 4, 17, 29, 1.0);
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    return mh;
  };

  // ---------------- 右侧 HUD 面板 ----------------

  Renderer.prototype.drawPanel = function (game) {
    var ctx = this.ctx, l = game.layout();
    var px = l.panelX, pw = l.panelW, H = this.H;
    var cx = px + pw / 2;

    ctx.save();
    // 面板底：略亮纸色 + 左侧手绘分隔线
    ctx.fillStyle = 'rgba(255,253,245,0.72)';
    ctx.fillRect(px, 0, pw, H);
    ctx.strokeStyle = 'rgba(58,50,56,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    var seg = 10;
    for (var i = 0; i <= seg; i++) {
      var ly = H * i / seg;
      var lx = px + (u.hash2(i, 7, 3) - 0.5) * 5;
      if (i === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
    }
    ctx.stroke();

    ctx.fillStyle = cfg.INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 标题
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('蜡笔贪吃蛇', cx, 24);

    // 模式 / 关卡号
    ctx.font = '12px sans-serif';
    ctx.globalAlpha = 0.75;
    var modeText = game.mode === 'level' ? ('闯关模式 · 第 ' + game.levelCfg.level + ' 关')
      : (game.mode === 'multi' ? '多人对战 · 7 蛇同场' : '无尽模式');
    ctx.fillText(modeText, cx, 46);
    ctx.globalAlpha = 1;

    // 分数
    ctx.font = '11px sans-serif';
    ctx.globalAlpha = 0.6;
    ctx.fillText('分数', cx, 74);
    ctx.globalAlpha = 1;
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(String(game.score), cx, 100);

    // 目标 / 最高分 + 进度条
    ctx.font = 'bold 13px sans-serif';
    if (game.mode === 'level') {
      ctx.fillText('目标 ' + game.levelCfg.targetScore, cx, 126);
      var barW = pw - 44, barH = 9, bx = cx - barW / 2, by = 136;
      var prog = u.clamp(game.score / game.levelCfg.targetScore, 0, 1);
      wobblyRoundRect(ctx, bx, by, barW, barH, 4, 9, 3, 0.8);
      ctx.fillStyle = 'rgba(58,50,56,0.12)';
      ctx.fill();
      if (prog > 0.02) {
        wobblyRoundRect(ctx, bx, by, Math.max(8, barW * prog), barH, 4, 9, 3, 0.8);
        ctx.fillStyle = cfg.COLORS.green;
        ctx.fill();
      }
      wobblyRoundRect(ctx, bx, by, barW, barH, 4, 9, 3, 0.8);
      ctx.strokeStyle = cfg.INK;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    } else if (game.mode === 'multi') {
      ctx.fillText('最佳 ' + Math.max(game.mpBest.len, game.snake.length()) + '节 · ' +
        Math.max(game.mpBest.score, game.score) + '分', cx, 126);
    } else {
      ctx.fillText('最高 ' + Math.max(game.best, game.score), cx, 126);
    }

    // 分数构成
    ctx.font = '10px sans-serif';
    ctx.globalAlpha = 0.6;
    ctx.fillText('存活 ' + game.survivalScore + ' · 消除 ' + game.elimScore, cx, 160);
    // 当前速度（动态加速可视化：随长度/时间提升，吃减速道具时回落）
    var spd = Math.round(game.currentSpeed());
    var slow = (game.slowUntil && game.timeMs < game.slowUntil);
    ctx.fillStyle = slow ? '#2EC4B6' : cfg.INK;
    ctx.fillText('速度 ' + spd + (slow ? ' (减速)' : '') + ' px/s', cx, 176);
    ctx.fillStyle = cfg.INK;
    ctx.globalAlpha = 1;

    // 多人对战：实时排行榜（按当前节数降序，玩家高亮加粗）
    var yOff = 0;
    if (game.mode === 'multi' && game.mp) {
      var lb = game.mp.leaderboard();
      ctx.font = '11px sans-serif';
      ctx.globalAlpha = 0.6;
      ctx.fillText('排行榜', cx, 180);
      ctx.globalAlpha = 1;
      var rowH = 16, ly = 194;
      for (var li = 0; li < lb.length; li++) {
        var rowY = ly + li * rowH;
        var row = lb[li];
        ctx.globalAlpha = row.isPlayer ? 1 : 0.8;
        ctx.fillStyle = row.isPlayer ? '#C47F17' : cfg.INK;
        ctx.font = (row.isPlayer ? 'bold ' : '') + '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText((li + 1) + '. ' + row.name, px + 16, rowY);
        ctx.textAlign = 'right';
        ctx.fillText(row.length + '节', px + pw - 16, rowY);
        ctx.textAlign = 'center';
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = cfg.INK;
      yOff = 30 + lb.length * rowH; // 排行榜占用的纵向高度，后续板块整体下移
    }

    // 已解锁颜色预览（4 列 x 2 行，未解锁灰色带叉）
    ctx.font = '11px sans-serif';
    ctx.globalAlpha = 0.6;
    ctx.fillText('已解锁颜色', cx, 186 + yOff);
    ctx.globalAlpha = 1;
    var sw = 20, gap = 7, cols = 4;
    var gridW = cols * sw + (cols - 1) * gap;
    var sx = cx - gridW / 2, sy = 196 + yOff;
    for (i = 0; i < cfg.MAX_COLORS; i++) {
      var col = i % cols, row = Math.floor(i / cols);
      var bx2 = sx + col * (sw + gap), by2 = sy + row * (sw + gap);
      if (i < game.unlockedCount) {
        drawCrayonBlock(ctx, bx2, by2, sw, cfg.COLORS[cfg.COLOR_KEYS[i]], 30 + i, 4, {
          rot: (u.hash2(i, 5, 2) - 0.5) * 0.3, wobble: 0.9
        });
      } else {
        ctx.save();
        ctx.globalAlpha = 0.45;
        wobblyRoundRect(ctx, bx2, by2, sw, sw, sw * 0.28, 30 + i, 4, 0.9);
        ctx.fillStyle = '#CFC8BC';
        ctx.fill();
        ctx.strokeStyle = cfg.INK;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath(); // 锁定叉号
        ctx.moveTo(bx2 + sw * 0.3, by2 + sw * 0.3);
        ctx.lineTo(bx2 + sw * 0.7, by2 + sw * 0.7);
        ctx.moveTo(bx2 + sw * 0.7, by2 + sw * 0.3);
        ctx.lineTo(bx2 + sw * 0.3, by2 + sw * 0.7);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 小地图
    var mapTop = sy + 2 * (sw + gap) + 18;
    ctx.font = '11px sans-serif';
    ctx.globalAlpha = 0.6;
    ctx.fillText('小地图', cx, mapTop);
    ctx.globalAlpha = 1;
    var mh = this.drawMinimap(game, px + 14, mapTop + 10, pw - 28);

    // 底部操作提示（空间不足时省略，多人模式面板较长）
    if (mapTop + 10 + mh < H - 60) {
      ctx.font = '11px sans-serif';
      ctx.globalAlpha = 0.55;
      ctx.fillText('方向键 / WASD 转向', cx, H - 44);
      ctx.fillText('或按住左下摇杆拖动', cx, H - 26);
    }
    ctx.restore();
  };

  // ---------------- 摇杆（固定底座，视口区左下角） ----------------

  Renderer.prototype.drawJoystick = function (game) {
    var j = game.joystick;
    var ctx = this.ctx;
    ctx.save();
    if (!j.active) {
      // 未激活：淡淡的提示圆盘
      ctx.globalAlpha = 0.28;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = cfg.INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(j.baseX, j.baseY, j.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = cfg.INK;
      ctx.fillText('摇杆', j.baseX, j.baseY);
      ctx.restore();
      return;
    }
    ctx.globalAlpha = 0.55;
    // 底盘
    ctx.beginPath();
    ctx.arc(j.baseX, j.baseY, j.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,253,245,0.6)';
    ctx.fill();
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // 摇杆头
    ctx.beginPath();
    ctx.arc(j.knobX, j.knobY, 20, 0, Math.PI * 2);
    ctx.fillStyle = cfg.PANEL;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  // ---------------- 界面（菜单 / 选关 / 结算） ----------------

  Renderer.prototype.drawButton = function (b) {
    var ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = b.enabled ? 1 : 0.35;
    wobblyRoundRect(ctx, b.x, b.y, b.w, b.h, 12, Math.round(b.x), Math.round(b.y), 1.6);
    ctx.fillStyle = cfg.PANEL;
    ctx.fill();
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.save();
    ctx.translate(1, -0.8);
    ctx.globalAlpha *= 0.3;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = cfg.INK;
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    ctx.restore();
  };

  Renderer.prototype.drawOverlay = function (alpha) {
    var ctx = this.ctx;
    ctx.fillStyle = 'rgba(251,246,233,' + (alpha === undefined ? 0.94 : alpha) + ')';
    ctx.fillRect(0, 0, this.W, this.H);
  };

  Renderer.prototype.drawMenu = function (game) {
    var ctx = this.ctx;
    this.drawOverlay(0.0); // 主菜单直接用纸面
    ctx.save();
    ctx.fillStyle = cfg.INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText('蜡笔贪吃蛇', this.W / 2, this.H * 0.24);
    // 标题下画四个小色块做装饰
    var s = 18, total = s * 4 + 12 * 3;
    for (var i = 0; i < 4; i++) {
      drawCrayonBlock(ctx, this.W / 2 - total / 2 + i * (s + 12), this.H * 0.24 + 38, s,
        cfg.COLORS[cfg.COLOR_KEYS[i]], 100 + i, 7, { rot: (u.hash2(i, 3, 5) - 0.5) * 0.5 });
    }
    ctx.font = '15px sans-serif';
    ctx.fillText('自由游动 · 吃色补头 · 四连消除 · 别撞墙', this.W / 2, this.H * 0.40);
    ctx.font = '13px sans-serif';
    ctx.globalAlpha = 0.7;
    ctx.fillText('无尽模式最高分：' + game.best + '    已解锁关卡：' + game.unlocked + ' / 10', this.W / 2, this.H * 0.84);
    ctx.fillText('多人对战最佳：最长 ' + game.mpBest.len + ' 节 · 最高 ' + game.mpBest.score + ' 分', this.W / 2, this.H * 0.84 + 24);
    ctx.restore();
    this.drawButtons(game);
  };

  Renderer.prototype.drawLevels = function (game) {
    var ctx = this.ctx;
    this.drawOverlay(0.0);
    ctx.save();
    ctx.fillStyle = cfg.INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('选择关卡', this.W / 2, this.H * 0.22);
    ctx.font = '13px sans-serif';
    ctx.globalAlpha = 0.65;
    ctx.fillText('通关可解锁后续关卡，每 2 关解锁 1 种新颜色', this.W / 2, this.H * 0.22 + 34);
    ctx.restore();
    this.drawButtons(game);
  };

  Renderer.prototype.drawResult = function (game, isClear) {
    var ctx = this.ctx;
    this.drawOverlay(0.9);
    ctx.save();
    ctx.fillStyle = cfg.INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 32px sans-serif';
    ctx.fillText(isClear ? '过关！' : '游戏结束', this.W / 2, this.H * 0.30);
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('得分 ' + game.score, this.W / 2, this.H * 0.39);
    ctx.font = '14px sans-serif';
    ctx.globalAlpha = 0.75;
    if (isClear) {
      ctx.fillText('存活 ' + game.survivalScore + ' 分 + 消除 ' + game.elimScore + ' 分', this.W / 2, this.H * 0.45);
    } else if (game.mode === 'endless') {
      ctx.fillText('历史最高 ' + game.best + ' 分', this.W / 2, this.H * 0.45);
    } else {
      ctx.fillText('目标分数 ' + game.levelCfg.targetScore + '，再接再厉', this.W / 2, this.H * 0.45);
    }
    ctx.restore();
    this.drawButtons(game);
  };

  Renderer.prototype.drawButtons = function (game) {
    for (var i = 0; i < game.uiButtons.length; i++) this.drawButton(game.uiButtons[i]);
  };

  // ---------------- 多人对战结算（手绘风卡片 + 逐行统计，v2.2） ----------------

  /**
   * 手绘风结算按钮：主按钮（再来一局）蜡笔黄填充 + 加粗描边，副按钮纸色。
   * @param {number} alpha 淡入透明度（结算动画用）
   */
  Renderer.prototype.drawDoodleButton = function (b, primary, alpha) {
    var ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = (b.enabled ? 1 : 0.35) * (alpha === undefined ? 1 : alpha);
    wobblyRoundRect(ctx, b.x, b.y, b.w, b.h, 14, Math.round(b.x), Math.round(b.y), 2.0);
    ctx.fillStyle = primary ? '#FFD94A' : cfg.PANEL;
    ctx.fill();
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = primary ? 3.2 : 2.4;
    ctx.stroke();
    ctx.save(); // 第二遍错位描边（手绘"描了两次"感）
    ctx.translate(1.4, -1);
    ctx.globalAlpha *= 0.3;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = cfg.INK;
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    ctx.restore();
  };

  /**
   * 多人对战结算界面：手绘风卡片底板（抖动描边圆角 + 纸张噪点），
   * 标题按名次变化（第 1 名「冠军！」+ 皇冠/星星涂鸦，2~3 名「很棒！」，其余「再接再厉」），
   * 统计每行一项（左侧涂鸦小图标 + 标签 + 右侧醒目数值），
   * 动画：卡片 280ms 淡入上移，各行依次延迟 ~80ms 从左侧滑入，按钮最后淡入。
   */
  Renderer.prototype.drawMultiResult = function (game) {
    var ctx = this.ctx, r = game.mpResult;
    var W = this.W, H = this.H;
    var t = Math.max(0, game.timeMs - (game.overAt || 0));
    this.drawOverlay(0.6); // 压暗战场，突出卡片

    // 统计行（每行一项：图标 / 标签 / 数值 / 数值颜色）
    var rows = [
      { icon: 'medal', label: '排名',         value: '第 ' + r.rank + ' 名', color: '#C47F17' },
      { icon: 'clock', label: '存活时间',     value: r.surviveSec + ' 秒',   color: cfg.INK },
      { icon: 'star',  label: '总分',         value: String(r.score),        color: '#E8552F' },
      { icon: 'clock', label: '时间分',       value: '+' + r.survivalScore,  color: '#4A7FD4' },
      { icon: 'spark', label: '消除分',       value: '+' + r.elimScore,      color: '#9B5DE5' },
      { icon: 'block', label: '累计消除方块', value: String(r.elimTotal),    color: '#2EC4B6' },
      { icon: 'burst', label: '击杀数',       value: String(r.kills),        color: '#E8552F' },
      { icon: 'snake', label: '最终节数',     value: r.finalLen + ' 节',     color: '#6FBF4A' }
    ];

    // 卡片几何：内容优先，小屏压缩行距；卡片整体停在按钮上方
    var rowH = 34, padV = 18, titleH = 96, footH = 30;
    var cw = Math.min(440, W * 0.62);
    var ch = padV * 2 + titleH + rows.length * rowH + footH;
    var btnTop = H;
    for (var bi = 0; bi < game.uiButtons.length; bi++) btnTop = Math.min(btnTop, game.uiButtons[bi].y);
    var maxCh = btnTop - 20 - 16;
    if (ch > maxCh) {
      rowH = Math.max(24, (maxCh - padV * 2 - titleH - footH) / rows.length);
      ch = padV * 2 + titleH + rows.length * rowH + footH;
    }
    var cx = W / 2;
    var x = cx - cw / 2;
    var y = Math.max(12, (btnTop - 20 - ch) / 2);

    // ---- 卡片底板（280ms 淡入 + 轻微上移）----
    var aCard = u.clamp(t / 280, 0, 1);
    ctx.save();
    ctx.globalAlpha = aCard;
    ctx.translate(0, (1 - aCard) * 14);
    wobblyRoundRect(ctx, x, y, cw, ch, 18, 71, 73, 2.4);
    ctx.fillStyle = cfg.PANEL;
    ctx.fill();
    var tile = getNoiseTile(); // 纸张质感：噪点平铺裁剪进卡片
    if (tile) {
      wobblyRoundRect(ctx, x, y, cw, ch, 18, 71, 73, 2.4);
      ctx.save();
      ctx.clip();
      for (var nx = x; nx < x + cw; nx += 160) {
        for (var ny = y; ny < y + ch; ny += 160) ctx.drawImage(tile, nx, ny);
      }
      ctx.restore();
    }
    wobblyRoundRect(ctx, x, y, cw, ch, 18, 71, 73, 2.4);
    ctx.strokeStyle = cfg.INK;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.save();
    ctx.translate(1.4, -1);
    ctx.globalAlpha = aCard * 0.3;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    // ---- 标题区（按名次变化）----
    var title = r.rank === 1 ? '冠军！' : (r.rank <= 3 ? '很棒！' : '再接再厉');
    var titleColor = r.rank === 1 ? '#C47F17' : (r.rank <= 3 ? '#4A8C3F' : cfg.INK);
    var ty = y + padV + 50;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (r.rank === 1) {
      drawCrown(ctx, cx, y + padV + 14, 46, 24);
      starPath(ctx, cx - 76, ty, 12, 0.4);
      ctx.fillStyle = '#FFD94A';
      ctx.fill();
      ctx.strokeStyle = cfg.INK;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      starPath(ctx, cx + 76, ty, 12, -0.3);
      ctx.fillStyle = '#FFD94A';
      ctx.fill();
      ctx.stroke();
    }
    ctx.font = 'bold 34px sans-serif';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = cfg.INK;
    ctx.strokeText(title, cx, ty);
    ctx.fillStyle = titleColor;
    ctx.fillText(title, cx, ty);
    ctx.font = '12px sans-serif';
    ctx.globalAlpha = aCard * 0.65;
    ctx.fillStyle = cfg.INK;
    ctx.fillText('多人对战 · 7 蛇同场', cx, ty + 30);
    ctx.globalAlpha = aCard;

    // ---- 统计行（每行一项，依次延迟 ~80ms 从左侧滑入）----
    var y0 = y + padV + titleH;
    for (var ri = 0; ri < rows.length; ri++) {
      var p = u.clamp((t - 260 - ri * 80) / 160, 0, 1);
      if (p <= 0) continue;
      var ry = y0 + ri * rowH + rowH / 2;
      var slide = (1 - p) * 22;
      ctx.save();
      ctx.globalAlpha = p * aCard;
      ctx.strokeStyle = 'rgba(58,50,56,0.18)'; // 行上手绘虚线分隔
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(x + 22, y0 + ri * rowH);
      ctx.lineTo(x + cw - 22, y0 + ri * rowH);
      ctx.stroke();
      ctx.setLineDash([]);
      drawStatIcon(ctx, rows[ri].icon, x + 44 - slide, ry, 20);
      ctx.textAlign = 'left';
      ctx.font = '14px sans-serif';
      ctx.fillStyle = cfg.INK;
      ctx.fillText(rows[ri].label, x + 68 - slide, ry);
      ctx.textAlign = 'right';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = rows[ri].color;
      ctx.fillText(rows[ri].value, x + cw - 30 - slide, ry);
      ctx.restore();
    }

    // ---- 卡片脚注：历史最佳（+ 新纪录标签）----
    var aFoot = u.clamp((t - 260 - rows.length * 80) / 200, 0, 1);
    if (aFoot > 0) {
      var fy = y + ch - padV - 8;
      ctx.save();
      ctx.globalAlpha = aFoot * aCard * 0.7;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = cfg.INK;
      ctx.fillText('历史最佳 ' + r.bestLen + ' 节 · ' + r.bestScore + ' 分', cx, fy);
      ctx.restore();
      if (r.newBest) {
        ctx.save();
        ctx.globalAlpha = aFoot * aCard;
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.lineJoin = 'round';
        var nb = '新纪录！';
        var bw3 = ctx.measureText('历史最佳 ' + r.bestLen + ' 节 · ' + r.bestScore + ' 分').width;
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#FFFDF5';
        ctx.strokeText(nb, cx + bw3 / 2 + 10, fy);
        ctx.fillStyle = '#E8552F';
        ctx.fillText(nb, cx + bw3 / 2 + 10, fy);
        ctx.restore();
      }
    }
    ctx.restore();

    // ---- 按钮（最后淡入；主按钮更醒目）----
    var aBtn = u.clamp((t - 300 - rows.length * 80) / 220, 0, 1);
    for (bi = 0; bi < game.uiButtons.length; bi++) {
      this.drawDoodleButton(game.uiButtons[bi], game.uiButtons[bi].id === 'retry', aBtn);
    }
  };

  // ---------------- 解锁提示横幅 ----------------

  /**
   * 手绘风「新颜色解锁！」提示（需求 3：无底板）。
   * 只有文字 + 新颜色小色块图标，直接浮在画面上，不遮挡地图：
   * 文字带深色描边保证可读性，无任何矩形底色/面板；
   * 位置在视口上方 1/4 处，停留 1.5 秒（200ms 淡入 / 300ms 淡出，时长不变）。
   */
  Renderer.prototype.drawUnlockBanner = function (game) {
    var b = game.unlockBanner;
    if (!b || !b.keys || !b.keys.length) return;
    var ctx = this.ctx, l = game.layout();
    var life = cfg.UNLOCK_BANNER_MS;
    var remain = b.until - game.timeMs;     // 剩余毫秒
    var since = life - remain;              // 已显示毫秒
    var a = 1;
    if (since < 200) a = since / 200;       // 前 200ms 淡入
    else if (remain < 300) a = Math.max(0, remain / 300); // 末尾 300ms 淡出
    a = Math.max(0, Math.min(1, a));
    if (a <= 0) return;

    var cx = l.areaW / 2;
    var ty = this.H * 0.25; // 视口上方 1/4 处

    ctx.save();
    ctx.globalAlpha = a;
    // 手绘风文字：深色粗描边 + 纸色填充（无底板也可读）
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px sans-serif';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = cfg.INK;
    ctx.strokeText(b.text, cx, ty);
    ctx.fillStyle = '#FFFDF5';
    ctx.fillText(b.text, cx, ty);

    // 新颜色小色块图标（文字下方一排，无任何底色衬板）
    var keys = b.keys;
    var sw = 22, gap = 10;
    var totalW = keys.length * sw + (keys.length - 1) * gap;
    var sx = cx - totalW / 2;
    for (var i = 0; i < keys.length; i++) {
      drawCrayonBlock(ctx, sx + i * (sw + gap), ty + 18, sw, cfg.COLORS[keys[i]], 50 + i, 9, {
        rot: (u.hash2(i, 7, 3) - 0.5) * 0.4, wobble: 1.0
      });
    }
    ctx.restore();
  };

  // ---------------- 总入口 ----------------

  Renderer.prototype.draw = function (game) {
    this.drawBackground();
    if (game.state === 'menu') { this.drawMenu(game); return; }
    if (game.state === 'levels') { this.drawLevels(game); return; }
    // play / clear / over 都先画对局场景（世界 + 相机）
    this.drawPlay(game);
    this.drawPanel(game);
    if (game.state === 'play') {
      this.drawUnlockBanner(game); // 解锁提示横幅（在摇杆之上）
      this.drawJoystick(game);
    } else if (game.state === 'clear') this.drawResult(game, true);
    else if (game.state === 'over') {
      // 多人对战：卡片式逐行结算（含咬断/累计消除等新统计）；其余模式沿用简单结算
      if (game.mode === 'multi' && game.mpResult) this.drawMultiResult(game);
      else this.drawResult(game, false);
    }
  };

  CS.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
