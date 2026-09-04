# 联机对战架构设计（v3.0）

> 状态：待评审 · 2026-08-27
> 范围：在线匹配 + 真人对战。不含：账号系统、好友、观战、断线重连、排位分。

## 1. 目标与约束

| 约束 | 落地方案 |
|---|---|
| 自动匹配，人够即开 | 服务器内存匹配队列 + 房间 |
| 不支持断线重连，掉线判负 | ws 断开即标记死亡、尸体掉色块，无会话恢复 |
| 本地单机开发不受影响 | 传输层接口 + LocalTransport；单机模式零改动 |
| 流畅 | 自己蛇本地预测 + 软校正（零延迟）；他人蛇插值缓冲，延迟随快照频率自适应（30Hz→70ms） |
| 服务器压力小 | 状态同步 15~20Hz 快照 + 增量；复用客户端逻辑不重复建设 |
| 部署简单 | 一台腾讯云 Ubuntu 24.04：Nginx + Node 22 + systemd |

## 2. 关键决策

### D1：状态同步（服务器权威），弃帧同步

- 服务器跑权威模拟，客户端发输入（目标角度 + 加速），收快照渲染。
- 弃帧同步原因：现有代码大量使用 `Math.random`（道具刷新、尸体掉落相位等）与浮点连续坐标，改确定性模拟等于半重写，违背"本地开发不受影响"。
- 弃客户端权威原因：碰撞/死亡/计分判定必须唯一，防作弊零成本起步。

### D2：服务端 = Node.js + ws，直接复用 `js/` 逻辑代码

- 现有 12 个逻辑模块均为 IIFE 挂 `globalThis.CS`，Node 可 `require`（`test/smoke.js` 已验证）。
- `multiplayer.js`（610 行，对局编排核心）对 DOM 零依赖，仅触碰 `CS.audio`（服务器给 no-op 桩）和少量 game 上下文字段（见 §5.3 HeadlessGame）。
- 结果：**服务器不重写游戏规则**，规则改了两端天然一致。

### D3：单进程、内存态

- 匹配队列、房间全在单 Node 进程内存。无数据库、无 Redis。
- 掉线判负 ⇒ 无任何需要持久化的对局状态。最高分仍走客户端 localStorage。

### D4：协议第一版 JSON，预留二进制升级

- 消息为 JSON 文本帧，带 `t`（type）字段。开发调试快。
- 快照量大后换 MessagePack/自研二进制，协议层集中在 `js/net/protocol.js`，切换只改一处。

### D5：房间人数 4 真人（可配），允许 AI 补位

- `ROOM_SIZE = 4`（配置项）。匹配等待超时（默认 20s）后允许 AI 蛇补位开局，复用现有 AI 全部能力。
- `MIN_HUMANS = 1`：**单人也可开局**。等待 20s 后若队列仅 1 人，直接以「1 真人 + AI」开局。
  这样在线对战永远不会因为没人排队而进不去，也便于单人复现联机问题。
- 对局上限 5 分钟，存活者或分数最高者胜。
- 单真人局的结算阈值特判见 §6：`totalHumans === 1` 时以「本人死亡」为终局条件，
  不能沿用「存活真人 ≤1」（否则开局即刻结算）。

## 3. 总体架构

```
┌─ 浏览器客户端 ─────────────────────────────┐
│ index.html（单机模式：完全不变）            │
│ js/…（现有 15 模块：逻辑 + 渲染）           │
│ js/net/                                    │
│   protocol.js      消息编解码（两端共享）   │
│   transport.js     传输接口定义             │
│   localTransport.js 本地 AI 对战（现状搬迁）│
│   wsTransport.js   WebSocket 客户端        │
│   prediction.js    自己蛇预测 + 软校正      │
│   interpolation.js 他人蛇快照插值缓冲       │
│   netMatch.js      联机对局适配器（喂渲染） │
└──────┬─────────────────────────────────────┘
       │ WSS (JSON 帧)
┌──────┴─────────────────────────────────────┐
│ 腾讯云 Ubuntu 24.04                         │
│ Nginx :443                                  │
│   ├─ /        → 静态文件（游戏页面）        │
│   └─ /ws      → 127.0.0.1:8090（ws 反代）  │
│ Node 22（systemd 守护，崩溃自启）           │
│   server/                                   │
│     index.js       入口：HTTP+WS、连接管理  │
│     matchmaker.js  匹配队列                 │
│     room.js        房间：tick 循环/快照广播 │
│     headlessGame.js game 上下文桩（§5.3）   │
│     config.js      端口/房间参数            │
│   ↑ require('../js/*.js') 复用游戏逻辑      │
└─────────────────────────────────────────────┘
```

## 4. 目录结构（目标形态）

```
index.html              单机入口（不动）
js/…                    现有模块（逻辑模块不动；renderer/game 只做接入性改动）
js/net/…                新增：联机客户端层（见 §3）
server/                 新增：服务端（独立 package.json，唯一依赖 ws）
  index.js  matchmaker.js  room.js  headlessGame.js  config.js
test/
  smoke.js              现有逻辑冒烟（继续扩充）
  net/                  新增：协议/房间/匹配的 Node 集成测试
deploy/                 静态单文件版（照旧流程，联机版另行构建）
scripts/
  server-init.sh        腾讯云 Ubuntu 初始化（Node22+Nginx+systemd+certbot）
docs/                   本目录
```

## 5. 模块设计

### 5.1 协议 `js/net/protocol.js`

IIFE 同时挂 `CS.protocol`（浏览器）与 `module.exports`（server require）。
消息一律 JSON：`{ t: 类型, … }`。当前 `PROTO_VER=3`；版本提升与二进制
`BIN_VER=3` 同步，用于拒绝新旧客户端/服务端交叉运行，避免不兼容快照持续解码失败。

客户端 → 服务器：

| `t` | 字段 | 说明 |
|---|---|---|
| `join` | `name` | 进匹配队列 |
| `cancel` | — | 取消匹配 |
| `input` | `seq, angle, boost` | 方向输入，30Hz 上限；`seq` 在 TCP/UDP/WT 间共享，服务端只保留最新 |
| `accel` | `on` | 可靠控制面：0=TCP，1=加速，2=TCP+加速双发探测 |
| `ping` | `ts` | 心跳/测 RTT |

服务器 → 客户端：

| `t` | 字段 | 说明 |
|---|---|---|
| `queued` | `pos, need` | 排队中，当前第几位/需几人 |
| `matched` | `roomId, playerId, seed, players[], countdownMs, debugHud` | 匹配成功，含全部玩家名与配色；`debugHud` 见下 |
| `start` | `tick` | 倒计时结束，对局开始 |
| `snap` | `tick, ack, snakes[], foods[], items[]` | 快照（`ack` = 已处理到哪个输入 seq，用于校正） |
| `event` | `kind, …` | 离散事件：消除/咬断/死亡/道具/播报（驱动粒子音效） |
| `over` | `reason, ranks[]` | 结算（对方全灭/超时/己方死亡且为旁观模式则省略） |
| `pong` | `ts` | 回心跳 |

`matched.debugHud`（v3.1.1）：网络诊断 HUD（协议/RTT/丢包率/上下行 KB/s）是否对该环境
开放。由 `DEBUG_HUD=1` 环境变量控制，**dev 开、official 不设（缺省 false）**。
客户端不猜域名：缺字段的旧服务器等同 false，与 official 目标行为一致；
渲染层（侧栏与手机顶部行）只在 `online.debugHud === true` 时绘制诊断行，
official 下手机行 2 回落到颜色格。HUD 数据经 `netInfoHud()` 节流，**1 秒刷新一次**
（rAF 每帧重绘但数值同秒缓存，避免 RTT/速率逐帧抖动不可读）；
控制台 `__net()` 仍走实时值。流量字节数直接读传输层真实计数
（`ws.bytes` / `udp.stats.rxBytes|txBytes`），UDP 侧计全部到达字节（含畸形包与冗余副本）。

快照中蛇的表示（v1 全量，v2 做增量）：
`{ id, name, color, alive, head:[x,y], angle, boost, trail: 折线关键点数组, colors: 颜色序列, score, segs }`
坐标 int16 量化（地图 ≤4800×3200，无精度问题），角度 int16（0~65535 映射 0~2π）。
移动流星是独立实体：`{ mid, x, y, vx, vy, color, phase, trail }`；`mid` 在服务端生成后
整颗流星生命周期内不变，用于客户端跨快照关联轨迹（见 §5.4.2）。

### 5.2 传输层 `js/net/transport.js`

接口（事件源风格，两端模式对 game 层透明）：

```
connect() / joinMatch(name) / cancelMatch()
sendInput(angle, boost)        — 本地模式为直接喂给本地对局
onMatched / onStart / onSnap / onEvent / onOver / onDrop  — 回调注册
```

- `LocalTransport`：内部直接实例化现有 `CS.Multiplayer`（本地 AI 对战），把本地对局状态包装成与 `snap/event` 同构的对象。**联机 UI/渲染管线先用它开发**，服务器没好也能干活。
- `WsTransport`：连 `wss://host/ws`，负责编码、心跳、断线回调（→ 直接进"掉线判负"结算页）。

> **v3.1 起新增加速传输层**：`UdpAccel` 在小游戏/Node 上使用裸 UDP，在浏览器使用
> WebTransport datagram；两者共用二进制协议与冗余打散，WebSocket 保留为可靠控制面和
> 全量 JSON 保底（v3.1.1 起与加速通道同为 30Hz）。设计见 **`docs/architecture/02-udp-transport.md`**。
> 上层 `onlineMatch` 与判定逻辑零改动。

### 5.3 服务端房间 `server/room.js` + `headlessGame.js`

- `HeadlessGame`：伪装成本地 `game` 对象，提供 `multiplayer.js` 需要的字段：
  `walls / spawner / particles(空实现) / elapsed / survivalScore / elimScore / mpBonusScore / elimCombo / unlockedKeys / setItemToast(→ 转成 event 广播) / updateMulti(→ 钩子)`，`CS.audio` 挂 no-op。
- 真人玩家的蛇：输入来自可靠 TCP 或已激活的 UDP/WT 旁路（最新 angle/boost 覆盖），不走 AI；
  两条物理通道共享同一个单调 `seq/frameId`，服务端将其原样作为快照 `ack` 基线；
  AI 补位蛇照旧走 `CS.AI`。
- **固定步长模拟**：`TICK = 33ms`（30Hz），`multiplayer.update(0.033)`，与渲染解耦，避免本地 RAF 帧率差异影响判定。
- **快照广播按实际通道分频**，事件仍即时发：UDP / WebTransport 二进制 30Hz，
  TCP / wss 全量 JSON 保底 30Hz（v3.1.1 起）。
  > `SNAP_EVERY=1` 控制加速通道，`TCP_SNAP_EVERY=1` 控制保底通道；
  > **服务器模拟频率不随之变化**（恒 30Hz）。`matched` 同时下发两套间隔，
  > 客户端在通道激活 / 降级时按实际间隔动态切换插值缓冲（30Hz → 70ms）。
  > v3.0.x 曾把 TCP 压到 15Hz/119ms 以避免队头阻塞把 30Hz JSON 聚成突发；
  > v3.1.0 的 tick 权威时间线 + 短外推解决了突发回放问题后，真机 4G A/B 实测
  > 30Hz 明显更流畅（2026-09-04），故默认提回同频；代价是 JSON 下行约 38KB/s。
  > 公式与实测见 `02-udp-transport.md` §5。
- 掉线处理：ws close → `kill(entry)`（复用现有死亡/尸体掉落逻辑）→ 广播 event；房间存活真人 ≤1 → 结算解散。

### 5.4 流畅度 `js/net/prediction.js` + `interpolation.js`

- **自己的蛇**：本地每帧按收到的最新输入即刻模拟移动（参数与服务器一致），服务器快照带回 `ack` 后做**软校正**。每次权威快照应**替换**当前待校正残差，不能把同一时段的误差反复累加；位置校正必须把蛇头与整条 `trail` 一起平移，不能只移动 `x/y` 后让身体继续沿旧轨迹，否则首节间距会被拉大，表现为「头身分离」。偏差 ≥ 硬阈值时才整体重建。
  > 本机蛇**不经过插值缓冲**，操作到画面的延迟恒为 0，与快照频率无关；但校正频率越高，错误的“累加残差 + 只挪头”实现会越快放大，因此该不变量必须单独测试。
- **他人蛇**：维护插值缓冲，在两帧快照间对位置/角度/节心插值（角度走最短弧）。
  渲染始终比权威时刻慢 `delayMs`，肉眼无感。
  > `delayMs` **不是常量**，由快照间隔推导（`interval × 1.5 + 20`）：
  > 30Hz → 70ms，15Hz → 119ms。写死会导致提频后白等一帧、手感反而更钝。
  > 缓冲时间线必须来自**服务器 tick**（`tick × tickMs` 再锚定本地时钟），不能用本地
  > 收包时刻逐帧排列；否则 TCP 队头阻塞后的批量到达会被当成「真实高速运动」，
  > 表现为远端蛇突然连跳。缓冲耗尽时允许按最新速度与朝向做短时长外推，超过
  > `REMOTE_EXTRAPOLATE_MS` 后才停住，不能把「超过最新帧」直接等同于硬钳制。
- **移动实体（流星砖块）**：与远端蛇使用同一条权威时间线。协议必须携带稳定 `mid`
  与速度 `vx/vy`；客户端在两帧快照间按位置插值，缓冲耗尽时按速度短时长外推，
  并同步平移拖尾。禁止把移动实体只画在最新快照点上（15Hz 下会明显闪烁/跳格）。
- **静止食物/道具**：取最新快照即可；位置不变，插值只会增加复杂度。
- **消除/死亡/道具**：只由服务器 `event` 触发表现，本地不自行判定 ⇒ 表现与判定永远一致。

#### 5.4.1 预测体轨迹重建（v3.0.2 修复「头抛弃身体」）

**问题**：快照只带节心 `segPos`（间距 `SEG_SPACING`=30px），而 `Snake.trail` 的采样步长是
`TRAIL_STEP`=3px。早期实现把 `segPos` 直接当 `trail` 用，导致轨迹弧长恰好等于身体所需弧长
（**余量为零**）。`computeBody` 沿轨迹按弧长排布各节，轨迹一耗尽，**所有剩余节堆在轨迹末点**
——表现为「头带着几节移动，身体留在原地」。

实测：正常权威蛇 trail 202 点 / 弧长 995px（需 930px，有余量）；attach 后仅 31 点 / 900px（**不足**）。
致命场景是出生不久（轨迹尚短）时 colors 被服务器判定暴涨（连吃 / 流星注入 / 尸体色块），
40 节需 1230px 而实际约 150px → 实测 35/40 节堆叠、间距 0.0px，跑 150 帧仍不恢复。

**该 bug 只有本人可见**：他机蛇走插值层，`netMatch.updateEntryView` 直接用快照 `segPos` 渲染，
不重建轨迹；只有本机蛇走 `SelfPredictor`。这也是判定该现象的关键特征。

**修复规则**（`SelfPredictor._rebuildTrail`）：
1. **细分插值**：相邻节心之间按 `TRAIL_STEP` 补足中间点，使轨迹密度与本地自然行走一致；
2. **尾部外推**：沿最后两节的方向延长轨迹，保证总弧长 ≥
   `(colors.length+1) * SEG_SPACING + TRAIL_MARGIN`（`TRAIL_MARGIN`=90px，
   覆盖 `trimTrail` 的 60px 余量再加一档安全垫）；
3. **节心不足时的退化处理**：`segPos` 少于 2 个点（刚出生全部堆叠）时，沿 `angle` 反方向
   生成直线轨迹，保证身体立刻能展开而非堆成一点；
4. `reconcile` 中 **colors 变长**（吃块/注入）后必须重新校验轨迹弧长，不足则补足——
   这是本 bug 的主要触发路径，**不能只在 `attach` 里做**。

**引用隔离**：`onlineMatch.update` 把预测体状态同步到本机 Entry 视图时，`colors` / `segPos`
必须**拷贝**而非按引用赋值（早期实现两者共享同一数组，存在互相污染风险）。

#### 5.4.2 远端实体时间线与短外推（v3.1 渲染连续性修复）

远端渲染的核心不变量：**位置是服务器时间的函数，不是本地收包顺序的函数**。

1. 每帧快照有服务器 `tick`；客户端用 `tick × tickMs` 构造权威时间线，并用最早观测到的
   网络偏移锚定到本地时钟。TCP 抖动导致多帧同毫秒到达时，仍按 tick 间隔均匀回放。
   二进制快照的 tick 是 uint16、TCP JSON 不截断；插值层必须先把两者展开成同一条
   单调序号，65535 → 0 的回绕不得被误判为旧帧。
2. 时延下降可立即向前重锚；时延上升必须持续 `REMOTE_REANCHOR_MS` 才后移锚点。
   一次 TCP 突发只触发短外推，持续链路退化才调整时间线。
3. 正常情况在两帧之间线性插值；`renderT` 越过最新帧时，远端蛇按最新 `speed/angle`、
   流星按最新 `vx/vy` 继续外推，最多 `REMOTE_EXTRAPOLATE_MS`。外推只影响显示，不回写判定。
4. 外推必须平移整条 `segPos` / 流星 `trail`，不能只移动头部或本体，否则会把拖尾/身体
   留在旧位置。
5. 流星必须有稳定 `mid`；没有稳定 id 时，多颗流星交叉、消失、重生都无法可靠做跨帧关联。
   静止 blocks 不做插值。
6. HUD 的「插值缓冲耗尽率」继续统计原始耗尽；短外推是兜底，不得把耗尽伪装成正常插值。

### 5.5 对局编排复用 `netMatch.js`

把现有 `game.js` 的多人分支（`updateMulti`、排行榜 HUD、结算卡片）中"数据来自本地 multiplayer 实例"的部分抽象为数据源接口：
本地模式数据源 = `CS.Multiplayer` 实例；联机模式数据源 = 快照+插值层。渲染层（排行榜、小地图、结算卡片、昵称标签）两者完全共用。

## 6. 匹配与对局生命周期

```
join → 队列（queued 回报位置）
队列 ≥ ROOM_SIZE(4) → 建房 → matched（含 3s 倒计时）→ start
等待 > 20s 未满 → 以现有真人（≥ MIN_HUMANS=1）+ AI 补到 4 条开局
对局中：
  掉线 → 该蛇死亡判负（尸体掉色块），广播；不掉线不补位真人
  多真人局（totalHumans > 1）：存活真人 = 1 → 该玩家胜，over
  单真人局（totalHumans = 1）：本人死亡 → over（AI 存活不影响）
  满 5 分钟 → 按总分排名，over
over → 10s 后房间销毁，各端回主菜单/结算页
```

## 7. 性能预算

- 单房间模拟：8 蛇 × 30Hz，空间哈希碰撞检测，实测预期 < 0.5ms/tick（smoke 3000 帧模拟可作基准）。
- 带宽（v1 全量 JSON 快照，15Hz，8 蛇房）：预估下行 15~30 KB/s/客户端；上线前做 delta + 量化，目标 ≤ 10 KB/s。
  > **v3.1 实测（30Hz）**：UDP 二进制路径 **10.7 KB/s**（含 3 份冗余与 IP/UDP 头），
  > 达成目标；TCP JSON 保底路径 37.8 KB/s。两者详见 `02-udp-transport.md` §6.2。
- 单实例（2核2G）目标：≥ 100 并发房间。上线前用 `test/net/load.js` 模拟 N 个 ws 客户端压测验证。

## 8. 部署

- `scripts/server-init.sh`：Node 22（NodeSource）、Nginx、certbot、创建 `server` systemd 单元（`Restart=always`，日志 journalctl）、安全组提醒（控制台放行 22/80/443）。
- Nginx：`/` 静态根目录；`/ws` 反代到 `127.0.0.1:8090`，带 `Upgrade` 头与 3600s read_timeout。
- 节点选择：香港节点免备案即买即用；国内节点需 ICP 备案（1~3 周）。开发期可 IP + `ws://` 明文直连，上线必须 `wss://`。
- 客户端 `wsTransport` 的地址走构建期常量，缺省取 `location.host`（同域部署零配置）。

## 9. 测试策略

### 9.1 分层

| 层 | 方式 | 自动化 |
|---|---|---|
| 逻辑（规则/协议编解码/房间生命周期） | `test/smoke.js` 扩充 + `test/net/*.js`（Node 内存起 room，mock 连接） | ✅ `node test/...` |
| 联机集成 | `test/net/integration.js`：真实 ws server + N 个脚本化客户端跑完整局 | ✅ |
| 流畅度/渲染手感 | 本地双标签页 + 人工 checklist（插值平滑、校正无感、掉线提示） | 人工 |
| 服务器容量 | `test/net/load.js` 模拟客户端压测 | ✅ |

### 9.2 本地联机自动测试流程（硬性要求）

一条命令 `node test/net/run-all.js`（及 `npm test` 脚本）在本地**全自动**完成多人联机回归，不依赖浏览器、不依赖外部网络：

1. 进程内拉起真实 ws 服务器（随机空闲端口），N 个 ws 客户端以**脚本化机器人**行为接入；
2. 机器人行为可配置、可确定性复现（见下），覆盖场景：
   - 正常局：4 客户端匹配 → 倒计时 → 全程发输入 → 对局到 `over`，断言每端都收到 `matched/start/snap/over` 且排行一致；
   - 掉线局：1 客户端对局中途断开，断言其余端收到其死亡 event、尸体掉落、最终结算名次正确；
   - 补位局：只进 2 客户端，等待超时后断言 AI 补足 4 条开局；
   - 单人局：只进 1 客户端，等待超时后断言 AI 补位开局，且不会开局即结算；
   - 重排局：`over` 后同一连接再次 `join`，断言可进入新房间；
   - 协议健壮性：乱发/畸形消息不崩服务器，违规连接被踢；
3. 全局断言贯穿所有场景：快照 tick 单调递增、输入 `ack` 不超前于已发 `seq`、坐标均在地图范围内、死亡后不再收到该蛇的活动状态。

**确定性复现**：服务器随机源收敛为一个可注入的 `rng()`（`server/config.js` 默认 `Math.random`，测试时注入 `CS.utils.hash2` 种子序列）。测试用固定种子 ⇒ 同一用例每次跑出同一局，断言可精确到数值；机器人输入序列同样由种子驱动。这是服务器侧唯一的"确定性"要求，不涉及客户端。

**速度要求**：全套联机自动测试 ≤ 60s（对局可用加速 tick 跑，不等真实墙钟时间；倒计时/超时参数测试时缩小）。日常开发每次改代码后跑 `node test/smoke.js && node test/net/run-all.js` 即完成回归。

## 10. 明确不做（本期）

断线重连 · 账号/登录 · 观战 · 好友/房间号开黑（预留协议空间）· 排位分 · 反作弊深度校验（仅服务器权威判定）· 多实例水平扩展
