'use strict';
/**
 * layout.test.js — 横竖屏自适应布局回归（v3.0.2）
 * 运行：node test/net/layout.test.js
 *
 * 背景（docs/design/01-game-design.md §3.8）：原布局硬编码「右侧竖向 HUD 面板」，
 * 手机竖持时面板会吃掉近半屏宽，可玩区退化成窄条。现按朝向分支：
 *   横屏 → 右侧竖条；竖屏 → 顶部横条（可玩区占满宽度）。
 *
 * layout() 现返回视口矩形 viewX/viewY/viewW/viewH 作为世界渲染与相机的唯一权威来源，
 * 本测试锁定两种朝向下「视口 + 面板恰好铺满屏幕且互不重叠」这一核心不变量。
 */
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'joystick',
  'layoutBus', 'ai', 'multiplayer', 'renderer', 'game'].forEach(function (f) { require(path.join(JS, f + '.js')); });

var CS = globalThis.CS;

var passed = 0, failed = 0, failedNames = [];
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); failedNames.push(name); }
}
function section(t) { console.log('\n[' + t + ']'); }

/** 核心不变量：视口 + 面板铺满屏幕、互不重叠、视口有合理面积 */
function assertLayoutSane(g, label) {
  var l = g.layout();
  var W = g.screenW, H = g.screenH;

  ok(l.viewW > 0 && l.viewH > 0, label + '：视口尺寸为正（' + l.viewW + 'x' + l.viewH + ')',
    'viewW=' + l.viewW + ' viewH=' + l.viewH);

  if (l.portrait) {
    ok(l.viewX === 0 && l.viewW === W, label + '：竖屏视口占满宽度',
      'viewX=' + l.viewX + ' viewW=' + l.viewW + ' W=' + W);
    ok(l.viewY === l.panelH, label + '：竖屏视口起点 = 顶部面板高度',
      'viewY=' + l.viewY + ' panelH=' + l.panelH);
    ok(l.panelH + l.viewH === H, label + '：竖屏面板+视口铺满高度',
      l.panelH + '+' + l.viewH + ' != ' + H);
    ok(l.viewH > H * 0.6, label + '：竖屏可玩区 > 屏高 60%（面板不喧宾夺主）',
      'viewH/H=' + (l.viewH / H).toFixed(2));
  } else {
    ok(l.viewY === 0 && l.viewH === H, label + '：横屏视口占满高度',
      'viewY=' + l.viewY + ' viewH=' + l.viewH + ' H=' + H);
    ok(l.panelX === l.viewW, label + '：横屏面板起点 = 视口宽度',
      'panelX=' + l.panelX + ' viewW=' + l.viewW);
    ok(l.viewW + l.panelW === W, label + '：横屏视口+面板铺满宽度',
      l.viewW + '+' + l.panelW + ' != ' + W);
    ok(l.viewW > W * 0.6, label + '：横屏可玩区 > 屏宽 60%',
      'viewW/W=' + (l.viewW / W).toFixed(2));
  }
  ok(l.areaW === l.viewW, label + '：areaW 与 viewW 一致（旧调用点兼容别名）',
    'areaW=' + l.areaW + ' viewW=' + l.viewW);
  return l;
}

// ---------------- T1 常见设备尺寸 ----------------
function t1() {
  section('T1 常见设备尺寸');
  var cases = [
    { w: 1920, h: 1080, name: '桌面 1920x1080', portrait: false },
    { w: 1280, h: 720, name: '桌面 1280x720', portrait: false },
    { w: 844, h: 390, name: 'iPhone 横屏 844x390', portrait: false },
    { w: 390, h: 844, name: 'iPhone 竖屏 390x844', portrait: true },
    { w: 360, h: 800, name: 'Android 竖屏 360x800', portrait: true },
    { w: 820, h: 1180, name: 'iPad 竖屏 820x1180', portrait: true },
    { w: 1180, h: 820, name: 'iPad 横屏 1180x820', portrait: false }
  ];
  cases.forEach(function (c) {
    var g = new CS.Game(c.w, c.h);
    var l = g.layout();
    ok(l.portrait === c.portrait, c.name + ' → ' + (c.portrait ? '竖屏' : '横屏') + '布局',
      'portrait=' + l.portrait);
    assertLayoutSane(g, c.name);
  });
}

// ---------------- T2 旋转（resize）后布局与摇杆同步 ----------------
function t2() {
  section('T2 旋转后布局与摇杆重新同步');
  var g = new CS.Game(844, 390);           // 先横屏
  var lLand = g.layout();
  var baseLand = { x: g.joystick.baseX, y: g.joystick.baseY, r: g.joystick.radius };
  ok(!lLand.portrait, '初始为横屏');

  g.resize(390, 844);                       // 转竖屏
  var lPort = g.layout();
  ok(lPort.portrait, 'resize 后变竖屏');
  assertLayoutSane(g, '旋转后');

  var basePort = { x: g.joystick.baseX, y: g.joystick.baseY, r: g.joystick.radius };
  ok(basePort.y !== baseLand.y, '摇杆底座随朝向改变（y 变化）',
    '横屏 y=' + baseLand.y + ' 竖屏 y=' + basePort.y);
  ok(basePort.r >= baseLand.r, '竖屏摇杆半径不小于横屏（拇指操作更大热区）',
    '横屏 r=' + baseLand.r + ' 竖屏 r=' + basePort.r);

  // 摇杆必须落在视口内（不能跑到面板上或屏幕外）
  ok(basePort.y > lPort.viewY && basePort.y < lPort.viewY + lPort.viewH,
    '竖屏摇杆底座在视口垂直范围内',
    'baseY=' + basePort.y + ' view=[' + lPort.viewY + ',' + (lPort.viewY + lPort.viewH) + ']');
  ok(basePort.x > 0 && basePort.x < lPort.viewW, '竖屏摇杆底座在视口水平范围内');

  // 转回横屏应恢复
  g.resize(844, 390);
  ok(!g.layout().portrait, '转回横屏');
  ok(g.joystick.baseY === baseLand.y, '横屏摇杆位置可复现', 
    '期望 ' + baseLand.y + ' 实际 ' + g.joystick.baseY);
}

// ---------------- T3 极端尺寸不崩 ----------------
function t3() {
  section('T3 极端尺寸兜底');
  var extremes = [
    { w: 200, h: 200, name: '极小正方 200x200' },
    { w: 320, h: 240, name: '极小横屏 320x240' },
    { w: 240, h: 320, name: '极小竖屏 240x320' },
    { w: 300, h: 2000, name: '极窄长条 300x2000' },
    { w: 2000, h: 300, name: '极扁长条 2000x300' }
  ];
  extremes.forEach(function (c) {
    var g = new CS.Game(c.w, c.h);
    var l = g.layout();
    ok(l.viewW >= 120 && l.viewH >= 120, c.name + ' → 视口不塌陷（' + l.viewW + 'x' + l.viewH + ')',
      'viewW=' + l.viewW + ' viewH=' + l.viewH);
    ok(isFinite(l.panelW) && isFinite(l.panelH) && l.panelW > 0 && l.panelH > 0,
      c.name + ' → 面板尺寸有效');
  });

  // 近正方形不应在 portrait 边界反复抖动（1.05 余量）
  var gSq = new CS.Game(500, 510);
  ok(gSq.layout().portrait === false, '近正方（500x510）判为横屏，避免边界抖动',
    'portrait=' + gSq.layout().portrait);
}

// ---------------- T4 相机适配视口 ----------------
function t4() {
  section('T4 相机使用视口尺寸（竖屏不再用整屏宽高）');
  var g = new CS.Game(390, 844);
  g.startEndless();                         // 建立 snake / walls
  g.snapCamera();
  var l = g.layout();
  ok(isFinite(g.camera.x) && isFinite(g.camera.y), '相机坐标有效');
  // 相机应让蛇头居中于**视口**（而非整屏）
  var expectX = g.snake.x - l.viewW / 2;
  var expectY = g.snake.y - l.viewH / 2;
  var okX = Math.abs(g.camera.x - expectX) < 1 ||
    g.camera.x === -CS.config.WALL_THICK ||
    Math.abs(g.camera.x - (g.walls.W - l.viewW + CS.config.WALL_THICK)) < 1;
  var okY = Math.abs(g.camera.y - expectY) < 1 ||
    g.camera.y === -CS.config.WALL_THICK ||
    Math.abs(g.camera.y - (g.walls.H - l.viewH + CS.config.WALL_THICK)) < 1;
  ok(okX, '相机 x 按视口宽居中（或钳制到边界）',
    'camera.x=' + g.camera.x.toFixed(1) + ' 期望≈' + expectX.toFixed(1));
  ok(okY, '相机 y 按视口高居中（或钳制到边界）',
    'camera.y=' + g.camera.y.toFixed(1) + ' 期望≈' + expectY.toFixed(1));

  // 跑若干帧，相机不应发散
  for (var i = 0; i < 60; i++) g.update(16.7);
  ok(isFinite(g.camera.x) && isFinite(g.camera.y), '60 帧后相机仍有效');
  ok(g.camera.x >= -CS.config.WALL_THICK - 1 &&
     g.camera.x <= g.walls.W - l.viewW + CS.config.WALL_THICK + 1,
    '相机 x 在合法范围内', 'camera.x=' + g.camera.x.toFixed(1));
}

// ---------------- T5 safeInsets 在 node 环境安全 ----------------
function t5() {
  section('T5 safeInsets 在无浏览器环境下的兜底');
  var g = new CS.Game(390, 844);
  var z = g.safeInsets();
  ok(z && typeof z.top === 'number' && typeof z.bottom === 'number',
    'safeInsets 返回结构完整');
  ok(z.top === 0 && z.right === 0 && z.bottom === 0 && z.left === 0,
    'node 环境下全部回退为 0（不抛异常）',
    JSON.stringify(z));
}

// ---------------- T6 矮屏 UI 不溢出（v3.0.3 回归）----------------
/**
 * 手机横屏可视高度只有 ~360~390px。原实现两处按固定像素纵向堆叠会溢出屏幕底部，
 * 而 canvas 没有滚动条、拖也拖不动 → 按钮点不到、小地图被切掉一截（用户报告）。
 * 核心不变量：**任何屏幕尺寸下，所有 UI 按钮必须完整落在屏幕内**。
 */
function t6() {
  section('T6 矮屏 UI 不溢出（按钮 + 小地图）');
  var sizes = [
    [844, 390, 'iPhone横屏'], [800, 360, 'Android横屏'], [740, 360, '小屏横屏'],
    [667, 375, 'SE横屏'], [390, 844, '竖屏'], [360, 800, '安卓竖屏'],
    [1280, 720, '桌面'], [1920, 1080, '大屏'], [320, 240, '极小'], [240, 320, '极小竖']
  ];
  var states = ['menu', 'levels', 'clear', 'over', 'guide', 'matching'];

  sizes.forEach(function (sz) {
    var W = sz[0], H = sz[1], name = sz[2];
    var g = new CS.Game(W, H);
    g.levelCfg = { level: 3, targetScore: 100 };
    var allIn = true, detail = [];
    states.forEach(function (st) {
      g.mode = 'level';
      g.setState(st);
      g.uiButtons.forEach(function (b) {
        if (b.y < 0 || b.y + b.h > H || b.x < 0 || b.x + b.w > W) {
          allIn = false;
          detail.push(st + ':' + b.id + '(y' + Math.round(b.y) + '~' + Math.round(b.y + b.h) + ')');
        }
      });
    });
    // 多人结算另测（按钮并排布局，与单人不同分支）
    g.mode = 'multi';
    g.setState('over');
    g.uiButtons.forEach(function (b) {
      if (b.y < 0 || b.y + b.h > H || b.x < 0 || b.x + b.w > W) {
        allIn = false;
        detail.push('multi-over:' + b.id);
      }
    });
    ok(allIn, name + ' ' + W + 'x' + H + '：全部状态按钮均在屏内',
      detail.slice(0, 4).join(' '));
  });

  // 菜单按钮：矮屏走左右分栏后**不再需要压缩**（v3.0.5 方案 A），桌面保持原尺寸
  var gShort = new CS.Game(800, 360);
  gShort.setState('menu');
  var bsShort = gShort.uiButtons;
  ok(bsShort.length === 5, '菜单仍有 5 个按钮（矮屏不隐藏功能）', '实际 ' + bsShort.length);
  // 旧断言是「矮屏按钮必须被压缩」，那是 v3.0.3 纵向压缩方案的产物。
  // 方案 A 把按钮挪到右半区独占纵向空间后，54px 原始高度放得下 —— 不压缩才是对的。
  ok(bsShort[0].h >= 44, '矮屏分栏后按钮仍够大（' + Math.round(bsShort[0].h) + ' ≥ 44）',
    '实际 ' + Math.round(bsShort[0].h));
  ok(bsShort[0].h >= 34, '不低于可点下限 34px（' + Math.round(bsShort[0].h) + '）');

  var gDesk = new CS.Game(1280, 720);
  gDesk.setState('menu');
  ok(gDesk.uiButtons[0].h === 54, '桌面按钮保持 54px（无回归）',
    '实际 ' + gDesk.uiButtons[0].h);

  // solveButtonStack 契约
  var g2 = new CS.Game(800, 360);
  var st1 = g2.solveButtonStack(5, 100, 340);
  ok(st1.firstCy - st1.bh / 2 >= 100 - 0.5, 'solveButtonStack：首个按钮不越顶');
  ok(st1.firstCy + 4 * st1.step + st1.bh / 2 <= 340 + 0.5,
    'solveButtonStack：末个按钮不越底',
    '末底=' + (st1.firstCy + 4 * st1.step + st1.bh / 2).toFixed(1));
  var st2 = g2.solveButtonStack(0, 100, 340);
  ok(isFinite(st2.firstCy), 'solveButtonStack：n=0 不崩');
}

// ---------------- T7 横屏改横向布局（v3.0.4）----------------
/**
 * §3.8.1 只做纵向压缩，治症不治本：压缩后按钮虽在屏内，却盖住了标题下的蛇动画、
 * 副标题与底部信息；结算卡片压到行高下限仍超出 360~390px 的横屏。
 * 正解是利用富余的横向空间 —— 菜单两列、记分牌统计两列。
 */
function t7() {
  section('T7 横屏横向布局（菜单左右分栏 / 记分牌两列）');

  // --- 菜单：横屏走左右分栏，按钮区与品牌区必须完全分离 ---
  // v3.0.5：判据从「两列 + 让开固定比例坐标」改为「与 menuLayout() 各分区不相交」。
  // 旧断言硬编码 H*0.22 / H*0.35 / H*0.89，与实现脱钩 —— 实现一改就全错。
  [[844, 390, 'iPhone横屏'], [800, 360, 'Android横屏'],
   [667, 375, 'SE横屏'], [740, 360, '小屏横屏']].forEach(function (c) {
    var W = c[0], H = c[1], name = c[2];
    var g = new CS.Game(W, H);
    g.setState('menu');
    var bs = g.uiButtons;
    var ml = g.menuLayout();
    ok(ml.split === true, name + '：横屏矮屏启用左右分栏');
    ok(bs.length === 5, name + '：仍是 5 个按钮（不隐藏功能）');

    var left = Math.min.apply(null, bs.map(function (b) { return b.x; }));
    var bot = Math.max.apply(null, bs.map(function (b) { return b.y + b.h; }));
    var top = Math.min.apply(null, bs.map(function (b) { return b.y; }));
    // 核心不变量：按钮区整体位于品牌区右侧 ⇒ 纵向如何排都不可能遮挡品牌内容
    ok(left >= ml.brandX + ml.brandW, name + '：按钮区在品牌区右侧（' +
      Math.round(left) + ' ≥ ' + Math.round(ml.brandX + ml.brandW) + '）',
      '重叠 ' + Math.round(ml.brandX + ml.brandW - left) + 'px');
    ok(top >= 0 && bot <= H, name + '：按钮组纵向在屏内（' +
      Math.round(top) + '~' + Math.round(bot) + ' / ' + H + '）');
    ok(bs[0].h >= 42, name + '：分栏后按钮回到可读高度（' + Math.round(bs[0].h) + ' ≥ 42）');

    // 品牌区内部各层不重叠（标题 / 蛇动画轨道 / 副标题 / 统计）
    var tBot = ml.titleY + ml.titleSize / 2;
    var aTop = ml.animY - 30, aBot = ml.animY + 17;   // 轨道实际占用，见 game.menuLayout
    var sTop = ml.subY - 9, sBot = ml.subY + 9;
    var stTop = ml.statY - 9, stBot = ml.statY + ml.statLine + 9;
    ok(aTop >= tBot - 1, name + '：蛇动画不撞标题（' + Math.round(aTop) +
      ' ≥ ' + Math.round(tBot) + '）', '重叠 ' + Math.round(tBot - aTop) + 'px');
    ok(sTop >= aBot, name + '：副标题不撞蛇动画（' + Math.round(sTop) +
      ' ≥ ' + Math.round(aBot) + '）', '重叠 ' + Math.round(aBot - sTop) + 'px');
    ok(stTop >= sBot, name + '：统计不撞副标题（' + Math.round(stTop) +
      ' ≥ ' + Math.round(sBot) + '）', '重叠 ' + Math.round(sBot - stTop) + 'px');
    ok(stBot <= H, name + '：统计文字在屏内（底 ' + Math.round(stBot) + ' ≤ ' + H + '）');
  });

  // 桌面 / 竖屏保持单列 54px（无回归）
  [[1280, 720, '桌面'], [390, 844, '竖屏'], [1920, 1080, '大屏']].forEach(function (c) {
    var g = new CS.Game(c[0], c[1]);
    g.setState('menu');
    var xs = {};
    g.uiButtons.forEach(function (b) { xs[Math.round(b.x)] = 1; });
    ok(Object.keys(xs).length === 1, c[2] + '：保持单列（无回归）');
    ok(g.uiButtons[0].h === 54, c[2] + '：按钮保持 54px', '实际 ' + g.uiButtons[0].h);
  });

  // --- 结算记分牌：卡片必须完整在屏、不压按钮、不压 HUD 面板 ---
  // v3.0.5：改为**拦截真实绘制**取几何，不再复刻公式。
  // 复刻公式的做法在这次改动中已经脱钩过一次（实现改成视口驱动、测试还在用 W/2），
  // 拦截法让测试自动跟随实现，避免"测试绿但实现错"。
  //
  // 注意：drawMultiResult 第一件事是 drawOverlay(0.6) 画**全屏**遮罩，
  // 若把它算进 bbox，卡片宽度会变成整屏宽。所以这里按「路径批次」分段记录，
  // 取第一个非全屏的批次 —— 那就是卡片底板。
  function cardGeom(g, W, H) {
    var batches = [];
    var cur = null;
    function flush() {
      if (cur && cur.maxX > cur.minX) batches.push(cur);
      cur = null;
    }
    function track(x, y) {
      if (typeof x !== 'number' || typeof y !== 'number') return;
      if (!cur) cur = { minX: x, minY: y, maxX: x, maxY: y };
      if (x < cur.minX) cur.minX = x;
      if (y < cur.minY) cur.minY = y;
      if (x > cur.maxX) cur.maxX = x;
      if (y > cur.maxY) cur.maxY = y;
    }
    function nop() {}
    var stub = {
      save: nop, restore: nop, translate: nop, rotate: nop, scale: nop,
      beginPath: function () { flush(); },
      closePath: nop, clip: nop, fill: nop, stroke: nop,
      fillRect: nop, strokeRect: nop, drawImage: nop, setLineDash: nop,
      setTransform: nop,
      createLinearGradient: function () { return { addColorStop: nop }; },
      measureText: function (s) { return { width: String(s).length * 7 }; },
      fillText: nop, strokeText: nop, arc: nop, ellipse: nop,
      moveTo: track, lineTo: track,
      quadraticCurveTo: function (a, b, c, d) { track(c, d); },
      bezierCurveTo: function (a, b, c, d, e, f) { track(e, f); },
      rect: function (x, y, w, h) { track(x, y); track(x + w, y + h); },
      font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
      textAlign: '', textBaseline: '', lineJoin: '', lineCap: '',
      canvas: { width: W, height: H }
    };
    var r = Object.create(CS.Renderer.prototype);
    r.ctx = stub; r.W = W; r.H = H;
    CS.Renderer.prototype.drawMultiResult.call(r, g);
    flush();
    // 取第一个「不是全屏」的批次作为卡片（全屏遮罩宽度 ≈ W）
    var card = null;
    for (var i = 0; i < batches.length; i++) {
      var b = batches[i];
      if (b.maxX - b.minX < W * 0.99) { card = b; break; }
    }
    if (!card) card = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    var btnTop = H;
    g.uiButtons.forEach(function (b2) { btnTop = Math.min(btnTop, b2.y); });
    var lay = g.layout();
    return {
      x: card.minX, y: card.minY,
      w: card.maxX - card.minX, h: card.maxY - card.minY,
      btnTop: btnTop, portrait: lay.portrait, viewR: lay.viewX + lay.viewW
    };
  }

  [[844, 390, 'iPhone横屏'], [800, 360, 'Android横屏'],
   [667, 375, 'SE横屏'], [390, 844, '竖屏'], [1280, 720, '桌面'],
   [1920, 1080, '大屏'], [320, 240, '极小']].forEach(function (c) {
    var W = c[0], H = c[1], name = c[2];
    var g = new CS.Game(W, H);
    g.mode = 'multi';
    g.startMulti();
    g.mpResult = {
      surviveSec: 187, score: 4820, survivalScore: 187, elimScore: 4633,
      elimTotal: 96, rank: 2, kills: 3, finalLen: 41, maxLen: 47,
      bestLen: 47, bestScore: 4820, newBest: true
    };
    g.overAt = 0; g.timeMs = 5000;
    g.setState('over');
    var m = cardGeom(g, W, H);
    ok(m.y >= -1 && m.y + m.h <= H + 1, name + '：卡片纵向在屏内（' +
      Math.round(m.y) + '~' + Math.round(m.y + m.h) + ' / ' + H + '）',
      '底边 ' + Math.round(m.y + m.h) + ' 超出 ' + H);
    ok(m.x >= -1 && m.x + m.w <= W + 1, name + '：卡片横向在屏内（宽 ' + Math.round(m.w) + '）');
    ok(m.y + m.h <= m.btnTop - 6, name + '：卡片不压按钮（距 ' +
      Math.round(m.btnTop - (m.y + m.h)) + 'px）',
      '压了 ' + Math.round(m.y + m.h - (m.btnTop - 6)) + 'px');
    // 本轮新增的核心不变量：横屏时卡片不得越过视口右边界（= HUD 面板左沿）
    if (!m.portrait) {
      ok(m.x + m.w <= m.viewR + 1, name + '：卡片不压 HUD 面板（右 ' +
        Math.round(m.x + m.w) + ' ≤ 视口 ' + Math.round(m.viewR) + '）',
        '压了 ' + Math.round(m.x + m.w - m.viewR) + 'px');
    }
  });
}

/**
 * T8 全局重叠矩阵（v3.0.5 的核心不变量）。
 *
 * 前几轮 617 项断言全绿、真实截图却是坏的 —— 根因就是断言口径只有「在屏内」，
 * 遮挡类缺陷全部漏过（按钮盖住蛇动画、卡片盖住 HUD）。
 * 本组把判据升级为**任意两个 UI 元素矩形不相交**，并覆盖每个界面 × 每个尺寸。
 */
function t8() {
  section('T8 互不重叠矩阵（替代「在屏内」口径）');

  /** 两矩形是否相交（容差 1px，避免浮点与描边误判） */
  function hit(a, b) {
    var tol = 1;
    return !(a.x + a.w - tol <= b.x || b.x + b.w - tol <= a.x ||
             a.y + a.h - tol <= b.y || b.y + b.h - tol <= a.y);
  }

  var SIZES = [[844, 390, 'iPhone横'], [800, 360, 'Android横'], [667, 375, 'SE横'],
               [390, 844, 'iPhone竖'], [360, 800, 'Android竖'],
               [1280, 720, '桌面'], [1920, 1080, '大屏'],
               [320, 240, '极小横'], [240, 320, '极小竖']];

  // --- 8.1 任意界面：按钮两两不重叠 ---
  var STATES = ['menu', 'levels', 'guide', 'matching', 'clear', 'over'];
  SIZES.forEach(function (c) {
    var W = c[0], H = c[1], nm = c[2];
    var overlaps = 0, outs = 0;
    STATES.forEach(function (st) {
      var g = new CS.Game(W, H);
      g.levelCfg = { level: 3, targetScore: 100 };
      g.mode = 'level';
      g.setState(st);
      var bs = g.uiButtons;
      for (var i = 0; i < bs.length; i++) {
        if (bs[i].x < -1 || bs[i].y < -1 ||
            bs[i].x + bs[i].w > W + 1 || bs[i].y + bs[i].h > H + 1) outs++;
        for (var j = i + 1; j < bs.length; j++) if (hit(bs[i], bs[j])) overlaps++;
      }
    });
    ok(overlaps === 0, nm + ' ' + W + 'x' + H + '：所有界面按钮两两不重叠',
      '发现 ' + overlaps + ' 对重叠');
    ok(outs === 0, nm + ' ' + W + 'x' + H + '：所有界面按钮均在屏内',
      '发现 ' + outs + ' 个越界');
  });

  // --- 8.2 菜单：按钮组不与品牌区各层重叠 ---
  SIZES.forEach(function (c) {
    var W = c[0], H = c[1], nm = c[2];
    var g = new CS.Game(W, H);
    g.setState('menu');
    var ml = g.menuLayout();
    var bs = g.uiButtons;
    var bx = Math.min.apply(null, bs.map(function (b) { return b.x; }));
    var by = Math.min.apply(null, bs.map(function (b) { return b.y; }));
    var bx2 = Math.max.apply(null, bs.map(function (b) { return b.x + b.w; }));
    var by2 = Math.max.apply(null, bs.map(function (b) { return b.y + b.h; }));
    var btnBox = { x: bx, y: by, w: bx2 - bx, h: by2 - by };
    // 品牌区各层的包围盒（与 game.menuLayout / renderer.drawMenu 的实际占用一致）
    var layers = [
      { name: '标题', x: ml.brandCx - ml.brandW / 2, y: ml.titleY - ml.titleSize / 2,
        w: ml.brandW, h: ml.titleSize }
    ];
    // 蛇动画 / 副标题 / 统计在极端小屏会按优先级主动让位，此时不参与判定
    if (ml.showAnim !== false) {
      layers.push({ name: '蛇动画', x: ml.brandCx - ml.brandW / 2, y: ml.animY - 30,
        w: ml.brandW, h: 47 });
    }
    if (ml.showSub !== false) {
      layers.push({ name: '副标题', x: ml.brandCx - ml.brandW / 2, y: ml.subY - 9,
        w: ml.brandW, h: 18 });
    }
    if (ml.showStat !== false) {
      layers.push({ name: '底部统计', x: ml.brandCx - ml.brandW / 2, y: ml.statY - 9,
        w: ml.brandW, h: ml.statLine + 18 });
    }
    var bad = [];
    layers.forEach(function (L) { if (hit(btnBox, L)) bad.push(L.name); });
    ok(bad.length === 0, nm + ' ' + W + 'x' + H + '：菜单按钮不遮挡品牌区任何一层',
      '遮挡了 ' + bad.join('/'));
  });

  // --- 8.3 视口与面板：恰好铺满且互不重叠（既有不变量，纳入矩阵一并守护）---
  SIZES.forEach(function (c) {
    var W = c[0], H = c[1], nm = c[2];
    var g = new CS.Game(W, H);
    var l = g.layout();
    var view = { x: l.viewX, y: l.viewY, w: l.viewW, h: l.viewH };
    var panel = { x: l.panelX, y: l.panelY, w: l.panelW, h: l.panelH };
    ok(!hit(view, panel), nm + ' ' + W + 'x' + H + '：视口与 HUD 面板不重叠');
    var covered = view.w * view.h + panel.w * panel.h;
    ok(Math.abs(covered - W * H) < W * H * 0.02,
      nm + ' ' + W + 'x' + H + '：视口 + 面板铺满屏幕（覆盖 ' +
      Math.round(covered / (W * H) * 100) + '%）');
  });

  // --- 8.4 摇杆底座落在视口内、不被面板压住 ---
  SIZES.forEach(function (c) {
    var W = c[0], H = c[1], nm = c[2];
    var g = new CS.Game(W, H);
    var l = g.layout();
    var j = g.joystick;
    var jb = { x: j.baseX - j.radius, y: j.baseY - j.radius, w: j.radius * 2, h: j.radius * 2 };
    var panel = { x: l.panelX, y: l.panelY, w: l.panelW, h: l.panelH };
    ok(!hit(jb, panel), nm + ' ' + W + 'x' + H + '：摇杆不被 HUD 面板压住');
    ok(jb.x >= -1 && jb.y >= -1 && jb.x + jb.w <= W + 1 && jb.y + jb.h <= H + 1,
      nm + ' ' + W + 'x' + H + '：摇杆完整在屏内');
  });
}

/**
 * T9 layoutBus 全局重排派发（v3.0.5）。
 * 用户明确要求「横竖屏转换要有重新 layout 的全局派发，各界面分别处理」。
 * 这里验证：事件能派发、订阅者能收到、Game 的缓存确实失效并重算。
 */
function t9() {
  section('T9 layoutBus 全局重排派发');

  ok(typeof CS.LayoutBus === 'function', 'LayoutBus 构造函数存在');
  ok(CS.layoutBus instanceof CS.LayoutBus, 'CS.layoutBus 是全局单例');

  var bus = new CS.LayoutBus();
  var got = [];
  var un = bus.on('relayout', function (m) { got.push(m); });
  bus.relayout(844, 390);
  ok(got.length === 1, '订阅者收到 relayout 事件');
  ok(got[0].portrait === false && got[0].short === true,
    '横屏矮屏 metrics 正确（portrait=false, short=true）',
    JSON.stringify(got[0]));
  bus.relayout(390, 844);
  ok(got.length === 2 && got[1].portrait === true && got[1].short === false,
    '竖屏 metrics 正确（portrait=true, short=false）');
  un();
  bus.relayout(800, 360);
  ok(got.length === 2, '取消订阅后不再收到事件');

  // 单个订阅者抛异常不影响其它订阅者（布局是表现层，不该让整局黑屏）
  var bus2 = new CS.LayoutBus();
  var okCalled = false;
  bus2.on('relayout', function () { throw new Error('故意失败'); });
  bus2.on('relayout', function () { okCalled = true; });
  bus2.relayout(844, 390);
  ok(okCalled === true, '某订阅者抛异常时其余订阅者仍被调用');

  // Game.resize 必须清缓存 + 重建按钮 + 重新钳制相机
  var g = new CS.Game(844, 390);
  g.setState('menu');
  var l1 = g.layout();
  ok(g.layout() === l1, 'layout() 有缓存（同尺寸返回同一对象）');
  var before = g.uiButtons.length;
  var mlBefore = g.menuLayout().split;
  g.resize(390, 844);
  var l2 = g.layout();
  ok(l2 !== l1, 'resize 后 layout 缓存已失效');
  ok(l2.portrait === true, 'resize 后布局切到竖屏');
  ok(g.uiButtons.length === before, 'resize 后按钮已重建且数量不变');
  ok(mlBefore === true && g.menuLayout().split === false,
    '菜单分栏状态随朝向切换（横屏分栏 → 竖屏单列）');

  // 相机在新视口下不越界
  var g2 = new CS.Game(844, 390);
  g2.startMulti();
  g2.camera.x = 9999; g2.camera.y = 9999;   // 故意放到越界位置
  g2.resize(390, 844);
  var l3 = g2.layout();
  ok(g2.camera.x <= g2.walls.W + 40 && g2.camera.y <= g2.walls.H + 40,
    'resize 后相机被重新钳制（' + Math.round(g2.camera.x) + ',' +
    Math.round(g2.camera.y) + '）');

  // invalidateLayout 单独可用（供订阅者手动调用）
  var g3 = new CS.Game(844, 390);
  var a = g3.layout();
  g3.invalidateLayout();
  ok(g3.layout() !== a, 'invalidateLayout 能单独清缓存');

  // Renderer 也是订阅者：旋转后必须清掉标题动效状态（否则蛇从旧位置飘过去）
  ok(typeof CS.Renderer.prototype.applyRelayout === 'function',
    'Renderer.applyRelayout 存在（relayout 订阅入口）');
  var rr = Object.create(CS.Renderer.prototype);
  rr.ctx = null; rr.W = 844; rr.H = 390;
  rr.titleFx = { segs: ['red'], lastMs: 0 };
  rr.resize(390, 844);
  ok(rr.titleFx === null, 'Renderer.resize 清空标题动效状态');
  ok(rr.W === 390 && rr.H === 844, 'Renderer.resize 更新尺寸');

  // 端到端：一次 relayout 派发让 game 与 renderer 同时更新（模拟 main.js 的接线）
  var bus3 = new CS.LayoutBus();
  var gE = new CS.Game(844, 390);
  var rE = Object.create(CS.Renderer.prototype);
  rE.ctx = null; rE.W = 844; rE.H = 390; rE.titleFx = { x: 1 };
  bus3.on('relayout', function (m) { rE.resize(m.W, m.H); });
  gE.setState('menu');
  var splitBefore = gE.menuLayout().split;
  gE.screenW = 390; gE.screenH = 844;
  gE.applyRelayout();
  bus3.relayout(390, 844);
  ok(splitBefore === true && gE.menuLayout().split === false,
    '端到端：Game 随 relayout 从分栏切回单列');
  ok(rE.W === 390 && rE.titleFx === null,
    '端到端：Renderer 随同一次 relayout 更新并清缓存');
}

console.log('横竖屏自适应布局回归（v3.0.2 ~ v3.0.5）');
t1(); t2(); t3(); t4(); t5(); t6(); t7(); t8(); t9();

console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) { console.log('失败项：' + failedNames.join(' / ')); process.exit(1); }
process.exit(0);
