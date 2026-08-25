'use strict';
/**
 * snake.js — 蛇模型（v2：自由方向连续移动，DOM 无关）
 *  - 蛇头有连续位置 (x,y) 与朝向角 angle；输入给出目标角 targetAngle，
 *    蛇头以最大转向速率 TURN_RATE 平滑逼近目标角，前进速度 speed 恒定（px/s）；
 *  - 身体跟随：维护蛇头轨迹 trail（trail[0] 最新），各节沿轨迹按固定弧长
 *    SEG_SPACING 排布（经典 trail-following）；
 *  - 尾巴节（v2.3）：colors 保持纯颜色节，身体几何总长 = colors.length + 1，
 *    segPos 末尾恒多 1 节「尾巴节」（下标 = colors.length）。它不参与消除判定、
 *    不会被消除/咬断移除、不占 MIN_LENGTH 保底计数；但它是身体的一部分——
 *    收集/碰撞/撞身判定对它正常生效。渲染为深色蜡笔小尾鳍（renderer.drawTail）。
 *  - 颜色序列 colors[0] = 头；吃到色块 colors.unshift(新色)：头立即变为新颜色、
 *    原头变第 1 节身体、总长 +1（祖玛式从一端推入）；
 *  - 消除：颜色序列中相邻连续 ≥ELIM_RUN 同色立即移除，支持连锁，长度保底
 *    MIN_LENGTH（从末尾保留）。身体位置由轨迹派生，消除后自然伸缩。
 *  - 不做蛇身自碰（沿用原设计）。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;
  var u = CS.utils;

  /**
   * @param {number} x 出生点世界坐标
   * @param {number} y
   * @param {number} len 初始节数
   * @param {number} angle 初始朝向（弧度，0 = 向右）
   * @param {string[]} colorKeys 可用颜色池（已解锁色）
   */
  function Snake(x, y, len, angle, colorKeys) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.targetAngle = angle;
    this.speed = cfg.SNAKE_SPEED;
    this.colors = [];                 // colors[0] = 头
    this.trail = [{ x: x, y: y }];    // 头部轨迹，trail[0] 最新
    this.selfPullCd = 0;             // 自碰重组冷却（ms），>0 时不可触发（防刷屏）
    this.segPos = [];                 // 每节中心（含头），computeBody 派生
    // 出生时颜色随机但避免直接凑成 4 连（tries 防御：可选颜色不足时接受现状，不死循环）
    for (var i = 0; i < len; i++) {
      var color = colorKeys[0], tries = 0;
      do {
        color = colorKeys[Math.floor(Math.random() * colorKeys.length)];
      } while (++tries < 16 && i >= 3 &&
               this.colors[i - 1] === color &&
               this.colors[i - 2] === color &&
               this.colors[i - 3] === color);
      this.colors.push(color);
    }
    this.computeBody();
  }

  /** 颜色节数（消除/咬断/保底/计分/速度加成都按此计数，不含尾巴节） */
  Snake.prototype.length = function () { return this.colors.length; };

  /** 身体总节数（含恒在的尾巴节）= 颜色节数 + 1 */
  Snake.prototype.totalLength = function () { return this.colors.length + 1; };

  Snake.prototype.headColor = function () { return this.colors[0]; };

  /** 头部朝向单位向量（渲染眼睛 / 粒子方向用） */
  Snake.prototype.headDir = function () {
    return { x: Math.cos(this.angle), y: Math.sin(this.angle) };
  };

  /** 设置目标朝向角（弧度）；蛇头按 TURN_RATE 平滑逼近 */
  Snake.prototype.setTargetAngle = function (a) {
    this.targetAngle = u.normAngle(a);
  };

  /**
   * 每帧推进：转向（速率钳制）→ 前进 → 记录轨迹 → 重算身体 → 裁剪轨迹。
   * @param {number} dtMs 帧间隔（毫秒）
   */
  Snake.prototype.update = function (dtMs) {
    var dt = dtMs / 1000;
    // 转向：目标角突变时按 maxTurn 逐步逼近（走最短弧）
    this.angle = u.turnToward(this.angle, this.targetAngle, cfg.TURN_RATE * dt);
    // 前进（恒定速度）
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
    // 轨迹：头距最近记录点 ≥ TRAIL_STEP 才新增记录点（trail[0] 不随身移动，
    // 否则单帧位移 < TRAIL_STEP 时永远不累积，轨迹会塌缩成 1 个点）
    var t0 = this.trail[0];
    var dx = this.x - t0.x, dy = this.y - t0.y;
    if (dx * dx + dy * dy >= cfg.TRAIL_STEP * cfg.TRAIL_STEP) {
      this.trail.unshift({ x: this.x, y: this.y });
    }
    this.computeBody();
    this.trimTrail();
    if (this.selfPullCd > 0) this.selfPullCd = Math.max(0, this.selfPullCd - dtMs); // 自碰重组冷却衰减
  };

  /**
   * 自碰重组（v2.9 新机制）：当蛇头重叠到自身某一节身体（k≥1，不含恒在的尾巴节）时，
   * 把该节颜色移出并 unshift 到头部——总长度不变，但头部颜色改变、身体沿轨迹自然收拢，
   * 可能凑出新的同色段触发消除，增加消除的变化性（且不吃不长，节奏不膨胀）。
   * 仅当 selfPullCd<=0 时调用方才应触发；触发后由调用方重新设置冷却。
   * @returns {{color:string,x:number,y:number,idx:number}|null} 被拉到头部的节信息；无重叠返回 null
   */
  Snake.prototype.trySelfPull = function () {
    if (this.colors.length < cfg.MIN_LENGTH + 1) return null; // 至少 4 节才值得重组
    var tol = cfg.HEAD_HIT_RADIUS + cfg.SEG_RADIUS;
    var tol2 = tol * tol;
    // 从离头最近的一节开始找（k=1 是脖子，越往后越深）；命中第一个重叠的身体节
    for (var k = 1; k < this.segPos.length - 1; k++) {
      var sp = this.segPos[k];
      var dx = sp.x - this.x, dy = sp.y - this.y;
      if (dx * dx + dy * dy < tol2) {
        var color = this.colors[k];
        // 移出第 k 节、unshift 到头部（总长不变）；身体由轨迹重新派生自然收拢
        this.colors.splice(k, 1);
        this.colors.unshift(color);
        this.computeBody();
        return { color: color, x: sp.x, y: sp.y, idx: k };
      }
    }
    return null;
  };

  /**
   * 沿轨迹按弧长间距排布身体各节（segPos[0] = 头）。
   * 从头的实时位置出发，依次走向 trail[0]、trail[1]…，相邻节间距 = SEG_SPACING。
   * 节数 = colors.length + 1：末尾恒追加 1 节尾巴节（segPos[colors.length]）。
   * 轨迹不足时（开局）节堆叠在轨迹尾点，随移动自然拉开。
   */
  Snake.prototype.computeBody = function () {
    var n = this.colors.length + 1; // +1 = 不可消除的尾巴节
    var sp = cfg.SEG_SPACING;
    var trail = this.trail;
    var pos = this.segPos;
    pos.length = 0;
    pos.push({ x: this.x, y: this.y });
    var acc = 0;                 // 已沿轨迹走的弧长
    var px = this.x, py = this.y;
    var ti = 0;                  // 下一个要走向的轨迹点下标
    for (var i = 1; i < n; i++) {
      var target = i * sp;
      while (acc < target && ti < trail.length) {
        var nx = trail[ti].x, ny = trail[ti].y;
        var d = u.dist(px, py, nx, ny);
        if (acc + d >= target) { // 在本段轨迹内插值
          var k = (target - acc) / (d || 1e-6);
          px = px + (nx - px) * k;
          py = py + (ny - py) * k;
          acc = target;
          break;
        }
        acc += d;
        px = nx; py = ny;
        ti++;
      }
      pos.push({ x: px, y: py }); // 轨迹耗尽时 px,py 即轨迹尾点
    }
  };

  /** 裁剪轨迹：只保留身体所需弧长 + 余量，防止无限增长 */
  Snake.prototype.trimTrail = function () {
    var maxNeed = (this.colors.length + 1) * cfg.SEG_SPACING + 60; // +1：尾巴节弧长
    var acc = 0, keep = this.trail.length;
    var px = this.x, py = this.y;
    for (var i = 0; i < this.trail.length; i++) {
      acc += u.dist(px, py, this.trail[i].x, this.trail[i].y);
      if (acc > maxNeed) { keep = Math.max(1, i + 1); break; }
      px = this.trail[i].x; py = this.trail[i].y;
    }
    if (this.trail.length > keep) this.trail.length = keep;
  };

  /**
   * 吃到色块：新颜色进头部（祖玛式从一端推入）。
   * 头立即变为该颜色，原头变成第 1 节身体，总长 +1。
   */
  Snake.prototype.grow = function (color) {
    this.colors.unshift(color);
    this.computeBody(); // 立即对齐身体渲染（新节位于头后 SEG_SPACING 处）
  };

  /** 吃到万能色块：头部插入一个 'wild' 节（消除时可匹配任意相邻同色，见 findRuns） */
  Snake.prototype.growWild = function () {
    this.colors.unshift('wild');
    this.computeBody();
  };

  /**
   * 收集判定辅助：蛇头或任一身体节中心距 (x,y) 是否 < r + SEG_RADIUS
   * （「身体穿过也算」的圆形重叠判定）。
   */
  Snake.prototype.overlaps = function (x, y, r) {
    var rr = r + cfg.SEG_RADIUS;
    var rr2 = rr * rr;
    for (var i = 0; i < this.segPos.length; i++) {
      var dx = this.segPos[i].x - x, dy = this.segPos[i].y - y;
      if (dx * dx + dy * dy < rr2) return true;
    }
    return false;
  };

  /** 蛇身（含头）到 (x,y) 的最小距离（spawner 避让用） */
  Snake.prototype.distTo = function (x, y) {
    var best = Infinity;
    for (var i = 0; i < this.segPos.length; i++) {
      var d = u.dist(this.segPos[i].x, this.segPos[i].y, x, y);
      if (d < best) best = d;
    }
    return best;
  };

  /**
   * 咬断：移除颜色序列第 idx 节（多人对战「头撞身」附加效果，idx ≥ 1，不咬头）。
   * 与消除同一处理路径：只改颜色序列，身体几何由轨迹重新派生，缺口自然收拢。
   * 尾巴节（下标 = colors.length）不在颜色序列内，下标越界天然返回 null，不可被咬。
   * @param {number} idx 被咬节下标（segPos[1..colors.length-1] 中离撞者头心最近者，由调用方选定）
   * @returns {{color:string,x:number,y:number}|null} 被移除节信息（粒子/判定用）；下标非法返回 null
   */
  Snake.prototype.removeSegAt = function (idx) {
    if (idx < 1 || idx >= this.colors.length) return null;
    var p = this.segPos[idx] || { x: this.x, y: this.y };
    var color = this.colors.splice(idx, 1)[0];
    this.computeBody(); // 身体从缺口处自然收拢
    return { color: color, x: p.x, y: p.y };
  };

  /**
   * 流星注入：在身体第 idx 节前插入一个颜色节（中段注入，idx 越界自动夹紧）。
   * 与 grow（头部插入）共用身体几何派生，缺口自然收拢。用于「流星砖块」可靠的中段注入。
   */
  Snake.prototype.insertAt = function (idx, color) {
    idx = Math.max(0, Math.min(this.colors.length, idx | 0));
    this.colors.splice(idx, 0, color);
    this.computeBody();
  };

  /**
   * 命中检测：返回第一个与 (x,y) 距离 < r + SEG_RADIUS 的身体节下标（含尾巴节 colors.length），无则 -1。
   * 供流星砖块碰撞用（命中即在该节注入）。
   */
  Snake.prototype.segIndexAt = function (x, y, r) {
    var rr2 = (r + cfg.SEG_RADIUS) * (r + cfg.SEG_RADIUS);
    for (var i = 0; i < this.segPos.length; i++) {
      var dx = this.segPos[i].x - x, dy = this.segPos[i].y - y;
      if (dx * dx + dy * dy < rr2) return i;
    }
    return -1;
  };

  /** 内部：按下标数组批量移除，返回 [{color,x,y,chain:1}]（移除前捕获世界坐标供特效） */
  Snake.prototype._removeAt = function (idxs) {
    if (!idxs || !idxs.length) return [];
    idxs = idxs.slice().sort(function (a, b) { return a - b; });
    var removed = [];
    for (var k = idxs.length - 1; k >= 0; k--) { // 降序 splice，避免位移
      var idx = idxs[k];
      if (idx < 0 || idx >= this.colors.length) continue;
      var p = this.segPos[idx] || { x: this.x, y: this.y };
      removed.push({ color: this.colors[idx], x: p.x, y: p.y, chain: 1 });
      this.colors.splice(idx, 1);
    }
    this.computeBody();
    return removed;
  };

  /** 消色道具：移除所有该颜色的节（尾巴节恒在非颜色序列，天然排除） */
  Snake.prototype.removeByColor = function (color) {
    var idxs = [];
    for (var i = 0; i < this.colors.length; i++) if (this.colors[i] === color) idxs.push(i);
    return this._removeAt(idxs);
  };

  /** 后 N 消色：移除该颜色中最靠尾（下标最大）的至多 n 节 */
  Snake.prototype.removeRearByColor = function (color, n) {
    var idxs = [];
    for (var i = 0; i < this.colors.length; i++) if (this.colors[i] === color) idxs.push(i);
    if (idxs.length > n) idxs = idxs.slice(idxs.length - n);
    return this._removeAt(idxs);
  };

  /** 随机消：随机移除 n 节（互异下标），不足 n 则移除全部 */
  Snake.prototype.removeRandom = function (n) {
    var pool = [];
    for (var i = 0; i < this.colors.length; i++) pool.push(i);
    var idxs = [];
    for (var k = 0; k < n && pool.length; k++) {
      var j = Math.floor(Math.random() * pool.length);
      idxs.push(pool[j]); pool.splice(j, 1);
    }
    return this._removeAt(idxs);
  };

  /**
   * 找出所有长度 ≥ runLen 的同色连续段（返回下标段数组）。
   * 支持万能色 'wild'：一段连续节中，非 wild 节必须同色、wild 可充当中介/两端；
   * 该段整体视作该颜色（wild 节也计入长度并参与消除）——「万能色」即由此实现。
   */
  Snake.prototype.findRuns = function (runLen) {
    var runs = [], i = 0, n = this.colors.length;
    while (i < n) {
      var j = i;
      var runColor = this.colors[i] === 'wild' ? null : this.colors[i];
      while (j + 1 < n) {
        var c = this.colors[j + 1];
        if (c === 'wild') { j++; continue; }
        if (runColor === null) { runColor = c; j++; continue; }
        if (c === runColor) { j++; continue; }
        break;
      }
      if (runColor !== null && j - i + 1 >= runLen) {
        var r = [];
        for (var k = i; k <= j; k++) r.push(k);
        runs.push(r);
      }
      i = j + 1;
    }
    return runs;
  };

  /**
   * 执行消除（含连锁）。
   * 连锁等级 chain：一轮消除后颜色序列接拢、又凑成 ≥runLen 连再次消除时 chain+1。
   * @param {number} minLen 消除后保底长度（不足时从末尾保留）
   * @param {number} runLen 触发消除的连续同色节数
   * @returns {Array} 被移除的节 [{color,x,y,chain}]（x,y 为消除瞬间的世界坐标；
   *   chain 为该节被消除时的连锁等级，从 1 起，用于连锁倍率计分与逐级放大特效）
   */
  Snake.prototype.eliminate = function (minLen, runLen) {
    var removed = [];
    var guard = 0;
    var chain = 0; // 当前连锁等级（每进入一轮消除 +1）
    while (guard++ < 32) { // 防御性上限，正常连锁远小于此
      var runs = this.findRuns(runLen);
      if (!runs.length) break;
      chain++;
      var mark = {};
      runs.forEach(function (r) { r.forEach(function (idx) { mark[idx] = true; }); });
      // 保底：若删完长度不足 minLen，从尾部（下标大的一端）开始取消标记
      var idxs = Object.keys(mark).map(Number).sort(function (a, b) { return b - a; });
      var removeCount = idxs.length;
      while (this.colors.length - removeCount < minLen && removeCount > 0) {
        delete mark[idxs[idxs.length - removeCount]];
        removeCount--;
      }
      if (!removeCount) break;
      var next = [];
      for (var i = 0; i < this.colors.length; i++) {
        if (mark[i]) {
          var p = this.segPos[i] || { x: this.x, y: this.y };
          removed.push({ color: this.colors[i], x: p.x, y: p.y, chain: chain });
        } else {
          next.push(this.colors[i]);
        }
      }
      this.colors = next;
    }
    if (removed.length) this.computeBody(); // 身体由轨迹派生，消除后自然收缩
    return removed;
  };

  CS.Snake = Snake;
})(typeof window !== 'undefined' ? window : globalThis);
