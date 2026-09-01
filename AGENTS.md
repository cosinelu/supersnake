# AGENTS.md — AI 代理工作准则（最高优先级）

> 本文件是给 AI 编程助手（WorkBuddy / Cursor / Copilot 等）的强制工作准则。
> 开始本仓库的任何任务前必须读完本文件与 `docs/README.md`；冲突时以 `docs/README.md` 为准。

## 最高标准：分支与发布

1. **只在 `develop` 上开发**：日常改动直接 push develop；较大改动开 `feature/*` 从 develop 切出、合回 develop。
2. **绝不直接在 `main` 上提交**。main 只接受 develop 的 PR 合入。
3. **合入 main = 阶段性版本**，缺一不可：升版本号（根 `README.md` 第一行标题为版本真源）→ 合 main → 打同名 tag（`vX.Y.Z`）→ 手动触发 `official-deploy`。
4. **除非用户明确要求，不要合 main、不要发布。**

## 工程红线

- 交付前必须本地全绿：`node test/smoke.js` + `cd server && npm test`。
- 新行为必须带测试；架构/协议/规则改动**先改 `docs/` 再动代码**。
- 零依赖零构建：不引入前端框架/构建工具；逻辑模块 DOM 无关（不得出现 `document.`）。
- 调参只改 `js/config.js`。
- 部署机改动边界：只碰 `/opt/supersnake`、两个 systemd unit、`sites-available/supersnake`；nginx 主配置/stream.d/frps/docker 一律不动。
- 密钥/密码绝不写入任何文件。

## 文档索引

- 最高准则与完整索引：`docs/README.md`
- 游戏规则与模式区别：`docs/design/01-game-design.md`
- 联机架构与协议：`docs/architecture/01-online-multiplayer.md`
- CI/部署：`docs/deploy/02-tencentcloud-hk-ci.md`、`03-review-and-branching.md`
