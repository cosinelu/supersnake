'use strict';
/**
 * config.js — 联机服务器配置（v3.0）
 * 测试可通过 Object.assign({}, base, overrides) 注入小参数（短倒计时/短对局等）。
 */
module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 8090, // ws 监听端口（生产由 Nginx /ws 反代到 127.0.0.1:8090）
  HOST: process.env.HOST || '127.0.0.1',

  TICK_MS: 33,              // 房间模拟步长（30Hz 固定步长）
  SNAP_EVERY: 2,            // 每 2 tick 广播一帧快照（15Hz）

  ROOM_SIZE: 4,             // 满编真人即开
  MIN_HUMANS: 1,            // 超时补位开局的最少真人数（=1：单人也能开局，其余由 AI 补位）
  MATCH_TIMEOUT_MS: 20000,  // 匹配等待上限：超时以现有真人 + AI 补位开局
  COUNTDOWN_MS: 3000,       // matched → start 倒计时
  MATCH_MAX_MS: 5 * 60 * 1000, // 对局上限，到点按总分结算
  OVER_LINGER_MS: 10000,    // 结算后房间保留时长（供客户端展示结算页）

  MAX_MSG_BYTES: 4096,      // 上行消息体积上限（防垃圾流量）
  INPUT_MAX_SEQ_JUMP: 1000, // input seq 异常跳变容忍（超出视为作弊/乱序，忽略）
  INPUT_SEQ_RESET_GAP: 64,  // seq 回退超过该幅度 → 视为客户端重新计数，重置基线
                            // （防「重连后 seq 归零而服务端 lastSeq 停在旧值」导致输入永久失效）

  // ---------------- UDP 传输层（v3.1，设计见 docs/architecture/02-udp-transport.md） ----------------
  UDP_ENABLED: process.env.UDP_ENABLED !== '0', // 总开关：关掉即回到纯 TCP（回滚点）
  UDP_PORT: parseInt(process.env.UDP_PORT, 10) || 8092,
  UDP_DUP: 3,               // 冗余副本份数（1 = 关闭冗余）。副本在帧内按时间均分打散：
                            // 丢包按时间段发生，同一毫秒连发的副本会同生共死，
                            // 3000 帧实测「x3 同时发」与「x1」结果完全相同。
  UDP_RATE_LIMIT: 400,      // 每源每秒包数上限（正常 30Hz×3=90，给 4 倍余量）
  UDP_SESSION_TTL_MS: 60000,// 会话空闲超时（NAT 映射通常 30s 失效，客户端有 5s keepalive）
  UDP_SNAP_CAP: 1400,       // 单帧字节硬约束：**永不触发 IP 分片**。
                            // 超限则把最远的蛇降级为 lite 档（binProtocol.encSnapCapped）。
                            // 一旦分片，缺任一片则整包在内核报废，
                            // 单片丢 2% 会放大成整帧报废 24.6%（14 片时），比 TCP 还糟。
  LOWFREQ_MS: 1000,         // 低频通道周期：昵称/计分/排行榜 + 色块全量校正（走 TCP）。
                            // 色块全量是增量同步的兜底 —— 漏收任一增量都会永久偏差。

  nowFn: Date.now           // 时间源（测试可注入）
};
