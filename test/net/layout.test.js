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
  'ai', 'multiplayer', 'game'].forEach(function (f) { require(path.join(JS, f + '.js')); });

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

  // 菜单按钮：矮屏应压缩、桌面应保持原尺寸（无回归）
  var gShort = new CS.Game(800, 360);
  gShort.setState('menu');
  var bsShort = gShort.uiButtons;
  ok(bsShort.length === 5, '菜单仍有 5 个按钮（矮屏不隐藏功能）', '实际 ' + bsShort.length);
  ok(bsShort[0].h < 54, '矮屏按钮高度被压缩（' + Math.round(bsShort[0].h) + ' < 54）');
  ok(bsShort[0].h >= 34, '压缩不低于可点下限 34px（' + Math.round(bsShort[0].h) + '）');

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

console.log('横竖屏自适应布局回归（v3.0.2 / v3.0.3）');
t1(); t2(); t3(); t4(); t5(); t6();

console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) { console.log('失败项：' + failedNames.join(' / ')); process.exit(1); }
process.exit(0);
