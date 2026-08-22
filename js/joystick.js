'use strict';
/**
 * joystick.js — 虚拟摇杆 + 键盘输入（浏览器版 v2：输出目标角度）
 *  - 摇杆：固定底座浮在棋盘区左下角，半透明手绘风；
 *    触屏 touchstart/touchmove/touchend 与鼠标 mousedown/mousemove/mouseup 均可控制
 *    （事件转发在 main.js，鼠标 id 固定为 'mouse'）；
 *    向量方向即目标角（弧度，不再量化 4 向），死区保留。
 *  - 键盘：方向键 / WASD，按住期间有效；支持组合键（如 W+D = 右上），即 8 方向目标角；
 *    键盘优先于摇杆。
 *  - node 环境下构造安全（无 window 时跳过键盘绑定，keysDown/angle 可被测试直接注入）。
 */
(function (root) {
  var CS = root.CS = root.CS || {};

  var DEAD_ZONE = 16;   // 死区半径（px）：触点距底座中心小于此不产生目标角
  var KNOB_MAX = 40;    // 摇杆头最大偏移（px）

  function mapKey(k) {
    if (!k) return null;
    k = String(k).toLowerCase();
    if (k === 'arrowup' || k === 'w') return { x: 0, y: -1 };
    if (k === 'arrowdown' || k === 's') return { x: 0, y: 1 };
    if (k === 'arrowleft' || k === 'a') return { x: -1, y: 0 };
    if (k === 'arrowright' || k === 'd') return { x: 1, y: 0 };
    return null;
  }

  function Joystick() {
    this.active = false;
    this.touchId = null;
    this.baseX = 0; this.baseY = 0;
    this.radius = 52;         // 底座半径（渲染用，由 game.syncJoystick 按布局调整）
    this.knobX = 0; this.knobY = 0;
    this.angle = null;        // 摇杆当前目标角（弧度，死区内保持上一值）
    this.keysDown = {};       // 键盘按住的方向键 key -> 单位向量
    this.bindKeyboard();
  }

  Joystick.prototype.bindKeyboard = function () {
    if (typeof root.addEventListener !== 'function') return; // node 环境跳过
    var self = this;
    root.addEventListener('keydown', function (e) {
      var d = mapKey(e.key);
      if (d) {
        self.keysDown[String(e.key).toLowerCase()] = d;
        if (e.preventDefault) e.preventDefault(); // 阻止方向键滚动页面
      }
    });
    root.addEventListener('keyup', function (e) {
      delete self.keysDown[String(e.key).toLowerCase()];
    });
    root.addEventListener('blur', function () { self.keysDown = {}; });
  };

  /** 设置固定底座位置（窗口 resize / 开局布局变化时调用；激活中不打断） */
  Joystick.prototype.setBase = function (x, y, r) {
    if (typeof r === 'number') this.radius = r;
    if (this.active) return;
    this.baseX = x; this.baseY = y;
    this.knobX = x; this.knobY = y;
  };

  Joystick.prototype.onTouchStart = function (x, y, id) {
    if (this.active) return false;
    this.active = true;
    this.touchId = id;
    this.updateKnob(x, y);
    return true;
  };

  Joystick.prototype.onTouchMove = function (x, y, id) {
    if (!this.active || id !== this.touchId) return;
    this.updateKnob(x, y);
  };

  /** 触点 → 摇杆头位置 + 自由方向目标角（相对固定底座，保留死区） */
  Joystick.prototype.updateKnob = function (x, y) {
    var dx = x - this.baseX, dy = y - this.baseY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var kx = dx, ky = dy;
    if (dist > KNOB_MAX) { // 摇杆头限制在最大半径内
      kx = dx / dist * KNOB_MAX;
      ky = dy / dist * KNOB_MAX;
    }
    this.knobX = this.baseX + kx;
    this.knobY = this.baseY + ky;
    if (dist >= DEAD_ZONE) {
      this.angle = Math.atan2(dy, dx); // 向量方向即目标角，不量化
    }
  };

  Joystick.prototype.onTouchEnd = function (id) {
    if (!this.active || id !== this.touchId) return;
    this.active = false;
    this.touchId = null;
    this.angle = null;
    this.knobX = this.baseX;
    this.knobY = this.baseY;
  };

  /** 键盘组合向量（支持 8 方向）：无按键返回 null */
  Joystick.prototype.keyVector = function () {
    var x = 0, y = 0, n = 0;
    for (var k in this.keysDown) {
      x += this.keysDown[k].x; y += this.keysDown[k].y; n++;
    }
    if (!n || (x === 0 && y === 0)) return null; // 对按抵消视为无输入
    return { x: x, y: y };
  };

  /** 当前期望目标角（弧度）：键盘优先（方便调试与桌面端），其次摇杆；无输入返回 null */
  Joystick.prototype.currentAngle = function () {
    var kv = this.keyVector();
    if (kv) return Math.atan2(kv.y, kv.x);
    return this.angle;
  };

  CS.Joystick = Joystick;
  CS.joystick = { DEAD_ZONE: DEAD_ZONE, KNOB_MAX: KNOB_MAX, mapKey: mapKey };
})(typeof window !== 'undefined' ? window : globalThis);
