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
   * 边界墙：世界四周的墙带（带视口裁剪，只画可见带）。
   * 直接复用内部墙 drawWallRect 的画法（蜡笔灰底 + 斜线排线 + 深色描边），
   * 与里面的墙「同一个效果」，一眼可读"这是墙不能碰"；撞界判定不变（逻辑仍在 walls.hitsCircle）。
   */
  /**
   * 边界墙：世界四周的墙带（带视口裁剪，只画可见带）。
   * 与地图内部墙使用同一套 drawWallRect 画法（蜡笔灰底 + 斜线排线 + 深色描边），
   * 视觉完全统一；撞界判定不变（逻辑仍在 walls.hitsCircle）。
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
      drawWallRect(ctx, b, 91 + i);   // 与地图内部墙同一套蜡笔排线视觉
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
  /**
   * 特殊道具绘制（地图上的万能色/炸弹/减速/消色/后3消色/随机消N）。
   * 统一：先 translate 到块中心 + 脉动缩放，再按 kind 画；白底块一律加粗黑灰描边（浅色场景可见）。
   * @param {string} kind 'wild' | 'bomb' | 'slow' | 'clear' | 'clear3' | 'rand1|2|3'
   */
  function drawItemBlock(ctx, b, cx, cy, size, seedX, seedY, rot, pulse) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(pulse, pulse);

    if (b.kind === 'wild') {
      // 万能色：白底块 + 角上四色点 + 中心星标 + 粗黑描边
      drawCrayonBlock(ctx, -size / 2, -size / 2, size, '#FFFDF5', seedX, seedY, { rot: rot, wobble: 1.0 });
      var cols = ['#E8552F', '#4A7FD4', '#6FBF4A', '#F5A623'];
      for (var c = 0; c < 4; c++) {
        ctx.beginPath();
        ctx.arc(Math.cos(c * Math.PI / 2) * size * 0.34, Math.sin(c * Math.PI / 2) * size * 0.34, size * 0.10, 0, Math.PI * 2);
        ctx.fillStyle = cols[c]; ctx.fill();
        ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1; ctx.stroke();
      }
      starPath(ctx, 0, 0, size * 0.24, 0.3);
      ctx.fillStyle = '#FFD94A'; ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1.2; ctx.stroke();
      // 白底在浅色/白色场景易隐形 → 粗黑灰描边
      wobblyRoundRect(ctx, -size / 2, -size / 2, size, size, size * 0.28, seedX, seedY, 1.0);
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = Math.max(2.5, size * 0.13); ctx.stroke();

    } else if (b.kind === 'bomb') {
      // 炸弹：深灰圆 + 引线火光
      ctx.beginPath(); ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = '#3A3238'; ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -size * 0.42);
      ctx.quadraticCurveTo(size * 0.18, -size * 0.62, size * 0.06, -size * 0.72);
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.beginPath(); ctx.arc(size * 0.06, -size * 0.72, size * 0.09, 0, Math.PI * 2);
      ctx.fillStyle = '#F5A623'; ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1; ctx.stroke();

    } else if (b.kind === 'slow') {
      // 减速：蓝绿圆 + 时钟指针
      ctx.beginPath(); ctx.arc(0, 0, size * 0.44, 0, Math.PI * 2);
      ctx.fillStyle = '#2EC4B6'; ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -size * 0.26);
      ctx.moveTo(0, 0); ctx.lineTo(size * 0.20, size * 0.06);
      ctx.strokeStyle = '#FFFDF5'; ctx.lineWidth = 2; ctx.stroke();

    } else if (b.kind === 'clear') {
      // 消色（全部）：该色块 + 12 道粗放射线 + 外环，表达「整片清掉」
      drawCrayonBlock(ctx, -size / 2, -size / 2, size, cfg.COLORS[b.color], seedX, seedY, { rot: rot, wobble: 1.0 });
      wobblyRoundRect(ctx, -size / 2, -size / 2, size, size, size * 0.28, seedX, seedY, 1.0);
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = Math.max(1.8, size * 0.07); ctx.stroke();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = Math.max(2, size * 0.10);
      for (var a = 0; a < 12; a++) {
        var an = a * Math.PI / 6;
        ctx.beginPath();
        ctx.moveTo(Math.cos(an) * size * 0.16, Math.sin(an) * size * 0.16);
        ctx.lineTo(Math.cos(an) * size * 0.47, Math.sin(an) * size * 0.47);
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(0, 0, size * 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = Math.max(1.8, size * 0.07); ctx.stroke();

    } else if (b.kind === 'clear3') {
      // 后 3 消色：该色块 + 居中大号「×3」
      drawCrayonBlock(ctx, -size / 2, -size / 2, size, cfg.COLORS[b.color], seedX, seedY, { rot: rot, wobble: 1.0 });
      wobblyRoundRect(ctx, -size / 2, -size / 2, size, size, size * 0.28, seedX, seedY, 1.0);
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = Math.max(1.8, size * 0.07); ctx.stroke();
      ctx.font = 'bold ' + Math.round(size * 0.62) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, size * 0.10); ctx.strokeStyle = '#FFFDF5';
      ctx.strokeText('×3', 0, 1);
      ctx.fillStyle = cfg.INK; ctx.fillText('×3', 0, 1);

    } else if (b.kind === 'rand1' || b.kind === 'rand2' || b.kind === 'rand3') {
      // 随机消除：白底块 + 粗黑描边 + 居中大号数字 + ? 角标
      drawCrayonBlock(ctx, -size / 2, -size / 2, size, '#FFFDF5', seedX, seedY, { rot: rot, wobble: 1.0 });
      wobblyRoundRect(ctx, -size / 2, -size / 2, size, size, size * 0.28, seedX, seedY, 1.0);
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = Math.max(2.5, size * 0.13); ctx.stroke();
      var n = b.kind === 'rand1' ? 1 : (b.kind === 'rand2' ? 2 : 3);
      ctx.font = 'bold ' + Math.round(size * 0.6) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, size * 0.10); ctx.strokeStyle = '#FFFDF5';
      ctx.strokeText(String(n), 0, 1);
      ctx.fillStyle = cfg.INK; ctx.fillText(String(n), 0, 1);
      ctx.font = 'bold ' + Math.round(size * 0.28) + 'px sans-serif';
      ctx.fillStyle = cfg.INK; ctx.fillText('?', size * 0.30, -size * 0.30);

    } else if (b.kind === 'meteor') {
      // 流星砖块：会直线飞行的彩色砖块（与游戏内 drawMeteor 一致：彩色蜡笔砖 + 淡拖尾）
      var mc = cfg.COLORS[b.color] || '#E8552F';
      // 身后拖尾：几个依次变淡的残影，指示飞行方向（向右下飞入）
      for (var mt = 3; mt >= 1; mt--) {
        ctx.beginPath();
        ctx.arc(-size * 0.20 * mt, -size * 0.12 * mt, size * (0.30 - 0.05 * mt), 0, Math.PI * 2);
        ctx.fillStyle = mc;
        ctx.globalAlpha = 0.22 * (4 - mt);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // 本体：彩色蜡笔砖块
      drawCrayonBlock(ctx, -size / 2, -size / 2, size, mc, seedX, seedY, { rot: 0.2, wobble: 1.0, stroke: cfg.SEG_STROKE });

    } else {
      // 普通色块（默认）：纯色蜡笔砖块（带描边），即游戏内最常见的色块
      drawCrayonBlock(ctx, -size / 2, -size / 2, size, cfg.COLORS[b.color], seedX, seedY, { rot: rot, wobble: 1.0 });
    }

    // 稀有度边框：在方块外侧加一道明显加粗的彩色描边（强→弱：蓝/紫/橙），一眼可辨道具强度
    var rar = b.rarity || (b.kind && cfg.ITEM_RARITY ? cfg.ITEM_RARITY[b.kind] : null);
    if (rar && cfg.RARITY_COLORS && cfg.RARITY_COLORS[rar]) {
      wobblyRoundRect(ctx, -size / 2 - 3, -size / 2 - 3, size + 6, size + 6, size * 0.34, seedX, seedY, 1.1);
      ctx.strokeStyle = cfg.RARITY_COLORS[rar];
      ctx.lineWidth = Math.max(3, size * 0.17);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * 流星砖块：带拖尾的彩色光球（在 drawPlay 已做相机平移的世界坐标系内绘制）。
   * @param {object} m {x,y,color,trail}
   */
  function drawMeteor(ctx, m) {
    // 拖尾：淡淡的运动残影，指示来向
    for (var t = 0; t < m.trail.length; t++) {
      var p = m.trail[t];
      var a = (t + 1) / m.trail.length;
      ctx.beginPath();
      ctx.arc(p.x, p.y, cfg.METEOR_RADIUS * (0.4 + 0.4 * t / m.trail.length), 0, Math.PI * 2);
      ctx.fillStyle = cfg.COLORS[m.color];
      ctx.globalAlpha = a * 0.25;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // 本体：会移动的彩色蜡笔砖块（不是流星光球，就是移动中的砖）
    var size = cfg.METEOR_RADIUS * 2;
    drawCrayonBlock(ctx, m.x - size / 2, m.y - size / 2, size, cfg.COLORS[m.color],
      Math.round(m.x / 10), Math.round(m.y / 10), { rot: 0.2, wobble: 1.0, stroke: cfg.SEG_STROKE });
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

    // 流星砖块：带拖尾的彩色光球，从四周飞入命中身体
    for (i = 0; i < spawner.meteors.length; i++) {
      var m = spawner.meteors[i];
      if (m.x < cam.x - 60 || m.x > cam.x + vw + 60 || m.y < cam.y - 60 || m.y > cam.y + vh + 60) continue;
      drawMeteor(ctx, m);
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
      } else if (p.type === 'ring') {
        // 消除高亮：扩张圆环 + 中心 ✕，标出被消除节位置（非连续消除也清楚可见）
        var prog = 1 - t; // 0 → 1
        ctx.save();
        ctx.globalAlpha = Math.min(1, t * 1.5);
        var sc = p.scale || 1;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(2, 3 * (1 - prog) + 1.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, (5 + prog * 30) * sc, 0, Math.PI * 2);
        ctx.stroke();
        var s = 6 * sc;
        ctx.lineWidth = Math.max(1.5, 2 * sc);
        ctx.beginPath();
        ctx.moveTo(p.x - s, p.y - s); ctx.lineTo(p.x + s, p.y + s);
        ctx.moveTo(p.x + s, p.y - s); ctx.lineTo(p.x - s, p.y + s);
        ctx.stroke();
        ctx.restore();
      } else if (p.type === 'streak') {
        // 自吃牵引线：从身体接触点拉向蛇头，表达「砖块被吸到头部」
        ctx.save();
        ctx.globalAlpha = Math.min(1, t * 1.8);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(2.5, 4 * t + 1);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x1, p.y1);
        ctx.lineTo(p.x2, p.y2);
        ctx.stroke();
        // 头部端的箭头小三角（指示被拉过去的方向）
        var ang = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
        var ah = 7;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.x2, p.y2);
        ctx.lineTo(p.x2 - Math.cos(ang - 0.4) * ah, p.y2 - Math.sin(ang - 0.4) * ah);
        ctx.lineTo(p.x2 - Math.cos(ang + 0.4) * ah, p.y2 - Math.sin(ang + 0.4) * ah);
        ctx.closePath();
        ctx.fill();
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
    ctx.fillText('消食蛇', cx, 24);

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
    var cx = this.W / 2;
    var ty = this.H * 0.22; // 标题基线 Y

    // ---- 标题「消食蛇」美术设计 ----
    // 设计意图：每个字用不同颜色（红=消除、绿=吃、蓝=蛇身），
    //   字间穿插小蜡笔色块（体现"蛇由色块组成"），
    //   底部蜡笔波浪下划线 + 少量砖块沿线缓慢往返滑动（手绘感，平滑不跳动）
    ctx.save();
    var titleChars = ['消', '食', '蛇'];
    var titleColors = [cfg.COLORS.red, cfg.COLORS.green, cfg.COLORS.blue]; // 红(消) 绿(食) 蓝(蛇)
    var fontSize = 52;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold ' + fontSize + 'px sans-serif';

    // 测量总宽以便居中
    var totalW = 0;
    for (var tc = 0; tc < titleChars.length; tc++) totalW += ctx.measureText(titleChars[tc]).width;
    var charGap = 8; // 字间距
    totalW += charGap * (titleChars.length - 1);
    var startX = cx - totalW / 2;

    // 逐字绘制（每字独立颜色 + 轻微蜡笔描边）
    var curX = startX;
    for (var ci = 0; ci < titleChars.length; ci++) {
      var ch = titleChars[ci];
      var chW = ctx.measureText(ch).width;
      var chCx = curX + chW / 2;

      // 字体颜色（深色描边 + 彩色填充，保证在浅色背景可读）
      ctx.font = 'bold ' + fontSize + 'px sans-serif';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = cfg.INK;
      ctx.strokeText(ch, chCx, ty);
      ctx.fillStyle = titleColors[ci];
      ctx.fillText(ch, chCx, ty);

      curX += chW + charGap;
    }

    // 蜡笔波浪下划线（手绘感，贯穿标题下方）
    ctx.beginPath();
    var ulY = ty + fontSize * 0.48;
    var ulW = totalW + 40;
    var ulX0 = cx - ulW / 2;
    ctx.moveTo(ulX0, ulY);
    for (var wx = 1; wx <= 12; wx++) {
      var px = ulX0 + (wx / 12) * ulW;
      var py = ulY + Math.sin(wx * 1.3 + 0.7) * 3.5;
      ctx.lineTo(px, py);
    }
    ctx.strokeStyle = cfg.COLORS.orange; // 橙色下划线（第 4 色，点缀用）
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();

    // 标题两侧各飘 1 个稍大的装饰色块（四色各一，表达"四色消除"核心机制）
    var decorBlocks = [
      { x: cx - totalW / 2 - 28, y: ty - 6, color: cfg.COLORS.orange, size: 14, rot: -0.25 },
      { x: cx + totalW / 2 + 26, y: ty + 10, color: cfg.COLORS.purple, size: 12, rot: 0.35 }
    ];
    for (var di = 0; di < decorBlocks.length; di++) {
      var db = decorBlocks[di];
      ctx.save();
      ctx.translate(db.x, db.y);
      ctx.rotate(db.rot);
      drawCrayonBlock(ctx, -db.size / 2, -db.size / 2, db.size, db.color,
        di * 77, di * 43, { rot: db.rot * 0.8, wobble: 1.0 });
      ctx.restore();
    }

    // 标题下方「色块滑动 → 触发消除」循环动效（多色轮播 + 随机效果）
    this.drawTitleFx(game);

    ctx.restore();
    // ---- 标题结束 ----

    // 副标题：四个起始色块做装饰（保留原有设计，位置随标题下移）
    ctx.save();
    ctx.fillStyle = cfg.INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '15px sans-serif';
    ctx.fillText('自由游动 · 吃色补头 · 四连消除 · 别撞墙', cx, this.H * 0.35);
    ctx.font = '13px sans-serif';
    ctx.globalAlpha = 0.7;
    ctx.fillText('无尽模式最高分：' + game.best + '    已解锁关卡：' + game.unlocked + ' / 10', this.W / 2, this.H * 0.89);
    ctx.fillText('多人对战最佳：最长 ' + game.mpBest.len + ' 节 · 最高 ' + game.mpBest.score + ' 分', this.W / 2, this.H * 0.89 + 22);
    ctx.restore();
    this.drawParticles(game); // 标题消除动效的粒子（屏幕坐标，无相机变换）
    this.drawButtons(game);
  };

  /**
   * 标题下方装饰动效：小蛇「向左走」一边吃砖块一边凑 4 连消除，循环演示每种颜色各来一次。
   * 蛇头朝左、蛇身向右铺开；砖块从左侧远处流入、被蛇头吃掉补到头部（与游戏内 unshift 一致），
   * 同色节在头侧累积，凑够 4 连即触发消除（蜡笔屑迸裂 + 高亮环 + 星形闪光 + 飘字「4连消除！」），随后循环。
   * 颜色按 COLOR_KEYS 顺序轮播（红→蓝→绿→橙→紫→黄→青→粉→…），保证每种颜色都演示一次再循环。
   * 状态挂在 renderer 实例上（this.titleFx），逐帧更新。
   */
  Renderer.prototype.drawTitleFx = function (game) {
    var ctx = this.ctx;
    var fx = this.titleFx;
    if (!fx) fx = this.titleFx = {
      segs: ['red', 'blue', 'green', 'orange', 'purple'], // 常驻蛇身（多色、无 4 连同色），保证蛇一直有身体在"走"
      feeder: null,      // 正在流入、待"吃"下的砖块 {color, x}
      lastMs: game.timeMs,
      feedTimer: 300,    // 距下一块砖出现的间隔
      colorCursor: 0,    // 当前这一轮要连吃的颜色在 COLOR_KEYS 里的下标
      runLeft: 0,        // 该色还差几块才凑满一轮（一轮=4）
      runColor: cfg.COLOR_KEYS[0],
      bite: 0,           // 蛇头咬合动画剩余时长(ms)
      bob: 0             // 行走摆动相位
    };
    var nowMs = game.timeMs;
    var dt = nowMs - fx.lastMs;
    fx.lastMs = nowMs;
    if (dt < 0) dt = 0;
    if (dt > 80) dt = 80; // 切后台回来防跳帧
    fx.bob += dt;

    var cx = this.W / 2;
    var ty = this.H * 0.22;
    var fontSize = 52;
    var laneY = ty + fontSize * 0.95;             // 标题与副标题之间的一条轨道
    var SEG = 24, BLK = 20, MAXLEN = 14;
    var headX = cx - Math.min(this.W * 0.16, 130); // 蛇头在偏左（朝左走），蛇身向右铺开
    var walkSpeed = 175;                           // 砖块从左侧流入、向右被吃（视觉上=蛇向左走）

    // 1) 出块：COLOR_KEYS 顺序轮一遍（红→蓝→绿→…→粉→红…），每色喂 4 块凑 4 连
    fx.feedTimer -= dt;
    if (!fx.feeder && fx.feedTimer <= 0) {
      fx.feedTimer = 360 + Math.random() * 200;    // 0.36~0.56s 出一块（连续走、不断粮）
      if (fx.runLeft <= 0) {                       // 上一轮凑满，切到下一色
        fx.runColor = cfg.COLOR_KEYS[fx.colorCursor % cfg.COLOR_KEYS.length];
        fx.colorCursor++;
        fx.runLeft = 4;
      }
      fx.feeder = { color: fx.runColor, x: headX - 200 }; // 从左侧远处流入
      fx.runLeft--;
    }

    // 2) 推进待吃砖块（向左流入 → 到蛇头被吃下）；补到头部，超长去尾
    if (fx.feeder) {
      fx.feeder.x += walkSpeed * dt / 1000;
      if (fx.feeder.x >= headX) {
        fx.segs.unshift(fx.feeder.color);          // 补头（与游戏一致：吃到→unshift 到头部）
        if (fx.segs.length > MAXLEN) fx.segs.pop(); // 尾部掉落，总长有界
        fx.bite = 160;
        game.particles.ring(headX, laneY, cfg.COLORS[fx.feeder.color], 0.9); // 咬合小高亮
        fx.feeder = null;
        // 头侧 4 连（前 4 个同色）→ 消除
        var L = fx.segs.length;
        if (L >= 4 && fx.segs[0] === fx.segs[1] && fx.segs[1] === fx.segs[2] && fx.segs[2] === fx.segs[3]) {
          var col = cfg.COLORS[fx.segs[0]];
          for (var k = 0; k < 4; k++) {
            var px = headX + k * SEG;
            game.particles.burst(px, laneY, col, 7, 1.3);
            game.particles.ring(px, laneY, col, 1.3);
          }
          game.particles.flash(headX + 1.5 * SEG, laneY, '#FFD94A', 1.4, 3);
          game.particles.chainText(headX + 1.5 * SEG, laneY - 26, '4连消除！', 20);
          fx.segs.splice(0, 4); // 移除头侧 4 节（常驻蛇身保留）
        }
      }
    }
    if (fx.bite > 0) fx.bite -= dt;

    // 3) 绘制：蛇头在左（朝左走、眼睛朝左），常驻蛇身向右铺开；整体波浪式摆动表现"走"
    ctx.save();
    ctx.textBaseline = 'middle';
    for (var i = 0; i < fx.segs.length; i++) {
      var sx = headX + i * SEG;
      var isHead = (i === 0);
      var sz = isHead ? BLK + 2 : BLK;
      var py = laneY + Math.sin(fx.bob / 240 - i * 0.55) * 2.6; // 蛇身波浪式摆动
      if (sx > headX + MAXLEN * SEG + 30) continue;
      drawCrayonBlock(ctx, sx - sz / 2, py - sz / 2, sz, cfg.COLORS[fx.segs[i]], i * 53 + 17, 41,
        { rot: 0.08, wobble: 1.0, stroke: cfg.SEG_STROKE });
      if (isHead) {
        var sc = 1 + Math.max(0, fx.bite) / 160 * 0.18; // 咬合瞬间微微鼓一下
        ctx.save();
        ctx.translate(sx, py);
        ctx.scale(sc, sc);
        drawEyes(ctx, 0, 0, sz, { x: -1, y: 0 }); // 朝左（行进方向=向左走）
        ctx.restore();
      }
    }
    if (fx.feeder) { // 正在流入、待吃的砖块（带轻微脉冲提示"正在靠近"）
      var fsz = BLK * (1 + 0.08 * Math.sin(nowMs / 120));
      ctx.save();
      ctx.globalAlpha = 0.95;
      drawCrayonBlock(ctx, fx.feeder.x - fsz / 2, laneY - fsz / 2, fsz, cfg.COLORS[fx.feeder.color], 7, 41,
        { rot: 0.08, wobble: 1.0, stroke: cfg.SEG_STROKE });
      ctx.restore();
    }
    ctx.restore();
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

  // ---------------- 特殊道具效果提示（HUD，屏幕空间，不遮挡地图） ----------------

  /**
   * 吃到特殊道具时弹出的效果说明文字（game.itemToast）。
   * 屏幕顶部居中、手绘描边 + 纸色填充（无底板，与解锁横幅同风格），约 1.6s 后淡出。
   * 停留在视口区上方，不侵入右侧 HUD 面板与小地图。
   */
  Renderer.prototype.drawItemToast = function (game) {
    var b = game.itemToast;
    if (!b || !b.text) return;
    var ctx = this.ctx, l = game.layout();
    var life = cfg.ITEM_TOAST_MS;
    var remain = b.until - game.timeMs;
    var since = life - remain;
    var a = 1;
    if (since < 180) a = since / 180;                  // 前 180ms 淡入
    else if (remain < 320) a = Math.max(0, remain / 320); // 末尾 320ms 淡出
    a = Math.max(0, Math.min(1, a));
    if (a <= 0) return;

    var cx = l.areaW / 2;
    var ty = 64; // 视口区顶部

    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 19px sans-serif';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = cfg.INK;
    ctx.strokeText(b.text, cx, ty);
    ctx.fillStyle = '#FFFDF5';
    ctx.fillText(b.text, cx, ty);
    // 下方一道短装饰线（纯手绘感，无底板）
    ctx.lineWidth = 2;
    ctx.globalAlpha = a * 0.6;
    var dw = Math.min(l.areaW * 0.5, ctx.measureText(b.text).width + 24);
    ctx.beginPath();
    ctx.moveTo(cx - dw / 2, ty + 16);
    ctx.lineTo(cx + dw / 2, ty + 16);
    ctx.stroke();
    ctx.restore();
  };

  // ---------------- 道具图鉴页面 ----------------

  /**
   * 图鉴页：分页展示所有道具，每页 5 张卡片。
   * 图标使用与游戏内完全相同的 drawItemBlock（离屏 canvas 渲染后贴图）。
   * 支持翻页（点击左右区域或按钮）+ 底部页码指示器 + 返回按钮。
   */
  // ==================== 图鉴页面（完整重设计）====================
  //
  // 布局结构（三段式，像真正的应用页面）：
  //   ┌─ 顶栏（全宽）：标题居中 + 页签在右侧 ──────────────────┐
  //   ├─ 主体：左侧导航栏（竖排）+ 右侧内容区 ─────────────────┤
  //   └─ 底栏（全宽）：翻页 + 页码 + 返回按钮 ────────────────┘
  //

  /** 统一计算图鉴页面的布局网格（供 drawGuide / drawGuideColors 共用）。 */
  function guideLayout(game) {
    var W = game.screenW, H = game.screenH;
    var hdrH = 52;            // 顶栏高度
    var ftrH = 52;            // 底栏高度
    var hdrY = 0;             // 顶栏 Y
    var ftrY = H - ftrH;      // 底栏 Y
    var bodyTop = hdrY + hdrH; // 主体区域顶部
    var bodyBtm = ftrY;       // 主体区域底部
    var bodyH = bodyBtm - bodyTop;

    // 左侧导航栏
    var sbW = Math.min(130, W * 0.22);  // 侧边栏宽度
    var sbX = 16;                        // 侧边栏左边距
    var sbPad = 10;
    var tabW = sbW - sbPad * 2;
    var tabH = 38;
    var tabGap = 8;

    // 右侧内容区
    var cx = sbX + sbW + 16;             // 内容区左边界
    var cW = W - cx - 16;               // 内容区宽度

    return {
      W: W, H: H,
      hdrY: hdrY, hdrH: hdrH,
      ftrY: ftrY, ftrH: ftrH,
      bodyTop: bodyTop, bodyBtm: bodyBtm, bodyH: bodyH,
      sbX: sbX, sbW: sbW, sbPad: sbPad, tabW: tabW, tabH: tabH, tabGap: tabGap,
      cx: cx, cW: cW
    };
  }

  /**
   * 图鉴入口：统一调度道具页/颜色页。
   * 不再调用 drawButtons（返回按钮由本函数自绘，保证对齐）。
   */
  Renderer.prototype.drawGuide = function (game) {
    var ctx = this.ctx, L = guideLayout(game);

    // ════════════════ 1. 顶栏（全宽）════════════════
    this.drawGuideHeader(game, L);

    // ════════════════ 2. 左侧导航栏 ════════════════
    this.drawGuideSidebar(game, L);

    // ════════════════ 3. 内容区（按页签分发）════════════════
    if (game.guideTab === 'colors') {
      this.drawGuideColorsContent(game, L);
    } else {
      this.drawGuideItemsContent(game, L);
    }

    // ════════════════ 4. 底栏（全宽）════════════════
    this.drawGuideFooter(game, L);
  };

  // ---- 1. 顶栏：标题 + 页签胶囊（右侧）----
  Renderer.prototype.drawGuideHeader = function (game, L) {
    var ctx = this.ctx;
    // 标题（全屏居中）
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = cfg.INK;
    var title = game.guideTab === 'colors' ? '颜色解锁顺序' : '道具图鉴';
    ctx.fillText(title, L.W / 2, L.hdrY + L.hdrH / 2);
    ctx.restore();

    // 右侧页签胶囊（顶栏内，与标题同行）
    var tw = 72, th = 30, tg = 6;
    var tx = L.W - 16 - tw * 2 - tg;  // 右对齐
    var ty = L.hdrY + (L.hdrH - th) / 2;
    [['items', '道具'], ['colors', '颜色']].forEach(function (pair) {
      var key = pair[0], label = pair[1];
      var active = game.guideTab === key;
      ctx.save();
      wobblyRoundRect(ctx, tx, ty, tw, th, 8, tx * 3, ty * 7, 1.2);
      ctx.fillStyle = active ? cfg.INK : '#FFFDF5';
      ctx.fill();
      if (!active) { ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1.6; ctx.stroke(); }
      else { ctx.lineWidth = 2.2; ctx.stroke(); }
      ctx.fillStyle = active ? '#FFFDF5' : cfg.INK;
      ctx.font = active ? 'bold 13px sans-serif' : '13px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, tx + tw / 2, ty + th / 2);
      ctx.restore();
      tx += tw + tg;
    });
  };

  // ---- 2. 左侧导航栏（竖排，带背景面板）----
  Renderer.prototype.drawGuideSidebar = function (game, L) {
    var ctx = this.ctx;
    // 背景面板
    ctx.save();
    wobblyRoundRect(ctx, L.sbX, L.bodyTop + 8, L.sbW, L.bodyH - 16, 12, L.sbX * 3, L.bodyTop * 5, 1.0);
    ctx.fillStyle = '#FAF4E8';
    ctx.fill();
    ctx.strokeStyle = 'rgba(58,50,56,0.10)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();

    // 导航项（竖排：当前页高亮 + 左竖条）
    var items = [
      { key: 'items', label: '道具', icon: '📦' },
      { key: 'colors', label: '颜色', icon: '🎨' }
    ];
    var iy = L.bodyTop + 24;
    items.forEach(function (it, idx) {
      var active = game.guideTab === it.key;
      var ix = L.sbX + L.sbPad;
      var iw = L.tabW, ih = L.tabH;
      ctx.save();
      wobblyRoundRect(ctx, ix, iy, iw, ih, 9, ix * 7, iy * 11, 1.3);
      if (active) {
        ctx.fillStyle = cfg.INK; ctx.fill();
        // 左侧彩色竖条
        ctx.fillStyle = cfg.COLORS.orange;
        ctx.fillRect(ix + 3, iy + 6, 3, ih - 12);
        ctx.fillStyle = '#FFFDF5';
      } else {
        ctx.fillStyle = '#FFFDF5'; ctx.fill();
        ctx.strokeStyle = 'rgba(58,50,56,0.18)'; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.fillStyle = cfg.INK;
      }
      ctx.font = active ? 'bold 14px sans-serif' : '14px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(it.label, ix + iw / 2, iy + ih / 2);
      ctx.restore();
      iy += ih + L.tabGap;
    });
  };

  // ---- 3a. 道具页内容区 ----
  Renderer.prototype.drawGuideItemsContent = function (game, L) {
    var ctx = this.ctx;
    var items = cfg.ITEM_GUIDE.slice().sort(function (a, b) {
      var oa = a.rarity ? cfg.RARITY_ORDER.indexOf(a.rarity) : 99;
      var ob = b.rarity ? cfg.RARITY_ORDER.indexOf(b.rarity) : 99;
      return oa - ob;
    });
    if (!items || !items.length) return;

    var PER_PAGE = 5;
    var totalPages = Math.ceil(items.length / PER_PAGE);
    if (!game.guidePage || game.guidePage < 0) game.guidePage = 0;
    if (game.guidePage >= totalPages) game.guidePage = totalPages - 1;
    var pg = game.guidePage;
    var startIdx = pg * PER_PAGE;
    var endIdx = Math.min(startIdx + PER_PAGE, items.length);
    var pageItems = [];
    for (var k = startIdx; k < endIdx; k++) pageItems.push(items[k]);

    // 稀有度图例行（内容区顶部）
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '11.5px sans-serif';
    var legY = L.bodyTop + 20;
    var chipW = 28, chipH = 14, gapX = 6, labelGap = 3;
    var labels = [['orange', '强'], ['purple', '中'], ['blue', '弱']];
    var lx = L.cx;
    for (var li = 0; li < labels.length; li++) {
      var rc = cfg.RARITY_COLORS[labels[li][0]];
      ctx.fillStyle = rc;
      ctx.fillRect(lx, legY - chipH / 2, chipW, chipH);
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1.0;
      ctx.strokeRect(lx, legY - chipH / 2, chipW, chipH);
      ctx.fillStyle = '#FFFDF5';
      ctx.font = 'bold 9.5px sans-serif';
      ctx.fillText(labels[li][1], lx + chipW / 2, legY);
      ctx.fillStyle = '#777';
      ctx.font = '11.5px sans-serif';
      lx += chipW + gapX + ctx.measureText('▸').width + labelGap;
      if (li < labels.length - 1) { ctx.fillText('▸', lx - labelGap, legY); }
    }
    ctx.restore();

    // 卡片列表
    var cardW = Math.min(540, L.cW - 8);
    var cardX = L.cx + (L.cW - cardW) / 2;
    var startY = L.bodyTop + 44;
    var cardH = 78, gap = 7, iconSize = 46;

    for (var i = 0; i < pageItems.length; i++) {
      var it = pageItems[i];
      var cy = startY + i * (cardH + gap);

      // 卡片底板
      ctx.save();
      wobblyRoundRect(ctx, cardX, cy, cardW, cardH, 8, (startIdx + i) * 7, (startIdx + i) * 11, 1.4);
      ctx.fillStyle = '#FFFDF5';
      ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 2.0; ctx.stroke();
      ctx.restore();

      // 图标
      var ix = cardX + 18 + iconSize / 2, iy = cy + cardH / 2;
      var tmpC = document.createElement('canvas');
      tmpC.width = iconSize * 2 + 4; tmpC.height = iconSize * 2 + 4;
      var tx = tmpC.getContext('2d');
      tx.translate(iconSize + 2, iconSize + 2);
      drawItemBlock(tx, { kind: it.kind, color: it.colorKey || 'red' }, 0, 0, iconSize, (startIdx + i) * 13, (startIdx + i) * 17, 0, 1.0);
      ctx.drawImage(tmpC, ix - iconSize - 2, iy - iconSize - 2);

      // 名称 + 描述
      ctx.save();
      ctx.font = 'bold 14.5px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = cfg.INK;
      ctx.fillText(it.name, cardX + iconSize + 34, cy + 11);
      if (it.rarity && cfg.RARITY_COLORS[it.rarity]) {
        var bw = 68, bh = 17, bx = cardX + cardW - bw - 9, by = cy + 9;
        ctx.fillStyle = cfg.RARITY_COLORS[it.rarity]; ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = cfg.INK; ctx.lineWidth = 1.3; ctx.strokeRect(bx, by, bw, bh);
        ctx.fillStyle = '#FFFDF5';
        ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(cfg.RARITY_NAME[it.rarity], bx + bw / 2, by + bh / 2 + 0.5);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = 'bold 14.5px sans-serif';
      }
      ctx.font = '12px sans-serif'; ctx.fillStyle = '#555';
      var descX = cardX + iconSize + 34, descY = cy + 33, maxW = cardW - iconSize - 48;
      var words = it.desc.split(''), line = '', lineY = descY, lh = 16;
      for (var c = 0; c < words.length; c++) {
        var test = line + words[c];
        if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, descX, lineY); line = ''; lineY += lh; }
        line += words[c];
      }
      if (line) ctx.fillText(line, descX, lineY);
      ctx.restore();
    }

    // 存储分页信息供 footer 使用
    game._guideTotalPages = totalPages;
    game._guidePage = pg;
  };

  // ---- 3b. 颜色解锁顺序内容区 ----
  Renderer.prototype.drawGuideColorsContent = function (game, L) {
    var ctx = this.ctx;
    var plan = cfg.colorUnlockPlan();

    // 副标题
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '12px sans-serif'; ctx.fillStyle = '#888';
    ctx.fillText('顺序 = 解锁先后 · 闯关按关卡 / 无尽按存活时间', L.cx, L.bodyTop + 22);
    ctx.restore();

    var top = L.bodyTop + 40;
    var bottomLimit = L.ftrY - 8;
    var rows = 4, gap = 10;
    var cellH = Math.floor((bottomLimit - top - (rows - 1) * gap) / rows);
    if (cellH < 68) cellH = 68;
    var cellW = Math.min(300, (L.cW - gap) / 2);
    var gridW = cellW * 2 + gap;
    var gx0 = L.cx + (L.cW - gridW) / 2;

    for (var i = 0; i < plan.length; i++) {
      var p = plan[i], col = i % 2, row = Math.floor(i / 2);
      var cx = gx0 + col * (cellW + gap), cy = top + row * (cellH + gap);

      ctx.save();
      wobblyRoundRect(ctx, cx, cy, cellW, cellH, 8, i * 7, i * 11, 1.4);
      ctx.fillStyle = '#FFFDF5'; ctx.fill();
      ctx.strokeStyle = cfg.INK; ctx.lineWidth = 2.0; ctx.stroke();
      ctx.restore();

      // 角标
      var br = 11;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx + br + 5, cy + br + 5, br, 0, Math.PI * 2);
      ctx.fillStyle = cfg.INK; ctx.fill();
      ctx.fillStyle = '#FFFDF5';
      ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(p.order), cx + br + 5, cy + br + 5 + 0.5);
      ctx.restore();

      // 色块
      var bs = Math.min(42, cellH - 28);
      ctx.save();
      ctx.translate(cx + 16 + bs / 2, cy + cellH / 2);
      drawCrayonBlock(ctx, -bs / 2, -bs / 2, bs, p.hex, 30 + i, 9, { rot: (i % 2 ? 0.12 : -0.12), wobble: 1.0 });
      ctx.restore();

      // 文字
      var tx = cx + 16 + bs + 12;
      ctx.save();
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = cfg.INK; ctx.font = 'bold 18px sans-serif';
      ctx.fillText(p.name, tx, cy + cellH * 0.30);
      ctx.font = '12px sans-serif';
      ctx.fillStyle = p.initial ? '#C2185B' : '#555';
      ctx.fillText('闯关：' + p.levelText, tx, cy + cellH * 0.58);
      ctx.fillText('无尽：' + p.endlessText, tx, cy + cellH * 0.80);
      ctx.restore();
    }

    game._guideTotalPages = 1;
    game._guidePage = 0;
  };

  // ---- 4. 底栏（全宽：翻页 + 页码 + 返回按钮）----
  Renderer.prototype.drawGuideFooter = function (game, L) {
    var ctx = this.ctx;
    var tp = game._guideTotalPages || 1, pg = game._guidePage || 0;
    var fy = L.ftrY + L.ftrH / 2;

    // 翻页提示（左右两侧）
    if (tp > 1) {
      ctx.save();
      ctx.font = '12.5px sans-serif'; ctx.fillStyle = '#888';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(pg > 0 ? '◀ 上一页' : '', 20, fy);
      ctx.textAlign = 'right';
      ctx.fillText(pg < tp - 1 ? '下一页 ▶' : '', L.W - 20, fy);
      ctx.restore();
    }

    // 页码（居中偏左）
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '12px sans-serif'; ctx.fillStyle = '#AAA';
    ctx.fillText('第 ' + (pg + 1) + ' / ' + tp + ' 页', L.W / 2 - 60, fy);
    ctx.restore();

    // 返回按钮（右侧对齐）
    var btnW = 110, btnH = 36, btnX = L.W - 20 - btnW, btnY = fy - btnH / 2;
    ctx.save();
    wobblyRoundRect(ctx, btnX, btnY, btnW, btnH, 10, btnX * 3, btnY * 7, 1.5);
    ctx.fillStyle = cfg.PANEL; ctx.fill();
    ctx.strokeStyle = cfg.INK; ctx.lineWidth = 2.0; ctx.stroke();
    ctx.fillStyle = cfg.INK;
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('返回', btnX + btnW / 2, fy);
    ctx.restore();
  };

  // ---------------- 总入口 ----------------

  Renderer.prototype.draw = function (game) {
    this.drawBackground();
    if (game.state === 'menu') { this.drawMenu(game); return; }
    if (game.state === 'guide') { this.drawGuide(game); return; }
    if (game.state === 'levels') { this.drawLevels(game); return; }
    // play / clear / over 都先画对局场景（世界 + 相机）
    this.drawPlay(game);
    this.drawPanel(game);
    if (game.state === 'play') {
      this.drawUnlockBanner(game); // 解锁提示横幅（在摇杆之上）
      this.drawItemToast(game);    // 特殊道具效果提示（屏幕空间，不遮挡地图）
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
