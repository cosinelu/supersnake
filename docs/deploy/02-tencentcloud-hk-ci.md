# 02 · GitHub CI 部署到腾讯云香港轻量服务器（OIDC + TAT）

> 读者：执行本方案的 AI 助手或开发者。
> 目标：建立三环境体系——本地直玩（现状）/ develop CI → 测试进程 / official CI → 正式进程。
> 核心原则：**零长期密钥**（GitHub 侧无 Secret 私钥，服务器侧无 COS/云 API 密钥）、**零入站依赖**（部署不经 SSH）。
> 前置事实（已核对代码）：
> - `server/config.js` 的 `PORT`/`HOST` 走环境变量 → 双进程零改动；
> - `js/net/wsTransport.js` 前端 ws 地址 = `location.host + /ws` → 双端口天然隔离，无需 Nginx。

---

## 1. 架构总览

| | 本地（不变） | 测试环境 | 正式环境 |
|---|---|---|---|
| 代码 | 工作区 | `/opt/supersnake/dev`（develop 分支） | `/opt/supersnake/official`（main 分支） |
| systemd unit | — | `supersnake-dev.service` | `supersnake-official.service` |
| 监听 | `127.0.0.1:8090` | `0.0.0.0:8091` | `0.0.0.0:8090` |
| 访问 | 浏览器 `127.0.0.1:8090` | `http://43.161.196.218:8091/` | `http://43.161.196.218:8090/` |
| 部署方式 | 手动 | push develop 自动 | GitHub 页面手动 Run workflow |

服务器：腾讯云轻量应用服务器（香港 `ap-hongkong`，免备案），实例 ID 形如 `lhins-xxxx`。

### CI 部署链路（develop / official 两条，结构相同）

```
触发（push develop / 手动 official）
  → runner 跑全量测试（smoke + server npm test，不绿即中止）
  → OIDC：GitHub 签发短命 JWT，向腾讯云 STS 换 1 小时临时凭证
  → tccli tat InvokeCommand：把 scripts/deploy-remote.sh（占位符已替换）下发到实例
  → 实例上的 tat_agent 执行：git fetch/reset → npm ci → systemctl restart
  → runner 轮询执行结果 + curl 公网地址做端到端验收
```

### 设计决策记录

| 决策 | 理由 |
|---|---|
| OIDC + TAT 而非 SSH 推模式 | 零长期密钥（GitHub 无 Secret 私钥可泄露）、22 端口无需对 CI 开放、控制台有审计记录 |
| 香港机房 → 无 COS 中转 | 与国内机房方案不同，香港机 `git pull` 直连 GitHub 畅通，砍掉打包上传环节 |
| 双端口直跑，不用 Nginx | 前端 ws 已自适应端口；单依赖零构建项目，裸跑最透明；要 HTTPS/域名时再加反代 |
| 单 CAM 角色信任两个分支 | dev/official 同机同权，分角色收益低；official 的发布门槛由 workflow_dispatch（手动按钮）承担。将来多机器/多项目时再拆 |
| 服务器用 HTTPS 匿名 clone，**不放 deploy key** | 实测仓库为**公开**（`git ls-remote https://…` 匿名成功），无需任何凭证 → 少一处密钥面。若将来改私有，再恢复只读 deploy key 方案（见 §2.A 注） |
| official CI 仅手动触发 | 正式环境节奏完全可控，误推 main 不会直接上生产 |

---

## 2. 一次性配置（按顺序执行）

> **§2.A 已于 2026-09-01 实测执行完毕**，下方保留步骤供重建/排障参考。
> 服务器实况见 §2.0。

### 2.0 服务器实况（2026-09-01 实测，重要）

这台机器**不是 supersnake 专用**，上面已有在役业务，任何改动都要避开：

| 在役服务 | 占用端口 | 说明 |
|---|---|---|
| nginx | 80、8527、8528、8529 | ufw 注释为 `home relay` |
| frps | 7000、18527-18529 | 内网穿透服务端，**非 systemd 托管**（`systemctl is-active frps` 显示 inactive 但进程在跑） |
| docker + containerd | — | 有容器在跑 |
| fail2ban | — | 会自动封暴力破解 IP |
| tat_agent | — | **active**，TAT 部署方案前提已满足 |

环境事实：Ubuntu 24.04.4 LTS / 4 核 3.6G / 51G 可用 / 免密 sudo 可用 /
git 2.43.0 预装、**Node 需自行安装**（已装 v22.23.2 + npm 10.9.8）。
服务器 → GitHub 连通良好（api.github.com HTTPS 114ms，ssh:22 亦可达），香港机房无跨境问题。

**本项目的改动边界（严格遵守）**：只新增 Node、`/opt/supersnake`、
两个 systemd unit、两条 ufw 规则。**不碰** nginx / frps / docker 的任何配置。

### A. 服务器初始化（以 ubuntu 用户 SSH 登录执行一次）

前提：本地已推好 `develop` 分支（`git push origin develop`）。

```bash
scp scripts/server-init.sh ubuntu@43.161.196.218:/tmp/
ssh ubuntu@43.161.196.218 'bash /tmp/server-init.sh'
```

脚本做的事（内容见 `scripts/server-init.sh`，幂等可重跑）：
1. **端口占用前置校验**——8090/8091 若被非本项目进程占用则直接中止，保护在役服务；
2. 检查/安装 Node 22（NodeSource apt 源，香港机直连）；
3. `git clone` 双环境目录（**HTTPS 匿名，公开仓库无需凭证**）并各自 checkout main / develop；
4. 双环境 `server/` 下 `npm ci --omit=dev`；
5. 写入两个 systemd unit（含 `NoNewPrivileges` / `ProtectSystem=full` 等轻度沙箱，
   因为本机还跑着其他业务）并 `enable --now`；
6. 本机 curl 自检两个端口，失败时自动打印 journalctl 日志。

> **仓库若改为私有**：需恢复 deploy key 方案——`ssh-keygen -t ed25519` 生成密钥、
> 公钥加到 GitHub Settings → Deploy keys（**不勾 Allow write access**）、
> `REPO` 改回 `git@github.com:` 形式并设置 `GIT_SSH_COMMAND`。

> 密码只在首次建立 SSH 免密时人工使用，不写入任何文件/CI/文档。
> 免密建立后（公钥已装入 `~/.ssh/authorized_keys`）全程走密钥，不再需要密码。

### B. 防火墙放行端口（**两层，都要放行**）

这是最容易踩的坑：**轻量应用服务器有两层防火墙，缺一层就不通**。

**第 1 层：服务器内的 ufw**（可由脚本/SSH 完成）

```bash
sudo ufw allow 8090/tcp comment 'supersnake official'
sudo ufw allow 8091/tcp comment 'supersnake dev'
```

ufw 是白名单叠加，只增不改，不影响既有的 22 / 443 / 8527:8529 / 7000 规则。

**第 2 层：腾讯云轻量控制台「防火墙」页**（**只能在控制台手动操作**）

轻量应用服务器实例 → 防火墙（注意不是 CVM 安全组）。放行：

| 端口 | 协议 | 用途 |
|---|---|---|
| 8090 | TCP | 正式进程（页面 + ws） |
| 8091 | TCP | 测试进程（页面 + ws） |

**排障判据**（2026-09-01 实测踩过，记下来省时间）：

| 现象 | 结论 |
|---|---|
| 服务器 `curl 127.0.0.1:8090` → 200，但 `curl 43.161.196.218:8090` → 失败 | 云控制台防火墙未放行（ufw 已放行时） |
| `sudo iptables -L ufw-user-input -n \| grep 8090` 有 ACCEPT | ufw 这层没问题，问题在云控制台层 |
| 对照：`8527` 公网通而 `8090` 不通 | 证明网络链路本身正常，纯粹是该端口未在控制台放行 |

> **另一个干扰源**：若你在公司内网机器上测试，本地 IT 代理（`http_proxy`）
> 可能返回 **502 Bad Gateway**（响应体带「8000助手」字样）而非超时。
> 这是**代理拒绝转发境外 IP**，不是服务器故障。判断方法：改用
> 「SSH 到服务器再 curl 自己的公网 IP」作为权威判据，可完全绕开本地代理。

### C. 腾讯云 CAM 配置 OIDC 角色

1. **建 OIDC 身份提供商**（控制台 → 访问管理 → 身份提供商 → 角色SSO → 新建，类型 OIDC）：
   - 名称：`github`
   - 提供商 URL：`https://token.actions.githubusercontent.com`
   - 客户端 ID：`sts.tencentcloudapi.com`
   - 签名公钥：访问 `https://token.actions.githubusercontent.com/.well-known/jwks`，把返回的 JWKS JSON 全文粘贴进去
2. **建角色** `github-supersnake-deploy`（载体 = 身份提供商 github），信任策略：

```json
{
  "version": "2.0",
  "statement": [{
    "effect": "allow",
    "action": ["sts:AssumeRoleWithWebIdentity"],
    "principal": { "federated": ["qcs::cam::uin/<你的UIN>:oidc-provider/github"] },
    "condition": {
      "string_equal": {
        "oidc:aud": "sts.tencentcloudapi.com",
        "oidc:sub": [
          "repo:cosinelu/supersnake:ref:refs/heads/develop",
          "repo:cosinelu/supersnake:ref:refs/heads/main"
        ]
      }
    }
  }]
}
```

> ⚠️ **`oidc:sub` 是安全命门，漏配等于向全 GitHub 开放该角色。** 两行 sub 分别对应 develop CI 与 official CI（official 手动触发时 JWT 的 sub 也是 `ref:refs/heads/main`）。

3. **建自定义策略** `TatInvokeSupersnake` 并绑定到该角色：

```json
{
  "version": "2.0",
  "statement": [{
    "effect": "allow",
    "action": ["tat:InvokeCommand", "tat:DescribeInvocations", "tat:DescribeInvocationTasks"],
    "resource": "*"
  }]
}
```

> 说明：TAT 的资源级授权粒度较粗，`*` 意味着这把 1 小时临时凭证可在同账号同地域实例上执行命令。个人账号可接受；将来多实例时改用 `qcs::tat:...:instance/<id>` 细化。

4. 记下**角色 ARN**：`qcs::cam::uin/<你的UIN>:roleName/github-supersnake-deploy`。

### D. GitHub 仓库配置

Settings → Secrets and variables → Actions → **Variables**（不是 Secrets，本方案零 Secret）：

| 变量名 | 值 |
|---|---|
| `TENCENT_ROLE_ARN` | 上一步的角色 ARN |
| `TAT_INSTANCE_ID` | 实例 ID，如 `lhins-xxxxxxxx` |

> 实例 ID 在轻量服务器控制台实例详情页可见。

---

## 3. 仓库内新增文件

| 文件 | 作用 |
|---|---|
| `.github/workflows/develop-deploy.yml` | push develop → 测试全绿 → 部署 8091 |
| `.github/workflows/official-deploy.yml` | 手动 Run workflow（main）→ 测试全绿 → 部署 8090 |
| `scripts/deploy-remote.sh` | 在服务器上执行的部署脚本（`__ENV__/__BRANCH__/__REF__` 占位符由 CI 替换） |
| `scripts/ci-deploy.sh` | 在 runner 上执行：替换占位符 → TAT 下发 → 轮询结果 → curl 公网验收 |
| `scripts/server-init.sh` | 服务器一次性初始化 |

两条 workflow 除触发条件与 `ENV/BRANCH/PORT` 三个变量外完全一致，共用 `ci-deploy.sh`。
均设置 `concurrency`（同环境串行，不并发部署）与 `permissions: id-token: write`（OIDC 必需）。

### deploy-remote.sh 关键行为

```bash
git fetch origin <branch> && git reset --hard <ref>   # ref = 触发 CI 的精确 commit
cd server && npm ci --omit=dev                        # 依赖与 lockfile 严格一致
sudo systemctl restart supersnake-<env>
systemctl is-active ... && curl 127.0.0.1:<port>/     # 服务器本机自检
```

`git reset --hard <ref>` 而非 `git pull`：保证部署的就是 CI 测试过的那个 commit，不会混入测试后新推的提交。

---

## 4. 验收清单（首次联调逐项确认）

进度标记：`[x]` 已实测通过（2026-09-01） / `[ ]` 待办

- [x] `server-init.sh` 跑通（Node v22.23.2，official=main / dev=develop 双 checkout）
- [x] 仓库为公开仓库，**无需 deploy key**（已从方案中移除）
- [x] `systemctl is-active supersnake-official supersnake-dev` 均 active
- [x] 服务器本机 `curl 127.0.0.1:8090 / :8091` 均 HTTP 200
- [x] 在役服务未受影响（nginx / frps / docker / fail2ban / tat_agent 全部照旧，80、8527-8529、7000 未被占用）
- [x] ufw 已放行 8090/8091（既有 4 组规则未改动）
- [ ] **腾讯云轻量控制台防火墙放行 8090/8091**（只能手动，当前卡在这里）
- [ ] 浏览器开 `http://43.161.196.218:8090/` 与 `:8091/` 均见主菜单
- [ ] 两个环境各双开标签页进「在线对战」，能匹配进同一对局
- [ ] `gh auth login` 完成，`TENCENT_ROLE_ARN` / `TAT_INSTANCE_ID` 两个 Variables 已填
- [ ] CAM 角色（OIDC 身份提供商 + 信任策略 + TAT 策略）配置完成
- [ ] push 一个 develop 提交 → Actions 全绿 → `:8091` 页面出现新改动
- [ ] 手动 Run official workflow → Actions 全绿 → `:8090` 页面出现新改动
- [ ] 首次运行若 `ci-deploy.sh` 中 tccli 参数报错（如 `DescribeInvocationTasks` 的参数名），按报错提示修正后重跑——TAT CLI 参数以 `tccli tat DescribeInvocationTasks help` 输出为准

---

## 5. 已知限制与 TODO

| 项 | 现状 | 计划 |
|---|---|---|
| 部署重启杀在线玩家 | 「掉线判负」规则下，restart 瞬间在线玩家被判负 | TODO：server 增加 drain 接口（停止接新匹配，房间清零或超时后重启），official 部署脚本接入 |
| SSH 密码登录 | 已建立密钥免密登录（`id_ed25519`）；密码认证仍开放，且密码曾出现在聊天记录中 | **建议尽快** `PasswordAuthentication no`——免密已通，CI 也不依赖 SSH，关闭无影响。另建议改掉该密码 |
| 无 HTTPS/域名 | 裸 IP + 端口访问 | 见下方「微信小游戏 phase2」——届时必须补 |
| **微信小游戏 phase2** | ufw 里已预留 `443/tcp # wechat game (phase2)`，但当前无域名无证书 | 微信小游戏**强制 wss**，不接受裸 http/ws。届时需：域名 + 证书 + nginx 443 反代到 8090。`wsTransport.js` 已支持 `wss://` 自适应（`location.protocol === 'https:'` 分支），**前端零改动** |
| nginx 反代未启用 | 本机 nginx 已在役（服务 8527-8529），但 supersnake 走直连 8090/8091 | 当前直连便于定位问题；接入 443 时再加 server 段。**改动在役 nginx 配置前需明确确认** |
| 版本可见性 | 验收靠肉眼比对页面改动 | TODO：server 增加 `/version` 端点返回 git SHA，CI 验收直接比对（也能让 `ci-deploy.sh` 的验收从「HTTP 200」升级为「SHA 匹配」） |
| tccli 细节 | `DescribeInvocationTasks` 参数名以首联实测为准 | 已在验收清单中标注 |
| frps 非 systemd 托管 | `systemctl is-active frps` = inactive 但 7000 端口有 frps 进程 | 与本项目无关，仅记录以免日后误判「服务挂了」 |
