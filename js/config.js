'use strict';
/**
 * config.js — 全局可调参数表（浏览器版 v2：自由方向 + 大地图 + 跟随镜头）
 * 玩法手感、数值平衡、美术配色都集中在这里，调参只改这个文件。
 *
 * 颜色解锁规则（调优只改下方带「解锁」注释的常量即可）：
 *   颜色池共 MAX_COLORS=8 色；开局解锁 INITIAL_UNLOCKED=4 色（红蓝绿橙）；
 *   闯关模式每 LEVEL_UNLOCK_STEP_LEVELS=2 关 +1 色；无尽模式每 ENDLESS_UNLOCK_INTERVAL_SEC=45 秒 +1 色；上限 8 色。
 *
 * v2 与 v1 差异：废弃网格/四方向，蛇头连续坐标 (x,y) + 朝向角 θ，
 * 世界为像素坐标大地图（尺寸见 levels.js），相机平滑跟随蛇头。
 */
(function (root) {
  var CS = root.CS = root.CS || {};

  var cfg = {
    // ---------- 美术配色（蜡笔 8 色，数组顺序即解锁顺序）----------
    COLORS: {
      red:    '#E8552F',  // 蜡笔红
      blue:   '#4A7FD4',  // 蜡笔蓝
      green:  '#6FBF4A',  // 蜡笔绿
      orange: '#F5A623',  // 蜡笔橙
      purple: '#9B5DE5',  // 蜡笔紫（中后期解锁）
      yellow: '#F4D35E',  // 蜡笔黄
      teal:   '#2EC4B6',  // 蜡笔青
      pink:   '#F15BB5'   // 蜡笔粉
    },
    COLOR_KEYS: ['red', 'blue', 'green', 'orange', 'purple', 'yellow', 'teal', 'pink'],

    // ---------- 颜色解锁系统参数（调优只改这里）----------
    MAX_COLORS: 8,                    // 颜色池总数（默认与 COLOR_KEYS 长度一致）
    INITIAL_UNLOCKED: 4,              // 对局开局已解锁颜色数（红蓝绿橙）
    LEVEL_UNLOCK_BASE: 4,             // 闯关解锁基数（第 1 关起点）
    LEVEL_UNLOCK_STEP_LEVELS: 2,      // 闯关：每多少关 +1 色（每 2 关解锁 1 色）
    ENDLESS_UNLOCK_BASE: 4,           // 无尽解锁基数
    ENDLESS_UNLOCK_INTERVAL_SEC: 45,  // 无尽：每存活多少秒 +1 色（每 45 秒解锁 1 色）
    UNLOCK_BANNER_MS: 1500,           // 「新颜色解锁！」横幅停留时长（毫秒）

    INK: '#3A3238',        // 统一描边色（深灰近黑）
    TAIL_COLOR: '#3A3238', // 尾巴节颜色（深色蜡笔小尾鳍：不参与消除/咬断，一眼可辨）
    PAPER: '#FBF6E9',      // 浅奶油纸色背景
    WALL_FILL: '#B7B0A6',  // 墙壁灰色蜡笔底
    PANEL: '#FFFDF5',      // 面板/按钮底色

    // ---------- 蛇与连续移动（贪食蛇大作战式）----------
    SNAKE_SPEED: 150,            // 初始前进速度（px/s），闯关由 levels.js 覆盖
    SPEED_MAX: 380,              // 无尽模式提速上限（px/s）
    ENDLESS_SPEEDUP_PER_SEC: 2.5,// 无尽：每秒速度提升（px/s）
    // ---- 局内动态加速（只改速度，不改节间距/判定等几何参数）----
    SPEED_LEN_COEF: 2.5,         // 长度加成：每节 +2.5 px/s（闯关/无尽通用，加速更明显）
    LEVEL_SPEED_TIME_COEF: 1.2,  // 闯关时间加成：每存活 1 秒 +1.2 px/s
    LEVEL_SPEED_CAP_ADD: 170,    // 闯关封顶 = 关卡基础速度 + 170 px/s
    TURN_RATE: 4.5,              // 最大转向速率（rad/s）≈ 258°/s
    SEG_RADIUS: 13,              // 节半径（px）
    SEG_SPACING: 30,             // 节间弧长间距（px）= 直径 26 + 4px 纸色间隙，保证节可逐个数清
    SEG_STROKE: 3.0,             // 节描边粗细（px，深色 INK，相邻节边界一眼可辨）
    HEAD_HIT_RADIUS: 10,         // 撞墙判定半径（略小于节半径，手感宽容）
    START_LENGTH: 5,             // 出生颜色节数（另有恒在的 +1 尾巴节，出生总长 = 6 节）
    MIN_LENGTH: 3,               // 消除保底长度（从末尾保留；只计颜色节，尾巴节恒在、不占保底计数）
    TRAIL_STEP: 3,               // 轨迹记录最小间距（px，≪ SEG_SPACING，弧长插值精度足够）
    // 收集判定半径 = SEG_RADIUS + BLOCK_RADIUS = 25px（以节中心圆形重叠为准，不随间距变化）

    // ---------- 相机 ----------
    CAMERA_LERP: 5.0,            // 跟随平滑系数（/s，帧率无关指数趋近）

    // ---------- 色块 ----------
    BLOCK_RADIUS: 12,            // 色块半径（px）

    // ---------- 消除 ----------
    ELIM_RUN: 4,           // 相邻同色 ≥4 节触发消除
    ELIM_SCORE: 5,         // 每消除 1 节基础得分；连锁第 chain 次每节 = ELIM_SCORE × chain
    CHAIN_FX_STEP: 0.6,    // 连锁特效逐级放大：倍率 = 1 + (chain-1)×0.6（chain2=1.6, chain3=2.2…）
    CHAIN_TEXT_MIN: 2,     // chain ≥ 2 才弹「N连锁！」手绘文字

    // ---------- 计分 ----------
    SURVIVE_SCORE_PER_SEC: 1, // 存活得分：1 秒 = 1 分

    // ---------- 色块刷新 ----------
    SPAWN_INTERVAL_MS: 4000,  // 刷新检查间隔
    BLOCK_AREA_DIV: 90000,    // 目标密度：世界面积 / 90000 ≈ 每 300x300 区域 1 个
    BLOCKS_MIN: 8,            // 目标数量下限
    BLOCKS_MAX: 40,           // 目标数量上限
    BLOCK_MIN_DIST: 140,      // 新色块与已有色块最小距离（px）
    BLOCK_SNAKE_DIST: 80,     // 新色块与蛇身最小距离（px）
    BLOCK_EDGE_MARGIN: 60,    // 色块距世界边界最小距离（px）
    SPAWN_TRIES: 50,          // 拒绝采样最大尝试次数

    // ---------- 特殊道具（消除游戏常见：万能色 / 炸弹 / 减速 / 消色 / 随机 / 流星）----------
    ITEM_SPECIAL_CHANCE: 0.30,  // 每次生成色块时改为特殊道具的概率（否则普通色块）—— 上调以便肉眼频繁遇到
    SLOW_MS: 4000,              // 减速道具生效时长（ms）
    SLOW_FACTOR: 0.6,           // 减速道具期间速度倍率（缓解加速压力，临时喘息）
    BOMB_SCORE: 8,              // 炸弹消除每节额外得分
    // 特殊道具按权重抽取（覆盖 wild/bomb/slow + 新增 clear/clear3/rand1-3）；绝对值仅相对意义
    ITEM_WEIGHTS: {
      wild: 0.16, bomb: 0.08, slow: 0.06,
      clear: 0.22, clear3: 0.22,          // 消色类显著上调，最易遇到
      rand1: 0.08, rand2: 0.08, rand3: 0.10 // 随机消除 1/2/3 节
    },
    CLEAR_SCORE: 6,             // 消色道具每节额外得分
    CLEAR3_SCORE: 5,            // 后 3 消色每节额外得分
    RAND_SCORE: 5,              // 随机消除每节额外得分
    // 流星砖块（移动砖块）：从四周飞入，命中身体即把该色注入中段（可靠的中段注入方案）
    METEOR_INTERVAL_MS: 3500,   // 每隔多久生成一颗（缩短 → 更频繁）
    METEOR_MAX: 6,              // 同屏上限（提高 → 场上常有）
    METEOR_SPAWN_DIST: 850,     // 出生距蛇头的世界距离（环周随机方向，缩短 → 更快进入视野）
    METEOR_SPEED: 330,          // 飞行速度（px/s）
    METEOR_TURN_RATE: 2.4,      // 轻微归向蛇头的转向速率（弧度/s，保证大概率命中身体）
    METEOR_TTL_MS: 9000,        // 未命中则存活该时长后消失
    METEOR_HIT_R: 16,           // 命中判定半径（px）
    METEOR_RADIUS: 14,          // 移动砖块视觉半径（px）
    METEOR_SCORE: 3,            // 流星注入每节得分

    // ---------- 墙壁（世界像素坐标，矩形组合）----------
    WALL_MAX_RATIO: 0.08,     // 内部墙壁总面积 ≤ 世界面积 8%
    WALL_UNIT: 48,            // 墙段基本单元边长（px），一字/L/2x2 均由整数个单元矩形组合
    WALL_EDGE_MARGIN: 70,     // 内部墙距世界边界最小距离（px）
    WALL_GAP: 60,             // 墙段之间最小间隙（px，保证通道）
    WALL_THICK: 44,           // 边界墙视觉厚度（px），排线墙带，纯视觉；撞界判定不变
    SPAWN_SAFE_RADIUS: 180,   // 出生点保护半径（px，内无墙）

    // ---------- 无尽模式世界（像素）----------
    ENDLESS: { W: 3600, H: 2400, wallSegments: 8 },

    // ---------- 多人对战模式（玩家 1 名 + AI 蛇同场竞技）----------
    MULTI: { W: 4200, H: 2800, wallSegments: 6 }, // 共享大地图；内部墙比无尽(8)略少，给追逐留空间
    MP_AI_COUNT: 6,             // 场上恒定维持的 AI 蛇数量
    MP_START_LENGTH: 5,         // AI 出生 / 重生初始颜色节数（+1 尾巴节，总长 6 节）
    MP_RESPAWN_MIN_MS: 3000,    // AI 淘汰后重生延迟下限（毫秒）
    MP_RESPAWN_MAX_MS: 5000,    // 重生延迟上限（毫秒）
    MP_AI_SPEED_MIN: 130,       // AI 基础速度档位下限（px/s，随机）
    MP_AI_SPEED_MAX: 170,       // AI 基础速度档位上限（px/s，随机）
    MP_CORPSE_STRIDE: 2,        // 尸体每隔 2 节掉 1 个色块（起点随机 0/1，≈50% 的节）
    MP_BLOCK_AREA_DIV: 70000,   // 多人色块目标密度：世界面积 / 70000（7 条蛇在吃，比单人略高）
    MP_BLOCKS_MIN: 10,          // 多人色块目标数量下限
    MP_BLOCKS_MAX: 50,          // 多人色块目标数量上限
    MP_SPAWN_EDGE_MIN: 90,      // AI 出生带：距世界边界 90~260px
    MP_SPAWN_EDGE_MAX: 260,
    MP_SPAWN_CLEAR: 320,        // AI 出生点与其他蛇的期望最小距离（px，拒绝采样尽量满足）
    // ---- 咬断机制（头撞身附加：被撞者短一节）----
    MP_BITE_MIN_LENGTH: 3,      // 咬断保底：被咬后节数低于此值 → 被撞者直接淘汰（计入撞者击杀）
    MP_BITE_FLASH_MS: 300,      // 被咬视觉反馈时长：闪白 + 抖动（毫秒）

    // ---------- AI 决策参数（加权转向，见 ai.js）----------
    AI_DIRS: 16,                // 每帧评估的候选方向数（绕一圈均匀采样）
    AI_FOOD_RANGE: 850,         // 寻食感知范围（px，再按贪食性格伸缩）
    AI_FOOD_WEIGHT: 1.0,        // 寻食基础权重
    AI_SAME_COLOR_BONUS: 1.6,   // 偏好与头部同色的色块（凑 4 连）
    AI_PROBE_NEAR: 70,          // 避障近前景点距离（px，≈1 个身位，按谨慎性格伸缩）
    AI_PROBE_FAR: 150,          // 避障远前景点距离（px，≈2 个身位，按谨慎性格伸缩）
    AI_WALL_PENALTY: 120,       // 近点撞墙罚分（几乎否决该方向）
    AI_WALL_PENALTY_FAR: 36,    // 远点撞墙罚分（提前避让）
    AI_SNAKE_AVOID: 130,        // 避蛇感知半径（px，按谨慎性格伸缩）
    AI_SNAKE_PENALTY: 80,       // 避蛇罚分系数
    AI_INERTIA: 0.35,           // 惯性分：偏好保持当前朝向（防抖动）
    AI_WANDER: 0.3,             // 随机游走噪声幅度（无威胁时小幅漂移）
    AI_NICKNAMES: [             // AI 昵称池（随机取用，场上不重复）
      '蜡笔小新', '橡皮擦', '卷卷', '小粉笔', '涂鸦侠', '彩虹糖',
      '墨墨', '皮皮', '大白', '颜料罐', '小画伯', '条条', '点点', '麻花'
    ],

    // ---------- 存储 key ----------
    STORAGE_UNLOCKED: 'crayon_snake_web_unlocked', // 闯关已解锁关卡数
    STORAGE_BEST: 'crayon_snake_web_best',         // 无尽最高分
    STORAGE_MP_BEST: 'crayon_snake_web_mp_best'    // 多人对战最佳 {len:最长节数, score:最高分}
  };

  /**
   * 闯关模式：第 n 关解锁颜色数 = min(MAX_COLORS, BASE + floor((n-1)/STEP))
   * 档位：L1/L2=4，L3/L4=5，L5/L6=6，L7/L8=7，L9/L10=8。
   */
  cfg.unlockedCountForLevel = function (n) {
    var lvl = Math.max(1, n | 0);
    var c = cfg.LEVEL_UNLOCK_BASE + Math.floor((lvl - 1) / cfg.LEVEL_UNLOCK_STEP_LEVELS);
    return Math.min(cfg.MAX_COLORS, c);
  };

  /**
   * 无尽模式：存活 surviveSec 秒后解锁颜色数 = min(MAX_COLORS, BASE + floor(sec/INTERVAL))
   * 档位：每 45 秒 +1，0~44s=4，45~89s=5，90~134s=6，135~179s=7，180s 及以上=8。
   */
  cfg.unlockedCountForEndless = function (surviveSec) {
    var sec = Math.max(0, surviveSec | 0);
    var c = cfg.ENDLESS_UNLOCK_BASE + Math.floor(sec / cfg.ENDLESS_UNLOCK_INTERVAL_SEC);
    return Math.min(cfg.MAX_COLORS, c);
  };

  /**
   * 取前 count 个已解锁颜色的 key 数组（用于刷新色块 / 蛇身颜色）。
   * @param {number} count 已解锁颜色数
   * @returns {string[]} 颜色 key 数组
   */
  cfg.unlockedColorKeys = function (count) {
    return cfg.COLOR_KEYS.slice(0, Math.min(cfg.MAX_COLORS, Math.max(0, count | 0)));
  };

  CS.config = cfg;
})(typeof window !== 'undefined' ? window : globalThis);
