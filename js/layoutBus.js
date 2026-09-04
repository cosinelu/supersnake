'use strict';
/**
 * layoutBus.js — 全局重排事件总线（v3.0.5）
 *
 * 设计见 docs/design/01-game-design.md §3.8.3-D。
 *
 * 为什么需要它：原先各界面在 draw 里临时判断朝向，旋转后**缓存不会失效**
 * （按钮矩形、文本测量值、面板几何都还是旧朝向算出来的），于是出现
 * 「转了屏但布局没跟着变」。正确做法是把所有尺寸变化源收敛成一个事件，
 * 由各订阅者各自清缓存、各自重算。
 *
 * 本模块 **DOM 无关**（不引用 window / document / 任何浏览器 API），
 * 因此 node 测试里可以直接 emit 来验证订阅者的反应。
 * 事件源的接线（resize / orientationchange / visualViewport）放在 main.js。
 */
(function (root) {
  var CS = root.CS = root.CS || {};

  /** 矮屏阈值：真机横屏（360~390px 高）都落在此区间，见 §3.8.2 */
  var SHORT_H = 460;

  function LayoutBus() {
    this._subs = {};      // { event: [fn, ...] }
    this.last = null;     // 最近一次派发的 metrics（供后订阅者补齐状态）
    this.emitCount = 0;   // 派发计数（监控/测试用）
  }

  /**
   * 订阅事件。
   * @param {string} ev 事件名（目前只有 'relayout'）
   * @param {Function} fn 回调，收到 metrics 对象
   * @returns {Function} 取消订阅的函数
   */
  LayoutBus.prototype.on = function (ev, fn) {
    if (typeof fn !== 'function') return function () {};
    if (!this._subs[ev]) this._subs[ev] = [];
    this._subs[ev].push(fn);
    var self = this;
    return function () { self.off(ev, fn); };
  };

  /** 取消订阅（同一函数多次订阅时只移除第一个） */
  LayoutBus.prototype.off = function (ev, fn) {
    var a = this._subs[ev];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };

  /**
   * 派发事件。单个订阅者抛异常不影响其余订阅者（布局是表现层，
   * 一个界面算错不该让整个游戏黑屏）。
   * @param {string} ev
   * @param {object} payload
   */
  LayoutBus.prototype.emit = function (ev, payload) {
    this.emitCount++;
    if (ev === 'relayout') this.last = payload;
    var a = this._subs[ev];
    if (!a || !a.length) return;
    var list = a.slice();            // 快照：回调里可安全 on/off
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) {
        if (root.console && root.console.warn) {
          root.console.warn('[layoutBus] 订阅者异常 (' + ev + '):', e && e.message);
        }
      }
    }
  };

  /**
   * 由宽高构造标准 metrics —— 朝向与矮屏的判定**只在这里做一次**，
   * 各界面不得自行判断，避免口径漂移。
   * @param {number} w 逻辑宽（CSS 像素）
   * @param {number} h 逻辑高
   * @returns {{W:number,H:number,portrait:boolean,short:boolean}}
   */
  LayoutBus.prototype.metrics = function (w, h) {
    return {
      W: w,
      H: h,
      portrait: h > w,      // 与 Game.layout() 同一口径
      short: h < SHORT_H    // 矮屏（手机横屏）
    };
  };

  /** 便捷方法：构造 metrics 并派发 relayout */
  LayoutBus.prototype.relayout = function (w, h) {
    var m = this.metrics(w, h);
    this.emit('relayout', m);
    return m;
  };

  /** 订阅者总数（测试/监控用） */
  LayoutBus.prototype.count = function (ev) {
    var a = this._subs[ev];
    return a ? a.length : 0;
  };

  CS.LayoutBus = LayoutBus;
  CS.layoutBus = new LayoutBus();   // 全局单例
  CS.LAYOUT_SHORT_H = SHORT_H;

  if (typeof module !== 'undefined' && module.exports) module.exports = LayoutBus;
})(typeof window !== 'undefined' ? window : globalThis);
