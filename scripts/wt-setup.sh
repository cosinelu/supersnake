#!/usr/bin/env bash
# wt-setup.sh — 为已部署的 supersnake 进程启用 WebTransport（阶段 1d）
#
# 用法：
#   sudo ./wt-setup.sh dev        # 测试环境，UDP 8093
#   sudo ./wt-setup.sh official   # 正式环境，UDP 443（需 CAP_NET_BIND_SERVICE）
#   sudo ./wt-setup.sh status
#   sudo ./wt-setup.sh off dev    # 撤销（删 drop-in 即回到纯 wss）
#
# ---------------------------------------------------------------------------
# 为什么用 systemd drop-in 而不改原 unit
# ---------------------------------------------------------------------------
# 原 unit 由 scripts/server-init.sh 生成，重跑那个脚本会覆盖手改内容。
# drop-in（$UNIT.d/10-webtransport.conf）叠加在原 unit 之上，
# **删掉即完全恢复**，也不会被 server-init.sh 冲掉。
#
# ---------------------------------------------------------------------------
# 三个与原 unit 硬化选项的冲突（必须显式解决，否则服务起不来）
# ---------------------------------------------------------------------------
# 1. `NoNewPrivileges=true` 会让 AmbientCapabilities 失效
#    ⇒ 绑 443 的场景必须置为 false（dev 用 8093 则不需要）
# 2. `ProtectHome=read-only` 不影响 /etc/letsencrypt，但
#    `ProtectSystem=full` 会把 /etc 挂成只读 —— 只读足够（我们只读证书），
#    所以这条**不用动**
# 3. letsencrypt 的私钥默认 root:root 0600，而服务以 ubuntu 运行
#    ⇒ 需要给证书目录加可读权限（用 certbot 官方推荐的 group 方式）
set -uo pipefail

ENVNAME="${2:-${1:-}}"
ACTION="${1:-}"
CERT_DIR_DEFAULT=""

die() { echo "错误: $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "需要 root（用 sudo 运行）"

usage() {
  cat <<EOF
用法:
  $0 dev | official      启用 WebTransport
  $0 off dev|official    撤销（回到纯 wss）
  $0 status              查看当前状态

端口规划（见 docs/plan/02-udp-refactor-plan.md）:
  dev       → UDP 8093
  official  → UDP 443（穿透性最好；需 CAP_NET_BIND_SERVICE）

注意: 云控制台防火墙需**手动**放行对应 UDP 端口，SSH 改不了那一层。
EOF
}

# 找到 letsencrypt 证书目录（不写死域名：避免环境串台，与 check-hygiene 的原则一致）
find_cert_dir() {
  local d
  for d in /etc/letsencrypt/live/*/; do
    [ -f "$d/fullchain.pem" ] && [ -f "$d/privkey.pem" ] && { echo "${d%/}"; return 0; }
  done
  return 1
}

# 让 ubuntu 能读证书：certbot 官方做法是给 archive/live 目录加组可读，
# 而不是 chmod 私钥本身（后者会被续期重置）
grant_cert_read() {
  local user="$1"
  if ! getent group letsencrypt >/dev/null 2>&1; then
    groupadd letsencrypt
    echo "[wt] 建组 letsencrypt"
  fi
  usermod -aG letsencrypt "$user" 2>/dev/null || true
  chgrp -R letsencrypt /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
  chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
  echo "[wt] 已授予 $user 读取证书的权限（通过 letsencrypt 组）"
}

do_enable() {
  local env="$1" unit port needcap
  case "$env" in
    dev)      unit="supersnake-dev";      port=8093; needcap=0 ;;
    official) unit="supersnake-official"; port=443;  needcap=1 ;;
    *) usage; exit 1 ;;
  esac
  systemctl list-unit-files "$unit.service" >/dev/null 2>&1 \
    || die "找不到 $unit.service（先跑 scripts/server-init.sh）"

  # 先确认这份 checkout 的代码**真的支持** WT，再动配置。
  # 实测踩过：official 分支还没合入 1d，WT_ENABLED=1 对它只是个没人读的环境变量，
  # 服务照常起来、日志一片正常、443 就是不监听 —— 而脚本却把原因指向
  # 「证书不可读 / 端口被占 / addon 缺失」，排查方向被完全带偏。
  # 配置正确但代码不认，是最难自证的一类故障，必须前置拦住。
  local wd
  wd="$(systemctl show "$unit" -p WorkingDirectory --value)"
  [ -n "$wd" ] || die "无法取得 $unit 的 WorkingDirectory"
  [ -f "$wd/server/webtransport.js" ] \
    || die "$wd 的代码不含 server/webtransport.js
       ⇒ 该分支还没合入阶段 1d，配置写了也不会生效。
       先把 1d 合并部署到该环境，再运行本脚本。"
  [ -d "$wd/server/node_modules/@fails-components" ] \
    || die "$wd 缺少 WebTransport 依赖（@fails-components/*）
       ⇒ 在该 checkout 下跑 npm ci --omit=dev，或重新触发 CI 部署。"

  local cert_dir
  cert_dir="$(find_cert_dir)" || die "找不到 letsencrypt 证书（先跑 certbot）"
  echo "[wt] 使用证书目录: $cert_dir"

  local svc_user
  svc_user="$(systemctl show "$unit" -p User --value)"
  [ -n "$svc_user" ] || svc_user=root
  [ "$svc_user" != "root" ] && grant_cert_read "$svc_user"

  local dropin_dir="/etc/systemd/system/$unit.service.d"
  mkdir -p "$dropin_dir"
  {
    echo "[Service]"
    echo "Environment=WT_ENABLED=1"
    echo "Environment=WT_PORT=$port"
    echo "Environment=WT_HOST=0.0.0.0"
    echo "Environment=WT_CERT=$cert_dir/fullchain.pem"
    echo "Environment=WT_KEY=$cert_dir/privkey.pem"
    if [ "$needcap" = "1" ]; then
      # 绑 443 需要该 capability；而 NoNewPrivileges=true 会让它失效，
      # 故必须一并置为 false（这是 systemd 的既定交互，不是本项目的选择）
      echo "AmbientCapabilities=CAP_NET_BIND_SERVICE"
      echo "CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
      echo "NoNewPrivileges=false"
    fi
    # 证书属 letsencrypt 组，需让服务拿到该组
    echo "SupplementaryGroups=letsencrypt"
  } > "$dropin_dir/10-webtransport.conf"
  echo "[wt] 已写 $dropin_dir/10-webtransport.conf"

  # ufw（云控制台那层要手动）
  ufw allow "$port/udp" comment "supersnake $env webtransport" >/dev/null 2>&1 \
    && echo "[wt] ufw 已放行 $port/udp"

  systemctl daemon-reload
  systemctl restart "$unit"
  sleep 3
  systemctl is-active --quiet "$unit" \
    && echo "[wt] $unit 已重启并运行" \
    || { journalctl -u "$unit" -n 20 --no-pager; die "$unit 启动失败（日志见上）"; }

  echo ""
  if ss -ulnp 2>/dev/null | grep -q ":$port "; then
    echo "[wt] ✓ UDP $port 已监听"
  else
    echo "[wt] ✗ UDP $port 未监听"
    echo "     按可能性排查："
    echo "       1. 证书不可读 —— sudo -u $svc_user head -1 $cert_dir/privkey.pem"
    echo "       2. 端口被占   —— sudo ss -ulnp | grep ':$port '"
    echo "       3. addon 缺失 —— ls $wd/server/node_modules/@fails-components/"
    echo "     日志: journalctl -u $unit -n 50 --no-pager | grep -i 'wt\\|quic\\|cert'"
  fi
  echo ""
  echo "下一步（**必须手动**）：在云控制台防火墙放行 UDP $port。"
  echo "SSH 改不了那一层；ufw 放行但公网不通 ⇒ 一定卡在控制台。"
}

do_disable() {
  local env="$1" unit
  case "$env" in
    dev)      unit="supersnake-dev" ;;
    official) unit="supersnake-official" ;;
    *) usage; exit 1 ;;
  esac
  rm -f "/etc/systemd/system/$unit.service.d/10-webtransport.conf"
  systemctl daemon-reload
  systemctl restart "$unit"
  echo "[wt] 已撤销 $unit 的 WebTransport（回到纯 wss）"
}

do_status() {
  local u
  for u in supersnake-dev supersnake-official; do
    systemctl list-unit-files "$u.service" >/dev/null 2>&1 || continue
    echo "--- $u ---"
    echo "  active: $(systemctl is-active "$u")"
    local f="/etc/systemd/system/$u.service.d/10-webtransport.conf"
    if [ -f "$f" ]; then
      grep -E "WT_PORT|WT_ENABLED" "$f" | sed 's/^/  /'
      local p
      p="$(grep -oP 'WT_PORT=\K[0-9]+' "$f" || true)"
      [ -n "$p" ] && {
        ss -ulnp 2>/dev/null | grep -q ":$p " \
          && echo "  UDP $p: 已监听" || echo "  UDP $p: 未监听"
      }
    else
      echo "  WebTransport: 未启用"
    fi
  done
}

case "$ACTION" in
  dev|official) do_enable "$ACTION" ;;
  off)          do_disable "${2:-}" ;;
  status)       do_status ;;
  *)            usage; exit 1 ;;
esac
