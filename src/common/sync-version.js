'use strict';
/**
 * sync-version.js — 版本号单一来源同步器
 *
 * 读取 version.json 作为唯一版本来源，
 * 自动写入 package.json 的 "version" 字段。
 *
 * main.js 的 LOCAL_VERSION 已改为运行时 require('./version.json') 动态读取，
 * 不再是同步目标，以后只需修改 version.json，其余文件全部自动跟随。
 */
const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;

// 读取 version.json（主版本源）
let versionJson;
try {
  versionJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
} catch (e) {
  console.error('[ERROR] Cannot read version.json: ' + e.message);
  process.exit(1);
}

// 去掉可能的 "v" 前缀，得到纯 semver（如 1.0.2）
const version = String(versionJson.version || '').replace(/^v/, '').trim();
if (!version) {
  console.error('[ERROR] version.json has no valid "version" field.');
  process.exit(1);
}

// 读取并更新 package.json
const pkgPath = path.join(ROOT, 'package.json');
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (e) {
  console.error('[ERROR] Cannot read package.json: ' + e.message);
  process.exit(1);
}

const oldVersion = pkg.version;
if (oldVersion === version) {
  console.log('[OK]  version sync: package.json already at v' + version);
  process.exit(0);
}

pkg.version = version;
try {
  try { fs.chmodSync(pkgPath, 0o644); } catch (_) {}
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
} catch (e) {
  console.error('[ERROR] Cannot write package.json: ' + e.message);
  process.exit(1);
}

console.log('[OK]  version sync: package.json  ' + (oldVersion || '(none)') + '  →  ' + version);
console.log('[OK]  version source: version.json "' + versionJson.version + '"');
process.exit(0);
