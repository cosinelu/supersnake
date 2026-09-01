#!/usr/bin/env bash
# nginx-setup.sh — 为 supersnake 配置 nginx 反向代理（80，证书就绪时自动上 443/wss）
#
# 设计要点（2026-09-01）：
#   - 本机 nginx 已在役，服务家用 relay。那套走的是 **stream 四层模块**
#     （/etc/nginx/stream.d/home-relay.stream.conf：8527/8528/8529 TCP 透传到
#     frps 的 18527/18528/18529，再穿透回家里 NAS），与本文件的 http server
#     完全不冲突——**不同端口、不同 nginx 模块**。
#   - 域名 *.pippocao.top 是**通配符解析**，relay 也在用（如 f.pippocao.top:8527）。
#     但 relay 靠**端口**区分，不靠 server_name，所以本文件新增 server_name 不影响它。
#   - 本脚本只新增 /etc/nginx/sites-available/supersnake 并 enable，**不修改**：
#     nginx.conf、stream.d/*、sites-available/default。
#
# 【default_server 的两面性】——这台机器是共用的，务必理解：
#   - **80 端口**：sites-available/default 已占 default_server，本文件的 80 段
#     不加该标记，仅精确匹配 server_name → 其他子域名仍走 nginx 欢迎页，不受影响。
#   - **443 端口**：default 里的 443 default_server 是**注释掉的**，即原本无默认块。
#     nginx 规则是"该端口第一个 server 块自动成为默认"，若不处理，supersnake
#     会兜走所有 *.pippocao.top 的 https 请求（实测出现过）。
#     → 本文件显式声明一个 443 default_server 返回 444（断连），把默认位占为
#       拒绝语义，既不误服务别人的域名，也给将来 NAS 上 443 留出空间。
#
# WebSocket 关键：/ws 必须转发 Upgrade/Connection 头，否则握手失败（101 变 200/400）。
# 前端 js/net/wsTransport.js 的地址是 location.host + '/ws'（无路径前缀），
# 所以【按 host 区分环境】可零改动前端；若改用子路径（/dev/），必须改前端代码。
# 同一份代码里 location.protocol === 'https:' 时会自动切 wss://，因此上了 443 前端零改动。
#
# 【证书自适应】—— 这是本脚本幂等的关键：
#   若 $SSL_CERT_DIR/fullchain.pem 存在，则：
#     · 生成 443 ssl/http2 server 块（正式、测试各一个，共用同一张 SAN 证书）
#     · 80 只保留 ACME 校验路径 + 301 跳 443
#   若不存在，则：
#     · 80 直接做反代（当前阶段），并预留 ACME 校验路径供后续签发
#   所以先签证书后重跑，或先跑后签证书再重跑，结果都对。不要让 certbot 去改本文件。
#
# 用法：
#   bash nginx-setup.sh                          # 仅 IP 访问（正式 8090）
#   DOMAIN_OFFICIAL=snake.example.com \
#   DOMAIN_DEV=dev-snake.example.com \
#     bash nginx-setup.sh                        # 双子域名（证书在则自动 443）
set -euo pipefail

SITE=/etc/nginx/sites-available/supersnake
DOMAIN_OFFICIAL="${DOMAIN_OFFICIAL:-}"
DOMAIN_DEV="${DOMAIN_DEV:-}"
SERVER_IP="${SERVER_IP:-43.161.196.218}"
ACME_ROOT="${ACME_ROOT:-/var/www/acme}"
# 证书目录：默认用正式域名做 certbot 的 lineage 名（一张 SAN 证书含两个子域名）
SSL_CERT_DIR="${SSL_CERT_DIR:-/etc/letsencrypt/live/${DOMAIN_OFFICIAL:-none}}"

HAVE_CERT=0
if [ -n "$DOMAIN_OFFICIAL" ] && sudo test -f "$SSL_CERT_DIR/fullchain.pem" \
   && sudo test -f "$SSL_CERT_DIR/privkey.pem"; then
  HAVE_CERT=1
fi
echo "== 证书检测：$SSL_CERT_DIR -> $([ $HAVE_CERT = 1 ] && echo '已就绪，将启用 443' || echo '未就绪，仅配 80')"

# HTTP/2 语法在 nginx 1.25.1 分家：
#   <  1.25.1 : listen 443 ssl http2;      （http2 是 listen 参数）
#   >= 1.25.1 : listen 443 ssl; http2 on;  （独立指令，旧写法会告 deprecated）
# 本机实测 1.24.0 用新写法直接 [emerg] unknown directive "http2"，所以必须按版本选。
NGX_VER="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
if [ -n "$NGX_VER" ] && ver_ge "$NGX_VER" "1.25.1"; then
  H2_STYLE=directive
else
  H2_STYLE=listen_param
fi
echo "== nginx ${NGX_VER:-未知} -> HTTP/2 采用 $([ "$H2_STYLE" = directive ] && echo '独立指令 http2 on;' || echo 'listen 参数 http2')"

echo "== 备份现有配置 =="
BACKUP="/opt/supersnake/nginx-backup-$(date +%Y%m%d-%H%M%S)"
sudo mkdir -p "$BACKUP"
sudo cp -a /etc/nginx/nginx.conf      "$BACKUP/" 2>/dev/null || true
sudo cp -a /etc/nginx/sites-available "$BACKUP/" 2>/dev/null || true
sudo cp -a /etc/nginx/stream.d        "$BACKUP/" 2>/dev/null || true
echo "   备份于 $BACKUP"

# ACME 校验根目录（certbot --webroot 用；也让 renew 无需停 nginx）
sudo mkdir -p "$ACME_ROOT/.well-known/acme-challenge"
sudo chown -R www-data:www-data "$ACME_ROOT" 2>/dev/null || true

# ---------- 可复用片段 ----------

# ACME 校验位置：80 上永远保留，否则 certbot renew 会失败
emit_acme() {
  cat <<EOF
    # Let's Encrypt HTTP-01 校验 —— 必须常驻 80，renew 时无需停 nginx
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_ROOT;
        default_type "text/plain";
        try_files \$uri =404;
    }
EOF
}

# 反代片段（HTTP + WebSocket 通吃）
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

# TLS 参数（只写在自己的 server 块里，不碰全局 nginx.conf）
emit_ssl() {
  cat <<EOF
    ssl_certificate     $SSL_CERT_DIR/fullchain.pem;
    ssl_certificate_key $SSL_CERT_DIR/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSLsupersnake:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
EOF
}

# 80 上的一个域名 server：有证书 → ACME + 301；无证书 → ACME + 反代
emit_http_server() {
  local domain="$1" port="$2"
  echo "server {"
  echo "    listen 80;"
  echo "    listen [::]:80;"
  echo "    server_name $domain;"
  emit_acme
  if [ "$HAVE_CERT" = 1 ]; then
    echo ""
    echo "    location / { return 301 https://\$host\$request_uri; }"
  else
    echo ""
    emit_locations "$port"
  fi
  echo "}"
  echo ""
}

# 443 上的一个域名 server
emit_https_server() {
  local domain="$1" port="$2"
  echo "server {"
  if [ "$H2_STYLE" = directive ]; then
    echo "    listen 443 ssl;"
    echo "    listen [::]:443 ssl;"
    echo "    http2 on;"
  else
    echo "    listen 443 ssl http2;"
    echo "    listen [::]:443 ssl http2;"
  fi
  echo "    server_name $domain;"
  emit_ssl
  echo ""
  emit_locations "$port"
  echo "}"
  echo ""
}

# ---------- 生成配置 ----------
echo "== 生成 $SITE =="
{
  echo "# supersnake 反向代理 —— 由 scripts/nginx-setup.sh 生成，勿手改"
  echo "# 正式 → 127.0.0.1:8090 ；测试 → 127.0.0.1:8091"
  echo "# 不含 default_server：避免抢占 sites-available/default"
  echo "# TLS: $([ $HAVE_CERT = 1 ] && echo "启用（$SSL_CERT_DIR）" || echo '未启用')"
  echo ""

  if [ -n "$DOMAIN_OFFICIAL" ]; then
    echo "# ---- 正式环境 $DOMAIN_OFFICIAL -> 8090 ----"
    emit_http_server "$DOMAIN_OFFICIAL" 8090
    [ "$HAVE_CERT" = 1 ] && emit_https_server "$DOMAIN_OFFICIAL" 8090
  fi

  if [ -n "$DOMAIN_DEV" ]; then
    echo "# ---- 测试环境 $DOMAIN_DEV -> 8091 ----"
    emit_http_server "$DOMAIN_DEV" 8091
    [ "$HAVE_CERT" = 1 ] && emit_https_server "$DOMAIN_DEV" 8091
  fi

  # 纯 IP 访问兜底 → 正式环境。显式 IP 匹配，不加 default_server，
  # 避免与 sites-available/default 冲突。IP 不做 301（证书不含 IP，跳过去会告警）。
  echo "# ---- 纯 IP 访问兜底 → 正式环境（不做 https 跳转：证书不含 IP）----"
  echo "server {"
  echo "    listen 80;"
  echo "    listen [::]:80;"
  echo "    server_name $SERVER_IP;"
  emit_acme
  echo ""
  emit_locations 8090
  echo "}"

  # ---- 443 的显式默认块（重要，别删）----
  # 背景：这台机器还跑着家用 relay（*.pippocao.top 通配符解析 + frps）。
  # sites-available/default 的 default_server 只声明在 **80** 上（443 那两行是注释的），
  # 所以 443 上原本没有任何默认块。nginx 规则：某端口无显式 default_server 时，
  # 该端口上**第一个** server 块自动成为默认——也就是 snake.pippocao.top 会
  # 把所有未匹配域名的 https 请求全兜走（实测：https://nas.pippocao.top 出现了消食蛇页面）。
  # 这会挡住将来给 NAS 等其他子域名上 443 的路。
  # 解法：显式声明一个 443 default_server，用 444（nginx 特有：直接断连，不回响应）拒绝。
  # 这样 supersnake 只服务自己的两个子域名，443 的"默认位"被明确占为拒绝语义。
  if [ "$HAVE_CERT" = 1 ]; then
    echo ""
    echo "# ---- 443 默认块：未匹配 server_name 的 https 一律拒绝 ----"
    echo "# 防止 supersnake 意外成为 443 的默认站点（会兜走 *.pippocao.top 的所有 https）"
    echo "server {"
    if [ "$H2_STYLE" = directive ]; then
      echo "    listen 443 ssl default_server;"
      echo "    listen [::]:443 ssl default_server;"
      echo "    http2 on;"
    else
      echo "    listen 443 ssl default_server http2;"
      echo "    listen [::]:443 ssl default_server http2;"
    fi
    echo "    server_name _;"
    # TLS 握手必须先完成才能看到 Host，所以这里也得挂证书（复用同一张即可）
    emit_ssl
    echo "    return 444;   # 直接关闭连接，不泄露任何服务信息"
    echo "}"
  fi
} | sudo tee "$SITE" > /dev/null

sudo ln -sfn "$SITE" /etc/nginx/sites-enabled/supersnake

echo "== 语法校验 =="
# 校验失败必须自动回滚：否则磁盘上留下坏配置，下次任何人 reload nginx 都会挂
# （在役 relay 也会跟着倒）。实测踩过一次：nginx 1.24 不认 "http2 on;"。
if ! sudo nginx -t; then
  echo "!! nginx -t 失败，自动回滚 $SITE"
  if sudo test -f "$BACKUP/sites-available/supersnake"; then
    sudo cp -a "$BACKUP/sites-available/supersnake" "$SITE"
    echo "   已恢复为备份版本"
  else
    sudo rm -f /etc/nginx/sites-enabled/supersnake
    echo "   备份中无此站点（首次运行），已摘掉 sites-enabled 软链"
  fi
  sudo nginx -t && echo "   回滚后配置合法（在役 nginx 未受影响）"
  exit 1
fi

echo "== reload（不中断现有连接）=="
sudo systemctl reload nginx

echo "== 自检 =="
sleep 1
# 都打到本机 127.0.0.1，用 Host 头 / --resolve 选中目标 server 块，
# 这样不依赖公网可达性（云控制台防火墙可能还没放行）。
probe_http() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
           -H "Host: $1" "http://127.0.0.1/" 2>/dev/null || echo ERR)
  printf "   %-26s http  -> %s\n" "$1" "$code"
}
probe_https() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
           --resolve "$1:443:127.0.0.1" "https://$1/" 2>/dev/null || echo ERR)
  printf "   %-26s https -> %s\n" "$1" "$code"
}
probe_http "$SERVER_IP"
[ -n "$DOMAIN_OFFICIAL" ] && probe_http "$DOMAIN_OFFICIAL"
[ -n "$DOMAIN_DEV" ]      && probe_http "$DOMAIN_DEV"
if [ "$HAVE_CERT" = 1 ]; then
  [ -n "$DOMAIN_OFFICIAL" ] && probe_https "$DOMAIN_OFFICIAL"
  [ -n "$DOMAIN_DEV" ]      && probe_https "$DOMAIN_DEV"
fi

# 共存校验：确认没有抢占别人的域名（这台机器还跑着家用 relay）
echo "   -- 共存校验（其他域名不应被 supersnake 接管）--"
OTHER_HTTP=$(curl -s --max-time 8 -H "Host: nas.pippocao.top" http://127.0.0.1/ \
  | grep -o '<title>[^<]*' | head -1)
printf "   %-26s http  -> %s\n" "nas.pippocao.top" "${OTHER_HTTP:-无 title}"
case "$OTHER_HTTP" in
  *消食蛇*) echo "   !! 警告：80 上抢占了其他域名，检查是否误加 default_server" ;;
esac
if [ "$HAVE_CERT" = 1 ]; then
  # 注意：curl 失败时本身就会把 %{http_code} 输出成 000，
  # 再叠一层 `|| echo 000` 会拼成 "000000"（实测踩过）。这里只兜异常退出。
  OTHER_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -k \
    --resolve "nas.pippocao.top:443:127.0.0.1" "https://nas.pippocao.top/" 2>/dev/null) || true
  OTHER_CODE="${OTHER_CODE:-000}"
  # 期望 000：444 是"直接断连不回响应"，curl 侧表现为连接被重置 → http_code 为 000
  printf "   %-26s https -> %s %s\n" "nas.pippocao.top" "$OTHER_CODE" \
    "$([ "$OTHER_CODE" = "000" ] && echo '(444 断连，符合预期)' || echo '(!! 未被拒绝，检查 443 default_server)')"
fi

# relay 回归（这台机器还跑着家用 relay，每次改 nginx 都要确认没伤到它）
# relay 架构：nginx **stream 四层** 8527-8529 → frps 18527-18529 → 家里 NAS。
# 与本脚本的 http 80/443 server 块**不同端口不同模块**，理论上不可能互相影响，
# 但既然共用一个 nginx 进程（reload 会重载全部配置），每次仍实测一遍更稳妥。
#
# ⚠ 探测方法很重要（实测踩过误判）：
#   这些端口后面是 **HTTPS** 服务（8527 是 NAS 上的 Lucky，证书 CN=Lucky），
#   用 `curl http://...` 探测会得到 000，看起来像"链路挂了"，其实只是协议不对。
#   正确做法：TCP 可连性 + `curl -k https://`。
echo "   -- relay 回归（stream 四层，与本配置不同端口）--"
for p in 8527 8528 8529; do
  if timeout 3 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/$p" 2>/dev/null; then
    printf "   relay :%s TCP 可连 ✓\n" "$p"
  else
    printf "   relay :%s !! 连不上，请检查 frps 与 stream.d 配置\n" "$p"
  fi
done

echo ""
echo "== 完成。回滚方法："
echo "   sudo rm /etc/nginx/sites-enabled/supersnake && sudo systemctl reload nginx"
echo "   完整备份在 $BACKUP"
