# v3.1 UDP 传输层重构 · 开发计划

> 对应设计：`docs/architecture/02-udp-transport.md`（下称"UDP 架构文档"）
> 原则：**每个阶段结束都是一个可运行、可发布、可回滚的状态**；
> 单机三模式与现有联机全程不许被改坏（`node test/smoke.js` + `server npm test` 必须全绿）。

## 阶段总览

| 阶段 | 目标 | 传输层 | 可独立验证 |
|---|---|---|---|
| **1a** | 二进制编码 + 下行瘦身 | 仍走 TCP | ✅ 体积/精度可直接量化 |
| **1b** | UDP 传输层 + 冗余打散 + 降级 | UDP + TCP 保底 | ✅ 弱网工具对比 |
| **1c** | 微信小游戏 UDP 适配 | 复用 1b 协议层 | ✅ 真机 |
| **2** | 预表现与插值增强 | 不涉及 | 以后再说 |

**为什么 1a 必须独立**：实测现状快照 19662 字节会被切成 14 个 IP 分片，
任一片丢失则整包在内核报废（丢 2% 放大成报废 24.6%）。
**不瘦身则 UDP 比 TCP 还差** —— 1a 是 1b 的硬前提，且它自己就能改善 TCP 下的表现。

---

## 阶段 1a：二进制编码与下行瘦身（仍走 TCP）

目标：单帧从 19662 字节压到 632 字节，压进单个 datagram 预算。

### 任务

- [ ] **1a.1** `js/net/binCodec.js` 新建：二进制读写器
  - `BinWriter` / `BinReader`：uint8/uint16LE/int8 读写，基于 `Uint8Array`（浏览器与 node 通用）
  - 量化辅助：`qAngle8` / `dqAngle8`（2π/256）、`qAngle16` / `dqAngle16`、`qCoord16`
  - CRC16 实现（表驱动）
  - **约束**：不依赖 `Buffer`（小游戏无此对象），统一用 `Uint8Array` + `DataView`

- [ ] **1a.2** `js/net/protocol.js` 扩展：二进制 snap 编解码
  - `encSnapBin(tick, ack, snakes, blockDelta)` → `Uint8Array`
  - `decSnapBin(u8)` → 与现有 `decode()` **同构的对象**（关键：上层零改动）
  - 单蛇结构按架构文档 §2.2：`id`1 + `flags`1 + `x`2 + `y`2 + `angle`1 + `segCount`1 + `segAngles`N
  - 节心用**方向角**编码，解码端用 `SEG_SPACING` 重建坐标
  - `lite` 档：`flags` bit2 置位，`segCount = 0`

- [ ] **1a.3** 低频通道拆分
  - `server/room.js`：昵称/计分/排行榜从每帧 snap 移出，改 1Hz 单独消息 `meta`
  - 客户端 `netMatch.js` 维护一份 meta 缓存，HUD 与排行榜读它
  - **注意**：`nm` 移出后，`matched` 消息里已有名单，进房即可建立映射

- [ ] **1a.4** 色块增量同步
  - `server/room.js`：维护 `blockVersion`，每帧算出 `add[] / del[]`
  - **1Hz 全量校正**走 TCP（架构文档决策 B）
  - 客户端：增量应用 + 收到全量时整体替换
  - **风险点**：漏收增量会永久偏差 → 1Hz 全量兜底，且全量走 TCP 保证不丢

- [ ] **1a.5** 三档 LOD 视野裁剪
  - 服务器按每个玩家的相机位置分别组包（视口 1.4 倍范围）
  - 本机玩家自己的蛇永远完整档
  - **硬约束兜底**：预估 > 1400 字节时把最远的蛇降级为 lite，直到满足；触发时打点

- [ ] **1a.6** `SNAP_EVERY` 改为 1（30Hz），客户端插值缓冲改自适应
  - `bufferMs = snapIntervalMs × 1.8`
  - 服务器在 `matched` 里下发 `snapIntervalMs`，客户端不硬编码

- [ ] **1a.7** 测试 `test/net/codec.test.js`
  - 编解码往返一致（随机 200 条蛇 × 随机长度）
  - **精度断言**：节心重建误差 ≤ 4px（实测最大 3.68px），坐标 ≤ 1px，角度 ≤ 1.5°
  - **体积断言**：18 蛇 × 25 节 + 色块增量 ≤ 700 字节
  - **硬约束断言**：任意构造下组包结果 ≤ 1400 字节（含 100 节长蛇 × 18 条）
  - 色块增量：随机增删 1000 轮后与全量一致

### 验收

- 全套测试绿（含新增 codec.test.js）
- 实测体积：后期最坏 ≤ 700 字节
- develop 部署后真机对战，观感不劣于现在
- **回滚点**：二进制编码通过配置开关 `USE_BIN_CODEC` 控制，出问题一键切回 JSON

---

## 阶段 1b：UDP 传输层（核心）

目标：上下行切 UDP，冗余打散，TCP 保底全程可用。

### 任务

- [ ] **1b.1** 服务器 UDP 端点 `server/udp.js`
  - `dgram` 监听独立端口（不与 ws 端口冲突）
  - 会话表：`token → { connId, roomId, addr, port, lastSeen }`
  - **地址跟随**：收到合法 token 的包时更新 `addr/port`（应对 NAT 重绑定 / 4G↔WiFi 切换）
  - 三道校验：`magic` → `token` → `crc16` + 语义（架构文档 §3.5）
  - 每源限速（防垃圾流量灌入）

- [ ] **1b.2** 上行 Fragment 协议
  - 12 字节：`magic`1 + `token`4 + `frameId`2 + `angle`2 + `flags`1 + `crc16`2
  - 服务器去重规则**沿用现有 `room.js:113-122` 语义**（含「大幅回退＝重新计数」这条）
  - 一个 tick 内收到多个 Fragment：按 frameId 升序消化，只保留最新的生效

- [ ] **1b.3** 客户端 UDP 传输层 `js/net/udpTransport.js`
  - 实现与 `WsTransport` 相同的接口（`TransportBase` 契约），上层零改动
  - **冗余打散**：`UDP_DUP` 份，偏移 `frameIntervalMs / UDP_DUP × i`
    （3 份 → 0/11/22ms）。**份数可配，偏移由公式推导**
  - 下行去重：`frameId <= lastRecvFrameId` 直接丢弃

- [ ] **1b.4** 握手与降级
  - TCP `matched` 下发 `{ udpPort, sessionToken }`
  - 客户端 UDP 打洞：发 `hello(token)` → 等 `hello_ack`
  - **1.5s 无 ack → 判定 UDP 不可用，全程 TCP**
  - **对局中连续 500ms 无 UDP 下行 → 回落 TCP，后台继续重试**
  - TCP 连接全程不断开

- [ ] **1b.5** NAT 保活
  - 死亡/观战状态下 5 秒一次空 keepalive

- [ ] **1b.6** 服务器与运维
  - `sysctl net.core.rmem_max` 调大（当前 212992 是默认值）
  - ufw 放行 UDP 端口
  - **云轻量控制台防火墙需手动放行**（SSH 改不了，这一步必须人工）
  - systemd unit 无需改动（同进程内监听）

- [ ] **1b.7** 测试
  - `test/net/udp.test.js`：Fragment 编解码、CRC 校验、frameId 去重（含大幅回退重置）、
    地址跟随、限速、握手与降级状态机
  - `test/net/loss.sim.js`：丢包模拟器，对比 x1 / x3同时 / x3打散 在三种丢包形态下的
    「未收到新指令帧占比」。**断言打散优于同时发**

### 验收

- 全套测试绿
- 端到端：真 UDP 客户端连测试环境跑完一局
- **弱网验证**：用 `tc netem` 在服务器侧注入丢包/延迟，对比 TCP 与 UDP 表现
- **降级验证**：手动封 UDP 端口，确认自动回落 TCP 且游戏可继续
- **回滚点**：`UDP_ENABLED` 配置开关，关掉即回到纯 TCP（= 1a 的状态）

---

## 阶段 1c：微信小游戏 UDP 适配

- [ ] **1c.1** `js/net/wxUdpTransport.js`：`wx.createUDPSocket` 封装，复用 1b 的协议层
- [ ] **1c.2** 运行时能力探测：`wx` 存在 → WxUdp，`WebTransport` 可用 → WT，否则 WS
- [ ] **1c.3** **上线前必须实测**：小程序后台能否配置 UDP 域名
  > 微信多处旧文档仍写「UDP 只允许同局域网」，那是 ≤2.9.3 的表述，
  > 与 `UDPSocket.send` API 页原文（2.9.4+ 可连任意 IP/域名）矛盾。**以实测为准。**

---

## 阶段 2：预表现与插值增强（以后再说）

- 移动预测增强
- 插值曲线优化
- **不做**：消除/死亡/自碰的本地预判 —— 这类判定会引发连锁后果（颜色序列变化 → 触发消除），
  预测错了无法优雅回滚，比延迟更难看。维持「只由服务器 event 触发表现」的原则。

---

## 风险与应对

| 风险 | 应对 |
|---|---|
| 二进制编解码 bug 导致对局异常 | `USE_BIN_CODEC` 开关一键回退 JSON；codec 往返测试覆盖随机输入 |
| 色块增量漂移 | 1Hz 全量校正走 TCP 兜底 |
| 超长蛇撑爆单包 | 组包硬约束：>1400 字节自动降级远处蛇为 lite；测试断言覆盖 100 节 × 18 条 |
| UDP 被运营商/防火墙阻断 | 握手 1.5s 超时 + 对局中 500ms 无下行自动回落 TCP |
| NAT 映射失效 | 5s keepalive + 服务器地址跟随 |
| 云控制台未放行 UDP 端口 | 部署清单显式列出该人工步骤（SSH 改不了这一层） |
| 小游戏 UDP 实际不可用 | 1c 独立阶段，失败不影响 1a/1b 已上线的收益 |

## 不做的事

- **不做 KCP / 可靠 UDP**：上下行都幂等，重传是纯浪费
- **不做 gzip**：实测二进制 31x 远优于 gzip 4.4x，且 gzip 要吃 142% 单核
- **不做 HMAC / 加密**：判定权全在服务器，伪造上行只能让自己的蛇转向，攻击面近乎为零
- **不改判定归属**：客户端仍不做任何判定、不上报任何判定结果
