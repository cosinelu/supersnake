'use strict';
/**
 * config.js — 联机服务器配置（v3.0）
 * 测试可通过 Object.assign({}, base, overrides) 注入小参数（短倒计时/短对局等）。
 */
module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 8090, // ws 监听端口（生产由 Nginx /ws 反代到 127.0.0.1:8090）
  HOST: process.env.HOST || '127.0.0.1',

  TICK_MS: 33,              // 房间模拟步长（30Hz 固定步长）
  SNAP_EVERY: 1,            // 每 N tick 广播一帧快照。**三层频率互相独立**：
                            //   服务器模拟 30Hz（TICK_MS，不随此值变）
                            //   快照下行  30Hz / SNAP_EVERY（1=30Hz，2=15Hz）
                            //   客户端渲染 rAF 60Hz+（永不等网络）
                            // 客户端插值延迟由 matched.snapIntervalMs 自动推导
                            // （interpolation.js:deriveDelay），改这个值不需要动客户端。
                            // 降到 2 即回到 15Hz，带宽减半、延迟自动升到 ~120ms。

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
  // UDP 绑定地址**独立于 HOST**：ws 走 nginx 反代所以只需绑 127.0.0.1，
  // 但 UDP 没有反代（nginx stream 模块虽可转发 udp，但多一跳且掩盖源地址，
  // 会破坏「地址跟随」赖以工作的真实 IP:Port），必须直接监听公网。
  // 默认 0.0.0.0；本地开发/测试可用 UDP_HOST=127.0.0.1 收窄。
  UDP_HOST: process.env.UDP_HOST || '0.0.0.0',
  // 冗余副本份数（1 = 关闭冗余）。副本在帧内按时间均分打散：
  // 丢包按时间段发生，同一毫秒连发的副本会同生共死，
  // 3000 帧实测「x3 同时发」与「x1」结果完全相同（见 test/net/weaknet.test.js）。
  // **做成环境变量可配**：这是抗丢包的核心旋钮，真机弱网排障时需要现场做
  // 「有冗余 vs 无冗余」的对照实验（`UDP_DUP=1` 起个临时实例即可）。
  // 硬编码会逼人改代码重部署，而改代码本身就改变了被测对象。
  UDP_DUP: parseInt(process.env.UDP_DUP, 10) > 0
    ? parseInt(process.env.UDP_DUP, 10) : 3,
  UDP_RATE_LIMIT: 400,      // 每源每秒包数上限（正常 30Hz×3=90，给 4 倍余量）
  UDP_SESSION_TTL_MS: 60000,// 会话空闲超时（NAT 映射通常 30s 失效，客户端有 5s keepalive）
  UDP_SNAP_CAP: 1400,       // 单帧字节硬约束：**永不触发 IP 分片**。
                            // 超限则把最远的蛇降级为 lite 档（binProtocol.encSnapCapped）。
                            // 一旦分片，缺任一片则整包在内核报废，
                            // 单片丢 2% 会放大成整帧报废 24.6%（14 片时），比 TCP 还糟。
  LOWFREQ_MS: 1000,         // 低频通道周期：昵称/计分/排行榜 + 色块全量校正（走 TCP）。
                            // 色块全量是增量同步的兜底 —— 漏收任一增量都会永久偏差。

  // ---------------- WebTransport（v3.1 阶段 1d，浏览器的 UDP 通道） ----------------
  // 浏览器没有裸 UDP，只能走 WebTransport（HTTP/3 over QUIC，2026-03 起 Baseline）。
  // datagram 语义与本项目 UDP 通道完全一致 ⇒ 协议层 / 冗余打散 / 去重全部原样复用。
  // 设计见 docs/architecture/02-udp-transport.md §7.4.1。
  //
  // **默认关**：依赖 native addon 与证书文件，本地开发通常两者都缺；
  // 生产由 systemd 显式设 WT_ENABLED=1。
  WT_ENABLED: process.env.WT_ENABLED === '1',
  // 端口规划：official 443（穿透性最好，nginx 只占 TCP 443）/ dev 8093（挨着 8092）。
  // **环境隔离只能靠端口**：Http3Server 只收单套证书、无 SNI 分流，
  // 一个进程独占一个 UDP 端口 —— 这与 wss 靠 nginx server_name 分流正好相反。
  // 用 >= 0 判断而非 ||：0 是「随机空闲端口」的合法值（测试用）。
  WT_PORT: parseInt(process.env.WT_PORT, 10) >= 0
    ? parseInt(process.env.WT_PORT, 10) : 8093,
  WT_HOST: process.env.WT_HOST || '0.0.0.0',   // 同 UDP_HOST：必须直面公网（无反代）
  // 证书路径：**必须由环境变量提供，代码里不写死**。
  // 理由与 wsTransport 的服务器地址同源：路径里含域名会让代码与某套部署绑死，
  // 也是本项目 check-hygiene.sh 明确拦截的「硬编码地址」（会造成环境串台）。
  // systemd unit 里设 WT_CERT / WT_KEY 指向 letsencrypt 的 pem 即可。
  //
  // 与 nginx 共用同一份文件没有冲突（一 TCP 一 UDP，socket 不同、PEM 只读）。
  // 现有证书 SAN 已同时覆盖 dev 与 official 两个子域，两环境共用即可，无需签新证书。
  // certbot 续期后需 reload nginx **并** 让本进程 updateCert（renewal-hooks/deploy）。
  WT_CERT: process.env.WT_CERT || null,
  WT_KEY: process.env.WT_KEY || null,
  WT_SECRET: process.env.WT_SECRET || null,    // 缺省随机；仅库内部用

  nowFn: Date.now           // 时间源（测试可注入）
};
