#!/usr/bin/env bash
# deploy-remote.sh — 在服务器上执行的部署脚本（由 CI 经 TAT InvokeCommand 下发）
# 占位符 __ENV__ / __BRANCH__ / __REF__ 由 scripts/ci-deploy.sh 在 runner 侧替换后下发。
# 环境：ENV=official (PORT 8090, /opt/supersnake/official) 或 ENV=dev (PORT 8091, /opt/supersnake/dev)
#
# v3.1 起还有 UDP 端点（official 8094 / dev 8092）。它与 ws 端口的关键差异：
#   ws  走 nginx 反代 → 只监听 127.0.0.1
#   UDP **没有反代** → 必须直接绑 0.0.0.0
#   （走 nginx stream 转发会多一跳且掩盖真实源地址，破坏「地址跟随」，
#    而地址跟随正是 NAT 重绑定 / 4G↔WiFi 切换后还能认出玩家的机制）
# 因此 UDP 端口需要在**两层**放行：服务器 ufw + 云轻量控制台（后者只能手动操作）。
# UDP 不通不影响可玩性 —— 客户端 1.5s 握手超时后自动全程走 TCP。
set -euo pipefail

ENV=__ENV__
BRANCH=__BRANCH__
REF=__REF__

case "$ENV" in
  official) PORT=8090; UDP_PORT=8094 ;;
  dev)      PORT=8091; UDP_PORT=8092 ;;
  *) echo "bad ENV: $ENV"; exit 2 ;;
esac

DIR="/opt/supersnake/$ENV"
UNIT="supersnake-$ENV.service"
KEY="/opt/supersnake/deploy_key"
export GIT_SSH_COMMAND="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes"

echo "== deploy start: env=$ENV branch=$BRANCH ref=$REF =="

cd "$DIR"
git fetch origin "$BRANCH"
git reset --hard "$REF"
echo "== code now at $(git rev-parse HEAD) =="

(cd server && npm ci --omit=dev)

sudo systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT" || { systemctl status "$UNIT" || true; echo "unit not active"; exit 1; }

curl -fsS --max-time 10 "http://127.0.0.1:$PORT/" > /dev/null

# UDP 端点自检：不通只告警不失败（客户端会自动降级 TCP，游戏照常可玩）
if ss -ulnp 2>/dev/null | grep -q ":$UDP_PORT "; then
  echo "== UDP endpoint listening on :$UDP_PORT =="
else
  echo "!! UDP endpoint NOT listening on :$UDP_PORT — 客户端将全程走 TCP"
  echo "!! 检查项：systemd unit 是否设置 UDP_PORT=$UDP_PORT，ufw 与云控制台是否放行"
fi

echo "== deploy OK: $ENV @ $REF on :$PORT (udp :$UDP_PORT) =="
