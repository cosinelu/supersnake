'use strict';
/**
 * headlessGame.js — 无头对局宿主（v3.0，两端共享：服务器房间 / 浏览器 LocalTransport）
 *
 * 伪装成本地 Game 对象的字段面，让 CS.Multiplayer 原样跑在 Node 服务器或测试里：
 *   walls / spawner / particles(空实现) / elapsed / unlockedKeys /
 *   survivalScore·elimScore·mpBonusScore·elimCombo（兼容字段，真人计分在 Entry 上）/
 *   setItemToast(→ toast 事件) / onMpEvent(离散事件出口)
 *
 * 与本地 Game 多人分支的差异：
 *   - 支持 N 名真人（setup(playerNames)），出生点全部走 mp.findSpawn（边缘安全位，与 AI 同规则）；
 *   - 无相机/渲染/音效/横幅/持久化；颜色解锁静默更新刷新池；
 *   - 离散事件（death/elim/bite/item/grab/meteor/toast/grab_spawn/self_pull）统一从
 *     onMpEvent 流出，由 room / LocalTransport 转成协议 event 广播。
 *
 * 确定性：全部随机走 Math.random；测试用 CS.utils.makeRng(seed) 替换 + CS.resetMultiplayerIds()
 * 即可同种子双跑一致（见 test/net/room.test.js）。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var u = CS.utils;
  var Walls = CS.Walls;
  var Snake = CS.Snake;
  var Spawner = CS.Spawner;

  /** 粒子空实现（服务器无渲染；接口与 CS.Particles 对齐） */
  var NOOP_PARTICLES = {
    burst: function () {}, flash: function () {}, ring: function () {},
    chainText: function () {}, streak: function () {},
    clear: function () {}, update: function () {}
  };

  /**
   * @param {object} [opts] { W, H, wallSegments, onEvent(kind,data) }
   */
  function HeadlessGame(opts) {
    opts = opts || {};
    var m = cfg.MULTI;
    this.W = opts.W || m.W;
    this.H = opts.H || m.H;
    var spawn = { x: this.W / 2, y: this.H / 2 };
    this.walls = new Walls(this.W, this.H, spawn);
    this.walls.generateWalls(opts.wallSegments != null ? opts.wallSegments : m.wallSegments);

    this.unlockedCount = cfg.unlockedCountForEndless(0);
    this.unlockedKeys = cfg.unlockedColorKeys(this.unlockedCount);

    this.elapsed = 0;
    this.timeMs = 0;
    this.wallSpawnTimer = Math.round(cfg.WALL_SPAWN_INTERVAL_MS * 0.5);

    // 兼容 multiplayer 读取的宿主字段（真人计分在 Entry 上，这些仅为字段面兼容）
    this.snake = null;            // 无头对局无"主蛇"；本地模式由 Game 自己持有
    this.survivalScore = 0;
    this.elimScore = 0;
    this.mpBonusScore = 0;
    this.elimCombo = 0;

    this.particles = NOOP_PARTICLES;
    this.spawner = null;
    this.mp = null;

    this._onEvent = opts.onEvent || null;
    this._hadGrab = false; // 彩色星 null→block 变迁检测（grab_spawn 事件）
  }

  /** 兼容调用：连击已下沉到 Entry（mp.scoreChain 不再调 game.bumpCombo），防御保留 */
  HeadlessGame.prototype.bumpCombo = function () {};

  /** multiplayer 的飘字调用 → toast 事件（按 Entry 路由，客户端仅本人展示） */
  HeadlessGame.prototype.setItemToast = function (kind, color, entry) {
    this.onMpEvent('toast', { id: entry ? entry.id : 0, kind: kind, color: color || null });
  };

  /** 离散事件统一出口 */
  HeadlessGame.prototype.onMpEvent = function (kind, data) {
    if (this._onEvent) this._onEvent(kind, data);
  };

  /**
   * 建房：为每个真人名字造蛇（边缘安全出生位、朝向场心）并注册，随后补 AI 编制、满刷色块。
   * @param {string[]} playerNames 真人玩家名（至少 1 个）
   * @returns {Entry[]} 真人 Entry（顺序与 playerNames 一致）
   */
  HeadlessGame.prototype.setup = function (playerNames) {
    this.spawner = new Spawner(this.walls, null); // 无主蛇：避让全靠 mp.liveSnakes（spawner.others）
    this.spawner.unlockedKeys = this.unlockedKeys;
    this.spawner.grabEnabled = true; // 多人对战：启用「彩色星」抢夺道具
    this.spawner.target = u.clamp(Math.round(this.W * this.H / cfg.MP_BLOCK_AREA_DIV),
      cfg.MP_BLOCKS_MIN, cfg.MP_BLOCKS_MAX);

    this.mp = new CS.Multiplayer(this);
    var names = (playerNames && playerNames.length) ? playerNames : ['我'];
    for (var i = 0; i < names.length; i++) {
      var pos = this.mp.findSpawn(); // 与 AI 同规则：边缘安全位（此时已注册的真人会被避让）
      var angle = Math.atan2(this.H / 2 - pos.y, this.W / 2 - pos.x);
      var snake = new Snake(pos.x, pos.y, cfg.START_LENGTH, angle, this.unlockedKeys);
      this.mp.addPlayer(snake, String(names[i] || '玩家'));
    }
    this.mp.setup(); // players 已存在 → 跳过本地回退；补 AI + spawner.others = liveSnakes
    this.spawner.fillNow();
    return this.mp.players;
  };

  /** 写入真人输入（在 tick 前调用；死亡后忽略） */
  HeadlessGame.prototype.setInput = function (entry, angle) {
    if (entry && entry.alive && typeof angle === 'number') entry.snake.setTargetAngle(angle);
  };

  /**
   * 推进一个固定步长 tick：
   *  颜色解锁（静默）→ 动态墙体 → mp 编排 → 彩色星出现事件 → 真人自碰重组。
   * @param {number} dt 毫秒
   */
  HeadlessGame.prototype.tick = function (dt) {
    this.timeMs += dt;
    this.elapsed += dt;

    // 颜色解锁（同 Game.update 多人分支；无横幅/音效，仅更新刷新池）
    var cnt = cfg.unlockedCountForEndless(Math.floor(this.elapsed / 1000));
    if (cnt > this.unlockedCount) {
      this.unlockedCount = cnt;
      this.unlockedKeys = cfg.unlockedColorKeys(cnt);
      this.spawner.unlockedKeys = this.unlockedKeys;
    }

    // 动态墙体生成（同 Game.updateWallSpawn，避让点 = 全部活蛇节）；新增墙体逐个广播
    this.wallSpawnTimer -= dt;
    if (this.wallSpawnTimer <= 0) {
      this.wallSpawnTimer = cfg.WALL_SPAWN_INTERVAL_MS;
      var pts = [];
      var live = this.mp.aliveSnakes();
      for (var i = 0; i < live.length; i++) {
        var sp = live[i].segPos;
        for (var k = 0; k < sp.length; k++) pts.push(sp[k]);
      }
      var before = this.walls.rects.length;
      this.walls.addRandomWall(pts, cfg.WALL_SPAWN_MAX);
      for (var w = before; w < this.walls.rects.length; w++) {
        var r = this.walls.rects[w];
        this.onMpEvent('wall', { x: r.x | 0, y: r.y | 0, w: r.w | 0, h: r.h | 0 });
      }
    }

    this.mp.update(dt);

    // 彩色星出现事件（spawner 无钩子，轮询变迁；消失无需事件，快照自会反映）
    var hasGrab = !!this.spawner.grabBlock;
    if (hasGrab && !this._hadGrab) {
      this.onMpEvent('grab_spawn', { x: this.spawner.grabBlock.x, y: this.spawner.grabBlock.y });
    }
    this._hadGrab = hasGrab;

    // 真人自碰重组（同 Game.updateMulti；每名真人各自判定与计分）
    for (i = 0; i < this.mp.players.length; i++) {
      var e = this.mp.players[i];
      if (!e.alive || e.snake.selfPullCd > 0) continue;
      var pulled = e.snake.trySelfPull();
      if (pulled) {
        e.snake.selfPullCd = cfg.SELF_PULL_CD;
        this.onMpEvent('self_pull', { id: e.id, x: pulled.x, y: pulled.y, color: pulled.color });
        this.mp.resolveElim(e);
      }
    }
  };

  CS.HeadlessGame = HeadlessGame;
  if (typeof module !== 'undefined' && module.exports) module.exports = HeadlessGame;
})(typeof window !== 'undefined' ? window : globalThis);
