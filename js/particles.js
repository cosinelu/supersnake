'use strict';
/**
 * particles.js — 消除特效：蜡笔屑粒子 + 手绘星形闪光 + 连锁文字（DOM 无关）
 *  - burst/flash 支持 scale 参数：连锁等级越高，碎块/星形越大越多（逐级放大）；
 *  - chainText：手绘风「N连锁！」文字，上飘、短暂停留后淡出；
 *  - 粒子存活约 0.4 秒（文字 1.0 秒），由 renderer 负责绘制。
 */
(function (root) {
  var CS = root.CS = root.CS || {};

  function Particles() {
    this.list = [];
  }

  /**
   * 蜡笔屑爆发：从 (x,y) 弹射 n 个彩色小碎块。
   * @param {string} colorHex 碎块颜色（蜡笔色）
   * @param {number} n 碎块数量（调用方已按连锁倍率放大）
   * @param {number} scale 尺寸/速度倍率（连锁逐级放大用，默认 1）
   */
  Particles.prototype.burst = function (x, y, colorHex, n, scale) {
    n = n || 6;
    scale = scale || 1;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = (60 + Math.random() * 140) * scale; // px/s
      this.list.push({
        type: 'crumb',
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60 * scale, // 略向上飘
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 12,
        size: (2.5 + Math.random() * 3.5) * scale,
        color: colorHex,
        life: 0.35 + Math.random() * 0.15,
        maxLife: 0.5
      });
    }
  };

  /**
   * 星形闪光。
   * @param {number} scale 星形尺寸倍率（连锁逐级放大用，默认 1）
   * @param {number} count 星形数量（连锁越高越多，围绕消除点散开）
   */
  Particles.prototype.flash = function (x, y, colorHex, scale, count) {
    scale = scale || 1;
    count = count || 1;
    for (var i = 0; i < count; i++) {
      var a = Math.random() * Math.PI * 2;
      var d = i === 0 ? 0 : Math.random() * 20 * scale; // 第 1 颗在中心，其余散开
      var life = 0.4 + i * 0.07; // 多颗时依次晚灭，层次分明
      this.list.push({
        type: 'star',
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d,
        color: colorHex,
        scale: scale * (0.7 + Math.random() * 0.5),
        life: life,
        maxLife: life
      });
    }
  };

  /**
   * 消除高亮环：在被消除节的位置画一个扩张圆环 + 中心 ✕，标出「哪些节被消掉了」。
   * 尤其针对非连续消除（如消色/随机消除散落各处的节），让玩家一眼看清被消除位置。
   * @param {number} scale 尺寸倍率（连锁/炸弹逐级放大）
   */
  Particles.prototype.ring = function (x, y, colorHex, scale) {
    this.list.push({
      type: 'ring',
      x: x, y: y,
      color: colorHex,
      scale: scale || 1,
      life: 0.55,
      maxLife: 0.55
    });
  };

  /**
   * 连锁文字：「N连锁！」上飘 + 短暂停留淡出（手绘风，描边由 renderer 画）。
   * @param {number} size 字号（px，随连锁等级增大）
   */
  Particles.prototype.chainText = function (x, y, text, size) {
    this.list.push({
      type: 'text',
      x: x, y: y,
      vy: -30, // 上飘 px/s
      text: text,
      size: size,
      life: 1.0,
      maxLife: 1.0
    });
  };

  Particles.prototype.update = function (dtMs) {
    var dt = dtMs / 1000;
    var next = [];
    for (var i = 0; i < this.list.length; i++) {
      var p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      if (p.type === 'crumb') {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 380 * dt; // 轻重力
        p.rot += p.vr * dt;
      } else if (p.type === 'text') {
        p.y += p.vy * dt; // 匀速上飘
        p.vy *= 0.98;
      }
      next.push(p);
    }
    this.list = next;
  };

  Particles.prototype.clear = function () { this.list = []; };

  CS.Particles = Particles;
})(typeof window !== 'undefined' ? window : globalThis);
