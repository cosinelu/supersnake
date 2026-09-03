#!/usr/bin/env bash
# netem-weaknet.sh — 服务器侧真机弱网注入（tc netem），供 UDP 传输层真机复验用
#
# 用法：
#   sudo ./netem-weaknet.sh on  8092 --loss 20 --delay 60 --jitter 20
#   sudo ./netem-weaknet.sh off 8092          # 或 off all
#   sudo ./netem-weaknet.sh status
#
# ---------------------------------------------------------------------------
# 安全设计：为什么不能直接 `tc qdisc add dev eth0 root netem loss 20%`
# ---------------------------------------------------------------------------
# 这台机器**只有一块网卡 eth0，SSH 也走它**。对 root qdisc 加 20% 丢包
# 会立刻让自己的 SSH 会话卡死甚至断连，而断连后就再也进不去清理 ——
# 只能从云控制台走 VNC 救援。同一块卡上还跑着 nginx(80)、frps(7000/18527-9)、
# docker，全部会被牵连。
#
# 因此本脚本用 `prio` 分类 + `u32` 过滤器：
#   band 0/1 → 默认，无 netem（SSH、nginx、frps、docker 全走这里，零影响）
#   band 2   → 只挂 netem，仅由过滤器显式匹配的 UDP 端口进入
#
# 双保险：
#   1. 只匹配 **UDP(protocol 17) + 指定源端口**，TCP 一律不受影响
#   2. `on` 之后自动装一个 AUTO_OFF_SEC 的定时清理（at/systemd-run），
#      即使 SSH 断了、脚本被 Ctrl-C，netem 也会自动消失。
#      这条是硬要求：任何"必须靠人记得清理"的网络注入都会变成事故。
#
# 只影响**出向**（egress）。tc 的入向整形需要 ifb 重定向，额外一层风险，
# 而下行丢包（服务器→客户端）本来就是我们要验证的方向，出向足够。
set -uo pipefail

IFACE="${NETEM_IFACE:-eth0}"
HANDLE=1
NETEM_BAND=3          # prio 默认 3 个 band，band 2 对应 classid 1:3
AUTO_OFF_SEC="${NETEM_AUTO_OFF_SEC:-900}"   # 15 分钟兜底自动清理

die() { echo "错误: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = "0" ] || die "需要 root（用 sudo 运行）"; }

usage() {
  cat <<EOF
用法:
  $0 on  <udp-port> [--loss N] [--delay N] [--jitter N] [--reorder N]
  $0 off <udp-port|all>
  $0 status

参数（均为可选，缺省即不注入该项）:
  --loss N      丢包百分比，如 20 表示 20%
  --delay N     单向延迟 ms
  --jitter N    延迟抖动 ms（会产生乱序）
  --reorder N   乱序百分比（需配合 --delay）

环境变量:
  NETEM_IFACE          目标网卡（默认 eth0）
  NETEM_AUTO_OFF_SEC   自动清理倒计时秒数（默认 900，设 0 关闭兜底）

注意:
  - 只影响出向 UDP 指定端口，SSH/nginx/frps/docker 完全不受影响
  - on 之后会自动安排 ${AUTO_OFF_SEC}s 兜底清理，断连也不会残留
EOF
}

# 确保根 qdisc 是我们的 prio；已存在则复用（幂等）
ensure_root_qdisc() {
  if tc qdisc show dev "$IFACE" | grep -q "qdisc prio ${HANDLE}:"; then
    return 0
  fi
  # 若根上已有别人的 qdisc（如 mq/fq_codel 默认配置），替换为 prio。
  # 默认 qdisc 只做排队公平，替换不影响连通性；band 0/1 无 netem，
  # 所有未被过滤器匹配的流量行为不变。
  echo "[netem] 在 $IFACE 上建立 prio 根 qdisc（band 0/1 无损，band 2 挂 netem）"
  tc qdisc replace dev "$IFACE" root handle ${HANDLE}: prio bands 3 \
    || die "无法建立 prio qdisc"
}

cmd_on() {
  local port="$1"; shift
  [[ "$port" =~ ^[0-9]+$ ]] || die "端口必须是数字：$port"

  local loss="" delay="" jitter="" reorder=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --loss)    loss="${2:-}"; shift 2 ;;
      --delay)   delay="${2:-}"; shift 2 ;;
      --jitter)  jitter="${2:-}"; shift 2 ;;
      --reorder) reorder="${2:-}"; shift 2 ;;
      *) die "未知参数：$1" ;;
    esac
  done

  local netem_args=()
  if [ -n "$delay" ]; then
    netem_args+=(delay "${delay}ms")
    [ -n "$jitter" ] && netem_args+=("${jitter}ms")
    [ -n "$reorder" ] && netem_args+=(reorder "${reorder}%")
  elif [ -n "$jitter" ]; then
    # netem 的 jitter 必须挂在 delay 后面，单独给 jitter 无意义
    netem_args+=(delay "${jitter}ms" "${jitter}ms")
  fi
  [ -n "$loss" ] && netem_args+=(loss "${loss}%")

  [ ${#netem_args[@]} -gt 0 ] || die "至少要指定一项：--loss / --delay / --jitter"

  ensure_root_qdisc

  echo "[netem] band 2 注入: ${netem_args[*]}"
  tc qdisc replace dev "$IFACE" parent ${HANDLE}:${NETEM_BAND} \
    handle $((HANDLE + 10)): netem "${netem_args[@]}" \
    || die "netem 注入失败（内核缺 sch_netem？试 modprobe sch_netem）"

  # 过滤器：UDP(17) + 源端口 == port → band 2
  # prio 值用端口号保证不同端口的规则互不覆盖，也便于按端口精确删除
  echo "[netem] 过滤 UDP sport=$port → band 2"
  tc filter replace dev "$IFACE" protocol ip parent ${HANDLE}: prio "$port" u32 \
    match ip protocol 17 0xff \
    match ip sport "$port" 0xffff \
    flowid ${HANDLE}:${NETEM_BAND} \
    || die "过滤器安装失败"

  # 兜底自动清理：网络注入绝不能依赖"人记得关"
  if [ "$AUTO_OFF_SEC" != "0" ]; then
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --on-active="${AUTO_OFF_SEC}s" --unit="netem-autooff-${port}" \
        --collect /bin/bash -c \
        "tc filter del dev $IFACE protocol ip parent ${HANDLE}: prio $port 2>/dev/null; \
         tc qdisc del dev $IFACE parent ${HANDLE}:${NETEM_BAND} 2>/dev/null; true" \
        >/dev/null 2>&1 \
        && echo "[netem] 已安排 ${AUTO_OFF_SEC}s 后自动清理（断连也不残留）" \
        || echo "[netem] 警告: 兜底清理未安排成功，请务必手动 off"
    else
      echo "[netem] 警告: 无 systemd-run，未安排兜底清理，请务必手动 off"
    fi
  fi

  echo "[netem] 生效。SSH/nginx/frps 走 band 0，不受影响。"
  cmd_status
}

cmd_off() {
  local port="${1:-all}"
  if [ "$port" = "all" ]; then
    echo "[netem] 清除 $IFACE 上全部注入，恢复默认 qdisc"
    # 取消所有兜底定时器
    systemctl list-units --all --plain --no-legend 'netem-autooff-*' 2>/dev/null \
      | awk '{print $1}' | while read -r u; do
          [ -n "$u" ] && systemctl stop "$u" >/dev/null 2>&1
        done
    tc qdisc del dev "$IFACE" root 2>/dev/null
    # 交回内核默认（云主机通常是 mq/fq_codel），不指定则由 sysctl 默认接管
    echo "[netem] 已恢复。当前:"
  else
    echo "[netem] 移除 UDP 端口 $port 的注入"
    systemctl stop "netem-autooff-${port}" >/dev/null 2>&1 || true
    tc filter del dev "$IFACE" protocol ip parent ${HANDLE}: prio "$port" 2>/dev/null \
      || echo "[netem] （该端口没有过滤器，跳过）"
    # 若已无任何过滤器，顺手把 netem 也摘掉
    if ! tc filter show dev "$IFACE" parent ${HANDLE}: 2>/dev/null | grep -q 'match'; then
      tc qdisc del dev "$IFACE" parent ${HANDLE}:${NETEM_BAND} 2>/dev/null || true
      echo "[netem] 已无过滤器，netem 一并移除"
    fi
  fi
  cmd_status
}

cmd_status() {
  echo "--- qdisc on $IFACE ---"
  tc qdisc show dev "$IFACE"
  echo "--- filters ---"
  tc filter show dev "$IFACE" parent ${HANDLE}: 2>/dev/null || echo "(无)"
  local pending
  pending=$(systemctl list-units --all --plain --no-legend 'netem-autooff-*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
  [ -n "${pending// /}" ] && echo "--- 兜底清理定时器 --- $pending"
}

need_root
case "${1:-}" in
  on)     shift; [ $# -ge 1 ] || { usage; exit 1; }; cmd_on "$@" ;;
  off)    shift; cmd_off "${1:-all}" ;;
  status) cmd_status ;;
  *)      usage; exit 1 ;;
esac
