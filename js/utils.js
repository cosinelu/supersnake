'use strict';
/**
 * utils.js — 工具函数：确定性伪随机、数学助手、角度助手（DOM 无关）
 */
(function (root) {
  var CS = root.CS = root.CS || {};

  /**
   * 确定性二维哈希 → [0,1)
   * 用于手绘抖动的"固定伪随机"：同一种子每帧结果一致，避免闪烁。
   */
  function hash2(x, y, k) {
    var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul((k | 0) + 1, 974634211)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function manhattan(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }

  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

  /** 角度归一化到 (-PI, PI]（用于取最短转向方向） */
  function normAngle(a) {
    while (a <= -Math.PI) a += Math.PI * 2;
    while (a > Math.PI) a -= Math.PI * 2;
    return a;
  }

  /**
   * 当前角向目标角逼近，单步最大变化 maxDelta（弧度）。
   * 返回新角度；|差值| ≤ maxDelta 时直接到达目标角。
   */
  function turnToward(angle, target, maxDelta) {
    var diff = normAngle(target - angle);
    if (Math.abs(diff) <= maxDelta) return target;
    return angle + (diff > 0 ? maxDelta : -maxDelta);
  }

  CS.utils = {
    hash2: hash2, clamp: clamp, manhattan: manhattan,
    dist: dist, normAngle: normAngle, turnToward: turnToward
  };
})(typeof window !== 'undefined' ? window : globalThis);
