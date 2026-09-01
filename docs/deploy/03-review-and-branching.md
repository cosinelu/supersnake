# 03 · 分支模型与 Review 门禁

> 读者：执行本流程的 AI 助手或开发者。
> 目标：让「代码进入正式环境」这条路上有两道闸——**机器闸**（CI 自动检查，客观、不可绕过）
> 与**人工闸**（PR review 清单，针对机器查不出的设计问题）。
> 配套：`docs/deploy/02-tencentcloud-hk-ci.md`（部署链路）、`.github/workflows/*.yml`。

---

## 1. 分支模型

**两分支模型**（明确决策：不设 feature 分支）：

```
本地开发 ──直推──> develop ──push 钩子自动部署──> 测试环境 https://dev-snake.pippocao.top
                     │
                     └──PR（CI 绿 + 人工 review）──> main ──手动按钮──> 正式环境 https://snake.pippocao.top
```

| 分支 | 角色 | 进入方式 | 部署 |
|---|---|---|---|
| `develop` | 日常开发分支，随时可能不稳 | **直接 push**（无需 PR） | push 后**自动**部署测试环境（8091） |
| `main` | 与正式环境一致 | **PR 合入**（CI 绿 + 人工 review） | **手动** Run workflow 部署正式环境（8090） |

**为什么不要 feature 分支**：单人项目，开 feature 分支再 PR 到 develop 只是给自己
加仪式感——develop 本身就是「随时可能不稳」的集成分支，测试环境挂了也不影响正式。
真正需要门禁的位置只有一处：**develop → main**。把闸门集中在这一处，
既不牺牲安全，也不制造无意义流程。

需要多人协作或做长周期大改造时，再按需临时开 feature 分支即可，CI 无需改动
（`pr-review.yml` 对所有 PR 与 push 都生效）。

**当前状态：`develop` 与 `main` 均已就绪**，两个部署 workflow 已配好并指向对应域名。

### 单人项目为什么 develop → main 还要走 PR

不是为了「让别人审」，而是为了三件事：
①**留下变更叙事**（几个月后回看，PR 描述比 commit message 完整）；
②**给 CI 一个拦截点**（PR 上 CI 红了就合不进去，比推完再发现问题便宜）；
③**diff 集中审视**——写的时候是逐文件的，审的时候是整体的，视角不同，能捞出不同的问题。

而 develop 不走 PR，是因为它的错误成本极低（测试环境坏了就坏了），
而流程摩擦成本每天都在付。

---

## 2. 机器闸：CI 检查项

新增 `.github/workflows/pr-review.yml`，在 PR（目标 `develop` 或 `main`）与 push 时运行。
四个 job **并行**，任一红即阻断合入。

| Job | 检查内容 | 失败意味着 |
|---|---|---|
| `syntax` | `node --check` 全部 `js/**/*.js` + `server/*.js` + `test/**/*.js` | 有语法错误 |
| `test` | `node test/smoke.js` + `cd server && npm ci && npm test` | 逻辑回归 |
| `hygiene` | 见下方「工程卫生检查」 | 项目约定被破坏 |
| `deploy-lint` | 部署脚本 `bash -n` 语法 + workflow YAML 可解析 | 部署链路会在运行时炸 |

### 工程卫生检查（scripts/check-hygiene.sh）

这几条都是从本项目**真实约定**推导出来的，不是通用模板：

| 检查项 | 为什么（依据项目现实） |
|---|---|
| `index.html` 每个 `<script src>` 都带 `?v=` 版本号 | README v2.8.1 明确记录：不带版本号会导致浏览器加载旧缓存，「改动后看不到新内容」——这是踩过的坑 |
| `index.html` 里所有 `?v=` 值一致 | 版本号不统一 = 部分文件走缓存部分不走，最难查的一类 bug |
| `js/` 下每个 `.js` 要么被 `index.html` 引用，要么被 `test/` 引用 | 防止新增模块忘记挂进依赖链（当前 `js/net/localTransport.js`、`js/net/headlessGame.js` 为测试专用，属正常情况，脚本按此白名单放行） |
| 逻辑模块不出现 `document.` / `window.addEventListener` | README 承诺「逻辑模块不依赖 DOM，可在 node 中直接加载」——这是 smoke 测试与联机 headless 回放成立的前提，破了它测试直接跑不起来 |
| `server/` 与 `js/` 不出现硬编码 IP `43.161.196.218` | 服务器地址只应出现在 workflow 与文档，代码里硬编码会让本地/测试/正式串台 |
| 不出现疑似密钥字面量（`caoyu@`、`-----BEGIN.*PRIVATE KEY`、`SecretKey.*=.*['"]`） | 本方案全程零长期密钥，任何密钥字面量入仓都是事故 |

> 检查脚本只用 grep/bash，无新增依赖——与项目「零依赖」气质一致。

---

## 3. 人工闸：PR Review 清单

机器查不出的，靠这份清单。放进 `.github/pull_request_template.md`，PR 自动带出。

### 通用（每个 PR 都过）

- [ ] PR 描述说清了**为什么**改，不只是改了什么
- [ ] 改动范围与 PR 标题一致（没有夹带无关重构）
- [ ] 新增/修改了行为 → 有对应测试；`test/smoke.js` 断言数有增加
- [ ] 文档同步：玩法/数值改动 → 根 `README.md`；架构改动 → `docs/architecture/`
- [ ] 调参类改动只落在 `js/config.js`（README「怎么调参」约定）

### 玩法逻辑改动（涉及 `snake.js` / `multiplayer.js` / `game.js` / `config.js`）

- [ ] **确定性未被破坏**：没有引入 `Math.random()` 到需要可复现的路径（应走 `utils.js` 的 `hash2`）——否则联机预测/回放会漂移
- [ ] **尾巴节规则**未被违反：不参与消除、不被咬断、不占保底计数
- [ ] **消除保底**逻辑仍成立（颜色节保底 3）
- [ ] 单人与多人共用路径的改动，两边都验过（多人模式历史上有过「特殊道具被当普通色块」这类漏改）

### 联机改动（涉及 `js/net/` / `server/`）

- [ ] 协议字段变更 → 先改 `docs/architecture/01-online-multiplayer.md`（项目硬约定：先文档后代码）
- [ ] 协议改动**前后端同步**，且考虑了旧客户端连新服务端的行为
- [ ] 服务端权威性未被削弱（客户端只发输入，不发状态）
- [ ] `test/net/` 相关测试有覆盖；必要时跑 `test/net/load.js` 看压测无退化

### 部署/CI 改动（涉及 `.github/` / `scripts/`）

- [ ] 没有把密钥/密码写进仓库
- [ ] `oidc:sub` 条件仍限定到具体仓库+分支（漏配等于对全 GitHub 开放角色）
- [ ] 部署脚本改动后，先在 `develop`/测试环境验证过，再动 official

---

## 4. 三道闸的关系

```
本地写码
  │
  ├─ 直接 push develop（无 PR 门禁——错误成本低，流程摩擦成本高）
  │     └─ push 触发 CI：syntax/test/hygiene/deploy-lint 跑一遍
  │
  ├─ 自动部署测试环境 https://dev-snake.pippocao.top
  │     └─ CI 自动验收：页面内容 + wss 握手 101
  │
  ├─ 真机试玩（机器与人都替代不了的一步）
  │
  ├─ 机器闸：develop → main 的 PR 上跑 CI（四个 job，红则合不进）
  │
  ├─ 人工闸：按第 3 节清单审 diff
  │
  └─ 手动按钮 → 正式环境 https://snake.pippocao.top
        └─ CI 自动验收：页面内容 + wss 握手 101
```

关键设计：**测试环境试玩是不可跳过的一环**。这个项目大量价值在「手感」上——转向是否跟手、消除特效是否明显、AI 是否够聪明——这些没有任何自动测试能覆盖，只能真机玩。CI 的作用是保证「不会因为低级错误浪费你试玩的时间」。

另一个设计取舍：**门禁强度与错误成本匹配**。develop 无 PR 门禁但有 CI；
main 有 PR + CI + 人工 review + 手动触发四重。把严格度放在真正要紧的地方。

---

## 5. 落地步骤（按顺序）

- [x] 1. 建 `develop` 分支：`git checkout -b develop && git push -u origin develop`
- [x] 2. 推送新增文件（workflows / scripts / docs）到 `develop`
- [x] 3. `pr-review.yml` 四个 job 实测全绿
- [ ] 4. GitHub 仓库 Settings → Branches → 给 **`main`** 加保护规则：
      - Require a pull request before merging
      - Require status checks to pass：勾选 `syntax` / `test` / `hygiene` / `deploy-lint`
      - （单人项目不勾 Require approvals，避免自己批不了自己的 PR）
      - **`develop` 不加 PR 保护**（按两分支模型，允许直推）；可选只勾 status checks
- [ ] 5. 开一个测试 PR（develop → main）验证四个 check 都跑起来且能拦住故意引入的错误

> 第 4 步**需要仓库 admin 权限**，当前 gh token `permissions.admin = false`
> （API 返回 404 而非 403——GitHub 惯例用 404 防资源探测），只能手动在网页配置。

---

## 6. 已知限制

| 项 | 说明 |
|---|---|
| 无 lint/格式化 | 项目零依赖零构建，引入 ESLint 要加 devDependencies，与项目气质冲突；暂以 `node --check` + 人工把关代替 |
| hygiene 检查是 grep 级别 | 只能抓明显违规，不做 AST 分析；误报时在脚本里加白名单并注明理由 |
| 单人项目 review 是自审 | 主要价值在「换视角重看 diff」与「留变更叙事」，不指望抓出所有问题 |
| 手感回归无自动化 | 依赖测试环境人工试玩；将来可考虑录制输入序列做回放比对（见 `test/net/repro.dual.js` 思路） |
