# 02 · GitHub CI 部署到腾讯云香港轻量服务器（OIDC + TAT）

> 读者：执行本方案的 AI 助手或开发者。
> 目标：建立三环境体系——本地直玩（现状）/ develop CI → 测试进程 / official CI → 正式进程。
> 核心原则：**零长期密钥**（GitHub 侧无 Secret 私钥，服务器侧无 COS/云 API 密钥）、**零入站依赖**（部署不经 SSH）。
> 前置事实（已核对代码）：
> - `server/config.js` 的 `PORT`/`HOST` 走环境变量 → 双进程零改动；
> - `js/net/wsTransport.js` 前端 ws 地址 = `location.host + '/ws'`，且 `location.protocol === 'https:'`
>   时自动切 `wss://` → **按子域名区分环境 + 上 HTTPS 均无需改前端**；
> - `server/index.js` 的静态服务有**白名单**（仅 `/index.html`、`/js/*`、`/favicon.ico`）
>   → 做探针验证时文件必须放 `js/` 下，否则 404（易误判为反代故障）。
>
> **当前状态（2026-09-01）**：服务器初始化、nginx 反代、域名接入、HTTPS/wss 全部落地并实测通过。
> 剩余待办集中在 CAM/OIDC 配置与分支保护（均需控制台/admin 权限手动操作），见 §4。

---

## 1. 架构总览

公网唯一入口是 **nginx（80 → 301 → 443）反向代理**；两个后端进程只监听回环地址，不直接对外。

| | 本地（不变） | 测试环境 | 正式环境 |
|---|---|---|---|
| 代码 | 工作区 | `/opt/supersnake/dev`（develop 分支） | `/opt/supersnake/official`（main 分支） |
| systemd unit | — | `supersnake-dev.service` | `supersnake-official.service` |
| 监听 | `127.0.0.1:8090` | **`127.0.0.1:8091`** | **`127.0.0.1:8090`** |
| 公网入口 | 直连 | nginx 443（按 `server_name` 路由） | nginx 443（按 `server_name` 路由） |
| 访问地址 | `http://127.0.0.1:8090/` | **`https://dev-snake.pippocao.top/`** | **`https://snake.pippocao.top/`** |
| WebSocket | `ws://127.0.0.1:8090/ws` | `wss://dev-snake.pippocao.top/ws` | `wss://snake.pippocao.top/ws` |
| 部署方式 | 手动 | push develop 自动 | GitHub 页面手动 Run workflow |

服务器：云轻量应用服务器（香港 `ap-hongkong`，免备案），实例 ID **`ins-8l4bb18g`**
（注意：本实例元数据返回的是 `ins-` 前缀而非文档常见的 `lhins-`，TAT 调用直接用它）。

裸 IP `http://43.161.196.218/` 仍可用，兜底路由到**正式环境**，但不做 https 跳转
（证书 SAN 不含 IP，跳过去浏览器会报证书不匹配）。

### 域名与 TLS（2026-09-01 落地）

| 项 | 值 |
|---|---|
| 域名 | `pippocao.top`（托管在 DNSPod，NS = `larry/rock.dnspod.net`） |
| DNS | 已配 **`*.pippocao.top` 通配符**解析到 `43.161.196.218` → 两个子域名**无需新增记录** |
| 证书 | Let's Encrypt 单张 **SAN 证书**，SAN = `snake.pippocao.top` + `dev-snake.pippocao.top` |
| 证书路径 | `/etc/letsencrypt/live/snake.pippocao.top/`（lineage 名 = 正式域名） |
| 有效期 | 至 2026-11-30，`certbot.timer` 自动续期（每日 07:47 检查，`renew --dry-run` 已通过） |
| 签发方式 | `certonly --webroot -w /var/www/acme`，**不用 `--nginx` 插件** |

> **为什么不用 `--nginx` 插件**：插件会自作主张改写 `sites-available/supersnake`，
> 而这个文件由 `scripts/nginx-setup.sh` 生成（幂等、可重跑）。两者会互相打架。
> 改用 webroot 模式后，certbot 只管产证书，nginx 配置永远由脚本单一来源生成。
>
> 配套设计：`nginx-setup.sh` **证书自适应**——检测到 `fullchain.pem` 就生成 443 段
> 并让 80 做 301；检测不到就只在 80 上反代。所以「先签证书后跑脚本」和
> 「先跑脚本后签证书再重跑」两种顺序结果都对。
>
> ACME 校验路径 `/.well-known/acme-challenge/` **在 80 上常驻**（即使已启用 301），
> 否则 90 天后续期会失败。

### 为什么后端只听 127.0.0.1

纵深防御：公网仅开 80/443，8090/8091 不在 ufw 放行列表里，
且进程本身也不监听外网地址——即使 ufw 规则被误改，后端仍不会暴露。

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
  → 先判远端 ExitCode
  → 公网验收：① 页面内容含「消食蛇」 ② /ws 握手返回 101（必须 --http1.1）
```

> **顺序说明**：**先判 ExitCode 再 curl**。反过来的话，远端脚本失败时会先撞 curl 报错，
> 把真实失败原因掩盖掉（已修正）。
>
> **为什么验收要校验内容而不只看 200**：nginx 若兜到了错误的 server 块（比如
> `sites-available/default` 的欢迎页）同样返回 200。实测反例：`http://nas.pippocao.top/`
> 返回 200 但内容是 nginx 欢迎页，验收逻辑正确判失败。
>
> **为什么必须验 ws**：静态页 200 完全不能代表联机可用——`/ws` 的 Upgrade 头转发
> 是独立配置项，漏了页面照常但对战全废。

### 设计决策记录

| 决策 | 理由 |
|---|---|
| OIDC + TAT 而非 SSH 推模式 | 零长期密钥（GitHub 无 Secret 私钥可泄露）、22 端口无需对 CI 开放、控制台有审计记录 |
| 香港机房 → 无 COS 中转 | 与国内机房方案不同，香港机 `git pull` 直连 GitHub 畅通，砍掉打包上传环节 |
| **走 nginx 反代，不直接暴露 8090/8091** | 本机 nginx 已在役且 80 无真实业务；反代后可平滑接 443/wss（微信小游戏 phase2 必需），后端只听回环形成纵深防御。relay 走 stream 四层模块，与 http 块互不干扰 |
| **按子域名而非子路径区分环境** | `wsTransport.js` 的 ws 地址是 `location.host + '/ws'`（路径硬编码无前缀）。子路径方案下测试环境的 ws 仍会打到 `/ws`，被 nginx 路由到正式环境——必须改前端代码。子域名方案**前端零改动** |
| **一张 SAN 证书覆盖两个子域名** | 两个环境同机同域，共用 lineage 便于续期（一次 renew 管两个）。分开签会有两份续期任务、两倍失败面 |
| **certbot 用 webroot 而非 `--nginx` 插件** | nginx 配置由 `nginx-setup.sh` 单一来源生成（幂等可重跑），插件会改写它导致互相打架。webroot 模式下 certbot 只产证书，职责清晰 |
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
sudo ufw allow 80/tcp  comment 'nginx http (supersnake)'
sudo ufw allow 443/tcp comment 'nginx https (supersnake wss)'
# 注意：**不要**放行 8090/8091 —— 走 nginx 反代后它们只监听 127.0.0.1，
# 对外暴露纯属多余的攻击面。（本项目早期放行过，后已收回）
# 80 也不能关：Let's Encrypt HTTP-01 续期走的就是 80。
```

ufw 是白名单叠加，只增不改，不影响既有的 22 / 8527:8529 / 7000 规则。

放行后的完整规则（2026-09-01 实测）：

```
22/tcp          # ssh
443/tcp         # wechat game (phase2)   ← 原为预留，现已启用（wss）
8527:8529/tcp   # home relay             ← 你的家用中继，勿动
7000/tcp        # frp control            ← 勿动
80/tcp          # nginx http (supersnake) ← 301 跳转 + ACME 续期校验
```

**第 2 层：云轻量控制台「防火墙」页**（**只能在控制台手动操作，SSH 改不了**）

轻量应用服务器实例 → 防火墙（注意不是 CVM 安全组）。需放行：

| 应用类型 | 协议 | 端口 | 用途 | 状态 |
|---|---|---|---|---|
| 自定义 / HTTP | TCP | **80** | 301 跳转 + ACME 证书续期校验 | ✅ 已放行（实测公网 200） |
| 自定义 / HTTPS | TCP | **443** | HTTPS + wss | ✅ 已放行（实测公网 200 + 握手 101） |

> **8090 / 8091 不需要在任何一层放行**。它们只监听回环地址，仅 nginx 可达。
> **80 上线后也不要关**：`certbot renew` 走 HTTP-01 校验，关掉 90 天后证书会过期。

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

### B2. nginx 反向代理 + 域名 + HTTPS

**当前状态：已全部落地（2026-09-01）。** 下面是可重放的完整步骤。

#### 步骤 1：DNS

`pippocao.top` 托管在 DNSPod，已配 **`*.pippocao.top` 通配符**解析到 `43.161.196.218`，
所以 `snake` / `dev-snake` 两个子域名**不需要新增任何 DNS 记录**。

验证方法（重要——先确认没有在役服务占用这些子域名再动手）：

```bash
# 1) 解析是否落到本机
for h in snake.pippocao.top dev-snake.pippocao.top; do dig +short "$h"; done

# 2) 这些子域名当前被谁服务着？（避免抢占别人的站点）
for h in snake.pippocao.top dev-snake.pippocao.top; do
  curl -s -H "Host: $h" http://127.0.0.1/ | grep -o '<title>[^<]*'
done
# 实测输出均为 "Welcome to nginx!" → 无在役 http 服务占用，可安全新增 server 块
```

#### 步骤 2：先配 80（此时还没证书）

```bash
scp scripts/nginx-setup.sh ubuntu@43.161.196.218:/tmp/
ssh ubuntu@43.161.196.218 'DOMAIN_OFFICIAL=snake.pippocao.top \
  DOMAIN_DEV=dev-snake.pippocao.top bash /tmp/nginx-setup.sh'
```

脚本检测到无证书 → 只在 80 上反代，同时**预留 ACME 校验路径**。

#### 步骤 3：签证书

```bash
# 先自测 ACME 路径公网可达（这是签发的前提，不通就别浪费速率配额）
echo ok | sudo tee /var/www/acme/.well-known/acme-challenge/selftest
curl http://snake.pippocao.top/.well-known/acme-challenge/selftest   # 应回 ok

sudo apt-get install -y certbot          # 只装核心，**不装 python3-certbot-nginx**

# 演练（不消耗速率配额）
sudo certbot certonly --webroot -w /var/www/acme \
  -d snake.pippocao.top -d dev-snake.pippocao.top \
  --cert-name snake.pippocao.top \
  --agree-tos --register-unsafely-without-email --non-interactive --dry-run

# 正式签发（去掉 --dry-run）
```

> Let's Encrypt 有速率限制（同一组域名每周 5 次），**务必先 `--dry-run`**。

#### 步骤 4：重跑同一个脚本，自动启用 443

```bash
ssh ubuntu@43.161.196.218 'DOMAIN_OFFICIAL=snake.pippocao.top \
  DOMAIN_DEV=dev-snake.pippocao.top bash /tmp/nginx-setup.sh'
# 输出会变成：== 证书检测：... -> 已就绪，将启用 443
```

脚本行为：检测证书 → 备份现有 nginx 配置到 `/opt/supersnake/nginx-backup-<时间戳>/` →
生成 `/etc/nginx/sites-available/supersnake` 并 enable → `nginx -t` 校验
（**失败自动回滚**）→ `systemctl reload`（不中断现有连接）→ 自检 + 确认 relay 未受影响。

**回滚**：`sudo rm /etc/nginx/sites-enabled/supersnake && sudo systemctl reload nginx`

#### 关键配置点与踩坑记录

| 点 | 做法 | 不这样做会怎样 |
|---|---|---|
| WebSocket 头转发 | `/ws` location 里 `proxy_set_header Upgrade $http_upgrade;` + `Connection "upgrade";` + `proxy_http_version 1.1;` | 握手返回 200/400 而非 101，联机功能全废 |
| 长连接超时 | `/ws` 的 `proxy_read_timeout 3600s;` | 等待匹配时长时间无下行 → 被 nginx 默认 60s 掐断 |
| 不抢 default_server | supersnake 的 server 块**不加** `default_server` | 会覆盖 `sites-available/default`，影响机器上其他用途 |
| 按 host 而非子路径区分环境 | 用两个 `server_name` | 子路径（`/dev/`）方案下前端 ws 地址仍是 `/ws`（`wsTransport.js` 硬编码），会连错环境，必须改前端代码 |
| **HTTP/2 语法按版本分家** | nginx **< 1.25.1** 用 `listen 443 ssl http2;`；**≥ 1.25.1** 用 `listen 443 ssl;` + 独立指令 `http2 on;` | 本机 1.24.0 上写 `http2 on;` 直接 `[emerg] unknown directive "http2"`，`nginx -t` 失败。脚本已按 `nginx -v` 自动选 |
| **`nginx -t` 失败必须自动回滚** | 脚本在校验失败时把 site 文件恢复成备份版本（或摘掉软链） | 磁盘上留着坏配置，**下次任何人 reload nginx 都会挂，在役 relay 跟着倒**。实测踩过（就是上一行的 http2 问题） |
| **ACME 路径常驻 80** | 即使已 301，`location ^~ /.well-known/acme-challenge/` 也要保留在 80 段 | 90 天后 `certbot renew` 校验失败，证书过期 |
| **裸 IP 不做 301** | IP 的 server 块只反代，不跳 https | 证书 SAN 不含 IP，跳过去浏览器报证书不匹配 |

#### 验证方法（含两个测试假象，务必知道）

```bash
# ① 页面 + 内容（只看 200 不够：nginx 兜错 server 块也是 200）
curl -s https://snake.pippocao.top/ | grep -o '<title>[^<]*'

# ② WebSocket 握手 —— 必须加 --http1.1
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://snake.pippocao.top/ws        # 期望 101

# ③ 最权威：真实 ws 客户端（会收到服务端首帧）
#    在服务器上 cd 到有 ws 依赖的目录再跑，否则 Cannot find module 'ws'
cd /opt/supersnake/official/server && node <本仓库 test/wss-verify.js> wss://snake.pippocao.top/ws
```

> **假象 1：wss 握手在 HTTP/2 下返回 404。**
> h2 协议里 `Connection`/`Upgrade` 头是非法的，会被丢弃，请求退化成普通
> `GET /ws`，被 node 的静态白名单（`server/index.js` 只放行 `/index.html`、
> `/js/*`、`/favicon.ico`）拒成 404。**加 `--http1.1` 即回 101**。浏览器做
> WebSocket 一定用 HTTP/1.1，所以这是纯测试假象，不是故障。
>
> **假象 2：curl 拿到 101 后退出码非 0。**
> 会让 `|| echo FAIL` 之类的兜底逻辑误报（实测输出过 `101FAIL` 这种拼接结果）。
> 判定只看 `%{http_code}` 是否等于 101，别依赖 curl 退出码。
>
> **假象 3：往 `/opt/supersnake/<env>/` 根目录放探针文件取不到（404）。**
> 静态白名单不含任意路径。要做分流验证请把探针放到 `js/` 下（如
> `js/__probe.js`），测完记得删并确认 `git status` 干净。

#### 分流验证（域名 → 进程的硬证据）

只看两个域名都返回 200 **不能证明**它们连到了不同进程（页面字节数可能完全相同）。
用探针文件做硬验证：

```bash
echo '// I-AM-OFFICIAL-8090' | sudo tee /opt/supersnake/official/js/__probe.js
echo '// I-AM-DEV-8091'      | sudo tee /opt/supersnake/dev/js/__probe.js
curl -s -H 'Host: snake.pippocao.top'     http://127.0.0.1/js/__probe.js
curl -s -H 'Host: dev-snake.pippocao.top' http://127.0.0.1/js/__probe.js
sudo rm -f /opt/supersnake/{official,dev}/js/__probe.js   # 务必清理
```

实测结果：`snake` → OFFICIAL-8090，`dev-snake` → DEV-8091，裸 IP → OFFICIAL-8090。✅

### C. 腾讯云 CAM 配置 OIDC 角色

1. **建 OIDC 身份提供商**（控制台 → 访问管理 → 身份提供商 → 角色SSO → 新建，类型 OIDC）：
   - 名称：`github`
   - 提供商 URL：`https://token.actions.githubusercontent.com`
   - 客户端 ID：`sts.tencentcloudapi.com`
   - 签名公钥：访问 `https://token.actions.githubusercontent.com/.well-known/jwks`，把返回的 JWKS JSON 全文粘贴进去
2. **建角色** `github-supersnake-deploy`（载体 = 身份提供商 github）。信任策略在
   **角色详情页 → 信任策略 → 编辑（JSON 模式）**里整段粘贴：

```json
{
  "version": "2.0",
  "statement": [{
    "effect": "allow",
    "action": ["name/sts:AssumeRoleWithWebIdentity"],
    "principal": { "federated": ["qcs::cam::uin/100011909025:oidc-provider/github"] },
    "condition": {
      "string_equal": {
        "oidc:iss": ["https://token.actions.githubusercontent.com"],
        "oidc:aud": ["sts.tencentcloudapi.com"],
        "oidc:sub": [
          "repo:cosinelu@37471942/supersnake@1342904019:ref:refs/heads/develop",
          "repo:cosinelu@37471942/supersnake@1342904019:ref:refs/heads/main"
        ]
      }
    }
  }]
}
```

> ⚠️ **`oidc:sub` 是安全命门，漏配等于向全 GitHub 开放该角色。** 数组语义是 OR（匹配任一即通过）。
>
> ⚠️ **immutable sub 格式（2026-09-01 实测踩过的坑）**：
> GitHub 对 **2026-07-15 之后创建的仓库**改用"不可变 sub"，在 owner 和 repo 名后各附加数字 ID：
> `repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/BRANCH`。
> 本仓库 `2026-08-22` 创建 → owner_id=`37471942`、repo_id=`1342904019`。
> **如果照网上教程写 `repo:cosinelu/supersnake:ref:...`（无 ID 的旧格式），
> AssumeRoleWithWebIdentity 会一直 `UnauthorizedOperation ... has no permission`**
> （腾讯云回显里只列出 `oidc:sub` 那条，因为 iss/aud 是在身份提供商层面单独校验的）。
> 查自己仓库的两个 ID：
> `gh api repos/<owner>/<repo> -q '{owner_id:.owner.id, repo_id:.id}'`。
>
> ⚠️ **不要用 `string_like` 做通配**：腾讯云《条件键和条件运算符》明确
> `string_like`/`string_not_like` 的值**只支持大小写字母、数字、`-`、`_`**，
> 不能含 `/`、`:`、`.`，更不支持 `*`。GitHub sub 全是 `:` 和 `/`，`string_like` 匹配不了。
> 要多分支就用 `string_equal` + **数组**（如上）。
>
> 角色其余信息（实测）：ARN=`qcs::cam::uin/100011909025:roleName/github-supersnake-deploy`、
> 会话最大时长 2 小时。

3. **建自定义策略** `TatInvokeSupersnake` 并绑定到该角色：

```json
{
  "version": "2.0",
  "statement": [{
    "effect": "allow",
    "action": ["tat:RunCommand", "tat:DescribeInvocations", "tat:DescribeInvocationTasks"],
    "resource": "*"
  }]
}
```

> ⚠️ **用 `tat:RunCommand` 不是 `tat:InvokeCommand`**（2026-09-01 实测踩过）：
> - `InvokeCommand` 触发【已保存】的命令，`CommandId` 必填 —— 我们没预建命令，
>   tccli 报 `the following arguments are required: --CommandId`（exit 252）。
> - `RunCommand` 直接下发**临时命令**（`Content` base64 + `CommandType` + `InstanceIds`），
>   执行完即删、不需要 CommandId。每次部署的脚本内容随 commit 变化，本就该用临时的。
> - 结果查询（`DescribeInvocations`/`DescribeInvocationTasks`）两者通用。
> - 若角色绑的策略里只有 `InvokeCommand`，换到凭证后调 `RunCommand` 仍会被 CAM 拒。
>
> 说明：TAT 的资源级授权粒度较粗，`*` 意味着这把 1 小时临时凭证可在同账号同地域实例上执行命令。个人账号可接受；将来多实例时改用 `qcs::tat:...:instance/<id>` 细化。

4. 记下**角色 ARN**：`qcs::cam::uin/100011909025:roleName/github-supersnake-deploy`。

### D. GitHub 仓库配置

Settings → Secrets and variables → Actions → **Variables**（不是 Secrets，本方案零 Secret）：

| 变量名 | 值 | 状态 |
|---|---|---|
| `TENCENT_ROLE_ARN` | 上一步的角色 ARN | ⬜ 待填（CAM 配完才有） |
| `TAT_INSTANCE_ID` | `ins-8l4bb18g` | ✅ 已填 |

> 实例 ID 在轻量服务器控制台实例详情页可见。注意本实例是 `ins-` 前缀而非 `lhins-`。
> `PUBLIC_URL` 不走 Variables，直接写在两个 workflow 的 `env:` 里（明文域名，无需保密）。

---

## 3. 仓库内新增文件

| 文件 | 作用 |
|---|---|
| `.github/workflows/develop-deploy.yml` | push develop → 测试全绿 → 部署 8091 → 验收 `https://dev-snake.pippocao.top/` |
| `.github/workflows/official-deploy.yml` | 手动 Run workflow（main）→ 测试全绿 → 部署 8090 → 验收 `https://snake.pippocao.top/` |
| `scripts/deploy-remote.sh` | 在服务器上执行的部署脚本（`__ENV__/__BRANCH__/__REF__` 占位符由 CI 替换） |
| `scripts/ci-deploy.sh` | 在 runner 上执行：替换占位符 → TAT 下发 → 轮询结果 → 判 ExitCode → 公网验收（页面内容 + ws 握手 101） |
| `scripts/server-init.sh` | 服务器一次性初始化（Node、双 checkout、双 systemd unit） |
| `scripts/nginx-setup.sh` | nginx 反代配置（幂等；**证书自适应**：有证书自动上 443+301，无证书只配 80；`nginx -t` 失败自动回滚；HTTP/2 语法按 nginx 版本自动选） |
| `scripts/check-hygiene.sh` | 6 项工程卫生检查（pr-review 的 hygiene job 调用） |
| `test/wss-verify.js` | 真实 WebSocket 客户端验证工具（比 curl 可靠，会等服务端首帧）。手动排障用：`cd server && node ../test/wss-verify.js wss://snake.pippocao.top/ws` |

两条 workflow 除触发条件与 `ENV/BRANCH/PUBLIC_URL` 三个变量外完全一致，共用 `ci-deploy.sh`。
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
- [x] ufw 放行 80 + 443，收回 8090/8091（既有规则未改动）
- [x] `TAT_INSTANCE_ID` = `ins-8l4bb18g` 已填入 GitHub Variables
- [x] `pr-review` workflow 全绿（syntax / test / hygiene / deploy-lint 四个 job 均通过）
- [x] **云轻量控制台防火墙放行 TCP 80 + 443**（实测公网自访问 200，卡点已解除）
- [x] **域名接入**：`snake.pippocao.top` / `dev-snake.pippocao.top`（通配符 DNS，无需新增记录）
- [x] **HTTPS 上线**：Let's Encrypt SAN 证书，80 → 301 → 443，`ssl_verify_result=0`（链被公信）
- [x] **wss 握手 101**，且真实 ws 客户端收到服务端首帧（业务逻辑活着，非仅链路通）
- [x] **域名分流硬验证**：`snake`→8090(official)、`dev-snake`→8091(dev)、裸 IP→8090（探针法）
- [x] `certbot renew --dry-run` 通过，`certbot.timer` 已激活（每日 07:47）
- [x] 两个 workflow 的 `PUBLIC_URL` 已填成 https 域名
- [x] `ci-deploy.sh` 验收升级为「页面内容校验 + ws 握手 101」，含反例测试（默认页被正确判失败）
- [ ] 浏览器开 `https://snake.pippocao.top/` 见主菜单（**等你人工确认**）
- [ ] 双开标签页进「在线对战」，能匹配进同一对局（**等你人工确认**）
- [ ] `TENCENT_ROLE_ARN` 填入 Variables（需 CAM 建完角色后才有 ARN）
- [ ] CAM 角色（OIDC 身份提供商 + 信任策略 + TAT 策略）配置完成
- [ ] push 一个 develop 提交 → Actions 全绿 → `https://dev-snake.pippocao.top/` 出现新改动
- [ ] 手动 Run official workflow → Actions 全绿 → `https://snake.pippocao.top/` 出现新改动
- [ ] **分支保护**：需仓库 admin 权限（当前 gh token `permissions.admin = false`），
      手动在 Settings → Branches 给 main/develop 加规则，required checks 勾
      `syntax` / `test` / `hygiene` / `deploy-lint`
- [ ] 首次运行若 `ci-deploy.sh` 中 tccli 参数报错（如 `DescribeInvocationTasks` 的参数名），按报错提示修正后重跑——TAT CLI 参数以 `tccli tat DescribeInvocationTasks help` 输出为准

---

## 5. 已知限制与 TODO

| 项 | 现状 | 计划 |
|---|---|---|
| 部署重启杀在线玩家 | 「掉线判负」规则下，restart 瞬间在线玩家被判负 | TODO：server 增加 drain 接口（停止接新匹配，房间清零或超时后重启），official 部署脚本接入 |
| SSH 密码登录 | 已建立密钥免密登录（`id_ed25519`）；密码认证仍开放，且密码曾出现在聊天记录中 | **建议尽快** `PasswordAuthentication no`——免密已通，CI 也不依赖 SSH，关闭无影响。另建议改掉该密码 |
| ~~无 HTTPS/域名~~ | ✅ 已解决：`snake` / `dev-snake` 子域名 + Let's Encrypt SAN 证书，80→301→443 | — |
| **微信小游戏 phase2** | ✅ 前置条件已全部满足：443 已放行、wss 握手实测 101、证书链被公信 | `wsTransport.js` 的 `location.protocol === 'https:'` 分支会自动切 `wss://`，**前端零改动**。剩余是小游戏侧的域名白名单配置与打包 |
| ~~测试环境无公网入口~~ | ✅ 已解决：`https://dev-snake.pippocao.top/` | — |
| ~~develop CI 端到端验收降级~~ | ✅ 已解决：`PUBLIC_URL` 已填 https 域名，且验收升级为「内容校验 + ws 握手」 | — |
| 证书续期未经历真实 renew | `--dry-run` 通过、`certbot.timer` 已激活，但首次真实续期在 2026-11 月前后 | 到期前留意；若失败最可能是 80 被关或 ACME 路径被覆盖（见 §2.B2 踩坑表） |
| 分支保护未启用 | gh token 对该仓库 `permissions.admin = false`，API 返回 404 | 需手动在 Settings → Branches 配置，或换一个有 admin 权限的 token |
| 版本可见性 | 验收靠页面内容关键词（「消食蛇」），只能证明「是本项目」不能证明「是本次 commit」 | TODO：server 增加 `/version` 端点返回 git SHA，`ci-deploy.sh` 验收从「内容匹配」升级为「SHA 精确匹配」——这是当前验收链最后一处软肋 |
| tccli 细节 | `DescribeInvocationTasks` 参数名以首联实测为准 | 已在验收清单中标注 |
| frps 非 systemd 托管 | `systemctl is-active frps` = inactive 但 7000 端口有 frps 进程 | 与本项目无关，仅记录以免日后误判「服务挂了」 |
| HSTS 未启用 | 只做了 301，未发 `Strict-Transport-Security` 头 | 可选加固。**注意**：HSTS 有 max-age 缓存，配错难回滚，建议先用小 max-age 试；当前 301 已够用 |
