# 02 · GitHub CI 部署到腾讯云香港轻量服务器（OIDC + TAT）

> 读者：执行本方案的 AI 助手或开发者。
> 目标：建立三环境体系——本地直玩（现状）/ develop CI → 测试进程 / official CI → 正式进程。
> 核心原则：**零长期密钥**（GitHub 侧无 Secret 私钥，服务器侧无 COS/云 API 密钥）、**零入站依赖**（部署不经 SSH）。
> 前置事实（已核对代码）：
> - `server/config.js` 的 `PORT`/`HOST` 走环境变量 → 双进程零改动；
> - `js/net/wsTransport.js` 前端 ws 地址 = `location.host + /ws` → 双端口天然隔离，无需 Nginx。

---

## 1. 架构总览

公网唯一入口是 **nginx:80 反向代理**；两个后端进程只监听回环地址，不直接对外。

| | 本地（不变） | 测试环境 | 正式环境 |
|---|---|---|---|
| 代码 | 工作区 | `/opt/supersnake/dev`（develop 分支） | `/opt/supersnake/official`（main 分支） |
| systemd unit | — | `supersnake-dev.service` | `supersnake-official.service` |
| 监听 | `127.0.0.1:8090` | **`127.0.0.1:8091`** | **`127.0.0.1:8090`** |
| 公网入口 | 直连 | nginx:80（按 `server_name` 路由） | nginx:80（按 `server_name` 路由） |
| 访问（有域名后） | `127.0.0.1:8090` | `http://dev-snake.<域名>/` | `http://snake.<域名>/` |
| 访问（无域名，当前） | `127.0.0.1:8090` | 暂无公网入口（仅服务器内 `127.0.0.1:8091`） | `http://43.161.196.218/`（IP 兜底） |
| 部署方式 | 手动 | push develop 自动 | GitHub 页面手动 Run workflow |

服务器：云轻量应用服务器（香港 `ap-hongkong`，免备案），实例 ID **`ins-8l4bb18g`**
（注意：本实例元数据返回的是 `ins-` 前缀而非文档常见的 `lhins-`，TAT 调用直接用它）。

### 为什么后端只听 127.0.0.1

纵深防御：公网仅开 80（+ 将来 443），8090/8091 不在 ufw 放行列表里，
且进程本身也不监听外网地址——即使 ufw 规则被误改，后端仍不会暴露。
唯一代价是「无域名时测试环境没有公网入口」，见 §1 表格与 §2.B。

### 反向代理与在役 relay 的关系（重要）

本机 nginx 同时服务家用 relay（8527-8529），但那套走的是 **stream 四层模块**
（`/etc/nginx/stream.d/home-relay.stream.conf`，TCP 透传到 frps 的 18527-18529），
与 supersnake 的 **http server**（`/etc/nginx/sites-available/supersnake`）
处于不同配置块，**互不影响**。80 端口原本只是 nginx 默认欢迎页，无真实业务。

supersnake 的 server 块**不使用 `default_server` 标记**，仅精确匹配 `server_name`，
因此 `sites-available/default` 的默认行为保持原样（已实测：其他 Host 仍返回 nginx 欢迎页）。

### CI 部署链路（develop / official 两条，结构相同）

```
触发（push develop / 手动 official）
  → runner 跑全量测试（smoke + server npm test，不绿即中止）
  → OIDC：GitHub 签发短命 JWT，向腾讯云 STS 换 1 小时临时凭证
  → tccli tat InvokeCommand：把 scripts/deploy-remote.sh（占位符已替换）下发到实例
  → 实例上的 tat_agent 执行：git fetch/reset → npm ci → systemctl restart
  → 先判远端 ExitCode，再（PUBLIC_URL 非空时）curl 公网地址做端到端验收
```

> 顺序说明：**先判 ExitCode 再 curl**。反过来的话，远端脚本失败时会先撞 curl 报错，
> 把真实失败原因掩盖掉（已修正）。

### 设计决策记录

| 决策 | 理由 |
|---|---|
| OIDC + TAT 而非 SSH 推模式 | 零长期密钥（GitHub 无 Secret 私钥可泄露）、22 端口无需对 CI 开放、控制台有审计记录 |
| 香港机房 → 无 COS 中转 | 与国内机房方案不同，香港机 `git pull` 直连 GitHub 畅通，砍掉打包上传环节 |
| **走 nginx:80 反代，不直接暴露 8090/8091** | 本机 nginx 已在役且 80 无真实业务；反代后可平滑接 443/wss（微信小游戏 phase2 必需），后端只听回环形成纵深防御。relay 走 stream 四层模块，与 http 块互不干扰 |
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
sudo ufw allow 80/tcp comment 'nginx http (supersnake)'
# 注意：**不要**放行 8090/8091 —— 走 nginx 反代后它们只监听 127.0.0.1，
# 对外暴露纯属多余的攻击面。（本项目早期放行过，后已收回）
```

ufw 是白名单叠加，只增不改，不影响既有的 22 / 443 / 8527:8529 / 7000 规则。

放行后的完整规则（2026-09-01 实测）：

```
22/tcp          # ssh
443/tcp         # wechat game (phase2)   ← 预留，上域名+证书后启用
8527:8529/tcp   # home relay             ← 你的家用中继，勿动
7000/tcp        # frp control            ← 勿动
80/tcp          # nginx http (supersnake)
```

**第 2 层：云轻量控制台「防火墙」页**（**只能在控制台手动操作，SSH 改不了**）

轻量应用服务器实例 → 防火墙（注意不是 CVM 安全组）。需放行：

| 应用类型 | 协议 | 端口 | 用途 | 何时需要 |
|---|---|---|---|---|
| 自定义 / HTTP | TCP | **80** | nginx 统一入口 | **现在就要** |
| 自定义 / HTTPS | TCP | **443** | wss（微信小游戏必需） | 上域名+证书后 |

> **8090 / 8091 不需要在任何一层放行**。它们只监听回环地址，仅 nginx 可达。

**排障判据**（2026-09-01 实测踩过，记下来省时间）：

| 现象 | 结论 |
|---|---|
| 服务器 `curl 127.0.0.1:80` → 200，但从外部访问失败 | 云控制台防火墙未放行 80（ufw 已放行时） |
| `sudo iptables -L ufw-user-input -n \| grep ':80 '` 有 ACCEPT | ufw 这层没问题，问题在云控制台层 |
| 对照：`8527` 公网通而 `80` 不通 | 证明网络链路本身正常，纯粹是该端口未在控制台放行 |
| nginx 返回 502 / 504 | 后端进程挂了：`systemctl status supersnake-official`，或 `HOST` 配错（必须是 `127.0.0.1`） |
| WebSocket 连不上但页面正常 | nginx 的 `/ws` location 缺 `Upgrade`/`Connection` 头转发；正常握手应返回 **101** |

> **另一个干扰源**：若你在公司内网机器上测试，本地 IT 代理（`http_proxy`）
> 可能返回 **502 Bad Gateway**（响应体带「8000助手」字样）而非超时。
> 这是**代理拒绝转发境外 IP**，不是服务器故障。判断方法：改用
> 「SSH 到服务器再 curl 自己的公网 IP」作为权威判据，可完全绕开本地代理。

### B2. nginx 反向代理配置

```bash
scp scripts/nginx-setup.sh ubuntu@43.161.196.218:/tmp/
# 无域名（当前）：纯 IP → 正式环境
ssh ubuntu@43.161.196.218 'bash /tmp/nginx-setup.sh'

# 有域名后（重跑即可，幂等）：
ssh ubuntu@43.161.196.218 'DOMAIN_OFFICIAL=snake.example.com \
  DOMAIN_DEV=dev-snake.example.com bash /tmp/nginx-setup.sh'
```

脚本行为：备份现有 nginx 配置到 `/opt/supersnake/nginx-backup-<时间戳>/` →
生成 `/etc/nginx/sites-available/supersnake` 并 enable → `nginx -t` 校验 →
`systemctl reload`（不中断现有连接）→ 自检 + 确认 relay 未受影响。

**回滚**：`sudo rm /etc/nginx/sites-enabled/supersnake && sudo systemctl reload nginx`

关键配置点（踩坑预防）：

| 点 | 做法 | 不这样做会怎样 |
|---|---|---|
| WebSocket 头转发 | `/ws` location 里 `proxy_set_header Upgrade $http_upgrade;` + `Connection "upgrade";` + `proxy_http_version 1.1;` | 握手返回 200/400 而非 101，联机功能全废 |
| 长连接超时 | `/ws` 的 `proxy_read_timeout 3600s;` | 等待匹配时长时间无下行 → 被 nginx 默认 60s 掐断 |
| 不抢 default_server | supersnake 的 server 块**不加** `default_server` | 会覆盖 `sites-available/default`，影响机器上其他用途 |
| 按 host 而非子路径区分环境 | 用两个 `server_name` | 子路径（`/dev/`）方案下前端 ws 地址仍是 `/ws`（`wsTransport.js` 硬编码），会连错环境，必须改前端代码 |

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
| `scripts/ci-deploy.sh` | 在 runner 上执行：替换占位符 → TAT 下发 → 轮询结果 → 判 ExitCode → （PUBLIC_URL 非空时）curl 公网验收 |
| `scripts/server-init.sh` | 服务器一次性初始化（Node、双 checkout、双 systemd unit） |
| `scripts/nginx-setup.sh` | nginx 反向代理配置（幂等；支持无域名 / 双子域名两种模式，自动备份 + 校验 + reload） |
| `scripts/check-hygiene.sh` | 6 项工程卫生检查（pr-review 的 hygiene job 调用） |

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
- [x] 后端改为仅监听 `127.0.0.1:8090` / `127.0.0.1:8091`
- [x] nginx 反代配好：`sites-available/supersnake`，`nginx -t` 通过，reload 无中断
- [x] 经 nginx 访问：页面 HTTP 200（确认是消食蛇主页、22 个脚本齐全）、`/js/utils.js` 200
- [x] 经 nginx WebSocket 握手 **HTTP 101**
- [x] `sites-available/default` 未被抢占（其他 Host 仍返回 nginx 欢迎页）
- [x] 在役服务未受影响（nginx relay 8527-8529 / frps / docker / fail2ban / tat_agent 全部照旧）
- [x] ufw 放行 80，收回 8090/8091（既有 4 组规则未改动）
- [x] `TAT_INSTANCE_ID` = `ins-8l4bb18g` 已填入 GitHub Variables
- [x] `pr-review` workflow 全绿（syntax / test / hygiene / deploy-lint 四个 job 均通过）
- [ ] **云轻量控制台防火墙放行 TCP 80**（只能手动，当前卡在这里）
- [ ] 浏览器开 `http://43.161.196.218/` 见主菜单
- [ ] 双开标签页进「在线对战」，能匹配进同一对局
- [ ] `TENCENT_ROLE_ARN` 填入 Variables（需 CAM 建完角色后才有 ARN）
- [ ] CAM 角色（OIDC 身份提供商 + 信任策略 + TAT 策略）配置完成
- [ ] push 一个 develop 提交 → Actions 全绿 → 测试环境出现新改动
- [ ] 手动 Run official workflow → Actions 全绿 → `http://43.161.196.218/` 出现新改动
- [ ] **分支保护**：需仓库 admin 权限（当前 gh token `permissions.admin = false`），
      手动在 Settings → Branches 给 main/develop 加规则，required checks 勾
      `syntax` / `test` / `hygiene` / `deploy-lint`
- [ ] 域名到手后：重跑 `nginx-setup.sh` 带 `DOMAIN_OFFICIAL`/`DOMAIN_DEV`，
      并把两个 workflow 的 `PUBLIC_URL` 填成对应域名
- [ ] 首次运行若 `ci-deploy.sh` 中 tccli 参数报错（如 `DescribeInvocationTasks` 的参数名），按报错提示修正后重跑——TAT CLI 参数以 `tccli tat DescribeInvocationTasks help` 输出为准

---

## 5. 已知限制与 TODO

| 项 | 现状 | 计划 |
|---|---|---|
| 部署重启杀在线玩家 | 「掉线判负」规则下，restart 瞬间在线玩家被判负 | TODO：server 增加 drain 接口（停止接新匹配，房间清零或超时后重启），official 部署脚本接入 |
| SSH 密码登录 | 已建立密钥免密登录（`id_ed25519`）；密码认证仍开放，且密码曾出现在聊天记录中 | **建议尽快** `PasswordAuthentication no`——免密已通，CI 也不依赖 SSH，关闭无影响。另建议改掉该密码 |
| 无 HTTPS/域名 | 已上 nginx:80 反代，但仍是裸 HTTP + IP | 需域名才能签证书（Let's Encrypt 不给纯 IP 签，自签会红警告）。域名到手后重跑 `nginx-setup.sh` 加子域名，再 certbot 上 443 |
| **微信小游戏 phase2** | ufw 里已预留 `443/tcp # wechat game (phase2)`，nginx 反代已就位 | 微信小游戏**强制 wss**，不接受裸 http/ws。剩余工作：域名 + 证书 + 443 server 段。`wsTransport.js` 已支持 `wss://` 自适应（`location.protocol === 'https:'` 分支），**前端零改动** |
| 测试环境无公网入口 | 无域名阶段，80 上无法按 host 区分 dev/official，IP 兜底给了正式环境 | 域名到手即解决。当前测试环境验证靠 SSH 隧道：`ssh -L 8091:127.0.0.1:8091 ubuntu@43.161.196.218` 后开 `http://127.0.0.1:8091/` |
| develop CI 端到端验收降级 | `PUBLIC_URL` 置空 → 跳过公网 curl，仅靠远端 `curl 127.0.0.1:8091` 自检 | 同上，域名到手后填回 |
| 分支保护未启用 | gh token 对该仓库 `permissions.admin = false`，API 返回 404 | 需手动在 Settings → Branches 配置，或换一个有 admin 权限的 token |
| 版本可见性 | 验收靠肉眼比对页面改动 | TODO：server 增加 `/version` 端点返回 git SHA，CI 验收直接比对（也能让 `ci-deploy.sh` 的验收从「HTTP 200」升级为「SHA 匹配」） |
| tccli 细节 | `DescribeInvocationTasks` 参数名以首联实测为准 | 已在验收清单中标注 |
| frps 非 systemd 托管 | `systemctl is-active frps` = inactive 但 7000 端口有 frps 进程 | 与本项目无关，仅记录以免日后误判「服务挂了」 |
