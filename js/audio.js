'use strict';
/**
 * audio.js — 音效与背景音乐（纯 Web Audio API 振荡器合成，零外部文件）
 *  - 所有声音由 OscillatorNode + GainNode + DynamicsCompressorNode 实时合成；
 *  - 支持 master 音量、静音开关（保留 UI 入口）；
 *  - BGM 为低频柔和 drone 循环，不抢戏。
 *
 * 使用方式：CS.audio.playEat() / CS.audio.playSpecial() / CS.audio.playElim() /
 *          CS.audio.playWall() / CS.audio.startBgm() / CS.audio.stopBgm()
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var cfg = CS.config;

  /** @type {AudioContext|null} 延迟创建（需用户手势触发） */
  var ctx = null;
  var masterGain = null;
  var compressor = null;
  var bgmOsc = null;       // BGM 主振荡器
  var bgmGain = null;      // BGM 独立音量
  var bgmLfo = null;       // BGM 低频调制
  var bgmRunning = false;

  /**
   * 确保 AudioContext 已创建（首次调用时惰性初始化）。
   * 浏览器策略要求 AudioContext 必须在用户手势（click/touch）回调中 resume/创建，
   * 否则会被挂起。本函数在每次 playXxx 中自动调用。
   */
  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      // 主音量
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.6;
      // 压缩器：防止爆音削波
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -20;
      compressor.knee.value = 30;
      compressor.ratio.value = 12;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      masterGain.connect(compressor);
      compressor.connect(ctx.destination);
    }
    // 自动恢复（处理浏览器自动挂起）
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** 创建一个带衰减包络的振荡器（一次性短音） */
  function playTone(freq, duration, type, vol, detune) {
    var c = ensureCtx();
    if (!c) return;
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
    o.connect(g); g.connect(masterGain);
    o.start(c.currentTime);
    o.stop(c.currentTime + duration + 0.05);
  }

  /** 创建噪声爆发（用于消除/爆炸类音效） */
  function playNoise(duration, vol) {
    var c = ensureCtx();
    if (!c) return;
    var bufferSize = Math.round(c.sampleRate * duration);
    var buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
    }
    var src = c.createBufferSource();
    src.buffer = buffer;
    var g = c.createGain();
    g.gain.value = vol;
    src.connect(g); g.connect(masterGain);
    src.start(c.currentTime);
  }

  // ---- 公开 API ----

  var Audio = {
    muted: false,

    /** 吃到普通色块：轻快短促 "叮" */
    playEat: function () { if (this.muted) return; playTone(880, 0.08, 'sine', 0.22); },

    /** 吃到特殊道具：上扬双音 "叮~叮" */
    playSpecial: function () { if (this.muted) return; playTone(660, 0.1, 'sine', 0.2); setTimeout(function () { playTone(990, 0.14, 'sine', 0.18); }, 80); },

    /** 消除特效：噪声爆发 + 低频 "噗" */
    playElim: function () { if (this.muted) return; playNoise(0.18, 0.2); playTone(180, 0.2, 'triangle', 0.18); },

    /** 连锁消除（chain≥2）：更响亮 + 上扬音 */
    playChain: function (level) { if (this.muted) return; var lv = level || 2; playTone(440 + lv * 120, 0.2, 'sine', 0.15 + lv * 0.04); },

    /** 撞墙 / 游戏结束：低沉 "咚" */
    playWall: function () { if (this.muted) return; playTone(100, 0.35, 'triangle', 0.3); playTone(70, 0.4, 'sine', 0.2); },

    /** 解锁新颜色：三连上升音阶 */
    playUnlock: function () { if (this.muted) return; playTone(523, 0.12, 'sine', 0.18); setTimeout(function () { playTone(659, 0.12, 'sine', 0.18); }, 100); setTimeout(function () { playTone(784, 0.18, 'sine', 0.2); }, 200); },

    /** 按钮点击：极轻微 "嗒" */
    playClick: function () { if (this.muted) return; playTone(1200, 0.04, 'sine', 0.08); },

    /**
     * 启动背景音乐：柔和低频 drone（两个略有差频的振荡器产生拍音效果）。
     * 循环播放，可通过 stopBgm() 停止。
     */
    startBgm: function () {
      if (this.muted || bgmRunning) return;
      var c = ensureCtx(); if (!c) return;
      bgmRunning = true;
      // 主音：低频正弦
      bgmOsc = c.createOscillator();
      bgmOsc.type = 'sine';
      bgmOsc.frequency.value = 75; // A2 附近
      // LFO 轻微调制音高（±3Hz），让 drone 有呼吸感
      bgmLfo = c.createOscillator();
      bgmLfo.type = 'sine';
      bgmLfo.frequency.value = 0.15; // 非常慢的呼吸
      var lfoGain = c.createGain();
      lfoGain.gain.value = 3;
      bgmLfo.connect(lfoGain); lfoGain.connect(bgmOsc.frequency);
      // 音量（很轻，不抢戏）
      bgmGain = c.createGain();
      bgmGain.gain.value = 0.06;
      bgmOsc.connect(bgmGain); bgmGain.connect(masterGain);
      bgmOsc.start(); bgmLfo.start();
    },

    /** 停止背景音乐 */
    stopBgm: function () {
      if (!bgmRunning || !bgmOsc) return;
      try { bgmOsc.stop(); bgmLfo.stop(); } catch (e) { /* 可能已 stop */ }
      bgmOsc = null; bgmLfo = null; bgmGain = null; bgmRunning = false;
    },

    /** 设置主音量 (0~1) */
    setVolume: function (v) {
      if (masterGain) masterGain.gain.value = Math.max(0, Math.min(1, v));
    },

    /** 切换静音 */
    toggleMute: function () {
      this.muted = !this.muted;
      if (this.muted) this.stopBgm();
      else this.startBgm();
      return this.muted;
    }
  };

  CS.audio = Audio;
})(typeof window !== 'undefined' ? window : globalThis);
