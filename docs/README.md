# 消食蛇 · 工程入口文档（AI Agent / WorkBuddy 必读）

> **这是本仓库的最高准则文档。** 任何 AI Agent（尤其是 WorkBuddy）开始任何工作前，
> 必须先读完本文件并无条件遵守第 1 节。本文件与其他文档冲突时，**以本文件为准**。
> 人类读者同样适用。

---

## 1. 最高标准：分支与发布规则（不可违反）

### 1.1 分支模型

```
feature/* ──┐
            ├──合入──> develop ──push 自动部署──> 测试环境 https://dev-snake.pippocao.top
本地直推 ───┘              │
                          └──PR（CI 全绿 + review）──> main ──手动触发──> 正式环境 https://snake.pippocao.top
```

| 分支 | 角色 | 允许的操作 |
|---|---|---|
| `develop` | 唯一开发集成分支 | 日常改动**直接 push**，或从 `feature/*` 分支合入 |
| `feature/*` | 可选：较大改动/多轮迭代的临时分支 | 从 develop 切出，完成后合回 develop，合完即删 |
| `main` | 与正式环境严格一致 | **只接受 develop 的 PR 合入**，禁止直接 push、禁止在其上开发 |

### 1.2 发布规则（合入 main 的完整动作，缺一不可）

每次 develop 合入 main 都是一个**阶段性版本**，必须按顺序完成：

1. **升版本号**：语义化版本 `vX.Y.Z`（主.次.修订）。版本号真源 = 根目录 `README.md` 第一行标题；
   在 README 顶部追加该版本的变更说明段（沿用既有格式：加粗版本号 + 条目化说明）。
2. **打 tag**：`git tag vX.Y.Z` 打在 main 的合并提交上，并 `git push origin vX.Y.Z`。tag 名与 README 版本号严格一致。
3. **正式发布**：GitHub Actions 手动触发 `official-deploy`（只能在 main 分支上触发，workflow 有分支硬校验）。
4. **刷新分享版**：运行 `node scripts/pack-share.js` 重新生成 `消食蛇-网页版-分享.html` / `deploy/index.html` / `.zip`
   （这三个是生成物，**禁止手改**，版本号自动取自 README 标题）。

> 修订号（Z）= bug 修复/小改动；次版本（Y）= 新功能/新模式；主版本（X）= 架构级变化。
> 联机对战（v3.0.0）即主版本示例。

### 1.3 发布前置条件

- CI 四闸（syntax / test / hygiene / deploy-lint）在 PR 上全绿——见 `deploy/03-review-and-branching.md`。
- 本地已跑通 `node test/smoke.js` 与 `cd server && npm test` 全绿。
- 测试环境（dev-snake）已实际试玩验证——本项目大量价值在手感，自动测试覆盖不了。

---

## 2. 其他工程原则

| # | 原则 | 说明 |
|---|---|---|
| P1 | **先文档后代码** | 架构/协议/规则级改动，先改 `docs/` 对应文档再动代码；文档与代码冲突以文档为讨论起点 |
| P2 | **测试先行** | 新增/修改行为必须带对应测试（`test/smoke.js` 或 `test/net/`）；发布前 CI 必须全绿 |
| P3 | **零依赖、零构建** | 前端纯原生 Canvas 2D + 原生 ES5 风格 JS，不引入框架/构建工具；服务端仅依赖 `ws` |
| P4 | **逻辑模块 DOM 无关** | `js/` 下逻辑模块不得出现 `document.` / `window.addEventListener`，必须能在 Node 中直接加载（冒烟测试与服务器复用的前提） |
| P5 | **调参只改 `js/config.js`** | 所有数值/文案参数集中在 config.js，不散落在逻辑里 |
| P6 | **服务器改动边界** | 部署机上只碰 `/opt/supersnake`、两个 systemd unit、`sites-available/supersnake`；绝不动 nginx 主配置/stream.d/default site/frps/docker（服务器同时承载家庭 relay） |
| P7 | **密钥不入仓** | 任何密钥/密码/私钥一律不进仓库与文档；服务器密码只当面索取，不写入任何文件 |
| P8 | **文档即契约** | 协议字段/代码标识符用英文，文档正文用中文；计划文档任务状态用 `[ ]`/`[x]` 维护 |

---

## 3. AI 助手工作规程（每次会话）

**开工前：**
1. 读本文档（你正在读）。
2. `git checkout develop && git pull`——所有工作从最新 develop 开始。
3. 按任务类型读对应文档（见第 4 节索引）。

**交付前：**
1. 本地跑 `node test/smoke.js` + `cd server && npm test`，全绿才算完。
2. 行为改动 → 补测试；架构/规则改动 → 先已更新文档。
3. push 到 develop（或 feature 合入 develop）。**除非用户明确要求，不要合 main、不要发布。**
4. 用户要求发布时，走 1.2 完整流程（升版本号 → 合 main → tag → 手动触发 official-deploy）。

---

## 4. 文档索引

```
docs/
  README.md                         ← 本文件（最高准则 + 索引）
  design/
    01-game-design.md               ← 游戏设计：四个模式的区别、完整游戏规则、数值真源
  architecture/
    01-online-multiplayer.md        ← 联机架构（同步模型 / 协议 / 模块拆分 / 部署）
  plan/
    01-online-mvp-plan.md           ← 联机功能任务拆分与里程碑（M0~M6）
  deploy/
    01-local-windows-guide.md       ← 本地部署与试玩教程（Windows）
    02-tencentcloud-hk-ci.md        ← GitHub CI → 腾讯云香港轻量（OIDC + TAT，三环境）
    03-review-and-branching.md      ← CI 检查项明细 + PR review 人工清单
```

**各类问题的真源：**
- 玩法数值/参数 → `js/config.js`（含逐条注释）
- 版本历史 → 根目录 `README.md`
- 联机协议字段 → `js/net/protocol.js` + `architecture/01-online-multiplayer.md`
- 部署链路/踩坑 → `deploy/02-tencentcloud-hk-ci.md`
