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

  nowFn: Date.now           // 时间源（测试可注入）
};
