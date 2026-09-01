#!/usr/bin/env bash
# server-init.sh — 腾讯云香港轻量服务器一次性初始化（双环境：official :8090 / dev :8091）
# 以 ubuntu 用户 SSH 登录后执行：bash server-init.sh
#
# 做的事：Node 22 → 只读 deploy key（需人工加到 GitHub Deploy keys）→
#         双环境 clone（main / develop）→ npm ci → 两个 systemd unit → 启动自检。
# 设计说明见 docs/deploy/02-tencentcloud-hk-ci.md（不用 Nginx：前端 ws 自适应端口）。
# 前置：本地已推好 develop 分支；GitHub 仓库为私有。
# 注意：本脚本幂等，重复执行安全。
set -euo pipefail

BASE=/opt/supersnake
REPO=git@github.com:cosinelu/supersnake.git

# 1. Node.js
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  echo "== installing Node 22 (NodeSource) =="
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "== node $(node -v) =="

# 2. 目录与只读 deploy key
sudo mkdir -p "$BASE"
sudo chown ubuntu:ubuntu "$BASE"
if [ ! -f "$BASE/deploy_key" ]; then
  ssh-keygen -t ed25519 -N "" -f "$BASE/deploy_key" -C supersnake-deploy
fi
chmod 600 "$BASE/deploy_key"
echo ""
echo "======== 把下面这行公钥加到 GitHub 仓库 Settings → Deploy keys ========"
echo "（不要勾选 Allow write access，保持只读）"
cat "$BASE/deploy_key.pub"
echo "======================================================================"
echo ""

export GIT_SSH_COMMAND="ssh -i $BASE/deploy_key -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes"

# 3. 双环境 clone + checkout + 依赖
if [ ! -d "$BASE/official" ]; then git clone "$REPO" "$BASE/official"; fi
if [ ! -d "$BASE/dev" ]; then git clone "$REPO" "$BASE/dev"; fi
(cd "$BASE/official" && git fetch origin && git checkout -B main origin/main && git reset --hard origin/main)
(cd "$BASE/dev" && git fetch origin && git checkout -B develop origin/develop && git reset --hard origin/develop)
(cd "$BASE/official/server" && npm ci --omit=dev)
(cd "$BASE/dev/server" && npm ci --omit=dev)

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
Environment=HOST=0.0.0.0
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

write_unit supersnake-official "$BASE/official" 8090 "official environment (main)"
write_unit supersnake-dev      "$BASE/dev"      8091 "dev environment (develop)"

sudo systemctl daemon-reload
sudo systemctl enable --now supersnake-official supersnake-dev

# 5. 本机自检
sleep 2
systemctl is-active --quiet supersnake-official || { systemctl status supersnake-official || true; exit 1; }
systemctl is-active --quiet supersnake-dev      || { systemctl status supersnake-dev || true; exit 1; }
curl -fsS --max-time 10 http://127.0.0.1:8090/ > /dev/null && echo "official :8090 OK"
curl -fsS --max-time 10 http://127.0.0.1:8091/ > /dev/null && echo "dev      :8091 OK"

echo ""
echo "== server-init done。剩余人工步骤："
echo "   1. 把上方打印的公钥加到 GitHub Deploy keys（只读）——若尚未添加"
echo "   2. 轻量控制台防火墙放行 TCP 8090 / 8091"
echo "   3. 浏览器验证 http://<服务器IP>:8090/ 与 :8091/"
