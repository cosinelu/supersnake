# 联机对战 MVP · 任务拆分与计划

> 状态：全部里程碑 M0~M6 代码完成（2026-08-27）· 剩余人工验收：双标签页走查 + 腾讯云真机部署对测
> 对应设计：`docs/architecture/01-online-multiplayer.md`（下称"架构文档"）
> 原则：每个里程碑结束都是一个**可运行、可验证**的状态；单机模式全程不许被改坏（smoke 全绿）。

## 里程碑总览

| 里程碑 | 目标 | 验收 |
|---|---|---|
| M0 地基 | 协议模块 + 传输层接口 + LocalTransport | smoke 全绿；联机 UI 可用本地 AI 假数据开发 |
| M1 无头服务端 | HeadlessGame + Room 在 Node 里跑完整对局 | node 集成测试：一局 4 AI 对局跑到结算 |
| M2 联机打通 | ws 服务端 + WsTransport 客户端 | 本地双标签页真人对战跑通 |
| M3 匹配与生命周期 | 匹配队列、倒计时、掉线判负、结算 | 集成测试覆盖匹配/掉线/超时 |
| M4 流畅度 | 本地预测 + 软校正 + 插值缓冲 | 人工 checklist + 模拟延迟下无瞬移 |
| M5 联机 UI | 匹配中界面、玩家名牌、掉线/结算页 | 双标签页全流程人工走查 |
| M6 部署上云 | 初始化脚本 + Nginx + systemd + wss | 腾讯云真机双端对测 + 压测达标 |

预估总工作量：M0~M2 各约 1 个开发日，M3~M4 各约 1~1.5 日，M5~M6 各约 0.5~1 日。

---

## M0 地基（纯客户端，不碰服务器）

- [x] 0.1 新建 `js/net/protocol.js`：消息类型常量、encode/decode、`snap` 的蛇/食物/道具序列化与反序列化（坐标/角度量化函数）
- [x] 0.2 新建 `js/net/transport.js`：接口定义（架构文档 §5.2）
- [x] 0.3 新建 `js/net/localTransport.js`：包装现有 `CS.Multiplayer`，输出与 `snap/event` 同构的数据流
- [x] 0.4 新建 `js/net/netMatch.js`：RemoteMatch 与 Multiplayer 同构的形状模仿视图（renderer/game 零改动即可消费联机数据流）——实现时以形状模仿替代对 game.js 的侵入式改造，风险更低
- [x] 0.5 `test/smoke.js` 扩充：协议编解码往返一致、量化精度损失 < 1px、LocalTransport 数据流与 multiplayer 实例状态一致
- 验收：`node test/smoke.js` 全绿；单机三模式手工各玩一局无回归

## M1 无头服务端（Node，不开网络）

- [x] 1.1 `server/` 骨架：`package.json`（仅 ws 依赖）、`config.js`（含**可注入 `rng()` 随机源**，默认 `Math.random`，测试注入种子序列——联机自动测试确定性的前提）
- [x] 1.2 `server/headlessGame.js`：game 上下文桩 + `CS.audio` no-op 桩（字段清单见架构文档 §5.3）；房间内所有 `Math.random` 调用点（道具刷新/尸体相位等）改走注入的 `rng()`
- [x] 1.3 `server/room.js`：固定 33ms tick 循环、快照生成（复用 protocol 序列化）、事件收集；tick 循环支持**手动步进**（测试加速用，不等墙钟）
- [x] 1.4 `test/net/room.test.js`：内存中建房，4 条 AI 蛇跑满整局，断言对局能到 `over`、排行分数非负、尸体掉落数量正确；固定种子跑两次断言结果完全一致
- 验收：`node test/net/room.test.js` 通过；3000 tick 模拟耗时 < 3s（性能基准）；同种子双跑结果一致

## M2 联机打通

- [x] 2.1 `server/index.js`：ws 服务、连接注册、单房间直通（先进先开调试模式：连上即进房）
- [x] 2.2 `js/net/wsTransport.js`：连接、心跳、input 上行（30Hz 节流）、snap/event 下行
- [x] 2.3 房间输入接入：真人蛇的角度/boost 由 ws 输入驱动（保留最新值）
- [x] 2.4 客户端渲染接入：netMatch 联机数据源 = 最新快照（**暂不做插值**，先求通）
- [x] 2.5 `test/net/botClient.js`：**脚本化机器人客户端**——真实 ws 连接 + 种子驱动的输入序列（游走/抢食/加速等行为可配），记录收到的全部消息供断言
- [x] 2.6 `test/net/integration.js`：真实 ws server + 2 机器人客户端，跑完加入→输入→收快照→结束全流程；全局断言（tick 单调、ack 不超前、坐标在界内）
- 验收：本地 `node server/index.js` + 两个浏览器标签互见对方蛇实时移动（允许有跳变，M4 解决）；机器人集成测试通过

## M3 匹配与对局生命周期

- [x] 3.1 `server/matchmaker.js`：队列、满 4 建房、20s 超时 AI 补位、`queued/matched/start` 流程
- [x] 3.2 掉线判负：ws close → 蛇死亡 → 尸体掉落 → event 广播；存活真人 ≤1 → `over`
- [x] 3.3 5 分钟超时按总分结算；over 后房间销毁、连接状态复位（可再次 join）
- [x] 3.4 `test/net/run-all.js`：**联机自动回归总入口**（架构文档 §9.2）——一条命令跑齐 5 个场景：正常 4 人局 / 中途掉线判负局 / 超时 AI 补位局 / over 后再匹配局 / 畸形消息健壮性；固定种子确定性复现；全套 ≤ 60s
- 验收：`node test/smoke.js && node test/net/run-all.js` 全绿；手工双标签页验证"关一个标签，另一个看到对方尸体+结算"

## M4 流畅度

- [x] 4.1 `js/net/interpolation.js`：他人蛇 120ms 快照缓冲插值（已并入 RemoteMatch.renderSample）
- [x] 4.2 `js/net/prediction.js`：自己蛇本地即时模拟 + 软校正（10%/帧收敛无瞬移；80px 硬对齐自救；smooth.test 验证）
- [x] 4.3 事件驱动表现：消除/咬断/道具/播报改由服务器 `event` 触发粒子与音效（并入 M5，onlineMatch._onEvent 全量映射）
- [x] 4.4 快照优化：整型坐标 + 扁平数组 + 1字符颜色短码 + permessage-deflate，实测 ~20 KB/s（delta/二进制留作后续）
- 验收：人工 checklist（双标签 + `clumsy`/代理加 100ms 延迟与 5% 丢包）：移动平滑、转向无回弹、消除表现与判定一致

## M5 联机 UI

- [x] 5.1 主菜单加"在线对战"入口（与单机三模式并列）
- [x] 5.2 匹配中界面：排队位次、倒计时、可取消（state='matching' + drawMatching）
- [x] 5.3 对局内：真人玩家名牌、排行榜复用、彩色星等多人道具行为与本地一致（RemoteMatch 形状模仿 + 哑 spawner，renderer 零改动复用）
- [x] 5.4 结算页：复用手绘卡片，加"掉线判负"标题态与在线最佳持久化（crayon_snake_web_online_best）
- 自动化验收：`node test/net/ui.online.test.js` 31 断言全绿（Game+OnlineMatch+LocalTransport 无浏览器直驱全流程）
- 剩余人工验收：双标签页从主菜单到结算全流程走查无断点（需 `node server/index.js` 起服）

## M6 部署上云

- [x] 6.1 `scripts/server-init.sh`：Node 22 + Nginx + systemd 单元 + certbot（Ubuntu 24.04，架构文档 §8）
- [x] 6.2 Nginx 站点配置（随 6.1 生成）：`/` 静态 + `/ws` 反代（Upgrade 头、3600s 超时）
- [x] 6.3 客户端 ws 地址按 `location.host` 同域自适应（wsTransport 缺省 `/ws`；localStorage `crayon_snake_web_server` 可覆盖）；server/config 支持 PORT/HOST 环境变量
- [x] 6.4 `test/net/load.js`：N 客户端压测（`node test/net/load.js 100 10`）——100 端 25 房：快照 14.9/15 Hz、线上 ~18.6 KB/s/端、无饿死
- 附带修复：`Room.run()` 改累加器补帧（Windows 15.6ms 定时器粒度下 setInterval(33) 仅 ~21Hz，按真实流逝补步长，游戏时间=真实时间）
- 剩余人工验收：腾讯云真机双端对测 + 真机压测复核（2核2G 目标 ≥25 房/100 端）

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| `game.js` 多人分支与 multiplayer 耦合深，抽数据源时破坏单机 | M0 全程 smoke 看护；抽取只做"读路径"抽象，不改逻辑 |
| 快照全量 JSON 带宽超标 | M4.4 预留 delta+量化；协议字段已按量化设计，切换成本低 |
| AI 补位在服务器跑，smartness 逻辑依赖 elapsed | HeadlessGame 桩已含 `elapsed`；M1 测试覆盖 |
| 服务器某处漏用注入 `rng()`，自动测试结果不稳定 | M1.2 统一收口随机源；M1.4"同种子双跑一致"断言兜底，漏网之鱼会立刻暴露 |
| 国内节点备案卡住上线 | 首选香港节点（免备案）；域名备案并行推进不阻塞开发 |
