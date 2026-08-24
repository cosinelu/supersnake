'use strict';
/**
 * game.js — 游戏主控：状态机 + 主循环逻辑（v2：自由方向 + 大地图 + 跟随镜头，横版布局）
 * 状态：menu（主菜单）→ levels（选关）→ play（对局）→ clear（过关）/ over（结束）
 * 模式：level（闯关 10 关）/ endless（无尽）/ multi（多人对战：玩家 + AI 蛇，见 multiplayer.js）
 *
 * 横版布局：左/中为视口区（相机跟随蛇头、钳制在世界内），右侧竖向 HUD 面板
 * （分数/目标/关卡/已解锁颜色预览 + 小地图；多人模式另有实时排行榜）。
 * 除 resize/触摸入口外不含 DOM 依赖，可在 node 中加载做逻辑验证。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var u = CS.utils;
  var lv = CS.levels;
  var store = CS.storage;
  var Walls = CS.Walls;
  var Snake = CS.Snake;
  var Spawner = CS.Spawner;
  var Particles = CS.Particles;
  var Joystick = CS.Joystick;

  function Game(screenW, screenH) {
    this.screenW = screenW;
    this.screenH = screenH;
    this.state = 'menu';
    this.timeMs = 0;

    // 持久化进度
    this.unlocked = u.clamp(store.get(cfg.STORAGE_UNLOCKED, 1) | 0, 1, lv.LEVEL_COUNT);
    this.best = store.get(cfg.STORAGE_BEST, 0) | 0;
    var mpb = store.get(cfg.STORAGE_MP_BEST, null); // 多人最佳 {len, score}
    this.mpBest = (mpb && typeof mpb === 'object') ? { len: mpb.len | 0, score: mpb.score | 0 } : { len: 0, score: 0 };

    // 对局数据（startRun 时初始化）
    this.mode = 'level';
    this.levelCfg = null;
    this.walls = null;
    this.snake = null;
    this.spawner = null;
    this.particles = new Particles();
    this.joystick = new Joystick(); // 固定底座：浮在视口区左下角
    this.camera = { x: 0, y: 0 };   // 相机左上角世界坐标
    this.elapsed = 0;
    this.score = 0;
    this.survivalScore = 0;
    this.elimScore = 0;
    this.mp = null;       // 多人对战编排器（mode==='multi' 时非空）
    this.mpResult = null; // 多人结算数据 {surviveSec, score, survivalScore, elimScore, elimTotal,
                        //   rank, kills, finalLen, maxLen, bestLen, bestScore, newBest}
    this.overAt = 0;      // 进入结算界面的时刻（timeMs，结算卡片/逐行动画计时起点）
    this.slowUntil = 0;   // 减速道具到期时刻（timeMs），0 表示未生效
    this.wallSpawnTimer = 0; // 动态墙体生成倒计时（ms），startRun/startMulti 时重置

    // ---- 颜色解锁系统（本局状态）----
    this.unlockedCount = 0;     // 当前已解锁颜色数
    this.unlockedKeys = [];     // 已解锁颜色的 key 数组（刷新色块 / 蛇身颜色都用它）
    this.unlockBanner = null;   // 解锁提示横幅 {text, until, keys}

    this.uiButtons = [];
    this.buildButtons();
    this.syncJoystick();
  }

  // ---------------- 横版布局 ----------------

  /**
   * 横版布局：右侧固定 HUD 面板，其余为视口区（相机画面）。
   * @returns {{areaW:number, panelX:number, panelW:number}}
   */
  Game.prototype.layout = function () {
    var panelW = Math.round(u.clamp(this.screenW * 0.19, 148, 230));
    if (this.screenW < 560) panelW = Math.round(u.clamp(this.screenW * 0.24, 110, 148)); // 窄屏压缩面板
    var areaW = Math.max(120, this.screenW - panelW);
    return { areaW: areaW, panelX: areaW, panelW: panelW };
  };

  /** 摇杆底座：视口区左下角（浮于画面之上，半透明） */
  Game.prototype.syncJoystick = function () {
    var r = 52;
    this.joystick.setBase(r + 30, this.screenH - r - 30, r);
  };

  /** 窗口尺寸变化（main.js 在 resize 时调用） */
  Game.prototype.resize = function (w, h) {
    this.screenW = w;
    this.screenH = h;
    this.buildButtons();
    this.syncJoystick();
  };

  // ---------------- 相机 ----------------

  /** 单轴相机钳制：世界小于视口时居中，否则夹在 [0, world-view] */
  function clampCam(v, world, view) {
    if (world <= view) return (world - view) / 2;
    return u.clamp(v, 0, world - view);
  }

  /** 相机平滑跟随蛇头（帧率无关指数趋近）并钳制在世界边界内 */
  Game.prototype.updateCamera = function (dt) {
    if (!this.snake || !this.walls) return;
    var l = this.layout();
    var vw = l.areaW, vh = this.screenH;
    var tx = clampCam(this.snake.x - vw / 2, this.walls.W, vw);
    var ty = clampCam(this.snake.y - vh / 2, this.walls.H, vh);
    var k = 1 - Math.exp(-cfg.CAMERA_LERP * dt / 1000); // lerp 系数
    this.camera.x = clampCam(this.camera.x + (tx - this.camera.x) * k, this.walls.W, vw);
    this.camera.y = clampCam(this.camera.y + (ty - this.camera.y) * k, this.walls.H, vh);
  };

  /** 相机立即就位（开局调用，避免从原点飞入） */
  Game.prototype.snapCamera = function () {
    var l = this.layout();
    this.camera.x = clampCam(this.snake.x - l.areaW / 2, this.walls.W, l.areaW);
    this.camera.y = clampCam(this.snake.y - this.screenH / 2, this.walls.H, this.screenH);
  };

  // ---------------- 对局生命周期 ----------------

  Game.prototype.startRun = function (mode, levelCfg) {
    this.mode = mode;
    this.levelCfg = levelCfg;
    var W = levelCfg.W, H = levelCfg.H;
    var spawn = { x: W / 2, y: H / 2 }; // 出生在世界中心
    this.walls = new Walls(W, H, spawn);
    this.walls.generateWalls(levelCfg.wallSegments);
    // 计算本局初始解锁颜色数（闯关按当前关卡、无尽按 0 秒）
    this.unlockedCount = (mode === 'level')
      ? cfg.unlockedCountForLevel(levelCfg.level)
      : cfg.unlockedCountForEndless(0);
    this.unlockedKeys = cfg.unlockedColorKeys(this.unlockedCount);
    // 先清零计时/计分，再算开局速度（动态速度含时间加成，必须在 elapsed=0 时初始化）
    this.elapsed = 0;
    this.score = 0;
    this.survivalScore = 0;
    this.elimScore = 0;
    this.mp = null;
    this.mpResult = null;
    this.slowUntil = 0;
    this.snake = new Snake(spawn.x, spawn.y, cfg.START_LENGTH, 0, this.unlockedKeys);
    this.snake.speed = this.currentSpeed();
    this.spawner = new Spawner(this.walls, this.snake);
    this.spawner.unlockedKeys = this.unlockedKeys; // 色块只从已解锁颜色刷新
    this.spawner.fillNow();
    this.particles.clear();
    this.joystick.onTouchEnd(this.joystick.touchId); // 重置摇杆状态
    this.wallSpawnTimer = Math.round(cfg.WALL_SPAWN_INTERVAL_MS * 0.5); // 开局延迟约半周期再生成首段
    this.snapCamera();
    this.syncJoystick();
    this.setState('play');
  };

  Game.prototype.startLevel = function (n) {
    var prevCount = this.unlockedCount; // 进入前已解锁数（菜单首进为 0）
    this.startRun('level', lv.levelConfig(n));
    // 仅在"从已有对局推进关卡"且颜色增多时弹横幅（菜单首进 prev=0 不弹）
    if (this.unlockedCount > prevCount && prevCount >= cfg.INITIAL_UNLOCKED) {
      this.unlockBanner = {
        text: '新颜色解锁！',
        until: this.timeMs + cfg.UNLOCK_BANNER_MS,
        keys: cfg.COLOR_KEYS.slice(prevCount, this.unlockedCount) // 本次新增颜色
      };
    }
  };

  Game.prototype.startEndless = function () {
    var e = cfg.ENDLESS;
    this.startRun('endless', { level: 0, W: e.W, H: e.H, wallSegments: e.wallSegments, targetScore: 0, speed: cfg.SNAKE_SPEED });
  };

  /**
   * 多人对战：共享大地图（cfg.MULTI），玩家出生在世界中心，AI 出生在边缘安全位。
   * 颜色解锁规则同无尽（按玩家存活时间）；色块目标密度比单人略高（7 条蛇在吃）。
   * 玩家蛇仍是 this.snake（相机/摇杆/渲染主路径不变），AI 蛇由 this.mp 管理。
   */
  Game.prototype.startMulti = function () {
    this.mode = 'multi';
    var m = cfg.MULTI;
    this.levelCfg = { level: 0, W: m.W, H: m.H, wallSegments: m.wallSegments, targetScore: 0, speed: cfg.SNAKE_SPEED };
    var spawn = { x: m.W / 2, y: m.H / 2 };
    this.walls = new Walls(m.W, m.H, spawn);
    this.walls.generateWalls(m.wallSegments);
    this.unlockedCount = cfg.unlockedCountForEndless(0);
    this.unlockedKeys = cfg.unlockedColorKeys(this.unlockedCount);
    this.elapsed = 0;
    this.score = 0;
    this.survivalScore = 0;
    this.elimScore = 0;
    this.mpResult = null;
    this.snake = new Snake(spawn.x, spawn.y, cfg.START_LENGTH, 0, this.unlockedKeys);
    this.snake.speed = cfg.SNAKE_SPEED;
    this.spawner = new Spawner(this.walls, this.snake);
    this.spawner.unlockedKeys = this.unlockedKeys;
    // 多人色块目标密度：世界面积 / MP_BLOCK_AREA_DIV，夹取 [MP_BLOCKS_MIN, MP_BLOCKS_MAX]
    this.spawner.target = u.clamp(Math.round(m.W * m.H / cfg.MP_BLOCK_AREA_DIV), cfg.MP_BLOCKS_MIN, cfg.MP_BLOCKS_MAX);
    this.particles.clear();
    this.mp = new CS.Multiplayer(this);
    this.mp.setup(); // 玩家 Entry + 补足 AI 编制（同时挂 spawner.others 活引用）
    this.spawner.fillNow();
    this.joystick.onTouchEnd(this.joystick.touchId); // 重置摇杆状态
    this.wallSpawnTimer = Math.round(cfg.WALL_SPAWN_INTERVAL_MS * 0.5); // 开局延迟约半周期再生成首段
    this.snapCamera();
    this.syncJoystick();
    this.setState('play');
  };

  /** 多人对战帧更新：输入 → mp 编排（AI/碰撞/淘汰/补充/吃色/消除）→ 相机 → 结算判定 */
  Game.prototype.updateMulti = function (dt) {
    this.elapsed += dt;
    this.survivalScore = Math.floor(this.elapsed / 1000) * cfg.SURVIVE_SCORE_PER_SEC;

    // 输入：摇杆/键盘给出目标角（与 AI 同规则：只设目标角，转向速率由 Snake 钳制）
    var ang = this.joystick.currentAngle();
    if (ang !== null && this.mp.playerEntry.alive) this.snake.setTargetAngle(ang);

    this.mp.update(dt);

    // 玩家得分 = 存活分 + 消除分（消除分在 mp.resolveElim 中按连锁倍率累计）
    this.elimScore = this.mp.playerEntry.elimScore;
    this.score = this.survivalScore + this.elimScore;

    this.updateCamera(dt);

    if (!this.mp.playerEntry.alive) this.gameOverMulti();
  };

  /** 多人结算：排名 / 存活时间 / 总分（时间分+消除分）/ 累计消除方块 / 击杀数 / 最终节数
   *  + 本地最佳（最长节数 / 最高分）；overAt 供结算卡片逐行动画计时 */
  Game.prototype.gameOverMulti = function () {
    var e = this.mp.playerEntry;
    var rank = this.mp.rankOf(e);
    var bestLen = Math.max(this.mpBest.len, e.maxLen);
    var bestScore = Math.max(this.mpBest.score, this.score);
    var newBest = e.maxLen > this.mpBest.len || this.score > this.mpBest.score;
    this.mpBest = { len: bestLen, score: bestScore };
    store.set(cfg.STORAGE_MP_BEST, this.mpBest);
    this.mpResult = {
      surviveSec: Math.floor(this.elapsed / 1000),
      score: this.score,
      survivalScore: this.survivalScore,
      elimScore: this.elimScore,
      elimTotal: e.elimTotal,       // 累计消除方块（含连锁、含被咬触发的消除）
      rank: rank,
      kills: e.kills,
      finalLen: e.snake.length(),   // 淘汰瞬间节数
      maxLen: e.maxLen,
      bestLen: bestLen,
      bestScore: bestScore,
      newBest: newBest
    };
    this.overAt = this.timeMs;
    this.setState('over');
  };

  /**
   * 把已解锁颜色数提升到 count（仅在增大时更新刷新池并弹横幅）。
   * @param {number} count 目标解锁数
   */
  Game.prototype.unlockTo = function (count) {
    count = Math.min(cfg.MAX_COLORS, Math.max(0, count | 0));
    if (count <= this.unlockedCount) return; // 不加反、不重复弹
    var prev = this.unlockedCount;
    this.unlockedCount = count;
    this.unlockedKeys = cfg.unlockedColorKeys(count);
    if (this.spawner) this.spawner.unlockedKeys = this.unlockedKeys; // 新颜色立即进入刷新池
    this.unlockBanner = {
      text: '新颜色解锁！',
      until: this.timeMs + cfg.UNLOCK_BANNER_MS,
      keys: cfg.COLOR_KEYS.slice(prev, count) // 本次新增的颜色
    };
  };

  /**
   * 当前蛇速（px/s）——局内动态加速，每帧按公式重算（平滑，无跳变）：
   *   闯关：min(基础 + LEVEL_SPEED_CAP_ADD, 基础 + SPEED_LEN_COEF×当前节数 + LEVEL_SPEED_TIME_COEF×存活秒)
   *   无尽：min(SPEED_MAX, SNAKE_SPEED + ENDLESS_SPEEDUP_PER_SEC×存活秒 + SPEED_LEN_COEF×当前节数)
   * 只改速度数值；节间距、消除/收集/撞墙判定等几何参数不受影响。
   */
  Game.prototype.currentSpeed = function () {
    var len = this.snake ? this.snake.length() : cfg.START_LENGTH;
    var sec = this.elapsed / 1000;
    var sp, base;
    if (this.mode === 'endless') {
      sp = cfg.SNAKE_SPEED + sec * cfg.ENDLESS_SPEEDUP_PER_SEC + len * cfg.SPEED_LEN_COEF;
      sp = Math.min(cfg.SPEED_MAX, sp);
    } else {
      base = this.levelCfg.speed;
      sp = base + len * cfg.SPEED_LEN_COEF + sec * cfg.LEVEL_SPEED_TIME_COEF;
      sp = Math.min(base + cfg.LEVEL_SPEED_CAP_ADD, sp);
    }
    if (this.slowUntil && this.timeMs < this.slowUntil) sp *= cfg.SLOW_FACTOR; // 减速道具
    return sp;
  };

  /**
   * 统一的消除计分 + 特效（连锁倍率、逐级放大粒子/星闪、N 连锁文字）。
   * @param {Array} removed 被移除节 [{color,x,y,chain}]
   * @param {number} fxBoost 特效放大（炸弹更强）
   * @param {number} perSegBonus 每节额外得分（炸弹道具）
   */
  Game.prototype.applyElim = function (removed, fxBoost, perSegBonus) {
    if (!removed || !removed.length) return;
    var waves = {};
    for (var i = 0; i < removed.length; i++) {
      var ch = removed[i].chain || 1;
      (waves[ch] = waves[ch] || []).push(removed[i]);
    }
    var chainLv = Object.keys(waves).map(Number).sort(function (a, b) { return a - b; });
    for (var w = 0; w < chainLv.length; w++) {
      var chain = chainLv[w], segs = waves[chain];
      var fxScale = (1 + (chain - 1) * cfg.CHAIN_FX_STEP) * (fxBoost || 1);
      this.elimScore += segs.length * (cfg.ELIM_SCORE * chain + (perSegBonus || 0));
      var sx = 0, sy = 0;
      for (i = 0; i < segs.length; i++) {
        var col = segs[i].color === 'wild' ? '#FFD94A' : cfg.COLORS[segs[i].color];
        this.particles.burst(segs[i].x, segs[i].y, col, Math.round(5 * fxScale), fxScale);
        sx += segs[i].x; sy += segs[i].y;
      }
      var ccx = sx / segs.length, ccy = sy / segs.length;
      this.particles.flash(ccx, ccy, '#FFD94A', fxScale, Math.min(4, chain));
      if (chain >= cfg.CHAIN_TEXT_MIN) {
        this.particles.chainText(ccx, ccy - 24, chain + '连锁！', 20 + (chain - 1) * 6);
      }
    }
  };

  // ---------------- 主循环 ----------------

  /**
   * 动态墙体生成：按固定间隔在地图上新增一段障碍墙（避开玩家与 AI 蛇身）。
   * 渲染（drawWallRect）与碰撞（hitsCircle）都自动复用内部墙系统，无需额外接线。
   */
  Game.prototype.updateWallSpawn = function (dt) {
    this.wallSpawnTimer -= dt;
    if (this.wallSpawnTimer > 0) return;
    this.wallSpawnTimer = cfg.WALL_SPAWN_INTERVAL_MS;
    if (!this.walls) return;
    // 收集所有蛇身节点作为避让点（玩家优先，多人再补 AI）
    var pts = [];
    if (this.snake && this.snake.segPos) {
      for (var i = 0; i < this.snake.segPos.length; i++) pts.push(this.snake.segPos[i]);
    }
    if (this.mode === 'multi' && this.mp && this.mp.bots) {
      for (var b = 0; b < this.mp.bots.length; b++) {
        var bot = this.mp.bots[b];
        if (bot.alive && bot.snake && bot.snake.segPos) {
          for (var k = 0; k < bot.snake.segPos.length; k++) pts.push(bot.snake.segPos[k]);
        }
      }
    }
    this.walls.addRandomWall(pts, cfg.WALL_SPAWN_MAX);
  };

  Game.prototype.update = function (dt) {
    this.timeMs += dt;
    this.particles.update(dt);
    if (this.state !== 'play') return;

    // 解锁提示横幅到期自动清除
    if (this.unlockBanner && this.timeMs >= this.unlockBanner.until) this.unlockBanner = null;

    // 无尽/多人模式：随存活时间解锁新颜色（每 ENDLESS_UNLOCK_INTERVAL_SEC 秒 +1，封顶 MAX_COLORS）
    if (this.mode === 'endless' || this.mode === 'multi') {
      this.unlockTo(cfg.unlockedCountForEndless(Math.floor(this.elapsed / 1000)));
    }

    // 多人对战：蛇群推进/淘汰/补充全部由 mp 编排（含吃色与消除）
    if (this.mode === 'multi') {
      this.updateWallSpawn(dt);
      this.updateMulti(dt);
      return;
    }

    this.updateWallSpawn(dt);
    this.elapsed += dt;
    this.survivalScore = Math.floor(this.elapsed / 1000) * cfg.SURVIVE_SCORE_PER_SEC;
    this.score = this.survivalScore + this.elimScore;

    // 输入：摇杆/键盘给出目标角（无输入则保持上一目标角，蛇继续沿原方向）
    var ang = this.joystick.currentAngle();
    if (ang !== null) this.snake.setTargetAngle(ang);

    // 推进蛇（转向速率钳制 + 恒速前进 + 轨迹跟随在 snake 内完成）
    this.snake.speed = this.currentSpeed();
    this.snake.update(dt);

    // 相机跟随
    this.updateCamera(dt);

    // 撞墙判定：蛇头圆与世界边界 / 内部墙相交 → 结束
    if (this.walls.hitsCircle(this.snake.x, this.snake.y, cfg.HEAD_HIT_RADIUS)) {
      this.gameOver();
      return;
    }

    // 收集：蛇头或任一身体节压到的色块都收集；按类型触发不同效果
    var got = this.spawner.collectAt(this.snake);
    for (var i = 0; i < got.length; i++) {
      var b = got[i];
      if (b.kind === 'wild') {
        this.snake.growWild();                      // 万能色：头部插入通配节
        this.particles.burst(b.x, b.y, '#FFD94A', 7);
      } else if (b.kind === 'bomb') {
        this.particles.burst(b.x, b.y, '#E8552F', 12, 1.5);
        var remB = this.snake.eliminate(2, 2);      // 炸弹：清掉所有 ≥2 连同色段
        this.applyElim(remB, 1.4, cfg.BOMB_SCORE);
      } else if (b.kind === 'slow') {
        this.slowUntil = this.timeMs + cfg.SLOW_MS; // 减速：临时喘息
        this.particles.burst(b.x, b.y, '#2EC4B6', 9);
      } else if (b.kind === 'clear') {
        // 消色：消除全体现该颜色节
        var remC = this.snake.removeByColor(b.color);
        this.applyElim(remC, 1.3, cfg.CLEAR_SCORE);
        var remC2 = this.snake.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
        this.applyElim(remC2, 1, 0);
        this.particles.burst(b.x, b.y, cfg.COLORS[b.color], 12, 1.5);
      } else if (b.kind === 'clear3') {
        // 后 3 消色：消除该颜色最靠尾的至多 3 节
        var rem3 = this.snake.removeRearByColor(b.color, 3);
        this.applyElim(rem3, 1.2, cfg.CLEAR3_SCORE);
        var rem32 = this.snake.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
        this.applyElim(rem32, 1, 0);
        this.particles.burst(b.x, b.y, cfg.COLORS[b.color], 9, 1.3);
      } else if (b.kind === 'rand1' || b.kind === 'rand2' || b.kind === 'rand3') {
        // 随机消除 1/2/3 节
        var rn = b.kind === 'rand1' ? 1 : (b.kind === 'rand2' ? 2 : 3);
        var remR = this.snake.removeRandom(rn);
        this.applyElim(remR, 1.2, cfg.RAND_SCORE);
        var remR2 = this.snake.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
        this.applyElim(remR2, 1, 0);
        this.particles.burst(b.x, b.y, '#FFD94A', 9, 1.3);
      } else {
        this.snake.grow(b.color);
        this.particles.burst(b.x, b.y, cfg.COLORS[b.color], 4);
      }
    }

    // 流星砖块：移动 + 碰撞注入（命中身体即把该色注入中段，衔接消除连锁）
    var mev = this.spawner.updateMeteors(dt, this.snake);
    for (var mi = 0; mi < mev.length; mi++) {
      var ev = mev[mi];
      this.snake.insertAt(ev.idx, ev.color);
      this.particles.burst(ev.x, ev.y, cfg.COLORS[ev.color], 7, 1.3);
      this.elimScore += cfg.METEOR_SCORE;
      var remM = this.snake.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
      this.applyElim(remM, 1, 0);
    }

    // 消除：相邻连续 ≥4 节同色立即消除（含连锁），保底 3 节。
    var removed = this.snake.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
    this.applyElim(removed, 1, 0);

    this.spawner.update(dt);

    if (this.state === 'play' && this.mode === 'level' && this.score >= this.levelCfg.targetScore) {
      this.levelClear();
    }
  };

  Game.prototype.gameOver = function () {
    if (this.mode === 'endless' && this.score > this.best) {
      this.best = this.score;
      store.set(cfg.STORAGE_BEST, this.best);
    }
    this.overAt = this.timeMs;
    this.setState('over');
  };

  Game.prototype.levelClear = function () {
    var n = this.levelCfg.level;
    if (n >= this.unlocked && this.unlocked < lv.LEVEL_COUNT) {
      this.unlocked = n + 1;
      store.set(cfg.STORAGE_UNLOCKED, this.unlocked);
    }
    this.setState('clear');
  };

  // ---------------- UI 状态与按钮 ----------------

  Game.prototype.setState = function (s) {
    this.state = s;
    this.buildButtons();
  };

  Game.prototype.addButton = function (id, cx, cy, w, h, label, enabled) {
    this.uiButtons.push({ id: id, x: cx - w / 2, y: cy - h / 2, w: w, h: h, label: label, enabled: enabled !== false });
  };

  Game.prototype.buildButtons = function () {
    this.uiButtons = [];
    var W = this.screenW, H = this.screenH, cx = W / 2;
    var bw = Math.min(220, W * 0.3), bh = 54;
    if (this.state === 'menu') {
      this.addButton('level', cx, H * 0.52, bw, bh, '闯关模式');
      this.addButton('endless', cx, H * 0.52 + bh + 20, bw, bh, '无尽模式');
      this.addButton('multi', cx, H * 0.52 + 2 * (bh + 20), bw, bh, '多人对战');
    } else if (this.state === 'levels') {
      var cols = 5, lw = Math.min(64, (W - 80) / cols - 10), lh = 50;
      var gridW = cols * (lw + 12) - 12;
      var startX = (W - gridW) / 2 + lw / 2;
      var startY = H * 0.36;
      for (var i = 1; i <= lv.LEVEL_COUNT; i++) {
        var col = (i - 1) % cols, row = Math.floor((i - 1) / cols);
        this.addButton('lv' + i, startX + col * (lw + 12), startY + row * (lh + 16), lw, lh, String(i), i <= this.unlocked);
      }
      this.addButton('back', cx, startY + 2 * (lh + 16) + 42, 160, 48, '返回');
    } else if (this.state === 'clear') {
      var hasNext = this.levelCfg.level < lv.LEVEL_COUNT;
      if (hasNext) this.addButton('next', cx, H * 0.58, bw, bh, '下一关');
      this.addButton('menu', cx, H * 0.58 + (hasNext ? bh + 20 : 0), bw, bh, '返回菜单');
    } else if (this.state === 'over') {
      if (this.mode === 'multi') {
        // 多人结算：手绘卡片下方并排放置（renderer 的卡片自适应停在按钮上方）
        var bw2 = Math.min(170, W * 0.24), bh2 = 50;
        var by2 = Math.min(H * 0.87, H - bh2 / 2 - 16);
        this.addButton('retry', cx - bw2 / 2 - 14, by2, bw2, bh2, '再来一局');
        this.addButton('menu', cx + bw2 / 2 + 14, by2, bw2, bh2, '返回菜单');
      } else {
        this.addButton('retry', cx, H * 0.58, bw, bh, '重来');
        this.addButton('menu', cx, H * 0.58 + bh + 20, bw, bh, '返回菜单');
      }
    }
  };

  Game.prototype.onButton = function (id) {
    if (id === 'level') this.setState('levels');
    else if (id === 'endless') this.startEndless();
    else if (id === 'multi') this.startMulti();
    else if (id === 'back') this.setState('menu');
    else if (id === 'menu') this.setState('menu');
    else if (id === 'retry') {
      if (this.mode === 'level') this.startLevel(this.levelCfg.level);
      else if (this.mode === 'multi') this.startMulti();
      else this.startEndless();
    }
    else if (id === 'next') this.startLevel(this.levelCfg.level + 1);
    else if (id.indexOf('lv') === 0) {
      var n = parseInt(id.slice(2), 10);
      if (n >= 1 && n <= this.unlocked) this.startLevel(n);
    }
  };

  // ---------------- 触摸/鼠标入口（main.js 转发，坐标为 CSS 逻辑像素） ----------------

  Game.prototype.onTouchStart = function (x, y, id) {
    if (this.state === 'play') { this.joystick.onTouchStart(x, y, id); return; }
    for (var i = 0; i < this.uiButtons.length; i++) {
      var b = this.uiButtons[i];
      if (b.enabled && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this.onButton(b.id);
        return;
      }
    }
  };

  Game.prototype.onTouchMove = function (x, y, id) {
    if (this.state === 'play') this.joystick.onTouchMove(x, y, id);
  };

  Game.prototype.onTouchEnd = function (id) {
    this.joystick.onTouchEnd(id);
  };

  CS.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
