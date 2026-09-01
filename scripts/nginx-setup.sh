#!/usr/bin/env bash
# nginx-setup.sh — 为 supersnake 配置 nginx 反向代理（80，域名到手后可加 443）
#
# 设计要点（2026-09-01）：
#   - 本机 nginx 已在役，服务家用 relay（8527-8529）。那套走的是 **stream 四层模块**
#     （/etc/nginx/stream.d/home-relay.stream.conf），与本文件的 http server 完全不冲突。
#   - 本脚本只新增 /etc/nginx/sites-available/supersnake 并 enable，**不修改**：
#     nginx.conf、stream.d/*、sites-available/default。
#   - 80 端口原本只是 nginx 默认欢迎页（/var/www/html），无真实业务。
#     为避免抢占 default_server，本文件的 server 块**不使用** default_server 标记，
#     仅通过 server_name 精确匹配；纯 IP 访问由末尾的 fallback server 处理。
#
# WebSocket 关键：/ws 必须转发 Upgrade/Connection 头，否则握手失败（101 变 200/400）。
# 前端 js/net/wsTransport.js 的地址是 location.host + '/ws'（无路径前缀），
# 所以【按 host 区分环境】可零改动前端；若改用子路径（/dev/），必须改前端代码。
#
# 用法：
#   bash nginx-setup.sh                          # 仅 IP 访问（正式 8090）
#   DOMAIN_OFFICIAL=snake.example.com \
#   DOMAIN_DEV=dev-snake.example.com \
#     bash nginx-setup.sh                        # 双子域名
set -euo pipefail

SITE=/etc/nginx/sites-available/supersnake
DOMAIN_OFFICIAL="${DOMAIN_OFFICIAL:-}"
DOMAIN_DEV="${DOMAIN_DEV:-}"

echo "== 备份现有配置 =="
BACKUP="/opt/supersnake/nginx-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
sudo cp -a /etc/nginx/nginx.conf "$BACKUP/" 2>/dev/null || true
sudo cp -a /etc/nginx/sites-available "$BACKUP/" 2>/dev/null || true
sudo cp -a /etc/nginx/stream.d "$BACKUP/" 2>/dev/null || true
echo "   备份于 $BACKUP"

# 公共 proxy 片段（HTTP + WebSocket 通吃）
emit_locations() {
  local port="$1"
  cat <<EOF
    # 静态页面与资源
    location / {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout    60s;
    }

    # WebSocket（联机对局）——必须转发 Upgrade/Connection，否则握手失败
    location /ws {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        # 对局可能长时间无下行（等待匹配），给足超时避免被 nginx 掐断
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_buffering off;
    }
EOF
}

echo "== 生成 $SITE =="
{
  echo "# supersnake 反向代理 —— 由 scripts/nginx-setup.sh 生成，勿手改"
  echo "# 正式 → 127.0.0.1:8090 ；测试 → 127.0.0.1:8091"
  echo "# 不含 default_server：避免抢占 sites-available/default"
  echo ""

  if [ -n "$DOMAIN_OFFICIAL" ]; then
    echo "# ---- 正式环境（域名）----"
    echo "server {"
    echo "    listen 80;"
    echo "    listen [::]:80;"
    echo "    server_name $DOMAIN_OFFICIAL;"
    emit_locations 8090
    echo "}"
    echo ""
  fi

  if [ -n "$DOMAIN_DEV" ]; then
    echo "# ---- 测试环境（域名）----"
    echo "server {"
    echo "    listen 80;"
    echo "    listen [::]:80;"
    echo "    server_name $DOMAIN_DEV;"
    emit_locations 8091
    echo "}"
    echo ""
  fi

  # 纯 IP / 未匹配域名 → 正式环境。用 server_name "" 之外的显式 IP 匹配，
  # 不加 default_server，避免与 sites-available/default 冲突。
  echo "# ---- 纯 IP 访问兜底 → 正式环境 ----"
  echo "server {"
  echo "    listen 80;"
  echo "    listen [::]:80;"
  echo "    server_name 43.161.196.218;"
  emit_locations 8090
  echo "}"
} | sudo tee "$SITE" > /dev/null

sudo ln -sfn "$SITE" /etc/nginx/sites-enabled/supersnake

echo "== 语法校验 =="
sudo nginx -t

echo "== reload（不中断现有连接）=="
sudo systemctl reload nginx

echo "== 自检 =="
sleep 1
printf "   IP:80        -> HTTP %s\n" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: 43.161.196.218' http://127.0.0.1/)"
if [ -n "$DOMAIN_OFFICIAL" ]; then
  printf "   %s -> HTTP %s\n" "$DOMAIN_OFFICIAL" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: $DOMAIN_OFFICIAL" http://127.0.0.1/)"
fi
if [ -n "$DOMAIN_DEV" ]; then
  printf "   %s -> HTTP %s\n" "$DOMAIN_DEV" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: $DOMAIN_DEV" http://127.0.0.1/)"
fi
echo "   relay 未受影响: 8527=$(ss -tln | grep -c ':8527 ') 8528=$(ss -tln | grep -c ':8528 ') 8529=$(ss -tln | grep -c ':8529 ')"

echo ""
echo "== 完成。回滚方法："
echo "   sudo rm /etc/nginx/sites-enabled/supersnake && sudo systemctl reload nginx"
echo "   完整备份在 $BACKUP"
