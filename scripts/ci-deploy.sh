#!/usr/bin/env bash
# ci-deploy.sh — 在 GitHub Actions runner 上执行：把 deploy-remote.sh 经 TAT 下发并验收。
# 依赖环境变量：ENV（official|dev） BRANCH（main|develop） INSTANCE_ID（ins-xxx / lhins-xxx）
#               PUBLIC_URL（公网验收地址，**可为空**——见下）
# 前置：tccli 已装好且持有 OIDC 换来的临时凭证（TENCENTCLOUD_* 环境变量）。
#
# PUBLIC_URL 为空时跳过公网验收：后端已改为仅监听 127.0.0.1（唯一入口 nginx:80），
# 无域名阶段测试环境在 80 上无法与正式区分，此时由 deploy-remote.sh 的
# 服务器内部自检（curl 127.0.0.1:$PORT）兜底。有域名后填上即恢复端到端验收。
set -euo pipefail

: "${ENV:?}"; : "${BRANCH:?}"; : "${INSTANCE_ID:?}"
PUBLIC_URL="${PUBLIC_URL:-}"
REGION=ap-hongkong
REF="${GITHUB_SHA:?}"

sed -e "s|__ENV__|$ENV|g" -e "s|__BRANCH__|$BRANCH|g" -e "s|__REF__|$REF|g" \
  scripts/deploy-remote.sh > /tmp/deploy-remote.sh
CONTENT=$(base64 -w0 /tmp/deploy-remote.sh)

echo "== invoking TAT on $INSTANCE_ID (env=$ENV branch=$BRANCH ref=$REF) =="
# 用 RunCommand 而非 InvokeCommand：
#   InvokeCommand 触发【已保存】的命令，CommandId 必填（我们没预建命令，会报
#   "the following arguments are required: --CommandId"）。
#   RunCommand 直接下发临时命令（Content base64 + CommandType + InstanceIds），
#   执行完即删，不需要 CommandId —— 每次部署的脚本内容都随 commit 变化，
#   本就不该存成固定命令。实测踩过（exit 252）。
INV=$(tccli tat RunCommand --region "$REGION" \
  --InstanceIds "[\"$INSTANCE_ID\"]" \
  --Content "$CONTENT" \
  --CommandType SHELL \
  --Username ubuntu \
  --Timeout 300 \
  --output json)
INV_ID=$(echo "$INV" | jq -r '.Response.InvocationId')
echo "InvocationId: $INV_ID"

STATUS="PENDING"
for i in $(seq 1 60); do
  sleep 5
  STATUS=$(tccli tat DescribeInvocations --region "$REGION" \
    --InvocationIds "[\"$INV_ID\"]" --output json \
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
  --InvocationIds "[\"$INV_ID\"]" --output json || echo '{}')
EXIT_CODE=$(echo "$TASK" | jq -r '.Response.InvocationTaskSet[0].ExitCode // "unknown"')
echo "---- remote exit code: $EXIT_CODE ----"
echo "$TASK" | jq -r '.Response.InvocationTaskSet[0].Output // ""' | base64 -d 2>/dev/null \
  || echo "$TASK" | jq -r '.Response.InvocationTaskSet[0].Output // "no output"'
echo "------------------------------------------"

# 先判远端退出码：若部署脚本内部就失败了，直接报它，
# 不要让后面的公网 curl 先失败而掩盖真实原因（顺序很重要）。
if [ "$EXIT_CODE" != "0" ]; then
  echo "remote script exit=$EXIT_CODE (非 0，部署脚本内部有失败步骤，见上方 Output)"
  exit 1
fi

# 端到端验收：从公网拉页面（比 ExitCode 更硬的证据——服务真的活着）
if [ -n "$PUBLIC_URL" ]; then
  sleep 3

  # 1) 页面可达 + 内容抽检。只看 200 不够：nginx 兜错 server 块也会给 200
  #    （实测过所有子域名都落到 default 欢迎页的情况），所以必须校验标题。
  BODY=$(curl -fsS --max-time 15 "$PUBLIC_URL")
  echo "$BODY" | grep -q '消食蛇' || {
    echo "!! e2e 失败：$PUBLIC_URL 返回 200 但内容不是消食蛇页面（可能被 nginx 兜到了默认站点）"
    echo "$BODY" | head -20
    exit 1
  }
  echo "== e2e OK: $PUBLIC_URL 页面内容校验通过 =="

  # 2) WebSocket 握手。联机对战的命门，静态页 200 完全不能代表 ws 通。
  #    注意：/ws 必须走 HTTP/1.1——HTTP/2 里 Connection/Upgrade 头非法会被丢弃，
  #    请求退化成普通 GET /ws，被服务端静态白名单拒成 404（实测踩过这个假象）。
  WS_URL="${PUBLIC_URL%/}/ws"
  WS_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --http1.1 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$WS_URL" || true)
  if [ "$WS_CODE" = "101" ]; then
    echo "== e2e OK: WebSocket 握手 101（$WS_URL）=="
  else
    echo "!! e2e 失败：WebSocket 握手返回 $WS_CODE（期望 101），$WS_URL"
    echo "   排查方向：nginx 的 location /ws 是否转发了 Upgrade/Connection 头"
    exit 1
  fi
else
  echo "== e2e 跳过：PUBLIC_URL 未设置（由远端 curl 127.0.0.1:PORT 自检兜底）=="
fi

echo "== deploy verified: $ENV @ $REF =="
