'use strict';
/**
 * onlineMatch.js — 在线对战客户端控制器（v3.0 M5，仅浏览器）
 *
 * 串起整条联机管线：WsTransport（或注入的测试/本地传输）→ RemoteMatch（快照视图+插值）
 * → SelfPredictor（本机预测+软校正）→ Game 多人渲染分支（零改动复用）。
 *
 * 对 Game 的约定（game.online = 本实例时，game.update 把帧更新委托给 update(dt)）：
 *   mode='multi' / mp=RemoteMatch / snake=预测蛇 / spawner=快照哑对象 / walls=服务器下发
 *   得分字段（survivalScore/elimScore/mpBonusScore/score/elapsed）每帧从权威快照同步。
 *
 * 生命周期：begin() → matching（queued/matched）→ 首帧 snap 进 play → over/drop → finish()
 * 不支持断线重连：drop 即判负进结算（架构文档 §1）。
 *
 * 服务器地址：opts.url > localStorage 'crayon_snake_web_server' > 同域 /ws（见 wsTransport）。
 * 昵称：localStorage 'crayon_snake_web_nick'，缺省「我xxxx」（随机 4 位）。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var P = CS.protocol;
  var store = CS.storage;

  var INPUT_INTERVAL_MS = 33;   // 上行输入节流（≈30Hz）
  var NICK_KEY = 'crayon_snake_web_nick';
  var SERVER_KEY = 'crayon_snake_web_server';
  var ONLINE_BEST_KEY = 'crayon_snake_web_online_best';

  function defNick() {
    var n = store.get(NICK_KEY, null);
    if (n && typeof n === 'string') return n.slice(0, 12);
    n = '我' + String(Math.floor(Math.random() * 9000) + 1000);
    store.set(NICK_KEY, n);
    return n;
  }

  /**
   * @param {Game} game 宿主 Game（浏览器主控）
   * @param {object} [opts] { url, transport, nick }
   */
  function OnlineMatch(game, opts) {
    opts = opts || {};
    this.game = game;
    this.nick = opts.nick || defNick();
    this.transport = opts.transport || new CS.WsTransport({ url: opts.url || store.get(SERVER_KEY, null) || undefined });
    this.remote = null;
    this.predictor = new CS.SelfPredictor();
    this.playerId = 0;
    this.players = [];         // matched 下发的真人名单 [{id,name}]
    this.status = '正在连接服务器…'; // matching 界面状态行
    this.detail = '';          // 状态行补充（队列位次/对手数）
    this.over = false;
    this._inputTimer = 0;
    this._attached = false;    // 首帧快照已挂接预测体
    this._finished = false;
    this._disposed = false;
  }

  /** 连接并排入匹配队列（按钮「在线对战」触发） */
  OnlineMatch.prototype.begin = function () {
    var self = this;
    this.transport.onAll({
      open: function () {
        if (self._disposed) return;
        self.status = '正在匹配…';
        self.transport.joinMatch(self.nick);
      },
      queued: function (m) {
        self.detail = '队列 ' + (m.pos || 1) + ' / ' + (m.need || '?') + '，人满即开';
      },
      matched: function (m) { self._onMatched(m); },
      start: function () { self.status = '开局！等待首帧同步…'; },
      snap: function (m) { self._onSnap(m); },
      event: function (m) { self._onEvent(m); },
      over: function (m) { self._finish(m.reason, m.ranks, false); },
      drop: function () { self._finish(P.OVER_REASON.DROPPED, null, true); },
      error: function (m) {
        self.status = '服务器错误：' + (m.msg || m.code || 'unknown');
      }
    });
    try {
      if (typeof this.transport.startAuto === 'function') {
        // 本地传输（开发/测试用）：无连接概念，直接入队并自动泵模拟循环
        this.transport.joinMatch(this.nick);
        this.transport.startAuto(33);
      } else {
        this.transport.connect();
      }
    } catch (e) {
      this.status = '连接失败：' + (e && e.message || e);
    }
  };

  /** matched：建地图/视图/哑 spawner，进入开局倒计时（matching 界面继续） */
  OnlineMatch.prototype._onMatched = function (m) {
    var g = this.game;
    this.playerId = m.playerId;
    this.players = m.players || [];
    this.status = '匹配成功！' + this.players.length + ' 名玩家同场';
    this.detail = '开局倒计时 ' + Math.ceil((m.countdownMs || 0) / 1000) + ' 秒…';

    g.mode = 'multi';
    g.levelCfg = { level: 0, W: m.W, H: m.H, wallSegments: 0, targetScore: 0, speed: cfg.SNAKE_SPEED };
    g.walls = new CS.Walls(m.W, m.H, { x: m.W / 2, y: m.H / 2 });
    if (m.walls) {
      for (var i = 0; i < m.walls.length; i++) {
        var r = m.walls[i];
        g.walls.rects.push({ x: r[0], y: r[1], w: r[2], h: r[3] });
      }
    }
    // 联机不设本地解锁上限：服务器蛇可带任意颜色（渲染按快照 colors 直出）
    g.unlockedCount = cfg.MAX_COLORS;
    g.unlockedKeys = cfg.COLOR_KEYS.slice();
    g.elapsed = 0; g.score = 0; g.survivalScore = 0; g.elimScore = 0;
    g.mpBonusScore = 0; g.elimCombo = 0; g.elimComboTimer = 0;
    g.mpResult = null; g.slowUntil = 0;
    g.particles.clear();
    g.joystick.onTouchEnd(g.joystick.touchId);

    this.remote = new CS.RemoteMatch(this.playerId);
    g.mp = this.remote;
    // 哑 spawner：blocks/meteors 每帧从快照刷新；grabBlock 供彩色星播报/小地图涟漪
    g.spawner = { blocks: [], meteors: [], grabBlock: null, others: [] };
  };

  /** 快照：应用视图 + 本机 reconcile；首帧挂接预测体并切入 play */
  OnlineMatch.prototype._onSnap = function (m) {
    if (!this.remote || this._finished) return;
    var now = Date.now();
    this.remote.applySnap(m, now);
    var selfData = null;
    for (var i = 0; i < m.sn.length; i++) {
      if (m.sn[i].id === this.playerId) { selfData = P.deSnake(m.sn[i]); break; }
    }
    if (!selfData) return; // 本机 Entry 不在快照里（异常），等下一帧

    var g = this.game;
    if (!this._attached) {
      this._attached = true;
      this.predictor.attach(selfData, g.unlockedKeys);
      g.snake = this.predictor.snake;
      g.snapCamera();
      if (CS.audio) CS.audio.startBgm();
      g.setState('play');
    } else {
      this.predictor.reconcile(selfData);
    }
    this._syncSpawner();
  };

  /** 哑 spawner 与最新快照对齐（渲染/播报只读这三个字段） */
  OnlineMatch.prototype._syncSpawner = function () {
    var g = this.game, r = this.remote;
    if (!g.spawner || !r) return;
    g.spawner.blocks = r.blocks;
    g.spawner.meteors = r.meteors;
    var grab = null;
    for (var i = 0; i < r.blocks.length; i++) {
      if (r.blocks[i].kind === cfg.GRAB_KIND) { grab = r.blocks[i]; break; }
    }
    g.spawner.grabBlock = grab;
  };

  /** 离散事件 → 粒子/音效/飘字/墙体（本人相关事件才弹 toast） */
  OnlineMatch.prototype._onEvent = function (m) {
    var g = this.game, A = CS.audio;
    var mine = m.id === this.playerId;
    var col = (m.color && cfg.COLORS[m.color]) || '#FFD94A';
    switch (m.k) {
      case 'wall':
        if (g.walls) g.walls.rects.push({ x: m.x, y: m.y, w: m.w, h: m.h });
        break;
      case 'death':
        g.particles.flash(m.x, m.y, '#FFFFFF', mine ? 2.2 : 1.2);
        g.particles.burst(m.x, m.y, '#E8552F', mine ? 16 : 8, 1.3);
        if (mine && A) A.playWall();
        break;
      case 'elim': {
        var segs = m.segs || [];
        var sx = 0, sy = 0, maxChain = 1;
        for (var i = 0; i < segs.length; i++) {
          var c = segs[i].color === 'wild' ? '#FFD94A' : (cfg.COLORS[segs[i].color] || '#FFD94A');
          var fx = 1 + ((segs[i].chain || 1) - 1) * cfg.CHAIN_FX_STEP;
          g.particles.burst(segs[i].x, segs[i].y, c, Math.round(5 * fx), fx);
          g.particles.ring(segs[i].x, segs[i].y, c, fx);
          sx += segs[i].x; sy += segs[i].y;
          if ((segs[i].chain || 1) > maxChain) maxChain = segs[i].chain;
        }
        if (segs.length) {
          var cx = sx / segs.length, cy = sy / segs.length;
          g.particles.flash(cx, cy, '#FFD94A', 1, Math.min(4, maxChain));
          if (maxChain >= cfg.CHAIN_TEXT_MIN) {
            g.particles.chainText(cx, cy - 24, maxChain + '连锁！', 20 + (maxChain - 1) * 6);
          }
        }
        if (mine && A) { A.playElim(); if (maxChain >= 2) A.playChain(maxChain); }
        break;
      }
      case 'bite':
        g.particles.burst(m.x, m.y, col, 7, 1.2);
        if (mine && A) A.playWall();
        break;
      case 'item':
        g.particles.burst(m.x, m.y, col, mine ? 9 : 4, 1.2);
        if (mine) { g.setItemToast(m.kind, m.color); if (A) A.playSpecial(); }
        break;
      case 'grab':
        g.particles.burst(m.x, m.y, '#FFD94A', mine ? 14 : 6, 1.6);
        if (mine) {
          g.itemToast = { text: '彩色星！总分 +' + (m.bonus || 0) + ' 分', until: g.timeMs + cfg.ITEM_TOAST_MS };
          if (A) A.playSpecial();
        }
        break;
      case 'grab_spawn':
        g.particles.chainText(m.x, m.y - 20, '彩色星出现！', 18);
        break;
      case 'meteor':
        g.particles.burst(m.x, m.y, col, mine ? 7 : 3, 1.3);
        if (mine) { g.setItemToast('meteor', m.color); if (A) A.playSpecial(); }
        break;
      case 'self_pull':
        if (mine) {
          g.particles.ring(m.x, m.y, col, 1.4);
          g.particles.burst(m.x, m.y, col, 8, 1.4);
          if (g.snake) g.particles.streak(m.x, m.y, g.snake.x, g.snake.y, col);
          g.particles.chainText(m.x, m.y - 26, '自吃 +1', 16);
          if (A) A.playEat();
        }
        break;
      case 'toast':
        if (mine) g.setItemToast(m.kind, m.color);
        break;
    }
  };

  /**
   * 帧更新（game.update 在 online 时委托到这里）：
   * 输入节流上行 → 本机预测推进 → 他机插值采样 → HUD 字段同步 → 相机。
   */
  OnlineMatch.prototype.update = function (dt) {
    var g = this.game, r = this.remote;
    if (!r || this._finished) return;

    var ang = g.joystick.currentAngle();
    var selfAlive = !!(r.playerEntry && r.playerEntry.alive);

    // 上行输入（节流 30Hz；只在有方向输入且存活时发）
    this._inputTimer -= dt;
    if (this._inputTimer <= 0) {
      this._inputTimer = INPUT_INTERVAL_MS;
      if (ang !== null && selfAlive) this.transport.sendInput(ang, 0);
    }

    // 本机预测 + 他机插值
    if (this._attached) this.predictor.update(dt, ang === null ? undefined : ang);
    r.renderSample(Date.now());

    // 本机 Entry 视图与预测体对齐（名牌/排行榜/小地图读它）
    var e = r.playerEntry;
    if (e && this.predictor.snake) {
      var ps = this.predictor.snake, vs = e.snake;
      vs.x = ps.x; vs.y = ps.y; vs.angle = ps.angle; vs.speed = ps.speed;
      vs.colors = ps.colors; vs.segPos = ps.segPos;
    }

    // HUD 计分同步（权威在服务器 Entry 上）
    if (e) {
      g.elapsed = r.timeMs;
      g.survivalScore = e.survivalScore || 0;
      g.elimScore = e.elimScore || 0;
      g.mpBonusScore = e.mpBonusScore || 0;
      g.score = g.survivalScore + g.elimScore + g.mpBonusScore;
      // 减速显示：mp.timeMs 域 → game.timeMs 域
      var slowRemain = (e.slowUntil || 0) - r.timeMs;
      g.slowUntil = slowRemain > 0 ? g.timeMs + slowRemain : 0;
    }

    g.updateCamera(dt);
  };

  /**
   * 结算：reason ∈ win/dead/timeout/dropped；掉线判负不重连。
   * 合成 mpResult（renderer.drawMultiResult 直接复用；dropped 额外提示）。
   */
  OnlineMatch.prototype._finish = function (reason, ranks, dropped) {
    if (this._finished) return;
    this._finished = true;
    var g = this.game, A = CS.audio;
    if (A) { A.stopBgm(); if (!dropped) A.playWall(); }

    // 还在匹配阶段就掉线/出错：静默回菜单（无对局可结算）
    if (g.state === 'matching') {
      this.dispose();
      g.online = null;
      g.setState('menu');
      return;
    }

    var e = this.remote && this.remote.playerEntry;
    var myRank = null;
    if (ranks) {
      for (var i = 0; i < ranks.length; i++) {
        if (ranks[i].id === this.playerId) { myRank = ranks[i]; break; }
      }
    }
    var surviveSec = Math.floor((this.remote ? this.remote.timeMs : 0) / 1000);
    var score = g.score;
    var finalLen = myRank ? myRank.length : (e ? e.snake.length() : 0);
    var maxLen = e ? e.maxLen : finalLen;
    var rank = myRank ? myRank.rank : (e && this.remote ? this.remote.rankOf(e) : 0);

    var best = store.get(ONLINE_BEST_KEY, { len: 0, score: 0 });
    var newBest = maxLen > (best.len | 0) || score > (best.score | 0);
    best = { len: Math.max(best.len | 0, maxLen), score: Math.max(best.score | 0, score) };
    store.set(ONLINE_BEST_KEY, best);

    g.mpResult = {
      online: true,
      dropped: !!dropped,
      surviveSec: surviveSec,
      score: score,
      survivalScore: g.survivalScore,
      elimScore: g.elimScore,
      elimTotal: e ? e.elimTotal : 0,
      rank: rank,
      kills: myRank ? (myRank.kills || 0) : (e ? e.kills : 0),
      finalLen: finalLen,
      maxLen: maxLen,
      bestLen: best.len,
      bestScore: best.score,
      newBest: newBest
    };
    g.overAt = g.timeMs;
    this.transport.dispose(); // 对局结束即释放连接（rooms 结算后服务端也会回收）
    g.setState('over');
  };

  /** 主动离开（取消匹配/返回菜单）：释放传输与事件 */
  OnlineMatch.prototype.dispose = function () {
    if (this._disposed) return;
    this._disposed = true;
    try { this.transport.cancelMatch(); } catch (e) {}
    this.transport.dispose();
  };

  CS.OnlineMatch = OnlineMatch;
  if (typeof module !== 'undefined' && module.exports) module.exports = OnlineMatch;
})(typeof window !== 'undefined' ? window : globalThis);
