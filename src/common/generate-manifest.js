/**
 * generate-manifest.js
 * Seer2 Launcher - Hot-update manifest generator
 *
 * Run: node generate-manifest.js
 * Output: manifest.json
 *
 * 工作流程：
 *   1. 本地修改资源文件（图片等）
 *   2. 运行本脚本生成 manifest.json
 *   3. 将修改的文件 + manifest.json 推送到 GitHub 私有仓库
 *   4. Cloudflare Pages 自动同步，CDN 边缘节点更新（通常 < 60s）
 *   5. 用户下次启动启动器时自动拉取最新文件
 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Files published to the hot-update CDN.
const SYNC_FILES = [
  'bilibili.jpg',
  'contact-qq.jpg',
  'qq-group.jpg',
  'sponsor.jpg',
  'icon.ico',
];

const ROOT = __dirname;
const OUT  = path.join(ROOT, 'manifest.json');

console.log('');
console.log('============================================================');
console.log('  Seer2 Launcher - Hot-Update Manifest Generator');
console.log('  发布平台：GitHub 私有仓库 + Cloudflare Pages CDN');
console.log('============================================================');
console.log('');

let oldManifest = {};
try {
  if (fs.existsSync(OUT)) oldManifest = JSON.parse(fs.readFileSync(OUT, 'utf8'));
} catch(e) {}

const manifest = {};
let changedFiles = [];

for (const file of SYNC_FILES) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) {
    console.log('  [MISS]    ' + file + '  -- not found, skipped');
    if (oldManifest[file]) manifest[file] = oldManifest[file];
    continue;
  }
  const data   = fs.readFileSync(p);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const size   = data.length;
  manifest[file] = { sha256, size };

  const old = oldManifest[file];
  if (!old || old.sha256 !== sha256) {
    console.log('  [CHANGED] ' + file + '  (' + (size/1024).toFixed(1) + ' KB)');
    changedFiles.push(file);
  } else {
    console.log('  [OK]      ' + file + '  (unchanged)');
  }
}

// 解除只读属性（zip 解压后文件可能带有只读标志）
try { fs.chmodSync(OUT, 0o666); } catch(e) {}
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2), 'utf8');

console.log('');
console.log('------------------------------------------------------------');
if (changedFiles.length === 0) {
  console.log('  All files unchanged.');
} else {
  console.log('  manifest.json updated.');
  console.log('  请将以下文件推送到 GitHub 仓库（Cloudflare Pages 将自动同步）:');
  console.log('');
  changedFiles.forEach(function(f) { console.log('    ' + f); });
  console.log('    manifest.json   <-- 最后推送此文件');
}
console.log('------------------------------------------------------------');
console.log('');
