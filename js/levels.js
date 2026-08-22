'use strict';
/**
 * levels.js — 闯关模式 10 关参数（v2：世界为像素坐标大地图，宽 > 高）
 * 第 n 关：世界 2400x1600 → 5200x3600 递增，墙壁段数递增，蛇速微增，目标分 = 40 + n*20。
 */
(function (root) {
  var CS = root.CS = root.CS || {};

  var LEVEL_COUNT = 10;

  /**
   * @param {number} n 关卡号 1..10
   * @returns {{level:number,W:number,H:number,wallSegments:number,targetScore:number,speed:number}}
   *   W/H 为世界尺寸（像素）
   */
  function levelConfig(n) {
    var t = (n - 1) / (LEVEL_COUNT - 1); // 0..1
    return {
      level: n,
      W: Math.round(2400 + (5200 - 2400) * t),      // 2400 → 5200 世界宽（px）
      H: Math.round(1600 + (3600 - 1600) * t),      // 1600 → 3600 世界高（px）
      wallSegments: 3 + Math.round(t * 7),          // 3 → 10 段内部墙壁
      targetScore: 40 + n * 20,                     // 第1关60分 … 第10关240分
      speed: 150 + (n - 1) * 9                      // 150 → 231 px/s 微加速
    };
  }

  CS.levels = { LEVEL_COUNT: LEVEL_COUNT, levelConfig: levelConfig };
})(typeof window !== 'undefined' ? window : globalThis);
