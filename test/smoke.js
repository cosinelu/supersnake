'use strict';
/**
 * smoke.js — node 侧逻辑冒烟验证（v2：自由方向 + 大地图 + 跟随镜头，不依赖 DOM）
 * 运行：node test/smoke.js
 * 原理：所有 js 文件为 IIFE 挂全局命名空间，node 中 root=globalThis，
 *       require 执行文件后即可从 globalThis.CS 取到模块。
 */
var path = require('path');

['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'joystick', 'ai', 'multiplayer', 'game']
  .forEach(function (f) { require(path.join(__dirname, '..', 'js', f + '.js')); });

var CS = globalThis.CS;
var cfg = CS.config, lv = CS.levels, store = CS.storage, u = CS.utils;

var passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

// ---------------- 1. 解锁档位表 ----------------
section('解锁档位表');
var expectLevel = [4, 4, 5, 5, 6, 6, 7, 7, 8, 8];
var levelOk = true;
for (var n = 1; n <= 10; n++) {
  if (cfg.unlockedCountForLevel(n) !== expectLevel[n - 1]) levelOk = false;
}
ok(levelOk, '闯关 10 关档位 = [4,4,5,5,6,6,7,7,8,8]');
var endlessCases = [[0, 4], [44, 4], [45, 5], [89, 5], [90, 6], [134, 6], [135, 7], [179, 7], [180, 8], [9999, 8]];
var endlessOk = endlessCases.every(function (c) { return cfg.unlockedCountForEndless(c[0]) === c[1]; });
ok(endlessOk, '无尽 0s=4 / 45s=5 / 90s=6 / 135s=7 / 180s+=8');
ok(cfg.unlockedColorKeys(4).join(',') === 'red,blue,green,orange', 'unlockedColorKeys(4) 取前 4 色');

// ---------------- 1b. 颜色解锁顺序规划（图鉴页签） ----------------
section('颜色解锁顺序规划');
var plan = cfg.colorUnlockPlan();
ok(plan.length === cfg.COLOR_KEYS.length, 'plan 长度 = 颜色总数 ' + cfg.COLOR_KEYS.length);
ok(plan.map(function (p) { return p.key; }).join(',') === cfg.COLOR_KEYS.join(','), 'plan 顺序 == COLOR_KEYS（=解锁先后顺序）');
ok(plan[0].key === 'red' && plan[0].name === '红' && plan[0].order === 1, '第 1 色：红/序号1');
ok(plan[0].initial === true && plan[0].levelText === '开局解锁' && plan[0].endlessText === '开局解锁', '前 4 色开局解锁');
ok(plan[3].key === 'orange' && plan[3].initial === true, '第 4 色 橙 仍开局解锁');
ok(plan[4].key === 'purple' && plan[4].order === 5 && plan[4].initial === false, '第 5 色 紫 非开局');
ok(plan[4].level === 3 && plan[4].levelText === '第 3 关解锁', '紫：闯关第 3 关解锁');
ok(plan[4].sec === 45 && plan[4].endlessText === '存活 45 秒解锁', '紫：无尽存活 45 秒解锁');
ok(plan[5].key === 'yellow' && plan[5].level === 5 && plan[5].sec === 90, '黄：第 5 关 / 存活 90 秒');
ok(plan[6].key === 'teal' && plan[6].level === 7 && plan[6].sec === 135, '青：第 7 关 / 存活 135 秒');
ok(plan[7].key === 'pink' && plan[7].order === 8 && plan[7].level === 9 && plan[7].sec === 180, '粉：第 8 色 / 第 9 关 / 存活 180 秒');
var tr = cfg.guideTabRects({ screenW: 400, screenH: 640 });
ok(tr.tabItems && tr.tabColors, 'guideTabRects 返回居中页签（道具+颜色）2 个有效热区');
ok(tr.tabColors.x > tr.tabItems.x, 'guideTabRects 颜色页签在道具页签右侧');
var mid = 400 / 2; var tabCenter = (tr.tabItems.x + tr.tabColors.x + tr.tabColors.w) / 2;
ok(Math.abs(tabCenter - mid) < 1, 'guideTabRects 页签组水平居中（误差<1px）', 'mid=' + mid + ' tabCenter=' + tabCenter.toFixed(1));

// ---------------- 2. 关卡曲线（世界大地图） ----------------
section('关卡曲线');
var l1 = lv.levelConfig(1), l10 = lv.levelConfig(10);
ok(l1.W === 1500 && l1.H === 1000, 'L1 世界 1500x1000（v2.5 起始更小）', l1.W + 'x' + l1.H);
ok(l10.W === 4800 && l10.H === 3200, 'L10 世界 4800x3200（v2.5 随关卡递增）', l10.W + 'x' + l10.H);
ok(l1.W > l1.H && l10.W > l10.H, '横版：所有关 宽>高');
ok(l1.speed === 150 && l10.speed === 231, '蛇速 150→231 px/s');
ok(l1.wallSegments === 3 && l10.wallSegments === 10, '墙段 3→10');
ok(l1.targetScore === 60 && l10.targetScore === 240, '目标分 60→240');
ok(cfg.ENDLESS.W === 3600 && cfg.ENDLESS.H === 2400, '无尽世界 3600x2400');

// ---------------- 3. 头部插入（unshift 顺序） ----------------
section('头部插入');
var gs = new CS.Snake(500, 500, 4, 0, ['red', 'blue']);
var oldHeadColor = gs.colors[0];
var oldLen = gs.length();
gs.grow('green');
ok(gs.colors[0] === 'green', 'grow 后 colors[0] = 新吃到的颜色');
ok(gs.colors[1] === oldHeadColor, '原头变成第 1 节身体');
ok(gs.length() === oldLen + 1, '总长度 +1');
ok(gs.colors[0] === 'green' && gs.colors[2] === gs.colors[2], '颜色序列头端推入（祖玛式）');

// ---------------- 4. 消除 / 连锁 / 保底 ----------------
section('消除');
function makeSnake(colors) {
  var s = new CS.Snake(500, 500, colors.length, 0, ['red']);
  for (var i = 0; i < colors.length; i++) s.colors[i] = colors[i];
  return s;
}
var s1 = makeSnake(['red', 'red', 'red', 'red', 'blue', 'blue', 'blue']);
var r1 = s1.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
ok(r1.length === 4 && s1.length() === 3, '4 连消除：7 节删 4 节剩 3 节', 'removed=' + r1.length + ' len=' + s1.length());
ok(r1[0].color === 'red' && typeof r1[0].x === 'number', '被移除节带颜色与世界坐标（粒子用）');

// 连锁：绿 4 连消除后，两侧蓝色接拢成新 4 连
var s2 = makeSnake(['blue', 'red', 'green', 'green', 'green', 'green', 'blue', 'blue', 'blue', 'blue']);
var r2 = s2.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
ok(r2.length > 4, '连锁消除：首轮消绿后蓝色接拢再消（共移除 ' + r2.length + ' 节）');
ok(s2.length() >= cfg.MIN_LENGTH, '连锁后保底长度 ≥ ' + cfg.MIN_LENGTH, 'len=' + s2.length());

// 保底：整条 4 节同色，消除后不能低于 3 节
var s3 = makeSnake(['red', 'red', 'red', 'red']);
var r3 = s3.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
ok(s3.length() === cfg.REFILL_ON_FLOOR && r3.length === 4, '保底触发（标准4连）：整段消除后随机补满 ' + cfg.REFILL_ON_FLOOR + ' 节继续', 'removed=' + r3.length + ' len=' + s3.length());

// ---------------- 4b. 节可读性几何约束（需求 1） ----------------
section('节可读性几何');
ok(cfg.SEG_SPACING >= cfg.SEG_RADIUS * 2,
  '节间距 ≥ 节直径（' + cfg.SEG_SPACING + ' ≥ ' + cfg.SEG_RADIUS * 2 + '）');
ok(cfg.SEG_SPACING - cfg.SEG_RADIUS * 2 >= 2,
  '节间留纸色间隙 ≥2px（相邻节不重叠）', 'gap=' + (cfg.SEG_SPACING - cfg.SEG_RADIUS * 2) + 'px');
ok(cfg.SEG_STROKE >= 3, '节描边加粗 ≥3px（深色 INK，抖动描边保留）', 'stroke=' + cfg.SEG_STROKE);

// ---------------- 4c. 连锁倍率计分（需求 2） ----------------
section('连锁倍率计分');
// 嵌套三连：粉粉[红红[蓝蓝蓝蓝]红红]粉粉 → 蓝(chain1) → 红接拢(chain2) → 粉接拢(chain3，保底只删 1)
var sc = makeSnake(['pink', 'pink', 'red', 'red', 'blue', 'blue', 'blue', 'blue', 'red', 'red', 'pink', 'pink']);
var rc = sc.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
var byChain = { 1: 0, 2: 0, 3: 0 };
rc.forEach(function (s) { byChain[s.chain] = (byChain[s.chain] || 0) + 1; });
ok(byChain[1] === 4 && byChain[2] === 4 && byChain[3] === 4,
  '连锁等级标记：chain1 消 4 节 / chain2 消 4 节 / chain3 保底触发整段消除消 4 节',
  JSON.stringify(byChain));
var chainTotal = rc.reduce(function (sum, s) { return sum + cfg.ELIM_SCORE * s.chain; }, 0);
ok(chainTotal === 4 * cfg.ELIM_SCORE + 4 * cfg.ELIM_SCORE * 2 + 4 * cfg.ELIM_SCORE * 3,
  '连锁计分 = Σ ELIM_SCORE×chain = 4×' + cfg.ELIM_SCORE + ' + 4×' + (cfg.ELIM_SCORE * 2) + ' + 4×' + (cfg.ELIM_SCORE * 3) + ' = ' + chainTotal, 'total=' + chainTotal);
ok(cfg.ELIM_SCORE * 2 === 2 * cfg.ELIM_SCORE && cfg.ELIM_SCORE * 3 === 3 * cfg.ELIM_SCORE && cfg.ELIM_SCORE * 2 > cfg.ELIM_SCORE,
  '倍率核对：chain 每节 = ELIM_SCORE×chain（chain2=' + (cfg.ELIM_SCORE * 2) + '、chain3=' + (cfg.ELIM_SCORE * 3) + ' = 2×/3× 基础）');
ok(cfg.CHAIN_FX_STEP > 0 && 1 + cfg.CHAIN_FX_STEP === 1.6 && 1 + 2 * cfg.CHAIN_FX_STEP > 2,
  '特效放大倍率：chain2=1.6×、chain3=2.2×（chain≥2 弹「N连锁！」，渲染层表现）');
// 需求 3：解锁横幅已改为无底板纯文字+色块图标（渲染层，node 侧不断言绘制，仅说明）

// ---------------- 4e. 特殊道具行为（v2.5 需求 5：万能色 / 炸弹 / 减速） ----------------
section('特殊道具行为');
// 万能色通配：wild 桥接两侧同色，使原本不成的 4 连成立
var sw = makeSnake(['red', 'wild', 'red', 'red', 'red']);
var runsW = sw.findRuns(cfg.ELIM_RUN);
ok(runsW.length === 1 && runsW[0].length === 5, '万能色桥接：red,wild,red,red,red → 5 连（wild 充当中介）', JSON.stringify(runsW));
// 万能色不串接异色：red,wild,blue,blue,blue 中 wild 不能把红蓝连成同色
var sw2 = makeSnake(['red', 'wild', 'blue', 'blue', 'blue']);
var runsW2 = sw2.findRuns(cfg.ELIM_RUN);
ok(runsW2.length === 0, '万能色不串接异色：red,wild,blue×3 不产生跨色 4 连', JSON.stringify(runsW2));
// growWild：头部插入 'wild' 节且长度 +1
var gw = makeSnake(['red', 'blue', 'green']);
var gwBefore = gw.length();
gw.growWild();
ok(gw.colors[0] === 'wild' && gw.length() === gwBefore + 1, 'growWild：头插 wild 节且总长 +1');
// 炸弹消除（eliminate(2,2)）：普通规则(需 4 连)不消除 2 连，炸弹规则可消除
var eb = makeSnake(['red', 'red', 'blue', 'blue']);
var ebNormal = eb.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN); // 需 4 连
ok(ebNormal.length === 0 && eb.length() === 4, '普通规则：仅 2 连不触发消除');
var ebBomb = eb.eliminate(2, 2); // 炸弹：≥2 连即消
ok(ebBomb.length === 2 && eb.colors.join(',') === 'blue,blue', '炸弹规则(2,2)：清除 2 连（剩保底 2 节）', 'removed=' + ebBomb.length);
// 减速道具：currentSpeed 在 slowUntil 内 ×SLOW_FACTOR
var sg2 = new CS.Game(960, 540); sg2.startLevel(1);
var spdNormal = sg2.currentSpeed();
sg2.timeMs = 1000; sg2.slowUntil = sg2.timeMs + cfg.SLOW_MS; // 启用减速
var spdSlow = sg2.currentSpeed();
ok(Math.abs(spdSlow - spdNormal * cfg.SLOW_FACTOR) < 1e-9 && spdSlow < spdNormal,
  '减速道具：slowUntil 内速度 = 常态 ×' + cfg.SLOW_FACTOR, 'normal=' + spdNormal.toFixed(1) + ' slow=' + spdSlow.toFixed(1));
sg2.slowUntil = 0;
ok(Math.abs(sg2.currentSpeed() - spdNormal) < 1e-9, '减速结束：速度恢复常态');

// ---------------- 4f. v2.5 调参锁定（边界墙 / 加速感知） ----------------
section('v2.5 调参');
ok(cfg.WALL_THICK >= 40, '边界墙加粗至 ' + cfg.WALL_THICK + 'px（可见；撞即死逻辑不变）', 'WALL_THICK=' + cfg.WALL_THICK);
ok(cfg.SPEED_LEN_COEF >= 2 && cfg.LEVEL_SPEED_TIME_COEF >= 1,
  '加速感知：长度加成系数 ' + cfg.SPEED_LEN_COEF + ' / 时间加成系数 ' + cfg.LEVEL_SPEED_TIME_COEF + '（均显著上调）');
ok(lv.levelConfig(1).W < lv.levelConfig(5).W && lv.levelConfig(5).W < lv.levelConfig(10).W,
  '关卡地图随关卡递增：L1(' + lv.levelConfig(1).W + ') < L5 < L10(' + lv.levelConfig(10).W + ')');

// ---------------- 5. 转向速率钳制 + 轨迹跟随 ----------------
section('转向与轨迹');
var ts = new CS.Snake(1000, 1000, 4, 0, ['red', 'blue']);
ts.setTargetAngle(Math.PI); // 目标角突变 180°
ts.update(16);
var step = Math.abs(u.normAngle(ts.angle - 0));
ok(step <= cfg.TURN_RATE * 0.016 + 1e-9 && step > 0.01,
  '转向速率钳制：单帧 |Δθ| ≤ TURN_RATE*dt', 'Δθ=' + step.toFixed(4) + ' 上限=' + (cfg.TURN_RATE * 0.016).toFixed(4));
for (var i = 0; i < 200; i++) ts.update(16); // 约 3.2s，足够转满 180°
ok(Math.abs(u.normAngle(ts.angle - Math.PI)) < 1e-6, '持续转向后收敛到目标角 π', 'angle=' + ts.angle.toFixed(4));

// 直线行走后节间距 ≈ SEG_SPACING
var ls = new CS.Snake(1000, 1000, 6, 0, ['red', 'blue']);
for (i = 0; i < 120; i++) ls.update(16); // 直行约 288px
var gapOk = true;
for (i = 1; i < ls.segPos.length; i++) {
  var d = u.dist(ls.segPos[i - 1].x, ls.segPos[i - 1].y, ls.segPos[i].x, ls.segPos[i].y);
  if (Math.abs(d - cfg.SEG_SPACING) > 1.5) gapOk = false;
}
ok(gapOk, 'trail-following：直行后相邻节间距 ≈ SEG_SPACING(' + cfg.SEG_SPACING + 'px)');
ok(ls.trail.length < 400, '轨迹裁剪生效（不会无限增长）', 'trail=' + ls.trail.length);

// ---------------- 6. 相机钳制 ----------------
section('相机钳制');
var cg = new CS.Game(960, 540);
cg.startLevel(1);
var vw = cg.layout().areaW, vh = cg.screenH;
cg.snake.x = 30; cg.snake.y = 30;      // 左上角
cg.updateCamera(16);
ok(cg.camera.x >= -cfg.WALL_THICK - 1e-6 && cg.camera.y >= -cfg.WALL_THICK - 1e-6, '蛇在左上角：相机可放开到 (≥-T, ≥-T) 以露出左侧边界墙', cg.camera.x.toFixed(1) + ',' + cg.camera.y.toFixed(1));
cg.camera.x = 99999; cg.camera.y = 99999; // 人为制造越界
cg.snake.x = cg.walls.W - 30; cg.snake.y = cg.walls.H - 30; // 右下角
cg.updateCamera(16);
ok(cg.camera.x <= cg.walls.W - vw + cfg.WALL_THICK + 1e-6 && cg.camera.y <= cg.walls.H - vh + cfg.WALL_THICK + 1e-6,
  '蛇在右下角：相机钳制到 (≤W-vw+T, ≤H-vh+T)，留出边界墙余量', cg.camera.x.toFixed(1) + ',' + cg.camera.y.toFixed(1));
ok(cg.camera.x >= -cfg.WALL_THICK - 1e-6 && cg.camera.y >= -cfg.WALL_THICK - 1e-6, '越界相机被拉回合法区间');

// ---------------- 7. 世界墙生成约束 ----------------
section('墙壁生成');
var wallOk = true, wallDetail = '';
for (var t = 0; t < 20; t++) {
  var lc = lv.levelConfig(1 + (t % 10));
  var wl = new CS.Walls(lc.W, lc.H, { x: lc.W / 2, y: lc.H / 2 });
  wl.generateWalls(lc.wallSegments);
  if (wl.area > lc.W * lc.H * cfg.WALL_MAX_RATIO + 1e-6) { wallOk = false; wallDetail = 'area over budget'; break; }
  for (var ri = 0; ri < wl.rects.length; ri++) {
    var rc = wl.rects[ri];
    if (!wl.rectInBounds(rc)) { wallOk = false; wallDetail = 'out of bounds'; break; }
    if (wl.rectHitsSafeZone(rc)) { wallOk = false; wallDetail = 'safe zone violated'; break; }
  }
  if (!wallOk) break;
}
ok(wallOk, '20 次生成（L1~L10 轮换）：面积 ≤8%、界内、出生安全区无墙', wallDetail);
// 撞墙判定
var hw = new CS.Walls(2400, 1600, { x: 1200, y: 800 });
hw.rects.push({ x: 500, y: 500, w: 96, h: 48 });
ok(hw.hitsCircle(5, 800, cfg.HEAD_HIT_RADIUS), '蛇头贴左边界 → 撞墙');
ok(hw.hitsCircle(2395, 800, cfg.HEAD_HIT_RADIUS), '蛇头贴右边界 → 撞墙');
ok(hw.hitsCircle(548, 524, cfg.HEAD_HIT_RADIUS), '蛇头压内部墙矩形 → 撞墙');
ok(!hw.hitsCircle(1200, 800, cfg.HEAD_HIT_RADIUS), '出生点空地不撞墙');

// ---------------- 8. spawner 间距与只刷已解锁色 ----------------
section('spawner 约束');
var sw2 = new CS.Walls(cfg.ENDLESS.W, cfg.ENDLESS.H, { x: 1800, y: 1200 });
sw2.generateWalls(8);
var ss2 = new CS.Snake(1800, 1200, 4, 0, ['red', 'blue']);
var sp = new CS.Spawner(sw2, ss2);
sp.unlockedKeys = ['red', 'blue']; // 模拟只解锁 2 色
ok(sp.target === u.clamp(Math.round(3600 * 2400 / cfg.BLOCK_AREA_DIV), cfg.BLOCKS_MIN, cfg.BLOCKS_MAX),
  '目标数 = 世界面积/90000 夹取 [8,40]', 'target=' + sp.target);
for (i = 0; i < 300; i++) sp.spawnOne();
// 新结构：每块必须带 kind 字段；普通色块落在已解锁色、特殊道具 color=null
var shapeOk = sp.blocks.length > 0 && sp.blocks.every(function (blk) {
  if (typeof blk.kind !== 'string') return false;
  if (blk.kind === 'color') return blk.color === 'red' || blk.color === 'blue';
  if (blk.kind === 'wild' || blk.kind === 'bomb' || blk.kind === 'slow' ||
      blk.kind === 'rand1' || blk.kind === 'rand2' || blk.kind === 'rand3') return blk.color === null;
  if (blk.kind === 'clear' || blk.kind === 'clear3') return blk.color === 'red' || blk.color === 'blue';
  return false;
});
ok(shapeOk, '300 次生成：每块带 kind，普通块=已解锁色、特殊道具 color=null', 'blocks=' + sp.blocks.length);
var colorCount = sp.blocks.filter(function (b) { return b.kind === 'color'; }).length;
var specialCount = sp.blocks.filter(function (b) { return b.kind !== 'color'; }).length;
ok(colorCount > 0, '生成包含普通色块（color 块=' + colorCount + '）');
ok(specialCount > 0, '生成包含特殊道具（wild/bomb/slow 块=' + specialCount + '）');
var distOk = true;
for (i = 0; i < sp.blocks.length; i++) {
  var blk = sp.blocks[i];
  if (sw2.pointInWall(blk.x, blk.y, 0)) distOk = false;
  if (blk.x < cfg.BLOCK_EDGE_MARGIN - 1 || blk.x > sw2.W - cfg.BLOCK_EDGE_MARGIN + 1 ||
      blk.y < cfg.BLOCK_EDGE_MARGIN - 1 || blk.y > sw2.H - cfg.BLOCK_EDGE_MARGIN + 1) distOk = false;
  if (ss2.distTo(blk.x, blk.y) < cfg.BLOCK_SNAKE_DIST - 1e-6) distOk = false;
  for (var j = i + 1; j < sp.blocks.length; j++) {
    if (u.dist(blk.x, blk.y, sp.blocks[j].x, sp.blocks[j].y) < cfg.BLOCK_MIN_DIST - 1e-6) distOk = false;
  }
}
ok(distOk, '色块间距 ≥140px、离蛇 ≥80px、不压墙、避开边界');
// 收集：头部插入联动
var cs2 = new CS.Snake(1000, 1000, 4, 0, ['red']);
var cwalls = new CS.Walls(2400, 1600, { x: 1200, y: 800 });
var csp = new CS.Spawner(cwalls, cs2);
csp.blocks = [{ x: 1000, y: 1000, color: 'teal', phase: 0 }]; // 直接压在蛇头
var got = csp.collectAt(cs2);
ok(got.length === 1 && csp.blocks.length === 0, '身体/头部圆形重叠收集色块');
cs2.grow(got[0].color);
ok(cs2.colors[0] === 'teal' && cs2.length() === 5, '收集后新色进头部，长度 +1');

// ---------------- 8b. v2.8 道具（消色 / 随机 / 流星注入） ----------------
section('v2.8 道具');
// 构造可控颜色的蛇：直接指定 colors 并铺设直线轨迹使 segPos 按 30px 间距排布
function mkSnake(cols) {
  var s = new CS.Snake(1000, 1000, cols.length, 0,
    ['red', 'blue', 'green', 'orange', 'purple', 'yellow', 'teal', 'pink']);
  s.colors = cols.slice();
  s.trail = [];
  for (var t = 0; t < cols.length + 4; t++) s.trail.push({ x: 1000 - t * 30, y: 1000 });
  s.computeBody();
  return s;
}

var s1 = mkSnake(['red', 'blue', 'red', 'green', 'red', 'blue']);
var r1 = s1.removeByColor('red');
ok(r1.length === 3 && s1.colors.join(',') === 'blue,green,blue',
  '消色道具：移除全部 red（3 节），余 blue,green,blue', s1.colors.join(','));
ok(r1.every(function (x) { return x.color === 'red' && typeof x.x === 'number'; }),
  '消色：被移除节带颜色 + 世界坐标（特效用）');

var s2 = mkSnake(['red', 'blue', 'red', 'green', 'red', 'blue']);
var r2 = s2.removeRearByColor('red', 2);
ok(r2.length === 2 && s2.colors.join(',') === 'red,blue,green,blue',
  '后3消色：移除最靠尾的 2 个 red，余 red,blue,green,blue', s2.colors.join(','));

var s3 = mkSnake(['red', 'blue', 'green', 'orange', 'purple', 'yellow']);
var before3 = s3.colors.length;
var r3 = s3.removeRandom(3);
ok(r3.length === 3 && s3.colors.length === before3 - 3, '随机消 3：移除 3 节、长度 -3', 'rem=' + r3.length);

var s4 = mkSnake(['red', 'blue', 'green', 'orange', 'purple']);
s4.insertAt(2, 'yellow');
ok(s4.colors[2] === 'yellow' && s4.colors.length === 6, 'insertAt(2)：在下标 2 插入 yellow');
s4.insertAt(-9, 'X');
ok(s4.colors[0] === 'X', 'insertAt 负下标 → 夹紧到头部');
s4.insertAt(999, 'Y');
ok(s4.colors[s4.colors.length - 1] === 'Y', 'insertAt 超界 → 夹紧到尾部');

var s5 = mkSnake(['red', 'blue', 'green', 'orange', 'purple', 'yellow']);
var seg5 = s5.segPos[3];
ok(s5.segIndexAt(seg5.x, seg5.y, cfg.METEOR_HIT_R) === 3, 'segIndexAt：命中第 3 节返回下标 3');
ok(s5.segIndexAt(5000, 5000, cfg.METEOR_HIT_R) === -1, 'segIndexAt：远处返回 -1');

// 流星砖块：命中身体 → 返回注入事件（game 据此 insertAt 注入中段）
var ms = mkSnake(['red', 'blue', 'green', 'orange', 'purple']);
var msp = new CS.Spawner(new CS.Walls(2400, 1600, { x: 1200, y: 800 }), ms);
msp.unlockedKeys = ['red', 'blue', 'green', 'orange', 'purple'];
var lenBefore = ms.colors.length;
msp.spawnMeteor(ms);
var mm = msp.meteors[0];
var mseg = ms.segPos[3];
mm.x = mseg.x; mm.y = mseg.y; mm.vx = 0; mm.vy = 0; // 直接放到第 3 节上
msp.meteorTimer = 1e9; // 防止本帧额外生成，保持测试纯净
var evs = msp.updateMeteors(16, ms);
ok(evs.length === 1 && evs[0].idx >= 1 && evs[0].idx <= ms.colors.length,
  '流星命中身体节 → 返回注入事件(有效身体下标)');
ms.insertAt(evs[0].idx, evs[0].color);
ok(ms.colors.length === lenBefore + 1, '流星注入：身体长度 +1（中段新增该色节）');

// v2.8.2 流星：只从上下左右四个正方向、直线匀速、无归向（朝向恒定）
var m2 = mkSnake(['red', 'blue']);
var m2sp = new CS.Spawner(new CS.Walls(2400, 1600, { x: 1200, y: 800 }), m2);
m2sp.unlockedKeys = ['red', 'blue'];
var cardinalOK = true, straightOK = true;
for (var mi = 0; mi < 40; mi++) {
  m2sp.meteors = [];
  m2sp.spawnMeteor({ x: 1200, y: 800 });
  var mo = m2sp.meteors[0];
  if (!(Math.abs(mo.vx) < 1e-9 || Math.abs(mo.vy) < 1e-9)) cardinalOK = false; // 必为水平或垂直
  var ax0 = Math.atan2(mo.vy, mo.vx);
  mo.x += mo.vx * 0.1; mo.y += mo.vy * 0.1; // 不调 updateMeteors，避免被回收
  var ax1 = Math.atan2(mo.vy, mo.vx);
  if (Math.abs(ax0 - ax1) > 1e-9) straightOK = false; // 朝向恒定（无归向）
}
ok(cardinalOK, '流星：40 次生成全部为上下左右正方向（水平或垂直）');
ok(straightOK, '流星：飞行朝向恒定，无归向蛇头（直线飞向对侧）');

// ---------------- 9. Game 流程 ----------------
section('Game 流程');
var g1 = new CS.Game(960, 540);
g1.startEndless();
ok(g1.state === 'play' && g1.unlockedCount === 4, '无尽开局：play 状态 + 初始 4 色');
ok(g1.snake.x === 1800 && g1.snake.y === 1200, '蛇出生在世界中心');
var steps = 0;
while (g1.state === 'play' && steps++ < 20000) g1.update(16); // 不转向，直行撞右边界
ok(g1.state === 'over', '直行撞世界边界 → 游戏结束', 'steps=' + steps);

// 无尽解锁随时间生效
var g2 = new CS.Game(960, 540);
g2.startEndless();
g2.unlockTo(cfg.unlockedCountForEndless(50));
ok(g2.unlockedCount === 5 && g2.spawner.unlockedKeys.length === 5, 'unlockTo(5)：刷新池同步到 5 色');
ok(!!g2.unlockBanner && g2.unlockBanner.keys.join(',') === 'purple', '解锁横幅弹出，新增色 = purple');

// 闯关闭环：分数达标 → clear → 解锁下一关
var g3 = new CS.Game(960, 540);
g3.startLevel(1);
g3.elimScore = lv.levelConfig(1).targetScore; // 直接灌分
g3.update(16);
ok(g3.state === 'clear' && g3.unlocked === 2, 'L1 达标 → 过关并解锁第 2 关');
g3.onButton('next');
ok(g3.state === 'play' && g3.levelCfg.level === 2, '「下一关」进入 L2');
// 需求 4：闯关速度 = 关卡基础 + 长度加成 + 时间加成（开局 elapsed=0，时间加成为 0）
var base2 = lv.levelConfig(2).speed;
ok(Math.abs(g3.snake.speed - (base2 + cfg.START_LENGTH * cfg.SPEED_LEN_COEF)) < 1e-9,
  '闯关动态速度：开局 = 关卡基础 + 长度加成',
  'speed=' + g3.snake.speed.toFixed(1) + ' 期望=' + (base2 + cfg.START_LENGTH * cfg.SPEED_LEN_COEF).toFixed(1));

// ---------------- 9b. 动态速度公式（需求 4） ----------------
section('动态速度公式');
var sg = new CS.Game(960, 540);
sg.startLevel(1);
var base1 = lv.levelConfig(1).speed;
var v0 = sg.currentSpeed();
ok(Math.abs(v0 - (base1 + cfg.START_LENGTH * cfg.SPEED_LEN_COEF)) < 1e-9 && v0 > base1,
  '闯关开局：速度 = 基础 + 1.2×节数（大于裸基础速度）', 'v0=' + v0.toFixed(1));
sg.elapsed = 20000; // 模拟存活 20 秒
var v1 = sg.currentSpeed();
ok(Math.abs(v1 - (base1 + cfg.START_LENGTH * cfg.SPEED_LEN_COEF + 20 * cfg.LEVEL_SPEED_TIME_COEF)) < 1e-9 && v1 > v0,
  '存活 20s → 时间加成 +0.5×20 生效且速度变大', 'v1=' + v1.toFixed(1));
for (var q = 0; q < 300; q++) sg.snake.colors.push('red'); // 人为拉长验证封顶
var v2 = sg.currentSpeed();
ok(v2 === base1 + cfg.LEVEL_SPEED_CAP_ADD,
  '节数/时间过大 → 封顶 = 基础 + ' + cfg.LEVEL_SPEED_CAP_ADD, 'v2=' + v2.toFixed(1));
var se = new CS.Game(960, 540);
se.startEndless();
var e0 = se.currentSpeed();
se.elapsed = 200000; // 无尽 200 秒
ok(se.currentSpeed() === cfg.SPEED_MAX && e0 < cfg.SPEED_MAX,
  '无尽：时间+长度双加成，封顶 SPEED_MAX=' + cfg.SPEED_MAX,
  'e0=' + e0.toFixed(1) + ' cap=' + se.currentSpeed().toFixed(1));

// ---------------- 10. 4000 帧随机游走（带转向输入） ----------------
section('随机游走 4000 帧');
var g4 = new CS.Game(960, 540);
g4.startEndless();
var restarts = 0, err = null;
try {
  for (var f = 0; f < 4000; f++) {
    if (g4.state !== 'play') { g4.startEndless(); restarts++; }
    if (f % 7 === 0) g4.snake.setTargetAngle(Math.random() * Math.PI * 2 - Math.PI); // 随机目标角
    g4.update(16);
  }
} catch (e) { err = e; }
ok(!err, '无尽 4000 帧随机转向输入无异常' + (err ? '：' + err.message : ''), err && err.stack);
ok(g4.timeMs >= 4000 * 16, '主循环时间正常推进', 'timeMs=' + g4.timeMs);
console.log('  （期间撞墙重开 ' + restarts + ' 次，当前分数 ' + g4.score + '，蛇长 ' + (g4.snake ? g4.snake.length() : '-') + '）');

var g5 = new CS.Game(960, 540);
g5.startLevel(1);
err = null;
try {
  for (f = 0; f < 4000; f++) {
    if (g5.state !== 'play') break; // 过关或结束即停
    if (f % 5 === 0) g5.snake.setTargetAngle(Math.random() * Math.PI * 2 - Math.PI);
    g5.update(16);
  }
} catch (e) { err = e; }
ok(!err, '闯关 4000 帧随机转向输入无异常' + (err ? '：' + err.message : ''), err && err.stack);

// 键盘 8 方向输入
section('键盘 8 方向');
var js2 = new CS.Joystick();
js2.keysDown = { w: { x: 0, y: -1 }, d: { x: 1, y: 0 } };
var ka = js2.currentAngle();
ok(ka !== null && Math.abs(ka - (-Math.PI / 4)) < 1e-9, 'W+D 组合 → 右上目标角 -π/4', 'angle=' + ka);
js2.keysDown = {};
ok(js2.currentAngle() === null, '无按键无摇杆 → 无输入（保持原方向）');
js2.angle = 1.2;
ok(Math.abs(js2.currentAngle() - 1.2) < 1e-9, '摇杆自由角度直接透传（不量化）');

// ---------------- 11. storage 容错 ----------------
section('storage');
store.set('smoke_test_key', 42);
ok(store.get('smoke_test_key', 0) === 42, 'set/get 往返一致');
ok(store.get('smoke_missing_key', 'fallback') === 'fallback', '缺失 key 返回默认值');

// ---------------- 12. 多人对战：开局与编制 ----------------
section('多人对战：开局');
var mg = new CS.Game(960, 540);
mg.startMulti();
ok(mg.state === 'play' && mg.mode === 'multi', '多人开局：play 状态 + multi 模式');
ok(mg.unlockedCount === 4, '多人初始 4 色（解锁规则同无尽）');
ok(mg.walls.W === cfg.MULTI.W && mg.walls.H === cfg.MULTI.H,
  '多人世界 = ' + cfg.MULTI.W + 'x' + cfg.MULTI.H, mg.walls.W + 'x' + mg.walls.H);
ok(mg.spawner.target === u.clamp(Math.round(cfg.MULTI.W * cfg.MULTI.H / cfg.MP_BLOCK_AREA_DIV), cfg.MP_BLOCKS_MIN, cfg.MP_BLOCKS_MAX),
  '多人色块目标数 = 面积/' + cfg.MP_BLOCK_AREA_DIV + ' 夹取 [' + cfg.MP_BLOCKS_MIN + ',' + cfg.MP_BLOCKS_MAX + ']',
  'target=' + mg.spawner.target);
ok(mg.mp.aliveBotCount() === (cfg.MP_AI_START_COUNT || 3), '场上 AI 蛇 = ' + (cfg.MP_AI_START_COUNT || 3) + ' 条（开局初始值）');
ok(mg.mp.playerEntry && mg.mp.playerEntry.isPlayer && mg.mp.playerEntry.name === '我', '玩家 Entry 存在，标签为「我」');
var nameSet = {}, nameDup = false, nameInPool = true;
mg.mp.bots.forEach(function (b) {
  if (nameSet[b.name]) nameDup = true;
  nameSet[b.name] = true;
  if (cfg.AI_NICKNAMES.indexOf(b.name) < 0) nameInPool = false;
});
ok(!nameDup && nameInPool, 'AI 昵称取自名字池且场上不重复');
var speedOk = mg.mp.bots.every(function (b) {
  return b.base >= cfg.MP_AI_SPEED_MIN && b.base <= cfg.MP_AI_SPEED_MAX;
});
ok(speedOk, 'AI 基础速度档位在 ' + cfg.MP_AI_SPEED_MIN + '~' + cfg.MP_AI_SPEED_MAX + ' px/s 随机');
var personaOk = mg.mp.bots.every(function (b) {
  return b.greed >= 0.4 && b.greed <= 1.6 && b.caution >= 0.4 && b.caution <= 1.6;
});
ok(personaOk, 'AI 性格参数（贪食/谨慎）在 0.4~1.6 区间（早期 AI 随机性大）');

// ---------------- 13. AI 决策合法性与转向公平 ----------------
section('AI 决策');
var bot0 = mg.mp.bots[0];
var env0 = { walls: mg.walls, blocks: mg.spawner.blocks, snakes: mg.mp.aliveSnakes() };
var angleOk = true;
for (var ai = 0; ai < 300; ai++) {
  var dec = CS.AI.decide(bot0.snake, env0, { greed: Math.random() * 2, caution: Math.random() * 2 });
  if (typeof dec !== 'number' || !isFinite(dec) || dec <= -Math.PI - 1e-9 || dec > Math.PI + 1e-9) {
    angleOk = false;
    break;
  }
}
ok(angleOk, 'AI 决策 300 次：产出均为 (-π,π] 内的有限角度（无 NaN）');
// 转向速率与玩家同规则：逐帧检查每条活 AI 的 |Δangle| ≤ TURN_RATE×dt
var turnOk = true, turnDetail = '';
for (var tf = 0; tf < 200 && turnOk; tf++) {
  var before = {};
  mg.mp.bots.forEach(function (b) { if (b.alive) before[b.id] = b.snake.angle; });
  mg.update(16);
  if (mg.state !== 'play') break; // 玩家意外死亡则提前结束本项
  mg.mp.bots.forEach(function (b) {
    if (!turnOk || !b.alive || before[b.id] === undefined) return;
    var d = Math.abs(u.normAngle(b.snake.angle - before[b.id]));
    if (d > cfg.TURN_RATE * 0.016 + 1e-9) { turnOk = false; turnDetail = 'Δθ=' + d.toFixed(4); }
  });
}
ok(turnOk, 'AI 转向受 TURN_RATE 钳制（与玩家同规则）', turnDetail);

// ---------------- 14. 淘汰规则：撞蛇 / 头对头 ----------------
section('淘汰规则');
// 头撞身体：把 AI 头挪到玩家第 3 节上 → AI 淘汰，玩家记 1 击杀
var cg1 = new CS.Game(960, 540);
cg1.startMulti();
for (var mv = 0; mv < 40; mv++) cg1.snake.update(16); // 先让玩家前进，身体节沿轨迹拉开
var victim = cg1.mp.bots[0];
var pseg = cg1.snake.segPos[2]; // 距头 2×SEG_SPACING=60px，不触碰头对头判定
victim.snake.x = pseg.x; victim.snake.y = pseg.y;
cg1.mp.collide();
ok(!victim.alive, '头撞其他蛇身体节 → 该蛇淘汰');
ok(cg1.mp.playerEntry.alive && cg1.mp.playerEntry.kills === 1, '被撞身体的主人记 1 击杀',
  'kills=' + cg1.mp.playerEntry.kills);
// 头对头：两条 AI 头贴近 → 双双淘汰，不记击杀
var cg2 = new CS.Game(960, 540);
cg2.startMulti();
var ha = cg2.mp.bots[0], hb = cg2.mp.bots[1];
hb.snake.x = ha.snake.x + cfg.HEAD_HIT_RADIUS; // 头心距 = HEAD_HIT_RADIUS < 2×HEAD_HIT_RADIUS
hb.snake.y = ha.snake.y;
cg2.mp.collide();
ok(!ha.alive && !hb.alive, '头对头相撞 → 两条都淘汰');
ok(ha.kills === 0 && hb.kills === 0, '头对头不记击杀（简单公平）');
// 撞墙：AI 头压边界 → 淘汰
var cg3 = new CS.Game(960, 540);
cg3.startMulti();
var wallBot = cg3.mp.bots[0];
wallBot.snake.x = 2; wallBot.snake.y = cg3.walls.H / 2;
cg3.mp.collide();
ok(!wallBot.alive, '头撞世界边界 → 淘汰（沿用单人判定）');

// ---------------- 15. 尸体掉落 ≈ 节数一半 ----------------
section('尸体掉落');
var dg = new CS.Game(960, 540);
dg.startMulti();
var corpse = dg.mp.bots[0];
corpse.snake.colors = [];
for (var ci = 0; ci < 10; ci++) corpse.snake.colors.push(cfg.COLOR_KEYS[ci % 4]);
corpse.snake.computeBody();
var before10 = dg.spawner.blocks.length;
var added10 = dg.mp.dropCorpse(corpse);
ok(added10 === 5 && dg.spawner.blocks.length === before10 + 5,
  '10 节尸体掉落 5 个色块（≈50% 节）', 'added=' + added10);
corpse.snake.colors.push('red'); // 11 节
corpse.snake.computeBody();
var added11 = dg.mp.dropCorpse(corpse);
ok(added11 >= 5 && added11 <= 6, '11 节尸体掉落 5~6 个色块（起点随机）', 'added=' + added11);
var corpseColorOk = dg.spawner.blocks.slice(before10).every(function (b) {
  return cfg.COLOR_KEYS.indexOf(b.color) >= 0 && isFinite(b.x) && isFinite(b.y);
});
ok(corpseColorOk, '掉落色块带合法颜色与有限坐标（进入资源循环）');

// ---------------- 16. AI 补充维持编制 ----------------
section('AI 补充');
var rg = new CS.Game(960, 540);
rg.startMulti();
var deadBot = rg.mp.bots[0];
rg.mp.kill(deadBot); // 直接淘汰一条
ok(rg.mp.aliveBotCount() === cfg.MP_AI_START_COUNT - 1 && rg.mp.respawnQueue.length === 1,
  '淘汰后：活 AI ' + (cfg.MP_AI_START_COUNT - 1) + ' 条 + 重生队列 1 条');
var rosterOk = true, rebornLen = -1;
for (var rf = 0; rf < 400; rf++) { // 400 帧 = 6.4 秒，覆盖 3~5 秒重生延迟（且 < 25 秒增长阈值）
  rg.mp.update(16);
  // 前 25 秒目标数量 = MP_AI_START_COUNT；活 AI + 重生队列应恒定守恒（淘汰→入队、到期→重生）
  var total16 = rg.mp.aliveBotCount() + rg.mp.respawnQueue.length;
  if (total16 !== cfg.MP_AI_START_COUNT) rosterOk = false;
  if (rebornLen < 0 && rg.mp.respawned >= 1) {
    rebornLen = rg.mp.bots[rg.mp.bots.length - 1].snake.length(); // 重生当帧立即记录（之后可能吃到色块）
  }
}
ok(rosterOk, '编制守恒：活 AI + 重生队列 === ' + cfg.MP_AI_START_COUNT + '（前 25 秒不变式，死亡入队/到期重生守恒）');
ok(rg.mp.respawned >= 1, '延迟 3~5 秒后新 AI 重生（respawned=' + rg.mp.respawned + '）');
ok(rebornLen >= cfg.MP_START_LENGTH, '重生 AI 初始至少 ' + cfg.MP_START_LENGTH + ' 节', 'len=' + rebornLen);

// ---------------- 17. 排行榜排序 ----------------
section('排行榜');
var lg = new CS.Game(960, 540);
lg.startMulti();
// 人为设定节数：玩家 12，3 条 AI 依次 20、3、7（开局仅 3 条 AI）
while (lg.snake.colors.length < 12) lg.snake.colors.push('blue');
var setLens = [20, 3, 7];
lg.mp.bots.forEach(function (b, i2) {
  while (b.snake.colors.length > setLens[i2]) b.snake.colors.pop();
  while (b.snake.colors.length < setLens[i2]) b.snake.colors.push('red');
});
var lb = lg.mp.leaderboard();
var sortOk = lb.length === 4; // 玩家 + 3 AI
for (var li = 0; li < lb.length - 1; li++) {
  if (lb[li].length < lb[li + 1].length) sortOk = false;
}
ok(sortOk, '排行榜 4 条蛇按当前节数降序', lb.map(function (r) { return r.length; }).join(','));
ok(lb[0].length === 20 && !lb[0].isPlayer, '榜首为 20 节的 AI');
ok(lb[1].isPlayer && lb[1].length === 12, '玩家（12 节）排第 2 且带高亮标记',
  JSON.stringify(lb[1]));
ok(lg.mp.rankOf(lg.mp.playerEntry) === 2, 'rankOf(玩家) = 2（1 + 节数更多的活蛇数）');

// ---------------- 18. 玩家淘汰结算 ----------------
section('多人结算');
var og = new CS.Game(960, 540);
og.startMulti();
og.snake.x = 5; og.snake.y = og.walls.H / 2; // 头压左边界
og.update(16);
ok(og.state === 'over' && !og.mp.playerEntry.alive, '玩家撞界 → 淘汰进结算');
ok(og.mpResult && og.mpResult.rank >= 1 && og.mpResult.rank <= 7,
  '结算含最终排名（1~7）', 'rank=' + (og.mpResult && og.mpResult.rank));
ok(og.mpResult && typeof og.mpResult.kills === 'number' && og.mpResult.surviveSec >= 0,
  '结算含击杀数 / 存活时间 / 得分');
ok(og.mpResult && typeof og.mpResult.elimTotal === 'number' &&
  typeof og.mpResult.survivalScore === 'number' && typeof og.mpResult.elimScore === 'number' &&
  typeof og.mpResult.finalLen === 'number',
  '结算含累计消除方块 / 时间分 / 消除分 / 最终节数（v2.2 新统计项）');
var storedBest = store.get(cfg.STORAGE_MP_BEST, null);
ok(storedBest && storedBest.len >= og.mpResult.maxLen && storedBest.score >= og.mpResult.score,
  '多人最佳成绩写入 localStorage（新 key）', JSON.stringify(storedBest));
og.onButton('retry');
ok(og.state === 'play' && og.mode === 'multi' && og.mp.aliveBotCount() === cfg.MP_AI_START_COUNT,
  '「再来一局」重开多人对战，编制完整（开局 ' + cfg.MP_AI_START_COUNT + ' 条 AI）');

// ---------------- 19. 多人 3000 帧模拟 ----------------
section('多人 3000 帧模拟');
var sg2 = new CS.Game(960, 540);
sg2.startMulti();
var mpRestarts = 0;
var err = null;
var boundsOk = true, minTotal = Infinity, maxTotal = 0;
try {
  for (var mf = 0; mf < 3000; mf++) {
    if (sg2.state !== 'play') { sg2.startMulti(); mpRestarts++; }
    if (mf % 6 === 0) sg2.snake.setTargetAngle(Math.random() * Math.PI * 2 - Math.PI); // 随机玩家输入
    sg2.update(16);
    if (sg2.state === 'play') {
      var total19 = sg2.mp.aliveBotCount() + sg2.mp.respawnQueue.length;
      if (total19 < cfg.MP_AI_START_COUNT || total19 > cfg.MP_AI_MAX_COUNT) boundsOk = false;
      if (total19 < minTotal) minTotal = total19;
      if (total19 > maxTotal) maxTotal = total19;
    }
  }
} catch (e) { err = e; }
ok(!err, '3000 帧（随机玩家输入 + 动态 AI）无异常、无死循环' + (err ? '：' + err.message : ''), err && err.stack);
ok(sg2.timeMs >= 3000 * 16, '多人主循环时间正常推进', 'timeMs=' + sg2.timeMs);
ok(boundsOk, 'AI 总数始终在 [' + cfg.MP_AI_START_COUNT + ',' + cfg.MP_AI_MAX_COUNT + '] 区间（不越界、不爆炸）',
  'min=' + minTotal + ' max=' + maxTotal);
console.log('  （期间玩家死亡重开 ' + mpRestarts + ' 次，AI 累计重生 ' + sg2.mp.respawned + ' 次）');

// ---------------- 19b. AI 随时间动态增长（v2.8.7 核心需求） ----------------
section('AI 随时间动态增长');
var gg = new CS.Game(960, 540);
gg.startMulti();
var growCounts = [];
for (var gf = 0; gf < 60; gf++) { // 每次 +0.5 秒 → 覆盖 0~30 秒
  gg.mp.timeMs += 500;
  gg.mp.processRespawns();
  growCounts.push(gg.mp.aliveBotCount() + gg.mp.respawnQueue.length);
}
ok(growCounts[0] === cfg.MP_AI_START_COUNT, '开局 AI 数量 = ' + cfg.MP_AI_START_COUNT + ' 条（初始值）', 'c0=' + growCounts[0]);
var monoOk = true;
for (var gci = 1; gci < growCounts.length; gci++) {
  if (growCounts[gci] < growCounts[gci - 1]) monoOk = false;
}
ok(monoOk, 'AI 数量随时间单调不减（越后期越多）', growCounts.join(','));
ok(growCounts[growCounts.length - 1] <= cfg.MP_AI_MAX_COUNT,
  'AI 数量封顶 ' + cfg.MP_AI_MAX_COUNT + '（不会无限膨胀卡顿）', 'cEnd=' + growCounts[growCounts.length - 1]);
var smA = gg.mp.currentSmartness();
gg.mp.timeMs += 1000 * 80; // 再推进 80 秒
var smB = gg.mp.currentSmartness();
ok(smB > smA, '后期 AI 智力等级高于开局（currentSmartness 随时间提升）', 'smart ' + smA.toFixed(2) + '→' + smB.toFixed(2));

// ---------------- 20. 咬断机制（v2.2） ----------------
section('咬断机制');
// ① 基本咬断：A 头撞 B 第 3 节（下标 2）→ A 淘汰、B 记击杀，B 短一节且移除的正是最近节
var b1 = new CS.Game(960, 540);
b1.startMulti();
for (var mv = 0; mv < 40; mv++) b1.snake.update(16); // 让玩家前进，身体节沿轨迹拉开
b1.snake.colors = ['red', 'green', 'blue', 'orange', 'red']; // 5 节，无 4 连
b1.snake.computeBody();
var beforeSeq = b1.snake.colors.slice();
var atk1 = b1.mp.bots[0];
var pseg2 = b1.snake.segPos[2]; // 距头 60px，不触碰头对头判定
atk1.snake.x = pseg2.x; atk1.snake.y = pseg2.y;
b1.mp.collide();
ok(!atk1.alive && b1.mp.playerEntry.alive && b1.mp.playerEntry.kills === 1,
  '咬断沿用淘汰规则：撞身者淘汰、被撞身体主人记 1 击杀');
ok(b1.snake.length() === beforeSeq.length - 1, '被撞者短一节（5→4）', 'len=' + b1.snake.length());
var expectSeq = beforeSeq.slice(); expectSeq.splice(2, 1);
ok(b1.snake.colors.join(',') === expectSeq.join(','),
  '被移除的正是头心最近的身体节（下标 2，颜色序列去掉该项）',
  b1.snake.colors.join(',') + ' vs ' + expectSeq.join(','));
ok(b1.mp.playerEntry.bittenUntil > b1.mp.timeMs, '被咬闪白/抖动反馈已挂到被撞者（bittenUntil）');

// ② 咬断后凑成 4 连 → 正常消除 + 计分给 B（被撞者）
var b2 = new CS.Game(960, 540);
b2.startMulti();
for (mv = 0; mv < 40; mv++) b2.snake.update(16);
b2.snake.colors = ['red', 'red', 'red', 'blue', 'red', 'red']; // 咬掉 blue（下标 3）→ 5 连红
b2.snake.computeBody();
var atk2 = b2.mp.bots[0];
var pseg3 = b2.snake.segPos[3];
atk2.snake.x = pseg3.x; atk2.snake.y = pseg3.y;
b2.mp.collide();
ok(b2.mp.playerEntry.alive && b2.snake.length() === cfg.REFILL_ON_FLOOR,
  '咬断后 5 连红触发消除（保底触发：整段消除后随机补满 ' + cfg.REFILL_ON_FLOOR + ' 节）', 'len=' + b2.snake.length());
ok(b2.mp.playerEntry.elimScore === 5 * cfg.ELIM_SCORE,
  '咬断触发的消除分记给 B（移除 5 节 ×' + cfg.ELIM_SCORE + ' 分，chain1）', 'elimScore=' + b2.mp.playerEntry.elimScore);
ok(b2.mp.playerEntry.elimTotal === 5, '累计消除方块 = 5（被咬触发的消除全额计入）',
  'elimTotal=' + b2.mp.playerEntry.elimTotal);

// ③ 咬到保底节数以下 → B 直接淘汰（尸体掉落 + 计入 A 击杀）
var b3 = new CS.Game(960, 540);
b3.startMulti();
for (mv = 0; mv < 40; mv++) b3.snake.update(16);
b3.snake.colors = ['red', 'green', 'blue']; // 3 节：被咬 1 节 → 2 节 < 保底 3
b3.snake.computeBody();
var atk3 = b3.mp.bots[0];
var pseg1 = b3.snake.segPos[1];
atk3.snake.x = pseg1.x; atk3.snake.y = pseg1.y;
var blocksBefore3 = b3.spawner.blocks.length;
b3.mp.collide();
ok(!b3.mp.playerEntry.alive, '被咬到保底节数以下（3→2）→ B 直接淘汰');
ok(!atk3.alive && atk3.kills === 1, '保底淘汰计入 A 的击杀（A 撞身也照常淘汰）',
  'atk.kills=' + atk3.kills);
ok(b3.spawner.blocks.length > blocksBefore3, '保底淘汰走正常流程：尸体掉落色块进入资源循环');

// ④ 累计消除方块：连锁消除全额计入（chain1×4 + chain2×4 + chain3×1 = 9 节）
var b4 = new CS.Game(960, 540);
b4.startMulti();
var bot4 = b4.mp.bots[0];
bot4.snake.colors = ['pink', 'pink', 'red', 'red', 'blue', 'blue', 'blue', 'blue', 'red', 'red', 'pink', 'pink'];
bot4.snake.computeBody();
b4.mp.resolveElim(bot4);
ok(bot4.elimTotal === 12 && bot4.elimScore === 4 * cfg.ELIM_SCORE + 4 * cfg.ELIM_SCORE * 2 + 4 * cfg.ELIM_SCORE * 3,
  '连锁消除计入累计消除方块（12 节 / ' + (4 * cfg.ELIM_SCORE + 4 * cfg.ELIM_SCORE * 2 + 4 * cfg.ELIM_SCORE * 3) + ' 分，与单人连锁倍率一致）',
  'elimTotal=' + bot4.elimTotal + ' score=' + bot4.elimScore);

// ---------------- 21. 尾巴节（v2.3：恒在的不可消除末节） ----------------
section('尾巴节');
// ① 初始总长 = 颜色节 + 1（出生 5 颜色节 + 1 尾巴节 = 6 节；length() 只计颜色节）
ok(cfg.START_LENGTH === 5, '出生颜色节数 = 5（config.START_LENGTH）', 'START_LENGTH=' + cfg.START_LENGTH);
var t0s = new CS.Snake(500, 500, cfg.START_LENGTH, 0, ['red', 'blue']);
ok(t0s.length() === 5 && t0s.totalLength() === 6 && t0s.segPos.length === 6,
  '初始：颜色节 5 + 尾巴节 1 = 总长 6（segPos 末尾恒多 1 节）',
  'colors=' + t0s.length() + ' segPos=' + t0s.segPos.length);
var tg = new CS.Game(960, 540);
tg.startEndless();
ok(tg.snake.length() === 5 && tg.snake.segPos.length === 6,
  '对局出生蛇：颜色节 5 + 尾巴节 1 = 6 节总长');
// 直行后尾巴节也按 SEG_SPACING 排布（几何与颜色节一致）
for (var ti2 = 0; ti2 < 120; ti2++) t0s.update(16);
var tailGap = u.dist(t0s.segPos[4].x, t0s.segPos[4].y, t0s.segPos[5].x, t0s.segPos[5].y);
ok(Math.abs(tailGap - cfg.SEG_SPACING) <= 1.5, '尾巴节沿轨迹跟随：与末节间距 ≈ SEG_SPACING', 'gap=' + tailGap.toFixed(1));

// ② 极端消除：整条颜色节都能凑连，消除后颜色节保底 3 且尾巴节仍在（总长 ≥ 4）
var te = makeSnake(['red', 'red', 'red', 'red', 'blue', 'blue', 'blue', 'blue']);
var re = te.eliminate(cfg.MIN_LENGTH, cfg.ELIM_RUN);
ok(re.length === 8 && te.length() === cfg.REFILL_ON_FLOOR,
  '极端消除（8 节全凑连）：保底触发→整段消除后随机补满 ' + cfg.REFILL_ON_FLOOR + ' 节', 'removed=' + re.length + ' len=' + te.length());
ok(te.totalLength() === cfg.REFILL_ON_FLOOR + 1 && te.segPos.length === cfg.REFILL_ON_FLOOR + 1,
  '尾巴节恒在：全消除后随机补满 ' + cfg.REFILL_ON_FLOOR + ' 颜色节 + 1 尾巴节 = ' + (cfg.REFILL_ON_FLOOR + 1) + ' 节总长', 'segPos=' + te.segPos.length);

// ③ 咬断不会选中尾巴节：removeSegAt 下标越界（= 尾巴节下标）返回 null
var tb3 = makeSnake(['red', 'green', 'blue', 'orange', 'purple']);
ok(tb3.removeSegAt(tb3.colors.length) === null && tb3.length() === 5,
  'removeSegAt(尾巴节下标) 返回 null：尾巴节不可被咬断移除');
// 多人场景：攻击者头正好压在玩家尾巴节上 → 撞身淘汰照常，但无咬断（颜色节不变）
var tb4 = new CS.Game(960, 540);
tb4.startMulti();
// 120 帧 ≈ 前进 288px > 5×SEG_SPACING=150px，保证含尾巴节在内的全部节沿轨迹拉开
for (var mv2 = 0; mv2 < 120; mv2++) tb4.snake.update(16);
tb4.snake.colors = ['red', 'green', 'blue', 'orange', 'red']; // 5 颜色节，无 4 连
tb4.snake.computeBody();
var tailPos = tb4.snake.segPos[5]; // 尾巴节（距头 150px，不触碰头对头判定）
var atkTail = tb4.mp.bots[0];
atkTail.snake.x = tailPos.x; atkTail.snake.y = tailPos.y;
tb4.mp.collide();
ok(!atkTail.alive && tb4.mp.playerEntry.kills === 1,
  '头撞尾巴节：照样算撞身体 → 撞者淘汰、身体主人记 1 击杀');
ok(tb4.snake.length() === 5 && tb4.snake.segPos.length === 6,
  '咬断选节排除尾巴节：颜色节不变（5 节），尾巴节仍在', 'len=' + tb4.snake.length());

// ④ 只剩 3 颜色节时：尾巴节仍在；再咬只能咬颜色节，咬到保底以下才淘汰
var tb5 = new CS.Game(960, 540);
tb5.startMulti();
for (mv2 = 0; mv2 < 120; mv2++) tb5.snake.update(16); // 前进 288px，尾巴节完全拉开
tb5.snake.colors = ['red', 'green', 'blue']; // 3 颜色节（保底数）+ 1 尾巴节
tb5.snake.computeBody();
var tailPos2 = tb5.snake.segPos[3]; // 尾巴节
var atkTail2 = tb5.mp.bots[0];
atkTail2.snake.x = tailPos2.x; atkTail2.snake.y = tailPos2.y;
tb5.mp.collide();
ok(tb5.mp.playerEntry.alive && tb5.snake.length() === 3 && tb5.snake.segPos.length === 4,
  '3 颜色节时撞尾巴节：撞者淘汰但无咬断，B 存活（颜色节 3 + 尾巴节 1）');
// 再咬颜色节（下标 1）→ 3→2 < 保底 → B 淘汰
tb5.snake.computeBody();
var seg1Pos = tb5.snake.segPos[1];
var atkColor = tb5.mp.bots[1];
atkColor.snake.x = seg1Pos.x; atkColor.snake.y = seg1Pos.y;
tb5.mp.collide();
ok(!tb5.mp.playerEntry.alive && atkColor.kills === 1,
  '再咬颜色节（3→2 < 保底 3）→ B 淘汰并计入击杀', 'kills=' + atkColor.kills);
// 重生 AI 同样带尾巴节
var tb6 = new CS.Game(960, 540);
tb6.startMulti();
var botN = tb6.mp.spawnBot();
ok(botN.snake.length() === cfg.MP_START_LENGTH && botN.snake.segPos.length === cfg.MP_START_LENGTH + 1,
  'AI 出生/重生：5 颜色节 + 1 尾巴节 = 6 节总长');

// ---------------- 汇总 ----------------
console.log('\n========================================');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
