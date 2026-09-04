'use strict';
/**
 * netemProxy.js — 弱网注入设施（v3.1 弱网验证）
 *
 * 提供两样东西，**共用同一套丢包判定逻辑**：
 *   1. `LossChannel` —— 纯函数式的信道模型（可复现、无定时器、可跑几千帧）
 *   2. `WeakNetProxy` —— 真实 UDP 中继，把 LossChannel 套在真 socket 之间
 *
 * 为什么要两个：
 *   统计结论（到达率、陈旧度分布）需要**几千帧的样本量**才稳定，而真实
 *   socket + 定时器跑几千帧要几分钟，且必然引入 flake。反过来，纯模型
 *   证明不了真实代码栈（打散调度、去重、地址跟随）真的按模型行为。
 *   所以：**模型提供统计功效，真机运行提供地面真值**，两者共用同一个
 *   `LossChannel` 保证模型不是另一套虚构。
 *
 * ---------------------------------------------------------------------------
 * 关键设计：丢包必须是**时间相关**的，不能按包独立判定
 * ---------------------------------------------------------------------------
 * 若每个包独立以概率 p 丢弃，则同一帧的 N 个副本各自独立存活，
 * 「三份同时发」与「三份打散」的帧到达率**完全相同** ——
 * 此时冗余打散是纯粹的浪费，而测试会显示两者无差异，
 * 结论「打散有用」变成不可证伪的信仰。
 *
 * 真实世界的丢包**成窗口出现**（基站切换、缓冲区溢出、Wi-Fi 干扰），
 * 窗口宽度典型 20~100ms。窗口内几乎全丢，窗口外几乎不丢。
 * 只有在这种模型下，「把副本摊到窗口宽度之外」才真正提高存活率。
 *
 * 因此 `LossChannel` 的坏窗口按**到达时刻**判定（相对信道起点的时间轴），
 * 而不是按包序号 —— 这既是物理上正确的模型，也是让冗余打散可被验证的前提。
 *
 * 用法（模型）：
 *   var ch = new LossChannel({ seed: 7, burst: { periodMs: 150, durationMs: 60 } });
 *   ch.passes(tMs)  // → true 表示该时刻发出的包能到达
 *
 * 用法（真机）：
 *   var px = new WeakNetProxy({ serverHost, serverPort, down: {...}, up: {...} });
 *   px.listen(function () { clientSendsTo(px.port()); });
 */
var dgram = require('dgram');
var path = require('path');

// 复用项目自带的确定性 RNG（xorshift），避免再引一份实现
require(path.join(__dirname, '..', '..', 'js', 'utils.js'));
var makeRng = globalThis.CS.utils.makeRng;

/**
 * 信道丢包模型。
 *
 * @param {object} opts
 *   seed        {number}  RNG 种子（同种子 → 完全可复现）
 *   loss        {number}  基础均匀丢包率 0~1（窗口外也生效，模拟常态丢包）
 *   burst       {object|null} 坏窗口：{ periodMs, durationMs, loss }
 *                        periodMs   窗口起点间隔（每 periodMs 出现一次坏窗口）
 *                        durationMs 窗口宽度
 *                        loss       窗口内丢包率（默认 0.95）
 *   delayMs     {number}  基础单向延迟
 *   jitterMs    {number}  延迟抖动幅度（±jitterMs/2，会自然产生乱序）
 */
function LossChannel(opts) {
  opts = opts || {};
  this.seed = opts.seed == null ? 1 : opts.seed;
  this.loss = opts.loss || 0;
  this.burst = opts.burst || null;
  this.delayMs = opts.delayMs || 0;
  this.jitterMs = opts.jitterMs || 0;
  this.rng = makeRng(this.seed);
  this.stats = { seen: 0, dropped: 0, droppedInBurst: 0, droppedUniform: 0 };
}

/**
 * 该时刻是否落在坏窗口内。
 * tMs 是**相对信道起点**的毫秒数（真机由 Date.now()-t0 给出）。
 */
LossChannel.prototype.inBurst = function (tMs) {
  if (!this.burst) return false;
  var p = this.burst.periodMs, d = this.burst.durationMs;
  if (!(p > 0) || !(d > 0)) return false;
  // 窗口位于每个周期的前 d 毫秒
  return (tMs % p) < d;
};

/**
 * 判定一个在 tMs 时刻发出的包能否到达。
 * @returns {boolean}
 */
LossChannel.prototype.passes = function (tMs) {
  this.stats.seen++;
  if (this.inBurst(tMs)) {
    var bl = this.burst.loss == null ? 0.95 : this.burst.loss;
    if (this.rng() < bl) {
      this.stats.dropped++; this.stats.droppedInBurst++;
      return false;
    }
    return true;
  }
  if (this.loss > 0 && this.rng() < this.loss) {
    this.stats.dropped++; this.stats.droppedUniform++;
    return false;
  }
  return true;
};

/** 本次传输的单向延迟（含抖动，可能造成乱序） */
LossChannel.prototype.latency = function () {
  if (!this.delayMs && !this.jitterMs) return 0;
  var j = this.jitterMs ? (this.rng() - 0.5) * this.jitterMs : 0;
  var v = this.delayMs + j;
  return v > 0 ? v : 0;
};

/** 实测丢包率（用于断言「注入真的生效了」，防止代理静默失效导致测试空转） */
LossChannel.prototype.lossRate = function () {
  return this.stats.seen ? this.stats.dropped / this.stats.seen : 0;
};

LossChannel.prototype.reset = function () {
  this.rng = makeRng(this.seed);
  this.stats = { seen: 0, dropped: 0, droppedInBurst: 0, droppedUniform: 0 };
};

// ---------------------------------------------------------------------------

/**
 * 真实 UDP 中继：客户端 ↔ 代理 ↔ 服务器，双向注入丢包/延迟。
 *
 * 每个代理实例只服务**一个**客户端（学到的第一个上行地址即客户端地址）。
 * 这样每个客户端在服务器眼里有独立的源地址 —— 既避开服务器的每源限速，
 * 也正确模拟了「各客户端有各自的 NAT 映射」。
 *
 * @param {object} opts
 *   serverHost / serverPort  真实服务器 UDP 端点
 *   up   {object} 上行（客户端→服务器）信道参数，见 LossChannel
 *   down {object} 下行（服务器→客户端）信道参数
 *   onUp / onDown {function(buf)} 观测钩子：在**丢弃判定之前**调用，
 *                 因此可用来统计「服务器实际发出了多少唯一帧」——
 *                 到达率的分母必须是实测值，不能是理论推算
 */
function WeakNetProxy(opts) {
  opts = opts || {};
  this.serverHost = opts.serverHost || '127.0.0.1';
  this.serverPort = opts.serverPort;
  this.up = new LossChannel(Object.assign({ seed: 11 }, opts.up || {}));
  this.down = new LossChannel(Object.assign({ seed: 22 }, opts.down || {}));
  this.onUp = opts.onUp || null;
  this.onDown = opts.onDown || null;

  this.sock = null;          // 面向客户端（客户端把包发到这里）
  this.upstream = null;      // 面向服务器（代理用它转发，服务器回包到这里）
  this.clientAddr = null;
  this.clientPort = 0;
  this.t0 = 0;
  this._timers = [];
}

WeakNetProxy.prototype._track = function (tm) {
  if (tm && tm.unref) tm.unref();
  this._timers.push(tm);
  if (this._timers.length > 512) this._timers.shift();
};

WeakNetProxy.prototype.listen = function (cb) {
  var self = this;
  this.t0 = Date.now();
  this.sock = dgram.createSocket('udp4');
  this.upstream = dgram.createSocket('udp4');

  this.sock.on('error', function () {});
  this.upstream.on('error', function () {});

  // 客户端 → 服务器
  this.sock.on('message', function (buf, rinfo) {
    self.clientAddr = rinfo.address;
    self.clientPort = rinfo.port;
    if (self.onUp) { try { self.onUp(buf); } catch (e) {} }
    var t = Date.now() - self.t0;
    if (!self.up.passes(t)) return;
    var lat = self.up.latency();
    var fwd = function () {
      if (!self.upstream) return;
      try { self.upstream.send(buf, self.serverPort, self.serverHost); } catch (e) {}
    };
    if (lat > 0) self._track(setTimeout(fwd, lat)); else fwd();
  });

  // 服务器 → 客户端
  this.upstream.on('message', function (buf) {
    if (self.onDown) { try { self.onDown(buf); } catch (e) {} }
    var t = Date.now() - self.t0;
    if (!self.down.passes(t)) return;
    if (!self.clientAddr) return;   // 还没学到客户端地址
    var addr = self.clientAddr, port = self.clientPort;
    var lat = self.down.latency();
    var fwd = function () {
      if (!self.sock) return;
      try { self.sock.send(buf, port, addr); } catch (e) {}
    };
    if (lat > 0) self._track(setTimeout(fwd, lat)); else fwd();
  });

  var pending = 2;
  function ready() { if (--pending === 0 && cb) cb(); }
  this.sock.bind(0, '127.0.0.1', ready);
  this.upstream.bind(0, '127.0.0.1', ready);
};

WeakNetProxy.prototype.port = function () {
  return this.sock ? this.sock.address().port : 0;
};

WeakNetProxy.prototype.close = function () {
  for (var i = 0; i < this._timers.length; i++) clearTimeout(this._timers[i]);
  this._timers.length = 0;
  if (this.sock) { try { this.sock.close(); } catch (e) {} this.sock = null; }
  if (this.upstream) { try { this.upstream.close(); } catch (e) {} this.upstream = null; }
};

module.exports = { LossChannel: LossChannel, WeakNetProxy: WeakNetProxy };
