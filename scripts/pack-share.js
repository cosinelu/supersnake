'use strict';
/**
 * pack-share.js — 生成离线单文件「分享版」（零依赖，Node 直跑）
 *
 * 用法：node scripts/pack-share.js
 * 输入：index.html（script 引用顺序）、js/**、README.md 第一行版本号
 * 输出：
 *   消食蛇-网页版-分享.html   （仓库根，单文件双击即玩）
 *   deploy/index.html         （同内容副本，历史路径保留）
 *   消食蛇-网页版-分享.zip     （上述 html 的打包）
 *
 * 说明：
 * - 分享版 = index.html 的全部 <script src> 按序内联，含联机模块；
 *   file:// 直开时「在线对战」会尝试连 127.0.0.1:8090（本地服务器），连不上仅提示失败，不影响单机三模式。
 * - 版本号取自 README.md 第一行标题（版本真源），写入 <title>。
 * - 生成文件头部带「勿手改」标记；改动请改源文件后重新运行本脚本。
 */
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.join(__dirname, '..');
var OUT_NAME = '消食蛇-网页版-分享.html';

function readVersion() {
  var firstLine = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('\n')[0];
  var m = firstLine.match(/v\d+\.\d+\.\d+/);
  if (!m) throw new Error('README.md 第一行未找到版本号（vX.Y.Z）');
  return m[0];
}

function build() {
  var version = readVersion();
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // 按出现顺序提取 <script src="...">（剥掉 ?v= 查询串）
  var srcs = [];
  var re = /<script src="([^"?]+)(?:\?[^"]*)?"><\/script>/g;
  var m;
  while ((m = re.exec(html)) !== null) srcs.push(m[1]);
  if (!srcs.length) throw new Error('index.html 中未找到任何 <script src>');

  // 逐个内联（保持依赖顺序；</script 转义防提前闭合）
  var i = 0;
  var packed = html.replace(re, function () {
    var src = srcs[i++];
    var file = path.join(ROOT, src);
    var code = fs.readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script');
    return '<script>\n/* ===== 内联自 ' + src + '（勿手改，源文件为准） ===== */\n' +
      code + '\n</script>';
  });

  packed = packed.replace(/<title>[^<]*<\/title>/,
    '<title>消食蛇 · 网页版（分享版 ' + version + '）</title>');
  packed = '<!-- 本文件由 scripts/pack-share.js 自动生成（' + version +
    '），请勿手工修改；改动请改源文件后重新打包 -->\n' + packed;

  fs.writeFileSync(path.join(ROOT, OUT_NAME), packed);
  fs.writeFileSync(path.join(ROOT, 'deploy', 'index.html'), packed);
  console.log('[pack-share] ' + OUT_NAME + ' / deploy/index.html 已生成（' +
    version + '，内联 ' + srcs.length + ' 个脚本，' + Math.round(packed.length / 1024) + ' KB）');
  return version;
}

// ---------------- 最小 ZIP 写出（store 存储，无需外部 zip 工具） ----------------
var CRC_TABLE = (function () {
  var t = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function writeZip(zipPath, entryName, content) {
  var data = Buffer.from(content, 'utf8');
  var crc = crc32(data);
  var name = Buffer.from(entryName, 'utf8');
  var u32 = function (v) { var b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  var u16 = function (v) { var b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  var dosTime = u32(0x0000_0000); // 1980-01-01 00:00:00（时间戳无关紧要）

  var local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0800), u16(0), dosTime, // 版本/UTF-8 标志/store
    u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
  ]);
  var central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), dosTime,
    u32(crc), u32(data.length), u32(data.length),
    u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), name
  ]);
  var end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(1), u16(1),
    u32(central.length), u32(local.length), u16(0)
  ]);
  fs.writeFileSync(zipPath, Buffer.concat([local, central, end]));
  console.log('[pack-share] ' + path.basename(zipPath) + ' 已生成（store 压缩）');
}

var version = build();
writeZip(path.join(ROOT, '消食蛇-网页版-分享.zip'), OUT_NAME,
  fs.readFileSync(path.join(ROOT, OUT_NAME), 'utf8'));
