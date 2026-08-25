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
    var colors = snake.colors;

    var probeN = cfg.AI_PROBE_NEAR * (0.8 + 0.4 * caution); // 谨慎者近景看得更远
    var probeF = cfg.AI_PROBE_FAR * caution;                 // 远景观测（提前避让 + 自卷检测）
    var bodyR = cfg.AI_SNAKE_AVOID * (0.7 + 0.5 * caution);  // 避其他蛇身半径
    var bodyR2 = bodyR * bodyR;
    var selfR = cfg.AI_SELF_AVOID * (0.7 + 0.4 * caution);   // 避自身蛇身半径
    var selfR2 = selfR * selfR;
    var range = cfg.AI_FOOD_RANGE * (0.7 + 0.5 * greed);     // 贪食者感知更大
    var foodW = cfg.AI_FOOD_WEIGHT * greed;

    var best = snake.angle, bestScore = -Infinity;
    for (var k = 0; k < cfg.AI_DIRS; k++) {
      var cand = snake.angle + (k / cfg.AI_DIRS) * Math.PI * 2;
      var dx = Math.cos(cand), dy = Math.sin(cand);

      // 惯性（k=0 即当前朝向，得分最高）+ 游走噪声
      var score = cfg.AI_INERTIA * Math.cos(u.normAngle(cand - snake.angle));
      score += (Math.random() - 0.5) * cfg.AI_WANDER;

      // ① 寻食：对齐度 × 距离衰减；同色加成；「差 1~2 节即凑成 4 连消除」额外加权（更会规划消除）
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var bx = b.x - snake.x, by = b.y - snake.y;
        var d = Math.sqrt(bx * bx + by * by);
        if (d > range || d < 1e-6) continue;
        var align = (bx / d) * dx + (by / d) * dy; // cos(候选方向, 指向色块方向)
        if (align <= 0) continue;
        var fall = 1 - d / range;
        var w = foodW * align * fall;
        if (b.color === headColor) w *= cfg.AI_SAME_COLOR_BONUS;
        // 头段同色连续长度（含 wild）：吃到该色后能凑成 ≥3 连 → 离 4 连消除仅差 1 节，强烈偏好
        var run = 0;
        for (var r = 0; r < colors.length; r++) {
          var c = colors[r];
          if (c === b.color || c === 'wild') run++; else break;
        }
        if (run >= 2) w += foodW * cfg.AI_RUN_BONUS * align * fall * (run >= 3 ? 1.6 : 1);
        score += w;
      }

      // ② 避墙：近点重罚（几乎否决），近点安全才看远点（提前避让）
      var pnx = snake.x + dx * probeN, pny = snake.y + dy * probeN;
      var pfx = snake.x + dx * probeF, pfy = snake.y + dy * probeF; // 远点（自卷检测用）
      if (walls.hitsCircle(pnx, pny, cfg.HEAD_HIT_RADIUS + 4)) {
        score -= cfg.AI_WALL_PENALTY;
      } else if (walls.hitsCircle(pfx, pfy, cfg.HEAD_HIT_RADIUS + 4)) {
        score -= cfg.AI_WALL_PENALTY_FAR;
      }

      // ③ 避蛇身 / ④ 头对头规避 / ⑤ 自卷规避（统一累加惩罚，超阈值提前退出省性能）
      var pen = 0;
      for (i = 0; i < snakes.length; i++) {
        var o = snakes[i];
        var isSelf = (o === snake);
        var sp = o.segPos;
        for (var j = 0; j < sp.length; j++) {
          var sx = sp[j].x, sy = sp[j].y;
          if (isSelf) {
            if (j < 3) continue; // 头/脖子/次节恒在身后，跳过避免误判
            var ddx2 = sx - pfx, ddy2 = sy - pfy; // 自卷用远点：前方路径撞上自身远处身体才危险
            var dd2s = ddx2 * ddx2 + ddy2 * ddy2;
            if (dd2s < selfR2) {
              pen += cfg.AI_SELF_PENALTY * (1 - Math.sqrt(dd2s) / selfR) * 0.6;
            }
          } else {
            var ddx = sx - pnx, ddy = sy - pny;
            var dd2 = ddx * ddx + ddy * ddy;
            if (dd2 < bodyR2) {
              var nd = Math.sqrt(dd2);
              pen += cfg.AI_SNAKE_PENALTY * (1 - nd / bodyR);
              if (j === 0 && nd < bodyR) pen += cfg.AI_HEADON_PENALTY * (1 - nd / bodyR); // 头对头最危险
            }
          }
        }
        if (pen > 300) break; // 已经足够危险，提前退出省性能
      }
      if (pen > 0) score -= Math.min(600, pen);

      if (score > bestScore) { bestScore = score; best = cand; }
    }
    return u.normAngle(best);
  }

  CS.AI = { decide: decide };
})(typeof window !== 'undefined' ? window : globalThis);
