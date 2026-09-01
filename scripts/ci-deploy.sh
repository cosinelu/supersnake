#!/usr/bin/env bash
# ci-deploy.sh — 在 GitHub Actions runner 上执行：把 deploy-remote.sh 经 TAT 下发并验收。
# 依赖环境变量：ENV（official|dev） BRANCH（main|develop） INSTANCE_ID（lhins-xxx）
#               PUBLIC_URL（公网验收地址）
# 前置：tccli 已装好且持有 OIDC 换来的临时凭证（TENCENTCLOUD_* 环境变量）。
set -euo pipefail

: "${ENV:?}"; : "${BRANCH:?}"; : "${INSTANCE_ID:?}"; : "${PUBLIC_URL:?}"
REGION=ap-hongkong
REF="${GITHUB_SHA:?}"

sed -e "s|__ENV__|$ENV|g" -e "s|__BRANCH__|$BRANCH|g" -e "s|__REF__|$REF|g" \
  scripts/deploy-remote.sh > /tmp/deploy-remote.sh
CONTENT=$(base64 -w0 /tmp/deploy-remote.sh)

echo "== invoking TAT on $INSTANCE_ID (env=$ENV branch=$BRANCH ref=$REF) =="
INV=$(tccli tat InvokeCommand --region "$REGION" \
  --InstanceIds "[\"$INSTANCE_ID\"]" \
  --Content "$CONTENT" \
  --CommandType SHELL \
  --Username ubuntu \
  --Timeout 300 \
  --Output json)
INV_ID=$(echo "$INV" | jq -r '.Response.InvocationId')
echo "InvocationId: $INV_ID"

STATUS="PENDING"
for i in $(seq 1 60); do
  sleep 5
  STATUS=$(tccli tat DescribeInvocations --region "$REGION" \
    --InvocationIds "[\"$INV_ID\"]" --Output json \
    | jq -r '.Response.InvocationSet[0].InvocationStatus')
  echo "[poll $i] invocation status: $STATUS"
  case "$STATUS" in
    PENDING|DELIVERING|DELIVER_DELAYED|RUNNING) ;;
    *) break ;;
  esac
done

# 拉取远端任务的退出码与输出（Output 为 base64；参数名若与 tccli 版本不符，以
# `tccli tat DescribeInvocationTasks help` 输出为准修正——见部署文档验收清单）
TASK=$(tccli tat DescribeInvocationTasks --region "$REGION" \
  --InvocationIds "[\"$INV_ID\"]" --Output json || echo '{}')
EXIT_CODE=$(echo "$TASK" | jq -r '.Response.InvocationTaskSet[0].ExitCode // "unknown"')
echo "---- remote exit code: $EXIT_CODE ----"
echo "$TASK" | jq -r '.Response.InvocationTaskSet[0].Output // ""' | base64 -d 2>/dev/null \
  || echo "$TASK" | jq -r '.Response.InvocationTaskSet[0].Output // "no output"'
echo "------------------------------------------"

# 端到端验收：从公网拉页面（比 ExitCode 更硬的证据——服务真的活着）
sleep 3
curl -fsS --max-time 15 "$PUBLIC_URL" > /dev/null
echo "== e2e OK: $PUBLIC_URL serving =="

if [ "$EXIT_CODE" != "0" ]; then
  echo "remote script exit=$EXIT_CODE (非 0，部署脚本内部有失败步骤)"
  exit 1
fi
echo "== deploy verified: $ENV @ $REF =="
