#!/usr/bin/env bash
# server-init.sh — 腾讯云香港轻量服务器一次性初始化（双环境：official :8090 / dev :8091）
# 以 ubuntu 用户 SSH 登录后执行：bash server-init.sh
#
# 做的事：Node 22 → 双环境 clone（main / develop）→ npm ci → 两个 systemd unit → 启动自检。
# 设计说明见 docs/deploy/02-tencentcloud-hk-ci.md（不用 Nginx：前端 ws 自适应端口）。
#
# 前置事实（2026-09-01 实测确认，改动前请复核）：
#   - 仓库 cosinelu/supersnake 为【公开】仓库 → 用 HTTPS 匿名 clone，不需要 deploy key。
#     （若将来改为私有，需恢复 deploy key：ssh-keygen 生成后把公钥加到 GitHub Deploy keys，
#       并把 REPO 换成 git@github.com: 形式 + 设置 GIT_SSH_COMMAND）
#   - 服务器 → GitHub 连通正常（HTTPS 114ms，SSH:22 亦可达），香港机房无跨境问题。
#   - 本机已有其他在役服务：nginx(80/8527/8528/8529)、frps(7000/18527-18529)、docker。
#     本脚本【完全不碰】它们，只新增 Node、/opt/supersnake、两个 systemd unit、监听 8090/8091。
#   - 8090 / 8091 实测空闲，不冲突。
#
# 注意：本脚本幂等，重复执行安全。
set -euo pipefail

BASE=/opt/supersnake
REPO=https://github.com/cosinelu/supersnake.git

# 0. 端口占用前置校验 —— 机器上有其他在役服务，必须确认不抢别人的端口
for p in 8090 8091; do
  if ss -tln 2>/dev/null | grep -q ":$p "; then
    # 已被我们自己的 unit 占用属于正常（幂等重跑）；被别的进程占用则中止
    owner=$(sudo ss -tlnp 2>/dev/null | grep ":$p " | grep -o 'users:((\"[^\"]*\"' | head -1 || true)
    if systemctl is-active --quiet supersnake-official 2>/dev/null \
       || systemctl is-active --quiet supersnake-dev 2>/dev/null; then
      echo "== port $p 已被本项目 unit 占用（幂等重跑，继续）=="
    else
      echo "ERROR: 端口 $p 已被其他进程占用（$owner），中止以免影响在役服务。" >&2
      exit 1
    fi
  fi
done

# 1. Node.js
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  echo "== installing Node 22 (NodeSource) =="
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "== node $(node -v) / npm $(npm -v) =="

# 2. 目录
sudo mkdir -p "$BASE"
sudo chown ubuntu:ubuntu "$BASE"

# 3. 双环境 clone + checkout + 依赖
if [ ! -d "$BASE/official" ]; then git clone "$REPO" "$BASE/official"; fi
if [ ! -d "$BASE/dev" ];      then git clone "$REPO" "$BASE/dev";      fi
(cd "$BASE/official" && git fetch origin && git checkout -B main    origin/main    && git reset --hard origin/main)
(cd "$BASE/dev"      && git fetch origin && git checkout -B develop origin/develop && git reset --hard origin/develop)
(cd "$BASE/official/server" && npm ci --omit=dev)
(cd "$BASE/dev/server"      && npm ci --omit=dev)

# 4. systemd units（双进程，端口与目录见部署文档）
write_unit() {
  local name="$1" dir="$2" port="$3" desc="$4"
  sudo tee "/etc/systemd/system/$name.service" > /dev/null <<EOF
[Unit]
Description=supersnake $desc (:$port)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$dir
Environment=PORT=$port
# 只听本机：公网唯一入口是 nginx:80 反代（见 scripts/nginx-setup.sh）。
# 纵深防御——即使 ufw 规则被误改，后端也不会直接暴露。
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
# 轻度加固：这台机器还跑着其他业务，限制本服务的可触达范围
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$dir

[Install]
WantedBy=multi-user.target
EOF
}

write_unit supersnake-official "$BASE/official" 8090 "official environment (main)"
write_unit supersnake-dev      "$BASE/dev"      8091 "dev environment (develop)"

sudo systemctl daemon-reload
sudo systemctl enable --now supersnake-official supersnake-dev

# 5. 本机自检
sleep 3
for unit in supersnake-official supersnake-dev; do
  systemctl is-active --quiet "$unit" || {
    echo "ERROR: $unit 未启动，最近日志：" >&2
    sudo journalctl -u "$unit" -n 30 --no-pager >&2 || true
    exit 1
  }
done
curl -fsS --max-time 10 http://127.0.0.1:8090/ > /dev/null && echo "official :8090 OK"
curl -fsS --max-time 10 http://127.0.0.1:8091/ > /dev/null && echo "dev      :8091 OK"

echo ""
echo "== server-init done。剩余人工步骤："
echo "   1. 轻量控制台防火墙放行 TCP 8090 / 8091"
echo "   2. 浏览器验证 http://<服务器IP>:8090/ 与 :8091/"
