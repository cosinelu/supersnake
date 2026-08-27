'use strict';
// bench.cpu.js — 一次性 profiling：分解 tick 模拟 / snap encode / deflate 的 CPU 占比
var path = require('path');
var JS = path.join(__dirname, '..', '..', 'js');
['config', 'utils', 'storage', 'levels', 'walls', 'snake', 'spawner', 'particles', 'ai', 'multiplayer']
  .forEach(function (f) { require(path.join(JS, f + '.js')); });
['protocol', 'transport', 'headlessGame']
  .forEach(function (f) { require(path.join(JS, 'net', f + '.js')); });
var zlib = require('zlib');
var CS = globalThis.CS, P = CS.protocol;

var game = new CS.HeadlessGame({});
game.setup(['a', 'b', 'c', 'd']);
for (var i = 0; i < 600; i++) game.tick(33); // 热身到中局（蛇变长，负载更真实）

var t0 = process.hrtime.bigint();
for (i = 0; i < 1000; i++) game.tick(33);
var simMs = Number(process.hrtime.bigint() - t0) / 1e6;

var snap = P.snap(1, 0, game.mp.timeMs, game.mp.allEntries(), game.spawner.blocks, game.spawner.meteors);
t0 = process.hrtime.bigint();
var enc;
for (i = 0; i < 1000; i++) { snap.tk = i; enc = P.encode(snap); }
var encMs = Number(process.hrtime.bigint() - t0) / 1e6;

t0 = process.hrtime.bigint();
for (i = 0; i < 1000; i++) zlib.deflateRawSync(enc);
var zMs = Number(process.hrtime.bigint() - t0) / 1e6;

console.log('快照大小', enc.length, 'B（deflate 后约', zlib.deflateRawSync(enc).length, 'B）');
console.log('模拟   ', (simMs / 1000).toFixed(3), 'ms/tick → 30Hz×10房 =', (simMs / 1000 * 300).toFixed(0), 'ms/s CPU');
console.log('encode ', (encMs / 1000).toFixed(3), 'ms/次   → 15Hz×4端×10房 =', (encMs / 1000 * 600).toFixed(0), 'ms/s CPU');
console.log('deflate', (zMs / 1000).toFixed(3), 'ms/次   → 15Hz×4端×10房 =', (zMs / 1000 * 600).toFixed(0), 'ms/s CPU');
