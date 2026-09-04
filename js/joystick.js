'use strict';
/**
 * joystick.js — 虚拟摇杆 + 键盘输入（浏览器版 v2：输出目标角度；v3.0.2 修多点触控卡死）
 *  - 摇杆：固定底座浮在棋盘区左下角，半透明手绘风；
 *    触屏 touchstart/touchmove/touchend 与鼠标 mousedown/mousemove/mouseup 均可控制
 *    （事件转发在 main.js，鼠标 id 固定为 'mouse'）；
 *    向量方向即目标角（弧度，不再量化 4 向），死区保留。
 *  - 键盘：方向键 / WASD，按住期间有效；支持组合键（如 W+D = 右上），即 8 方向目标角；
 *    键盘优先于摇杆。
 *  - node 环境下构造安全（无 window 时跳过键盘绑定，keysDown/angle 可被测试直接注入）。
 *
 * **多点触控（v3.0.2，见 docs/design/01-game-design.md §3.7）**：
 * 早期为「单指独占锁」——onTouchStart 遇 active 直接 return、onTouchMove 要求 id 匹配。
 * 这会造成输入永久卡死：A 按着 → B 触屏被忽略 → 抬起 A → B 仍在屏上却永不响应；
 * 或倒计时按住手指、开局后摇杆从未激活 → 整局锁死。
 * 现规则：任意在屏手指均可接管；未激活时收到 move 即自动 latch；
 * 接管者抬起时把控制权转交给其它在屏手指；触点集合空才真正释放。
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
    this.touches = {};        // 在屏触点集合 id -> {x,y}（多指接管与自愈的依据）
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
    root.addEventListener('blur', function () {
      self.keysDown = {};
      self.reset(); // 失焦时触点事件不再可靠，一并清零防卡死
    });
  };

  /** 设置固定底座位置（窗口 resize / 布局变化时调用；激活中不打断） */
  Joystick.prototype.setBase = function (x, y, r) {
    if (typeof r === 'number') this.radius = r;
    if (this.active) return;
    this.baseX = x; this.baseY = y;
    this.knobX = x; this.knobY = y;
  };

  /** 按下：记入触点集合；无人接管时由该指接管 */
  Joystick.prototype.onTouchStart = function (x, y, id) {
    this.touches[id] = { x: x, y: y };
    if (!this.active) {
      this.active = true;
      this.touchId = id;
      this.updateKnob(x, y);
      return true;
    }
    return false;
  };

  /**
   * 移动：任意在屏手指都能驱动摇杆。
   * 未激活时收到 move 即由这根手指**自动接管**（latch）——覆盖「倒计时按住手指」、
   * 「代码强制重置过摇杆」、「touchstart 被状态门槛吞掉」等一切代码态与物理态脱钩的情况。
   * 已有接管者且不是这根手指时忽略，避免两指互抢导致方向抖动。
   */
  Joystick.prototype.onTouchMove = function (x, y, id) {
    this.touches[id] = { x: x, y: y };
    if (!this.active) {
      this.active = true;
      this.touchId = id;
      this.updateKnob(x, y);
      return;
    }
    if (id !== this.touchId) return;
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

  /**
   * 抬起：移出触点集合。
   * 若抬起的是当前接管者，把控制权**转交**给任意其它在屏手指（而非直接失效）；
   * 没有其它触点时才真正释放。这样「A 按着→B 触屏→抬起 A」后 B 能立即接手。
   */
  Joystick.prototype.onTouchEnd = function (id) {
    delete this.touches[id];
    if (!this.active) return;
    if (id !== this.touchId) return;   // 非接管者抬起：不影响当前操作
    for (var other in this.touches) {  // 转交给下一根还在屏上的手指
      this.touchId = other;
      this.updateKnob(this.touches[other].x, this.touches[other].y);
      return;
    }
    this.release();
  };

  /** 真正释放摇杆（已无在屏触点）：清激活态与角度，摇杆头归位 */
  Joystick.prototype.release = function () {
    this.active = false;
    this.touchId = null;
    this.angle = null;
    this.knobX = this.baseX;
    this.knobY = this.baseY;
  };

  /**
   * 场景切换/对局开始时的硬重置：连在屏触点集合一并清空。
   * 注意：对局开始时应优先用 latchExisting（若手指还按着，直接接管而不是丢弃）。
   */
  Joystick.prototype.reset = function () {
    this.touches = {};
    this.release();
  };

  /**
   * 进入 play 态时若已有在屏触点，立即用它 latch。
   * 覆盖「倒计时就按住手指、开局后只有 touchmove 在流」的场景（原会整局锁死）。
   * @returns {boolean} 是否成功接管
   */
  Joystick.prototype.latchExisting = function () {
    if (this.active) return false;
    for (var id in this.touches) {
      this.active = true;
      this.touchId = id;
      this.updateKnob(this.touches[id].x, this.touches[id].y);
      return true;
    }
    return false;
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
