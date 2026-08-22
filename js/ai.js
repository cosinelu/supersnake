'use strict';
/**
 * ai.js — 多人对战 AI 决策（加权转向，DOM 无关）
 * 每帧为一条 AI 蛇产出目标角（弧度）：
 *  在 AI_DIRS 个候选方向（绕当前朝向均匀采样一整圈）上打分，取最高分：
 *   ① 寻食：感知范围内色块按「方向对齐度 × 距离衰减」加分，与头部同色 ×AI_SAME_COLOR_BONUS
 *      （凑 4 连的动机），整体权重按贪食性格 greed 伸缩；
 *   ② 避墙：沿候选方向取近（≈1 身位）/ 远（≈2 身位）两个前景点，撞边界/内部墙则罚分
 *      （近点重罚 ≈ 否决，远点轻罚 = 提前避让），探测距离按谨慎性格 caution 伸缩；
 *   ③ 避蛇：近前景点附近出现其他蛇（含玩家）身体节则按接近程度罚分；
 *   ④ 惯性 + 游走：保持当前朝向有小幅加分（防抖动），叠加小随机噪声（无威胁时漂移）。
 * 公平性：AI 只输出目标角，转向速率与玩家一样由 Snake.update 的 TURN_RATE 钳制。
 * 输出保证为有限角度（所有打分项有限，候选方向有限），不会出现 NaN。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var u = CS.utils;

  /**
   * @param {Snake} snake 决策对象（本人蛇）
   * @param {object} env { walls, blocks, snakes } 环境快照引用（snakes 含自己与所有活蛇）
   * @param {object} persona 性格参数 { greed: 0.6~1.4 贪食, caution: 0.6~1.4 谨慎 }
   * @returns {number} 目标角（弧度，(-PI, PI] 内的有限值）
   */
  function decide(snake, env, persona) {
    persona = persona || {};
    var greed = persona.greed || 1;
    var caution = persona.caution || 1;
    var walls = env.walls;
    var blocks = env.blocks || [];
    var snakes = env.snakes || [];
    var headColor = snake.headColor();

    var probeN = cfg.AI_PROBE_NEAR * (0.8 + 0.4 * caution); // 谨慎者看得更远
    var probeF = cfg.AI_PROBE_FAR * caution;
    var avoidR = cfg.AI_SNAKE_AVOID * (0.7 + 0.5 * caution);
    var range = cfg.AI_FOOD_RANGE * (0.7 + 0.5 * greed);    // 贪食者感知更大
    var foodW = cfg.AI_FOOD_WEIGHT * greed;

    var best = snake.angle, bestScore = -Infinity;
    for (var k = 0; k < cfg.AI_DIRS; k++) {
      var cand = snake.angle + (k / cfg.AI_DIRS) * Math.PI * 2;
      var dx = Math.cos(cand), dy = Math.sin(cand);

      // ④ 惯性（k=0 即当前朝向，得分最高）+ 游走噪声
      var score = cfg.AI_INERTIA * Math.cos(u.normAngle(cand - snake.angle));
      score += (Math.random() - 0.5) * cfg.AI_WANDER;

      // ① 寻食：对齐度 × 距离衰减，同色加成
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var bx = b.x - snake.x, by = b.y - snake.y;
        var d = Math.sqrt(bx * bx + by * by);
        if (d > range || d < 1e-6) continue;
        var align = (bx / d) * dx + (by / d) * dy; // cos(候选方向, 指向色块方向)
        if (align <= 0) continue;
        var w = foodW * align * (1 - d / range);
        if (b.color === headColor) w *= cfg.AI_SAME_COLOR_BONUS;
        score += w;
      }

      // ② 避墙：近点重罚（几乎否决），近点安全才看远点（提前避让）
      var pnx = snake.x + dx * probeN, pny = snake.y + dy * probeN;
      if (walls.hitsCircle(pnx, pny, cfg.HEAD_HIT_RADIUS + 4)) {
        score -= cfg.AI_WALL_PENALTY;
      } else if (walls.hitsCircle(snake.x + dx * probeF, snake.y + dy * probeF, cfg.HEAD_HIT_RADIUS + 4)) {
        score -= cfg.AI_WALL_PENALTY_FAR;
      }

      // ③ 避蛇：近前景点与其他蛇（含玩家）任一节的接近程度（含对手的头）
      var danger = 0;
      for (i = 0; i < snakes.length; i++) {
        var o = snakes[i];
        if (o === snake) continue;
        var sp = o.segPos;
        for (var j = 0; j < sp.length; j++) {
          var ddx = sp[j].x - pnx, ddy = sp[j].y - pny;
          var dd2 = ddx * ddx + ddy * ddy;
          if (dd2 < avoidR * avoidR) {
            danger += (avoidR - Math.sqrt(dd2)) / avoidR;
            if (danger > 2) break; // 已经足够危险，提前退出省性能
          }
        }
        if (danger > 2) break;
      }
      if (danger > 0) score -= cfg.AI_SNAKE_PENALTY * Math.min(2, danger);

      if (score > bestScore) { bestScore = score; best = cand; }
    }
    return u.normAngle(best);
  }

  CS.AI = { decide: decide };
})(typeof window !== 'undefined' ? window : globalThis);
