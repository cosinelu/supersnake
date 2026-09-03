'use strict';
/**
 * transportHub.js — 加速通道聚合（v3.1 阶段 1d）
 *
 * 把「裸 UDP（小游戏/Node）」与「WebTransport（浏览器）」两个端点聚合成
 * **一个与 UdpEndpoint 完全同构的对象**，交给 room.js 使用。
 *
 * ---------------------------------------------------------------------------
 * 为什么要这一层，而不是在 room.js 里写 if/else
 * ---------------------------------------------------------------------------
 * room.js 只通过 4 个方法用加速通道：offer / isReady / sendFrame / dropSession。
 * 只要保持这 4 个方法的语义，room.js 就**一行都不用改** ——
 * 房间逻辑不该知道「玩家是小游戏还是浏览器」，那是传输层的事。
 *
 * 反过来说：一旦让 room.js 去分辨通道，判定/广播逻辑就会长出两条分支，
 * 而这两条分支的差异其实只有「管道」而已（协议、编码、冗余策略完全相同）。
 *
 * ---------------------------------------------------------------------------
 * 路由规则
 * ---------------------------------------------------------------------------
 * `offer` 把**两条通道的接入信息都下发**（`udpPort`/`udpToken` +
 * `wtPort`/`wtToken`），由客户端按自身能力挑一条打洞：
 *   小游戏 → wx.createUDPSocket → 裸 UDP
 *   浏览器 → WebTransport       → WT
 *   Node   → dgram              → 裸 UDP
 * 服务器不猜，谁打通了就用谁（`isReady` 按连接实测）。
 *
 * 两条都通时优先裸 UDP：它开销更低（无 QUIC 加密与拥塞控制层），
 * 且这种情况只出现在测试环境里 —— 真实客户端只会具备其中一种能力。
 */

/**
 * @param {object} opts { udp: UdpEndpoint|null, wt: WebTransportEndpoint|null }
 */
function TransportHub(opts) {
  opts = opts || {};
  this.udp = opts.udp || null;
  this.wt = opts.wt || null;
}

/** 是否至少有一条加速通道可用（决定房间要不要走低频通道/增量同步） */
TransportHub.prototype.enabled = function () {
  return !!(this.udp || this.wt);
};

/**
 * 下发两条通道的接入信息。
 * @returns {{port:number, token:number, wtPort:number, wtToken:number, wtPath:string}|null}
 *   与 UdpEndpoint.offer 兼容（port/token 字段名不变），额外带 wt* 字段。
 *   两条都不可用时返回 null（客户端全程走 TCP）。
 */
TransportHub.prototype.offer = function (connId, roomId) {
  var out = null;
  if (this.udp) {
    var u = this.udp.offer(connId, roomId);
    if (u) out = { port: u.port, token: u.token };
  }
  if (this.wt) {
    var w = this.wt.offer(connId, roomId);
    if (w) {
      out = out || {};
      out.wtPort = w.port;
      out.wtToken = w.token;
      out.wtPath = w.path;
    }
  }
  return out;
};

/** 该连接是否有任一加速通道已打通 */
TransportHub.prototype.isReady = function (connId) {
  if (this.udp && this.udp.isReady(connId)) return true;
  if (this.wt && this.wt.isReady(connId)) return true;
  return false;
};

/**
 * 按该连接**实际打通的通道**发送。
 * 两条都通时优先裸 UDP（开销更低；实际只会出现在测试环境）。
 */
TransportHub.prototype.sendFrame = function (connId, bytes) {
  if (this.udp && this.udp.isReady(connId)) {
    return this.udp.sendFrame(connId, bytes);
  }
  if (this.wt && this.wt.isReady(connId)) {
    return this.wt.sendFrame(connId, bytes);
  }
  return false;
};

/** 连接断开：两条通道的会话都要清，否则令牌泄漏 */
TransportHub.prototype.dropSession = function (connId) {
  if (this.udp) this.udp.dropSession(connId);
  if (this.wt) this.wt.dropSession(connId);
};

/** 诊断：该连接走的是哪条通道（供日志/验证脚本用） */
TransportHub.prototype.channelOf = function (connId) {
  if (this.udp && this.udp.isReady(connId)) return 'udp';
  if (this.wt && this.wt.isReady(connId)) return 'wt';
  return 'tcp';
};

module.exports = TransportHub;
