'use strict';
/**
 * multiplayer.js — 多人对战模式编排（N 名真人玩家 + AI 蛇，DOM 无关）
 * 职责：
 *  - 蛇管理：真人玩家 N 名（v3.0 起支持多真人，见 addPlayer；本地单机对局为 1 名）+ AI 蛇
 *    （v2.8.7 起**动态增长**：开局 MP_AI_START_COUNT 条（默认 3），
 *    （独立 Snake 实例、昵称、基础速度档位、性格参数 greed/caution、击杀数、消除分、历史最长节数）；
 *  - 淘汰：头撞墙/边界 → 淘汰；头撞其他蛇身体节 → 淘汰（身体主人记 1 击杀）；
 *    头对头相撞 → 两条都淘汰（简单公平，不记击杀）；不做蛇身自碰（沿用现有设计）；
 *  - 咬断（v2.2，头撞身附加效果）：A 头撞 B 身体时，B 被咬中那一节（segPos[1..] 中
 *    离 A 头心最近的「颜色节」，v2.3 起排除末尾恒在的尾巴节）从颜色序列移除
 *    （短一节，身体由轨迹自然收拢）；尾巴节仍算身体——头撞上尾巴照样淘汰撞者，
 *    只是不产生咬断；被咬后 B 节数
 *    低于 MP_BITE_MIN_LENGTH → B 直接淘汰（尸体掉落、计入 A 的击杀）；被咬移除后
 *    立即按正常规则检查消除（凑成 ≥4 连同色照常连锁/倍率计分，分数记 B）；
 *    被咬处迸小粒子 + B 短暂闪白/抖动（MP_BITE_FLASH_MS），AI 与玩家一视同仁；
 *  - 尸体掉落：被淘汰蛇的颜色序列按节在原地散落成色块（每隔 MP_CORPSE_STRIDE 节掉 1 个，
 *    起点随机 → ≈50% 的节变成可吃色块），多人模式的主要资源循环；
 *  - 补充：AI 淘汰后延迟 MP_RESPAWN_MIN_MS~MP_RESPAWN_MAX_MS 在世界边缘、远离其他蛇的
 *    安全位置重生（初始 MP_START_LENGTH 节），维持编制；真人不重生（由 game/room 结算）；
 *  - 吃色/消除：所有蛇共用同一套 grow / 4 连消除连锁逻辑（Snake 类原样复用）；
 *    连锁倍率计分与特效与单人模式一致（消除分计入各真人 Entry，AI 的 elimScore 仅供调试）；
 *  - 速度：所有蛇按 基础速度 + SPEED_LEN_COEF×节数 + ENDLESS_SPEEDUP_PER_SEC×存活秒 动态加速，
 *    封顶 SPEED_MAX（AI 基础速度在 MP_AI_SPEED_MIN~MAX 随机，玩家用 SNAKE_SPEED）。
 *
 * v3.0 联机改造（对本地单机行为完全等价）：
 *  - players[]：真人 Entry 列表（addPlayer 加入；setup() 无真人时回退为本地单真人 game.snake）；
 *  - liveSnakes[]：全部活蛇活引用（spawner.others 改用它，多真人时刷新避让所有真人）；
 *  - 连击 combo / 生存分 survivalScore / 彩色星加成 mpBonusScore 下沉到 Entry
 *    （本地单真人时由 game.updateMulti 每帧同步回 game 字段，显示与结算不变）；
 *  - 流星砖块目标从「唯一玩家蛇」改为「全部存活真人蛇」（单人时行为不变）；
 *  - onMpEvent(kind, data) 钩子：game 实现时接收离散事件（death/elim/bite/item/grab/toast/
 *    self_pull），供服务器广播；本地 Game 不实现 → 零行为变化。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var u = CS.utils;
  var Snake = CS.Snake;

  var nextId = 1;

  /** 重置 id 计数（测试用：保证同种子双跑时 id 序列一致） */
  function resetIds() { nextId = 1; }

  /** 一条参赛蛇的档案（真人玩家或 AI） */
  function Entry(snake, name, isPlayer) {
    this.id = nextId++;
    this.snake = snake;
    this.name = name;
    this.isPlayer = !!isPlayer;
    this.alive = true;
    this.kills = 0;        // 击杀数：其他蛇撞到我方身体节而死（含咬断保底淘汰）
    this.elimScore = 0;    // 消除分（连锁倍率，规则同单人）
    this.elimTotal = 0;    // 累计消除方块：本局通过消除移除的总节数（含连锁、含被咬触发）
    this.bittenUntil = 0;  // 被咬闪白/抖动截止时刻（mp.timeMs，0 = 无反馈）
    this.slowUntil = 0;    // 减速道具到期时刻（mp.timeMs，0 = 未生效）
    this.maxLen = snake.length(); // 历史最长节数（结算最佳成绩用）
    this.base = cfg.SNAKE_SPEED;  // 基础速度档位（AI 在 spawnBot 随机覆盖）
    this.greed = 1;        // 性格：贪食权重（AI 决策用）
    this.caution = 1;      // 性格：谨慎权重（避障/避蛇距离）
    this.diedAt = 0;
    // v3.0：计分状态下沉到 Entry（多真人各自独立计分；本地单真人由 game.updateMulti 同步回 game）
    this.combo = 0;           // 连击层数（窗口内连续消除 +1，分数 ×combo）
    this.comboTimer = 0;      // 连击剩余窗口（ms），每帧衰减
    this.survivalScore = 0;   // 生存分（存活秒 × SURVIVE_SCORE_PER_SEC，死亡后冻结）
    this.mpBonusScore = 0;    // 彩色星加成（吃到即 +20% 当前总分，可累计叠加）
  }

  /**
   * @param {Game} game 宿主游戏实例（读 walls/spawner/particles/unlockedKeys/snake；
   *   联机服务器传入 HeadlessGame 桩，字段面相同）
   */
  function Multiplayer(game) {
    this.game = game;
    this.walls = game.walls;
    this.spawner = game.spawner;
    this.particles = game.particles;
    this.timeMs = 0;
    this.players = [];       // 全部真人 Entry（本地模式恒为 1 名）
    this.playerEntry = null; // 首位真人（本地模式 = 本机玩家，game.js/renderer 沿用）
    this.bots = [];          // 全部 AI Entry（含已淘汰的，死亡 FX 引用）
    this.botSnakes = [];     // 活体 AI 蛇数组（活引用）
    this.liveSnakes = [];    // 全部活蛇活引用（真人 + AI；spawner.others 刷新避让用）
    this.respawnQueue = [];  // [{at}] 待重生时刻表
    this.usedNames = {};     // 场上已占用昵称（防重名）
    this.respawned = 0;      // 累计重生次数（测试/统计）
  }

  // ---------------- 事件钩子 ----------------

  /** 离散事件钩子：game 实现 onMpEvent 时上报（服务器广播用；本地 Game 不实现则为空操作） */
  Multiplayer.prototype.emitEv = function (kind, data) {
    var g = this.game;
    if (g && typeof g.onMpEvent === 'function') g.onMpEvent(kind, data);
  };

  // ---------------- 编制管理 ----------------

  /** 从昵称池取一个场上未占用的名字（池子耗尽则加序号兜底） */
  Multiplayer.prototype.pickName = function () {
    var pool = cfg.AI_NICKNAMES;
    for (var t = 0; t < 40; t++) {
      var n = pool[Math.floor(Math.random() * pool.length)];
      if (!this.usedNames[n]) { this.usedNames[n] = true; return n; }
    }
    var fallback = '无名氏' + (nextId % 100);
    this.usedNames[fallback] = true;
    return fallback;
  };

  /**
   * 加入一名真人玩家（v3.0）：外部构造好 Snake（出生点由调用方选定）后注册。
   * 首位真人同时成为 playerEntry（本地单机对局的"我"）。
   */
  Multiplayer.prototype.addPlayer = function (snake, name) {
    var e = new Entry(snake, name || '我', true);
    this.players.push(e);
    this.liveSnakes.push(snake);
    if (!this.playerEntry) this.playerEntry = e;
    return e;
  };

  /** 初始化：真人 Entry（未 addPlayer 时回退包裹 game.snake，本地兼容）+ 补足 AI 编制 */
  Multiplayer.prototype.setup = function () {
    if (!this.players.length) this.addPlayer(this.game.snake, '我'); // 本地单真人（原行为）
    // 开局只生成初始数量的 AI（后续随时间增长）
    var startCount = cfg.MP_AI_START_COUNT || cfg.MP_AI_COUNT;
    for (var i = 0; i < startCount; i++) this.spawnBot(0); // 早期 AI，智力普通
    this.spawner.others = this.liveSnakes; // 活引用：重生/淘汰自动反映到刷新避让（含全部真人）
  };

  /** 全部 Entry（真人在前，含已淘汰） */
  Multiplayer.prototype.allEntries = function () {
    return this.players.concat(this.bots);
  };

  /** 全部活蛇的 Snake 实例（AI 决策 / 出生避让用） */
  Multiplayer.prototype.aliveSnakes = function () {
    var es = this.allEntries(), arr = [];
    for (var i = 0; i < es.length; i++) if (es[i].alive) arr.push(es[i].snake);
    return arr;
  };

  /** 存活真人数量（联机房间结算判定用） */
  Multiplayer.prototype.alivePlayerCount = function () {
    var n = 0;
    for (var i = 0; i < this.players.length; i++) if (this.players[i].alive) n++;
    return n;
  };

  Multiplayer.prototype.aliveBotCount = function () {
    var n = 0;
    for (var i = 0; i < this.bots.length; i++) if (this.bots[i].alive) n++;
    return n;
  };

  /**
   * 根据存活时间计算当前应有的 AI 数量（线性增长：从 MP_AI_START_COUNT 到 MP_AI_MAX_COUNT）。
   * @param {number} surviveSec 存活秒数
   * @returns {number} 当前目标 AI 数量
   */
  Multiplayer.prototype.targetAiCount = function (surviveSec) {
    var start = cfg.MP_AI_START_COUNT || 3;
    var max = cfg.MP_AI_MAX_COUNT || 14;
    var interval = cfg.MP_AI_GROW_INTERVAL_SEC || 25;
    // 每过 interval 秒 +1，封顶 max
    var count = start + Math.floor(surviveSec / interval);
    return Math.min(max, Math.max(start, count));
  };

  /** 当前智力等级（0~1，随时间从 0 渐变到 1） */
  Multiplayer.prototype.currentSmartness = function () {
    var sec = this.timeMs / 1000;
    var start = cfg.MP_AI_START_COUNT || 3;
    var max = cfg.MP_AI_MAX_COUNT || 14;
    var interval = cfg.MP_AI_GROW_INTERVAL_SEC || 25;
    // 智力等级 = 已增长的步数 / 总增长步数
    var totalSteps = max - start;
    if (totalSteps <= 0) return 1;
    var grown = Math.min(totalSteps, Math.floor(sec / interval));
    return grown / totalSteps; // 0 → 1
  };

  /**
   * 在世界边缘带（距边界 MP_SPAWN_EDGE_MIN~MAX px）找一个远离其他蛇的出生点。
   * 拒绝采样最多 60 次，取「与其他蛇最小距离」最大的候选；达到期望净距提前收工。
   */
  Multiplayer.prototype.findSpawn = function () {
    var w = this.walls;
    var best = null, bestD = -1;
    var snakes = this.aliveSnakes();
    for (var t = 0; t < 60; t++) {
      var inset = cfg.MP_SPAWN_EDGE_MIN + Math.random() * (cfg.MP_SPAWN_EDGE_MAX - cfg.MP_SPAWN_EDGE_MIN);
      var side = Math.floor(Math.random() * 4);
      var x, y;
      if (side === 0) { x = inset; y = inset + Math.random() * Math.max(1, w.H - 2 * inset); }
      else if (side === 1) { x = w.W - inset; y = inset + Math.random() * Math.max(1, w.H - 2 * inset); }
      else if (side === 2) { y = inset; x = inset + Math.random() * Math.max(1, w.W - 2 * inset); }
      else { y = w.H - inset; x = inset + Math.random() * Math.max(1, w.W - 2 * inset); }
      if (w.pointInWall(x, y, cfg.SEG_RADIUS + 30)) continue; // 不压墙（含安全余量）
      var dmin = Infinity;
      for (var i = 0; i < snakes.length; i++) {
        var d = snakes[i].distTo(x, y);
        if (d < dmin) dmin = d;
      }
      if (snakes.length === 0) dmin = Infinity;
      if (dmin > bestD) { bestD = dmin; best = { x: x, y: y }; }
      if (dmin >= cfg.MP_SPAWN_CLEAR + 200) break; // 足够安全，提前收工
    }
    // 兜底：世界中心（出生安全区保证无墙）
    return best || { x: w.W / 2, y: w.H / 2 };
  };

  /**
   * 生成一条 AI 蛇（边缘安全位、朝向场心、随机昵称/速度档位/性格）。
   * @param {number} smartness 智力等级 0~1（0=开局普通AI，1=后期聪明AI；越高越谨慎、速度越快）
   */
  Multiplayer.prototype.spawnBot = function (smartness) {
    var pos = this.findSpawn();
    var angle = Math.atan2(this.walls.H / 2 - pos.y, this.walls.W / 2 - pos.x);
    var snake = new Snake(pos.x, pos.y, cfg.MP_START_LENGTH, angle, this.game.unlockedKeys);
    var e = new Entry(snake, this.pickName(), false);

    // 基础速度：后期 AI 略快（给玩家更大压力）
    var speedRange = cfg.MP_AI_SPEED_MAX - cfg.MP_AI_SPEED_MIN;
    e.base = cfg.MP_AI_SPEED_MIN + Math.random() * speedRange * (0.7 + smartness * 0.5);

    // 性格参数：早期 AI 随机性大（可能很贪或很怂），后期 AI 更均衡聪明
    if (smartness < 0.3) {
      // 早期：极端随机（有的很莽有的很胆小）
      e.greed = 0.4 + Math.random() * 1.2;    // 0.4~1.6
      e.caution = 0.4 + Math.random() * 1.2;   // 0.4~1.6
    } else {
      // 后期：更聪明（适中偏高贪食 + 高谨慎 = 会吃但不容易送死）
      e.greed = 0.8 + Math.random() * 0.5;     // 0.8~1.3
      e.caution = 0.9 + Math.random() * 0.5;   // 0.9~1.4
    }

    this.bots.push(e);
    this.botSnakes.push(snake);
    this.liveSnakes.push(snake);
    return e;
  };

  // ---------------- 淘汰与尸体 ----------------

  /**
   * 尸体掉落：颜色序列每隔 MP_CORPSE_STRIDE 节掉 1 个色块（起点随机 0/1 → ≈50% 节）。
   * 掉落的色块直接进入 spawner.blocks（资源循环），不受稀疏刷新间距约束。
   * @returns {number} 实际掉落的色块数
   */
  Multiplayer.prototype.dropCorpse = function (e) {
    var s = e.snake;
    var stride = Math.max(1, cfg.MP_CORPSE_STRIDE);
    var offset = Math.floor(Math.random() * stride);
    var added = 0;
    for (var i = offset; i < s.colors.length; i += stride) {
      var p = s.segPos[i] || { x: s.x, y: s.y };
      this.spawner.blocks.push({
        x: p.x, y: p.y,
        color: s.colors[i],
        phase: Math.random() * Math.PI * 2
      });
      added++;
    }
    return added;
  };

  /** 淘汰一条蛇：掉落尸体 + 粒子闪光；AI 进入重生队列，真人由 game/room 结算 */
  Multiplayer.prototype.kill = function (e) {
    if (!e.alive) return;
    e.alive = false;
    e.diedAt = this.timeMs;
    var dropped = this.dropCorpse(e);
    this.dropDeathItems(e); // 必然掉 1 个随机道具 + 每 10 节额外掉 1 个
    this.particles.flash(e.snake.x, e.snake.y, '#FFD94A', 1.4, 3);
    var li = this.liveSnakes.indexOf(e.snake);
    if (li >= 0) this.liveSnakes.splice(li, 1);
    if (!e.isPlayer) {
      delete this.usedNames[e.name];
      var idx = this.botSnakes.indexOf(e.snake);
      if (idx >= 0) this.botSnakes.splice(idx, 1);
      var delay = cfg.MP_RESPAWN_MIN_MS + Math.random() * (cfg.MP_RESPAWN_MAX_MS - cfg.MP_RESPAWN_MIN_MS);
      this.respawnQueue.push({ at: this.timeMs + delay });
    }
    this.emitEv('death', { id: e.id, isPlayer: e.isPlayer, x: e.snake.x, y: e.snake.y, drop: dropped });
  };

  /**
   * 碰撞判定（每帧一次，批量结算）：
   *  1. 头撞墙/边界 → 淘汰；
   *  2. 头对头（头心距 < 2×HEAD_HIT_RADIUS）→ 两条都淘汰；
   *  3. 头撞其他蛇身体节（segPos[1..]，头除外）→ 淘汰，身体主人记 1 击杀；
   *     同时触发咬断：被撞者 B 被移除「离 A 头心最近」的那一节（见 applyBite）。
   */
  Multiplayer.prototype.collide = function () {
    var es = this.allEntries();
    var alive = [];
    var i, j;
    for (i = 0; i < es.length; i++) if (es[i].alive) alive.push(es[i]);
    var dead = {}; // entry.id -> {by: Entry|null}
    var bites = []; // [{A, B, seg}] 本帧发生的咬断（A 撞 B 第 seg 节）

    // 1. 撞墙/边界
    for (i = 0; i < alive.length; i++) {
      var s = alive[i].snake;
      if (this.walls.hitsCircle(s.x, s.y, cfg.HEAD_HIT_RADIUS)) dead[alive[i].id] = { by: null };
    }

    // 2. 头对头
    var hh = cfg.HEAD_HIT_RADIUS * 2;
    for (i = 0; i < alive.length; i++) {
      for (j = i + 1; j < alive.length; j++) {
        var a = alive[i], b = alive[j];
        if (dead[a.id] && dead[b.id]) continue;
        if (u.dist(a.snake.x, a.snake.y, b.snake.x, b.snake.y) < hh) {
          if (!dead[a.id]) dead[a.id] = { by: null };
          if (!dead[b.id]) dead[b.id] = { by: null };
        }
      }
    }

    // 3. 头撞身体（k 从 1 起：跳过对方头部，头对头已在上面判过）
    //    碰撞：尾巴节也算身体（撞上照样淘汰撞者）；
    //    咬断：被咬节 = 判定半径内离 A 头心最近的「颜色节」（排除末尾尾巴节，它不可被咬掉）
    var hb = cfg.HEAD_HIT_RADIUS + cfg.SEG_RADIUS;
    for (i = 0; i < alive.length; i++) {
      var A = alive[i];
      if (dead[A.id]) continue;
      for (j = 0; j < alive.length; j++) {
        if (i === j) continue;
        var B = alive[j];
        var sp = B.snake.segPos;
        var colorN = B.snake.colors.length; // segPos[colorN] 即尾巴节
        var hitK = -1, bestD = hb;          // 碰撞最近节（含尾巴节）
        var biteK = -1, biteD = hb;         // 咬断最近节（仅颜色节）
        for (var k = 1; k < sp.length; k++) {
          var d = u.dist(A.snake.x, A.snake.y, sp[k].x, sp[k].y);
          if (d < bestD) { bestD = d; hitK = k; }
          if (k < colorN && d < biteD) { biteD = d; biteK = k; }
        }
        if (hitK >= 0) {
          dead[A.id] = { by: B };
          if (biteK >= 0) bites.push({ A: A, B: B, seg: biteK }); // 只撞上尾巴：淘汰但不咬断
          break;
        }
      }
    }

    // 咬断结算（在统一淘汰前处理；同一被撞者按节下标从大到小移除，避免下标位移咬错节）
    bites.sort(function (p, q) { return q.seg - p.seg; });
    for (i = 0; i < bites.length; i++) {
      var bt = bites[i];
      if (dead[bt.B.id]) continue; // B 已因其他原因淘汰（墙/头对头/此前的咬断保底）：整尸掉落，不再咬断
      this.applyBite(bt.A, bt.B, bt.seg, dead);
    }

    // 结算（统一在判定完之后处理，避免遍历中改状态）
    for (i = 0; i < alive.length; i++) {
      var E = alive[i];
      if (dead[E.id]) {
        if (dead[E.id].by) dead[E.id].by.kills++;
        this.kill(E);
      }
    }
  };

  /**
   * 咬断：A 撞 B 身体，B 移除第 segIdx 节（颜色序列去掉该项，身体由轨迹自然收拢）。
   *  - 尾巴节保护：segIdx 越界（= 尾巴节下标）时 removeSegAt 返回 null，不咬断不保底；
   *  - 保底：移除后 B 节数 < MP_BITE_MIN_LENGTH → B 直接淘汰（dead[B] = {by: A}，计入 A 击杀）；
   *  - 消除联动：B 存活则立即检查颜色序列，凑成 ≥ELIM_RUN 连同色正常触发消除
   *    （连锁/倍率计分照常，分数与累计消除方块都记 B）；
   *  - 视觉反馈：被咬处迸小粒子 + B 短暂闪白/抖动（bittenUntil，渲染层表现）。
   */
  Multiplayer.prototype.applyBite = function (A, B, segIdx, dead) {
    var removed = B.snake.removeSegAt(segIdx);
    if (!removed) return;
    this.particles.burst(removed.x, removed.y, cfg.COLORS[removed.color], 5, 0.8);
    B.bittenUntil = this.timeMs + cfg.MP_BITE_FLASH_MS;
    this.emitEv('bite', { id: B.id, by: A.id, seg: segIdx, x: removed.x, y: removed.y, color: removed.color });
    if (B.snake.length() < cfg.MP_BITE_MIN_LENGTH) {
      dead[B.id] = { by: A }; // 保底淘汰：正常淘汰流程（尸体掉落）+ 计入 A 的击杀
      return;
    }
    this.resolveElim(B); // 被咬后颜色接拢，可能凑成 4 连 → 正常消除（计分给 B）
  };

  // ---------------- 帧更新 ----------------

  /** 消除结算：4 连消除 + 连锁倍率计分 + 逐级放大特效（与单人模式同一套表现）；
   *  同时累计「累计消除方块」elimTotal（含连锁与被咬触发的消除） */
  Multiplayer.prototype.resolveElim = function (e) {
    var removed = e.snake.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
    this.scoreChain(e, removed, 1, 0);
  };

  /**
   * 统一计分 + 特效（供 resolveElim 与 applyItem 共用）。
   * 连击 combo 为 Entry 级状态（v3.0 下沉，多真人各自独立；窗口规则与单机一致）。
   * @param {Entry} e 被消除的蛇档案
   * @param {Array} removed 被移除节 [{color,x,y,chain}]
   * @param {number} fxBoost 特效放大（炸弹更强）
   * @param {number} perSegBonus 每节额外得分（炸弹/消色/随机消除等道具）
   */
  Multiplayer.prototype.scoreChain = function (e, removed, fxBoost, perSegBonus) {
    if (!removed || !removed.length) return;
    if (CS.audio) CS.audio.playElim();
    e.elimTotal += removed.length;
    // 连击（仅真人计分，AI 的 elimScore 仅供调试）：窗口内连续消除 → combo 递增 → 分数成倍
    var combo = 1;
    if (e.isPlayer) {
      e.combo = (e.comboTimer > 0) ? e.combo + 1 : 1;
      e.comboTimer = cfg.ELIM_COMBO_WINDOW;
      combo = Math.min(cfg.ELIM_COMBO_MAX, e.combo);
    }
    var waves = {};
    var i;
    for (i = 0; i < removed.length; i++) {
      var ch = removed[i].chain || 1;
      (waves[ch] = waves[ch] || []).push(removed[i]);
    }
    var chainLv = Object.keys(waves).map(Number).sort(function (a, b) { return a - b; });
    for (var w = 0; w < chainLv.length; w++) {
      var chain = chainLv[w], segs = waves[chain];
      var fxScale = (1 + (chain - 1) * cfg.CHAIN_FX_STEP) * (fxBoost || 1);
      e.elimScore += segs.length * cfg.ELIM_SCORE * chain * combo + (perSegBonus || 0);
      var sx = 0, sy = 0;
      for (i = 0; i < segs.length; i++) {
        this.particles.burst(segs[i].x, segs[i].y, cfg.COLORS[segs[i].color],
          Math.round(5 * fxScale), fxScale);
        sx += segs[i].x; sy += segs[i].y;
      }
      var ccx = sx / segs.length, ccy = sy / segs.length;
      this.particles.flash(ccx, ccy, '#FFD94A', fxScale, Math.min(4, chain));
      if (chain >= cfg.CHAIN_TEXT_MIN) {
        this.particles.chainText(ccx, ccy - 24, chain + '连锁！', 20 + (chain - 1) * 6);
      }
      if (e.isPlayer && combo >= 2) {
        this.particles.chainText(ccx, ccy - 46, combo + '连击 ×' + combo, 18 + combo);
      }
    }
    this.emitEv('elim', { id: e.id, segs: removed, combo: combo, score: e.elimScore });
  };

  /**
   * 拾取道具的统一处理（真人与 AI 共用）：按 kind 触发对应效果 + 计分 + 特效。
   * 特殊道具（wild/bomb/slow/clear/clear3/rand1-3）都会真正生效；
   * 真人拾取时弹出效果飘字（setItemToast，本地模式仅本机玩家可见；联机按 Entry 路由）。
   * @param {Entry} e 拾取者
   * @param {object} b 色块 {kind,color,x,y,rarity}
   */
  Multiplayer.prototype.applyItem = function (e, b) {
    var px = b.x, py = b.y;
    var isPlayer = e.isPlayer;
    if (b.kind && b.kind !== 'color' && isPlayer) this.game.setItemToast(b.kind, b.color, e);
    if (b.kind === 'wild') {
      e.snake.growWild();
      if (CS.audio) CS.audio.playSpecial();
      this.particles.burst(px, py, '#FFD94A', 7);
      this.resolveElim(e);
    } else if (b.kind === 'bomb') {
      if (CS.audio) CS.audio.playSpecial();
      this.particles.burst(px, py, '#E8552F', 12, 1.5);
      var rem = e.snake.eliminate(2, 2);
      this.scoreChain(e, rem, 1.4, cfg.BOMB_SCORE);
    } else if (b.kind === 'slow') {
      if (CS.audio) CS.audio.playSpecial();
      e.slowUntil = this.timeMs + cfg.SLOW_MS;
      this.particles.burst(px, py, '#2EC4B6', 9);
      this.resolveElim(e);
    } else if (b.kind === 'clear') {
      if (CS.audio) CS.audio.playSpecial();
      var rem = e.snake.removeByColor(b.color);
      this.scoreChain(e, rem, 1.3, cfg.CLEAR_SCORE);
      var rem2 = e.snake.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
      this.scoreChain(e, rem2, 1, 0);
      this.particles.burst(px, py, cfg.COLORS[b.color], 12, 1.5);
    } else if (b.kind === 'clear3') {
      if (CS.audio) CS.audio.playSpecial();
      var rem = e.snake.removeRearByColor(b.color, 3);
      this.scoreChain(e, rem, 1.2, cfg.CLEAR3_SCORE);
      var rem2 = e.snake.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
      this.scoreChain(e, rem2, 1, 0);
      this.particles.burst(px, py, cfg.COLORS[b.color], 9, 1.3);
    } else if (b.kind === 'rand1' || b.kind === 'rand2' || b.kind === 'rand3') {
      if (CS.audio) CS.audio.playSpecial();
      var rn = b.kind === 'rand1' ? 1 : (b.kind === 'rand2' ? 2 : 3);
      var rem = e.snake.removeRandom(rn);
      this.scoreChain(e, rem, 1.2, cfg.RAND_SCORE);
      var rem2 = e.snake.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
      this.scoreChain(e, rem2, 1, 0);
      this.particles.burst(px, py, '#FFD94A', 9, 1.3);
    } else if (b.kind === 'grab') {
      // 多人专属「彩色星」：真人吃到 → 自己当前总分立即 +20%（一次性加成，可叠加）；
      // AI 吃到则只是把道具消耗掉（真人失去抢夺机会）。无论谁吃，都清掉场上这颗并安排下一颗。
      if (CS.audio) CS.audio.playSpecial();
      this.particles.burst(px, py, '#FFD94A', 16, 1.9);
      this.particles.ring(px, py, '#FFC83D', 1.8);
      var bonus = 0;
      if (isPlayer) {
        var cur = (e.survivalScore || 0) + (e.elimScore || 0) + (e.mpBonusScore || 0);
        bonus = Math.max(1, Math.round(cur * cfg.GRAB_SCORE_MUL));
        e.mpBonusScore = (e.mpBonusScore || 0) + bonus;
        this.particles.chainText(px, py - 32, '分数 +20%！+' + bonus, 24);
      }
      this.emitEv('grab', { id: e.id, isPlayer: isPlayer, bonus: bonus, x: px, y: py });
      // 消费场上这颗彩色星（collectAt 已将其移出 blocks，这里只清引用 + 排下一颗）
      this.spawner.grabBlock = null;
      this.spawner.grabTimer = cfg.GRAB_RESPAWN_MS;
    } else {
      if (CS.audio) CS.audio.playEat();
      e.snake.grow(b.color);
      this.particles.burst(px, py, cfg.COLORS[b.color], 4);
      this.resolveElim(e);
    }
    if (b.kind && b.kind !== 'color') {
      this.emitEv('item', { id: e.id, kind: b.kind, color: b.color || null, x: px, y: py });
    }
  };

  /**
   * 阵亡掉落道具：除身体散落色块（dropCorpse）外，必然额外掉落一个随机道具，
   * 且真人/任意蛇每有 10 个颜色节（不含尾巴节）再额外掉一个随机道具（长度越长奖励越多）。
   * @param {Entry} e 被淘汰的蛇
   */
  Multiplayer.prototype.dropDeathItems = function (e) {
    var s = e.snake;
    var colorLen = s.colors.length; // 颜色节数（尾巴节不在 colors[] 内，天然排除）
    var count = 1 + Math.floor(colorLen / 10);
    for (var i = 0; i < count; i++) {
      var kind = this.spawner.randomSpecialKind();
      var p = s.segPos[Math.floor(Math.random() * s.segPos.length)] || { x: s.x, y: s.y };
      var jx = (Math.random() * 2 - 1) * 26, jy = (Math.random() * 2 - 1) * 26;
      this.spawner.addDroppedItem(p.x + jx, p.y + jy, kind);
    }
  };

  /**
   * 处理 AI 重生 + 动态增长（v2.8.7：AI 数量随时间从 MP_AI_START_COUNT 增长到 MP_AI_MAX_COUNT）。
   * 逻辑：
   *  1) 到期的淘汰 AI 按原延迟重生（维持基本编制）；
   *  2) 计算当前存活时间对应的目标 AI 数量，若当前活 AI 少于目标，额外补招新 AI；
   *  3) 新补招的 AI 使用 currentSmartness() 智力参数（后期 AI 更聪明）。
   */
  Multiplayer.prototype.processRespawns = function () {
    var now = this.timeMs;
    var sec = this.timeMs / 1000;
    var smartness = this.currentSmartness();

    // 1) 到期重生（淘汰的 AI 回来）
    var due = 0;
    var keep = [];
    for (var i = 0; i < this.respawnQueue.length; i++) {
      if (this.respawnQueue[i].at <= now) due++;
      else keep.push(this.respawnQueue[i]);
    }
    this.respawnQueue = keep;
    for (i = 0; i < due; i++) {
      this.spawnBot(smartness);  // 重生的 AI 也带当前智力水平
      this.respawned++;
    }

    // 2) 动态增长：若「活 AI + 重生队列」< 目标数量，补招新 AI（队列中的待重生蛇也算编制，
    //    避免「刚被淘汰→队列里还躺着一条→又补一条」导致数量瞬间越界）。
    //    节流仅作为「增长补招」的速率限制（每隔 >=800ms 才允许补一条），绝不越过目标数量硬上限。
    var alive = this.aliveBotCount() + this.respawnQueue.length;
    var target = this.targetAiCount(sec);
    var canGrow = !this._lastGrowSpawn || now - this._lastGrowSpawn >= 800;
    if (alive < target && canGrow) {
      this.spawnBot(smartness);
      this.respawned++;
      this._lastGrowthSpawn = now; // 注意：故意用不同变量名避免与重生混淆
      this._lastGrowSpawn = now;
    }
  };

  /**
   * 每帧推进（由 game.updateMulti / room.tick 调用；真人输入已写入各 snake.targetAngle）：
   *  AI 决策 → 动态速度 → 推进所有蛇 → 碰撞淘汰 → 吃色/消除 → 重生补充 → 色块刷新。
   */
  Multiplayer.prototype.update = function (dt) {
    this.timeMs += dt;
    var entries = this.allEntries();
    var snakes = this.aliveSnakes();
    var env = { walls: this.walls, blocks: this.spawner.blocks, snakes: snakes };
    var sec = this.timeMs / 1000;
    var i, e;

    // 随时间提升特殊道具刷新概率（越后期道具越密集）
    this.spawner.specialChance = cfg.specialChanceForElapsed(this.game.elapsed);

    // AI 决策（与真人同规则：只设目标角，转向速率由 Snake.update 钳制）
    for (i = 0; i < this.bots.length; i++) {
      e = this.bots[i];
      if (!e.alive) continue;
      e.snake.setTargetAngle(CS.AI.decide(e.snake, env, e));
    }

    // 真人计分状态推进：生存分（死亡冻结）+ 连击窗口衰减
    for (i = 0; i < this.players.length; i++) {
      e = this.players[i];
      if (e.alive) e.survivalScore = Math.floor(this.timeMs / 1000) * cfg.SURVIVE_SCORE_PER_SEC;
      if (e.comboTimer > 0) {
        e.comboTimer -= dt;
        if (e.comboTimer <= 0) { e.comboTimer = 0; e.combo = 0; }
      }
    }

    // 动态速度（长度/时间加成，封顶 SPEED_MAX；减速道具期间 ×SLOW_FACTOR）+ 推进
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      if (!e.alive) continue;
      var sp = e.base + e.snake.length() * cfg.SPEED_LEN_COEF + sec * cfg.ENDLESS_SPEEDUP_PER_SEC;
      if (e.slowUntil && this.timeMs < e.slowUntil) sp *= cfg.SLOW_FACTOR;
      e.snake.speed = Math.min(cfg.SPEED_MAX, sp);
      e.snake.update(dt);
      if (e.snake.length() > e.maxLen) e.maxLen = e.snake.length();
    }

    // 碰撞淘汰（墙 / 头头 / 头身）
    this.collide();

    // 吃色块 + 消除（真人优先，其后 AI；特殊道具走 applyItem 真正生效 + 真人飘字）
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      if (!e.alive) continue;
      var got = this.spawner.collectAt(e.snake);
      for (var g = 0; g < got.length; g++) this.applyItem(e, got[g]);
    }

    // 流星砖块：直线飞行 + 命中真人蛇身注入中段（目标 = 全部存活真人；单人时行为不变）
    var targets = [];
    for (i = 0; i < this.players.length; i++) {
      if (this.players[i].alive) targets.push(this.players[i]);
    }
    var targetSnakes = [];
    for (i = 0; i < targets.length; i++) targetSnakes.push(targets[i].snake);
    var mev = this.spawner.updateMeteors(dt, targetSnakes);
    for (var mi = 0; mi < mev.length; mi++) {
      var ev = mev[mi];
      var owner = null;
      for (i = 0; i < targets.length; i++) {
        if (targets[i].snake === ev.snake) { owner = targets[i]; break; }
      }
      if (!owner) continue;
      owner.snake.insertAt(ev.idx, ev.color);
      this.particles.burst(ev.x, ev.y, cfg.COLORS[ev.color], 7, 1.3);
      if (CS.audio) CS.audio.playSpecial();
      owner.elimScore += cfg.METEOR_SCORE; // 记到被注入的真人 Entry
      this.game.setItemToast('meteor', ev.color, owner); // 流星注入飘字（按 Entry 路由）
      this.emitEv('meteor', { id: owner.id, idx: ev.idx, color: ev.color, x: ev.x, y: ev.y });
      this.resolveElim(owner);
    }

    // AI 补充 + 稀疏刷新
    this.processRespawns();
    this.spawner.update(dt);
  };

  // ---------------- 排行榜与名次 ----------------

  /** 实时排行榜：活蛇按当前节数降序（同节数真人优先），[{name, length, isPlayer}] */
  Multiplayer.prototype.leaderboard = function () {
    var es = this.allEntries();
    var arr = [];
    for (var i = 0; i < es.length; i++) {
      if (es[i].alive) arr.push({ name: es[i].name, length: es[i].snake.length(), isPlayer: es[i].isPlayer });
    }
    arr.sort(function (a, b) {
      if (b.length !== a.length) return b.length - a.length;
      return (a.isPlayer ? 0 : 1) - (b.isPlayer ? 0 : 1);
    });
    return arr;
  };

  /** 某 Entry 在当前场上的名次（1 起）：1 + 节数严格更多的活蛇数 */
  Multiplayer.prototype.rankOf = function (e) {
    var len = e.snake.length();
    var rank = 1;
    var es = this.allEntries();
    for (var i = 0; i < es.length; i++) {
      if (es[i] !== e && es[i].alive && es[i].snake.length() > len) rank++;
    }
    return rank;
  };

  CS.Multiplayer = Multiplayer;
  CS.MultiplayerEntry = Entry;
  CS.resetMultiplayerIds = resetIds;
})(typeof window !== 'undefined' ? window : globalThis);
