'use strict';
/**
 * storage.js — localStorage 封装（替代 wx.setStorageSync / wx.getStorageSync）
 *  - 值以 JSON 序列化存储；读取时 JSON 解析失败 / 键不存在 → 返回默认值；
 *  - localStorage 不可用（隐私模式 / node 环境）→ 降级到内存对象。
 */
(function (root) {
  var CS = root.CS = root.CS || {};
  var mem = {};

  function hasLocalStorage() {
    try {
      return typeof root.localStorage !== 'undefined' && root.localStorage !== null;
    } catch (e) {
      return false; // 隐私模式等场景访问 localStorage 会抛异常
    }
  }

  /**
   * 读取持久化值。
   * @param {string} key
   * @param {*} def 读不到 / 解析失败时返回的默认值
   */
  function get(key, def) {
    try {
      if (hasLocalStorage()) {
        var raw = root.localStorage.getItem(key);
        if (raw === null || raw === undefined || raw === '') return def;
        try {
          var v = JSON.parse(raw);
          return (v === null || v === undefined) ? def : v;
        } catch (e) {
          return def; // 容错：脏数据不炸游戏
        }
      }
    } catch (e) { /* 忽略，走降级 */ }
    return mem[key] !== undefined ? mem[key] : def;
  }

  /** 写入持久化值（JSON 序列化） */
  function set(key, val) {
    try {
      if (hasLocalStorage()) {
        root.localStorage.setItem(key, JSON.stringify(val));
        return;
      }
    } catch (e) { /* 忽略，走降级 */ }
    mem[key] = val;
  }

  /** 清除某个 key（调试用） */
  function remove(key) {
    try {
      if (hasLocalStorage()) { root.localStorage.removeItem(key); return; }
    } catch (e) { /* 忽略 */ }
    delete mem[key];
  }

  CS.storage = { get: get, set: set, remove: remove };
})(typeof window !== 'undefined' ? window : globalThis);
