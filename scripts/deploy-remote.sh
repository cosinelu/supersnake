#!/usr/bin/env bash
# deploy-remote.sh — 在服务器上执行的部署脚本（由 CI 经 TAT InvokeCommand 下发）
# 占位符 __ENV__ / __BRANCH__ / __REF__ 由 scripts/ci-deploy.sh 在 runner 侧替换后下发。
# 环境：ENV=official (PORT 8090, /opt/supersnake/official) 或 ENV=dev (PORT 8091, /opt/supersnake/dev)
set -euo pipefail

ENV=__ENV__
BRANCH=__BRANCH__
REF=__REF__

case "$ENV" in
  official) PORT=8090 ;;
  dev)      PORT=8091 ;;
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
echo "== deploy OK: $ENV @ $REF on :$PORT =="
