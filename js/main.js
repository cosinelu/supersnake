'use strict';
/**
 * main.js — 启动引导（浏览器版）：画布初始化、屏幕适配、输入转发、主循环
 *  - 画布按设备像素比（devicePixelRatio）缩放，逻辑坐标 = CSS 像素；
 *  - window resize 时重设画布尺寸并通知 game/renderer 重新布局；
 *  - 输入：touchstart/move/end + mousedown/move/up 统一转发给 game
 *    （鼠标 id 固定为 'mouse'，方便电脑上用鼠标拖动摇杆试玩）；
 *  - 主循环用 requestAnimationFrame，蛇的连续移动/转向由 game.update(dt) 每帧驱动。
 */
(function (root) {
  var CS = root.CS;

  function boot() {
    var canvas = document.getElementById('game');
    var ctx = canvas.getContext('2d');

    var game = new CS.Game(window.innerWidth, window.innerHeight);
    var renderer = new CS.Renderer(ctx, window.innerWidth, window.innerHeight);
    root.__game = game; // 调试钩子：控制台/WebBridge 可读取对局状态（无功能影响）

    function resize() {
      var w = window.innerWidth, h = window.innerHeight;
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 之后全部用逻辑像素绘制
      game.resize(w, h);
      renderer.resize(w, h);
    }
    window.addEventListener('resize', resize);
    resize();

    // ---------- 触摸输入 ----------
    canvas.addEventListener('touchstart', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        game.onTouchStart(t.clientX, t.clientY, t.identifier);
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        game.onTouchMove(t.clientX, t.clientY, t.identifier);
      }
    }, { passive: false });
    function onTouchEnd(e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        game.onTouchEnd(e.changedTouches[i].identifier);
      }
    }
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

    // ---------- 鼠标输入（桌面端拖动摇杆 / 点按钮） ----------
    var mouseDown = false;
    canvas.addEventListener('mousedown', function (e) {
      mouseDown = true;
      game.onTouchStart(e.clientX, e.clientY, 'mouse');
    });
    window.addEventListener('mousemove', function (e) {
      if (mouseDown) game.onTouchMove(e.clientX, e.clientY, 'mouse');
    });
    window.addEventListener('mouseup', function (e) {
      if (mouseDown) {
        mouseDown = false;
        game.onTouchEnd('mouse');
      }
    });

    // ---------- 主循环 ----------
    var last = 0;
    function loop(ts) {
      var now = (typeof ts === 'number' && ts > 0) ? ts : Date.now();
      if (!last) last = now;
      var dt = now - last;
      last = now;
      if (dt > 100) dt = 100; // 切后台回来防跳帧
      game.update(dt);
      renderer.draw(game);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
