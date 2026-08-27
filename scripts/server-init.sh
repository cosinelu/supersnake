#!/usr/bin/env bash
# server-init.sh — 消食蛇联机服务器初始化（腾讯云 Ubuntu 24.04 LTS）
#
# 作用：Node 22（NodeSource）+ Nginx + systemd 守护单元 +（可选）certbot 证书
# 用法：
#   sudo bash scripts/server-init.sh                # 基础安装（http，先用 IP 跑通）
#   sudo bash scripts/server-init.sh example.com    # 加域名：配置 Nginx server_name + certbot 申请证书
#
# 前置：代码已放在 /opt/supersnake（git clone 或 rsync 上传）；
#       腾讯云控制台安全组已放行 22/80/443。
# 部署后：systemctl status supersnake / journalctl -u supersnake -f 看日志。
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/opt/supersnake"
APP_USER="supersnake"
WS_PORT=8090

echo "==> [1/6] 系统依赖"
apt-get update
apt-get install -y curl nginx ufw

echo "==> [2/6] Node 22（NodeSource）"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v; npm -v

echo "==> [3/6] 应用用户与依赖"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/server" ]; then
  cd "$APP_DIR/server"
  sudo -u "$APP_USER" npm ci --omit=dev || sudo -u "$APP_USER" npm install --omit=dev
else
  echo "!! 未找到 $APP_DIR/server —— 请先把仓库放到 $APP_DIR 再重跑" >&2
  exit 1
fi

echo "==> [4/6] systemd 单元"
cat > /etc/systemd/system/supersnake.service <<EOF
[Unit]
Description=supersnake online server (ws :$WS_PORT)
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/server
ExecStart=$(command -v node) index.js
Restart=always
RestartSec=2
Environment=NODE_ENV=production
Environment=PORT=$WS_PORT

[Install]
WantedBy=multi-user.target
EOF
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
systemctl daemon-reload
systemctl enable --now supersnake

echo "==> [5/6] Nginx 站点（/ 静态 + /ws 反代）"
cat > /etc/nginx/sites-available/supersnake <<EOF
server {
    listen 80;
    server_name ${DOMAIN:-_};

    root $APP_DIR;
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location /ws {
        proxy_pass http://127.0.0.1:$WS_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600s;   # 长连接保活（对局最长 5 分钟 + 余量）
        proxy_send_timeout 3600s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/supersnake /etc/nginx/sites-enabled/supersnake
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> [6/6] 防火墙与证书"
ufw allow 'Nginx Full' || true
if [ -n "$DOMAIN" ]; then
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email \
    || echo "!! certbot 失败：请确认 $DOMAIN 已解析到本机后手动重跑 certbot --nginx -d $DOMAIN"
else
  echo "   未提供域名，跳过 HTTPS；先用 http://<IP> 跑通，后续加域名重跑：sudo bash $0 <域名>"
fi

echo ""
echo "完成！验证："
echo "  systemctl status supersnake"
echo "  curl -I http://127.0.0.1/            # 静态页"
echo "  curl -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' \\"
echo "       -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' \\"
echo "       http://127.0.0.1/ws              # 应返回 101 Switching Protocols"
