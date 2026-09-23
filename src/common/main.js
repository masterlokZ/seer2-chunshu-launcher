'use strict';
/**
 * main.js — Seer2 Launcher 主进程
 *
 * 内存泄漏根治 & Log 功能完全移除版本：
 *   1. 所有 ipcMain.on/handle 在模块顶层一次性注册，不在窗口函数内重复注册。
 *   2. toggleOverlay 事件侦听器仅捕获 name（字符串），通过 overlayWins[name] 动态
 *      查找，closed 后 overlayWins[name]=null，循环引用链自然断裂。
 *   3. closed 事件中调用 removeAllListeners() 显式断开 EventEmitter 内部链。
 *   4. setInterval 定时器（startPeakPoller）在游戏关闭时
 *      对应 stop 函数清除，无幽灵定时器。
 *   5. _reqLogBuffer 在 core-net.js 中严格限制 100 条并 shift() 旧项。
 *   6. Log 悬浮面板已完全移除（文件、overlayWins/overlayCfg 条目、菜单项、
 *      IPC handlers、preload.js API 均已删除）。
 */

if (process.env.LAUNCHER_AUTOTEST === '1') { try { require('./autotest'); } catch(e) {} }

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, clipboard, protocol, nativeImage } = require('electron');
const path   = require('path');
const fs     = require('fs');
const createOverlayVisibilityIntent = require('./modules/overlay-visibility-intent');
const os     = require('os');
const http   = require('http');
const https  = require('https');
const dns    = require('dns');
const zlib   = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const net    = require('net');
const customSkinSol = require('./custom-skin-sol');
const { deriveCustomSkinIdentity } = require('./modules/custom-skin-identity');
const { collectOfficialIdentityIdsFromXml } = require('./modules/custom-skin-official-ids');
const uClientFtrNativeConverter = require('./uclient-ftr-x86-converter');
const launcherRenderPolicy = require('./modules/launcher-render-policy');
const { createUClientFtrFlashPipeline } = require('./modules/uclient-ftr-flash-pipeline');
const { createSkinStorage } = require('./modules/skin-storage');
const { createSourceSuiteTransaction } = require('./modules/source-suite-transaction');
const { createCustomSkinFolderPackage } = require('./modules/custom-skin-folder-package');
const { createCustomSkinConfigPackage } = require('./modules/custom-skin-config-package');
const { createCustomSkinScanIdentity } = require('./modules/custom-skin-scan-identity');
const uClientCatalog = require('./modules/uclient-resource-catalog');
const { createOfficialCatalogStore } = require('./modules/official-catalog-store');
const { createUClientSnapshotService } = require('./modules/uclient-snapshot-service');
const { createUClientIdentityCatalog } = require('./modules/uclient-identity-catalog');
const { createUClientCatalogProjection } = require('./modules/uclient-catalog-projection');
const { createOfficialCatalogClassification } = require('./modules/official-catalog-classification');
const { createResourceVariantIntegrity } = require('./modules/resource-variant-integrity');
const uClientResourceFamily = require('./modules/uclient-resource-family-adapter');
const { createUClientResourceFamilyConverter } = require('./modules/uclient-resource-family-converter');
const { createUClientSkillTimelineAutoAdapter } = require('./modules/uclient-skill-timeline-auto-adapter');
const { createUClientNativeVideoTimeline } = require('./modules/uclient-native-video-timeline');
const battleResourceSelector = require('./modules/battle-resource-selector');
const ultimateCapability = require('./modules/ultimate-capability');
const { createOfficialBattleRouting } = require('./modules/official-battle-routing');
const {
  createUClientEmbeddedCinematic,
  embeddedCinematicMatchesFightBuild,
} = require('./modules/uclient-embedded-cinematic');
const { createCustomSkinSwfUtils } = require('./modules/custom-skin-swf-utils');
const { createSeer1RobotCoreParser } = require('./modules/seer1-robotcore-parser');
const IS_X64_RUNTIME = process.arch === 'x64';
const CUSTOM_SKIN_ARCH_POLICY = Object.freeze({
  httpSockets:IS_X64_RUNTIME ? 12 : 6,
  httpFreeSockets:IS_X64_RUNTIME ? 8 : 4,
  normalMaxBytes:(IS_X64_RUNTIME ? 96 : 48) * 1024 * 1024,
  fightMaxBytes:(IS_X64_RUNTIME ? 128 : 64) * 1024 * 1024,
  ultimateMaxBytes:(IS_X64_RUNTIME ? 128 : 64) * 1024 * 1024,
  iconMaxBytes:8 * 1024 * 1024,
  uClientStageWorkers:IS_X64_RUNTIME ? 4 : 2,
});
const officialBattleRouting = createOfficialBattleRouting(
  require('./resources/traditional-swf-routing.json'));
const customSkinSwfUtils = createCustomSkinSwfUtils({ parseId:parseCustomSkinId });
const {
  customSkinTypeFromName,
  customSkinIdFromName,
  customSkinReadRectSize,
  inflateCustomSkinSwfAsync,
  customSkinReadRectSizeAsync,
  customSkinStaticIconInfo,
} = customSkinSwfUtils;
const seer1RobotCoreParser = createSeer1RobotCoreParser({
  parseId:parseCustomSkinId,
  readTagHeader:customSkinReadTagHeader,
});
const {
  decodeSeer1RobotCoreSwf,
  extractSeer1RobotCoreBinaryAssets,
  decodeXmlEntities,
  parseXmlAttributes,
  parseSeer1RobotCorePetSkinXml,
  selectSeer1RobotCorePetSkinTable,
  parseSeer1RobotCorePetXml,
  Seer1Amf3Reader,
  collectSeer1MovesById,
} = seer1RobotCoreParser;
const uClientCatalogProjection = createUClientCatalogProjection({ parseId:parseCustomSkinId });
const uClientIdentityCatalog = createUClientIdentityCatalog({ parseId:parseCustomSkinId });
const officialCatalogClassification = createOfficialCatalogClassification(parseCustomSkinId);
const normalizeUClientActions = uClientCatalogProjection.normalizeActions;
const uClientActionCapabilities = uClientCatalogProjection.actionCapabilities;
const mergeUClientIdentityIntoCatalog = uClientCatalogProjection.mergeIdentity;
const isSeer1NativeUClientCatalogItem = officialCatalogClassification.isNativeUClient;
const isSeer1CatalogPreviewOnly = officialCatalogClassification.isPreviewOnly;
const findSeer1OfficialCatalogResource = officialCatalogClassification.findResource;
const countSeer1NativeUClientCatalogItems = officialCatalogClassification.countNativeUClient;
const resourceVariantIntegrity = createResourceVariantIntegrity({ fs:fs, path:path, crypto:crypto });
const sourceSuiteTransaction = createSourceSuiteTransaction({
  fs:fs,path:path,crypto:crypto,process:process,
});

if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_USER_DATA_ROOT) {
  try {
    var isolatedUserData = path.resolve(process.env.LAUNCHER_AUTOTEST_USER_DATA_ROOT);
    fs.mkdirSync(isolatedUserData, { recursive:true });
    app.setPath('userData', isolatedUserData);
  } catch(e) {
    console.warn('[AUTOTEST] userData isolation failed:', e.message);
  }
}

// login-data: 只存 Cookies (登录态), 与 user-data 完全隔离
// user-data 会被构建清理, login-data 永远不碰 (除非卸载/手动删)
try {
  var _exeDir = path.dirname(app.getPath('exe'));
  var _loginDataDir = path.join(_exeDir, 'login-data');
  fs.mkdirSync(_loginDataDir, { recursive: true });
  var _probeFile = path.join(_loginDataDir, '.write_test_' + Date.now());
  fs.writeFileSync(_probeFile, 'ok');
  fs.unlinkSync(_probeFile);
  app.setPath('userData', _loginDataDir);
  console.log('[LOGIN] userData (Cookies only) → ' + _loginDataDir);
} catch(_) {
  console.log('[LOGIN] exe dir not writable, using AppData');
}

// GameCache / other runtime data 保持原路径 (exe旁\GameCache\)

const EARLY_QUALITY_CONFIG_FILE = app.isPackaged
  ? path.join(path.dirname(process.execPath), 'quality-config.json')
  : path.join(__dirname, 'quality-config.json');
var _earlyRenderState = launcherRenderPolicy.initializeEarly({
  app:app,
  fs:fs,
  configFile:EARLY_QUALITY_CONFIG_FILE,
});
var _qualityConfig = _earlyRenderState.config;

var _startupCrashLogPath = (function() {
  try {
    if (app.isPackaged && process.execPath) {
      var base = path.dirname(process.execPath);
      var dir = path.join(base, 'logs');
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch(_) {}
      return path.join(dir, 'startup-crash.log');
    } else {
      var repoRoot = path.dirname(__dirname);
      var wsDir = path.join(repoRoot, '_workspace');
      try { if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true }); } catch(_) {}
      return path.join(wsDir, 'startup-crash.log');
    }
  } catch(_) {
    try { return path.join(os.tmpdir(), 'seer2-startup-crash.log'); } catch(_) { return null; }
  }
})();
var _startupEpoch = Date.now();
var STARTUP_CRASH_MAX_BYTES  = 100 * 1024;
var STARTUP_CRASH_KEEP_BYTES = 50 * 1024;
(function _truncateStartupCrashLog() {
  try {
    if (!_startupCrashLogPath) return;
    if (!fs.existsSync(_startupCrashLogPath)) return;
    var size = fs.statSync(_startupCrashLogPath).size;
    if (size <= STARTUP_CRASH_MAX_BYTES) return;
    var fd = fs.openSync(_startupCrashLogPath, 'r');
    try {
      var keep = Buffer.alloc(STARTUP_CRASH_KEEP_BYTES);
      fs.readSync(fd, keep, 0, STARTUP_CRASH_KEEP_BYTES, size - STARTUP_CRASH_KEEP_BYTES);
      var nl = keep.indexOf(0x0A);
      var slice = (nl >= 0 && nl + 1 < keep.length) ? keep.slice(nl + 1) : keep;
      var marker = Buffer.from(
        '=== truncated to last 50KB at ' + new Date().toISOString() + ' ===\n',
        'utf8'
      );
      fs.writeFileSync(_startupCrashLogPath, Buffer.concat([marker, slice]));
    } finally {
      try { fs.closeSync(fd); } catch(_) {}
    }
  } catch(_) { /* 截断失败不影响启动 */ }
})();

function startupDiag(tag, data) {
  try {
    if (!_startupCrashLogPath) return;
    var now = new Date();
    var ts  = now.toISOString();
    var dt  = Date.now() - _startupEpoch;
    var line = '[' + ts + '] [+' + dt + 'ms] ' + String(tag || '');
    if (data !== undefined && data !== null) {
      try { line += ' ' + JSON.stringify(data); } catch(_) { line += ' ' + String(data); }
    }
    line += '\n';
    fs.appendFileSync(_startupCrashLogPath, line, 'utf8');
  } catch(_) { /* 连日志都写不了时静默吞 */ }
}
startupDiag('=== startup-session-begin ===', {
  pid: process.pid,
  arch: process.arch,
  cwd: process.cwd(),
  execPath: process.execPath,
  argv: process.argv.slice(0, 4),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  osVersion: (function(){ try { return os.release(); } catch(_){ return ''; } })(),
});

var _pendingFatalDialog = null;
function _reportFatal(source, err) {
  var info = {
    source: source,
    message: (err && err.message) ? String(err.message) : String(err),
    stack: (err && err.stack) ? String(err.stack).split(/\r?\n/).slice(0, 20).join(' | ') : '',
    code: (err && err.code) ? String(err.code) : '',
  };
  startupDiag('FATAL', info);
  try {
    if (app.isReady && app.isReady()) {
      try {
        dialog.showErrorBox(
          '启动时发生异常',
          '启动过程中捕获到异常，程序仍在尝试继续运行。\n\n' +
          '来源：' + info.source + '\n' +
          '错误：' + info.message + '\n\n' +
          '详细日志已写入：\n' + (_startupCrashLogPath || '(logging failed)')
        );
      } catch(_) {}
    } else {
      _pendingFatalDialog = info;
    }
  } catch(_) {}
}
process.on('uncaughtException', function(err) { _reportFatal('uncaughtException', err); });
process.on('unhandledRejection', function(err) { _reportFatal('unhandledRejection', err); });

startupDiag('stage: require coreNet');
const coreNet = require('./core-net');
try { coreNet.setRenderQuality(_qualityConfig); } catch(_) {}
startupDiag('stage: require coreNet done');

const LOCAL_HOSTNAME    = 'seer2.chunshu';
const FLASH_POLICY_DATA = '<?xml version="1.0"?><!DOCTYPE cross-domain-policy SYSTEM ' +
  '"http://www.macromedia.com/xml/dtds/cross-domain-policy.dtd">' +
  '<cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>';
const BLOOM_ROOT_URL    = 'http://43.138.190.6/seer2';
const BLOOM_PATH        = '/config/bloom-path.data';

var GAME_SERVERS = [
  { id: 'default', host: 'seer2.chunshu', rootUrl: 'http://43.138.190.6/seer2', label: '默认线路' },
  { id: 'de',      host: 'seer2.chunshu', rootUrl: 'http://o1.733702.xyz/seer2', label: '德国服务器' }
];
var _selectedServerId = 'default';
var _serverCfgPath = (function() {
  if (app.isPackaged) return path.join(path.dirname(process.execPath), 'selected-server.txt');
  return path.join(__dirname, 'selected-server.txt');
})();

function loadSelectedServer() {
  try {
    var id = fs.readFileSync(_serverCfgPath, 'utf8').trim();
    if (GAME_SERVERS.some(function(s) { return s.id === id; })) {
      _selectedServerId = id;
    }
  } catch(e) { /* 文件不存在或读取失败，使用默认 */ }
}

function saveSelectedServer(id) {
  try { fs.writeFileSync(_serverCfgPath, id, 'utf8'); } catch(e) {}
}

function getSelectedServer() {
  return GAME_SERVERS.find(function(s) { return s.id === _selectedServerId; }) || GAME_SERVERS[0];
}

function rewriteUrlForCurrentServer(url) {
  if (!url || typeof url !== 'string') return url;
  var srv = getSelectedServer();
  var targetRoot = srv.rootUrl || 'http://43.138.190.6/seer2';
  for (var i = 0; i < GAME_SERVERS.length; i++) {
    var root = GAME_SERVERS[i].rootUrl;
    if (!root) continue;
    if (url.indexOf(root) === 0) {
      return targetRoot + url.slice(root.length);
    }
  }
  var virtualPrefix = 'http://seer2.chunshu/seer2';
  if (url.indexOf(virtualPrefix) === 0) {
    return targetRoot + url.slice(virtualPrefix.length);
  }
  return url;
}

function normalizeUrlForStorage(url) {
  if (!url || typeof url !== 'string') return url;
  var defaultRoot = GAME_SERVERS[0].rootUrl || 'http://43.138.190.6/seer2';
  for (var i = 0; i < GAME_SERVERS.length; i++) {
    var root = GAME_SERVERS[i].rootUrl;
    if (!root) continue;
    if (url.indexOf(root) === 0) {
      return defaultRoot + url.slice(root.length);
    }
  }
  var virtualPrefix = 'http://seer2.chunshu/seer2';
  if (url.indexOf(virtualPrefix) === 0) {
    return defaultRoot + url.slice(virtualPrefix.length);
  }
  return url;
}

function getReplaceRulesForCurrentServer() {
  return _replaceRules.map(function(rule) {
    var r = { url: rewriteUrlForCurrentServer(rule.url), file: rule.file, enabled: rule.enabled };
    if (rule.label) r.label = rule.label;
    return r;
  });
}

function applyReplaceRulesToCoreNet() {
  // Skin-mode rules are intentionally installed before user rules.  core-net
  // keeps the first matching rule, so a user-added conflicting rule can never
  // shadow the launcher-owned skin adapters while the mode is enabled.
  var forced = _skinModeEnabled ? getSkinModeRulesForCurrentServer() : [];
  coreNet.setUserReplaceRules(forced.concat(getReplaceRulesForCurrentServer()));
}

function notifyReplaceRulesChanged() {
  var w = overlayWins && overlayWins['replace'];
  if (w && !w.isDestroyed()) {
    w.webContents.send('replace-rules-changed', { rules: getReplaceRulesForCurrentServer() });
  }
}

function getGameEntryUrl() {
  return 'http://seer2.chunshu/seer2/';
}



(function() {
  startupDiag('stage: loading local-game-index.html');
  try {
    var idxBuf = fs.readFileSync(path.join(__dirname, 'local-game-index.html'));
    coreNet.setLocalGameIndex(idxBuf);
    console.log('[LocalHTML] local-game-index.html loaded:', idxBuf.length, 'bytes');
    startupDiag('stage: local-game-index.html loaded', { bytes: idxBuf.length });
  } catch(e) {
    console.warn('[LocalHTML] local-game-index.html not found, falling back to server HTML:', e.message);
    startupDiag('stage: local-game-index.html load failed', { message: e.message, code: e.code });
  }
})();

var _startupLog = [];
var _origLog    = console.log.bind(console);
var _origWarn   = console.warn.bind(console);
var _origError  = console.error.bind(console);
function _captureConsole(level, args) {
  var msg = Array.prototype.slice.call(args).map(function(a) {
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
    return String(a);
  }).join(' ');
  var now = new Date();
  var ts  = now.toTimeString().slice(0,8) + '.' + String(now.getMilliseconds()).padStart(3,'0');
  _startupLog.push('[' + ts + '] [' + level + '] ' + msg);
  if (_startupLog.length > 500) _startupLog.shift();
}
console.log   = function() { _captureConsole('LOG',  arguments); _origLog.apply(null, arguments); };
console.warn  = function() { _captureConsole('WARN', arguments); _origWarn.apply(null, arguments); };
console.error = function() { _captureConsole('ERR',  arguments); _origError.apply(null, arguments); };

const LOG_DIR = (function() {
  if (app.isPackaged && process.execPath) {
    return path.join(path.dirname(process.execPath), 'logs');
  }
  return path.join(__dirname, 'logs');
})();
var _lastLogCleanTs   = 0;
var LOG_MAX_SIZE_KB   = 2048;
var LOG_RETAIN_DAYS   = 7;
var LOG_CLEAN_TTL     = 60000;

function getLogPath() {
  var d = new Date();
  return path.join(LOG_DIR, 'seer2-' +
    d.getFullYear() + '-' +
    String(d.getMonth()+1).padStart(2,'0') + '-' +
    String(d.getDate()).padStart(2,'0') + '.log');
}
var _logDirEnsured = false; // 仅首次 writeLog 时检查/创建日志目录，后续跳过 existsSync
function writeLog(level, category, msg, data) {
  try {
    if (!_logDirEnsured) {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
      _logDirEnsured = true;
    }
    var now  = new Date();
    var time = now.toTimeString().slice(0,8) + '.' + String(now.getMilliseconds()).padStart(3,'0');
    var line = '[' + time + '] [' + level + '] [' + category + '] ' + msg;
    if (data !== undefined && data !== null) { try { line += ' | ' + JSON.stringify(data); } catch(e) {} }
    line += '\n';
    var logPath = getLogPath();
    try { if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX_SIZE_KB * 1024) return; } catch(e) {}
    fs.appendFileSync(logPath, line, 'utf8');
    var nowTs = Date.now();
    if (nowTs - _lastLogCleanTs >= LOG_CLEAN_TTL) {
      _lastLogCleanTs = nowTs;
      try {
        var files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('seer2-') && f.endsWith('.log'));
        files.sort();
        if (files.length > LOG_RETAIN_DAYS) {
          files.slice(0, files.length - LOG_RETAIN_DAYS).forEach(f => {
            try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch(e) {}
          });
        }
      } catch(e) {}
    }
  } catch(e) { _origError('[Logger] Failed:', e.message); }
}
function logInfo(cat, msg, data)  { console.log('['+cat+']', msg, data||'');   writeLog('INFO',  cat, msg, data); }
function logWarn(cat, msg, data)  { console.warn('['+cat+']', msg, data||'');  writeLog('WARN',  cat, msg, data); }
function logError(cat, msg, data) { console.error('['+cat+']', msg, data||''); writeLog('ERROR', cat, msg, data); }

function dnsLookup(host) {
  return new Promise(function(resolve, reject) {
    dns.lookup(host, {}, function(err, address) {
      if (err) reject(err);
      else resolve(address);
    });
  });
}

function httpGetText(url) {
  return new Promise(function(resolve, reject) {
    http.get(url, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        if ((res.statusCode || 0) >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function bufferToStream(buf) {
  return Readable.from([Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''))]);
}

async function initBloomRouting() {
  var bloomRootUrl = BLOOM_ROOT_URL;
  var bloomUrl = bloomRootUrl + BLOOM_PATH;
  var bloomText = await httpGetText(bloomUrl);
  coreNet.setBloomRoutes(bloomRootUrl, bloomText);
  logInfo('Bloom', 'Bloom routing ready', { rootUrl: bloomRootUrl, bloomUrl: bloomUrl });
}

const PROXY_CFG_FILE = app.isPackaged
  ? path.join(path.dirname(process.execPath), 'proxy-config.json')
  : path.join(__dirname, 'proxy-config.json');
var proxyCfg = { enabled:false, type:'socks5', host:'127.0.0.1', port:10808, username:'', password:'' };
function loadProxyCfg() {
  try {
    if (fs.existsSync(PROXY_CFG_FILE)) {
      var saved = JSON.parse(fs.readFileSync(PROXY_CFG_FILE, 'utf8'));
      if (typeof saved.enabled !== 'undefined') proxyCfg.enabled = !!saved.enabled;
      if (saved.type)     proxyCfg.type = saved.type;
      if (saved.host)     proxyCfg.host = saved.host;
      if (saved.port)     proxyCfg.port = parseInt(saved.port,10)||10808;
      if (saved.username !== undefined) proxyCfg.username = saved.username;
      if (saved.password !== undefined) proxyCfg.password = saved.password;
    }
  } catch(e) {}
  coreNet.setProxyConfig(proxyCfg);
}
function saveProxyCfg() {
  try { fs.writeFileSync(PROXY_CFG_FILE, JSON.stringify(proxyCfg, null, 2), 'utf8'); } catch(e) {}
  coreNet.setProxyConfig(proxyCfg);
}
function buildProxyRules() {
  if (!proxyCfg.enabled) return 'direct://';
  var scheme = (proxyCfg.type === 'http') ? 'http' : 'socks5';
  var auth = '';
  if (proxyCfg.username) {
    auth = encodeURIComponent(proxyCfg.username);
    if (proxyCfg.password) auth += ':' + encodeURIComponent(proxyCfg.password);
    auth += '@';
  }
  return scheme + '://' + auth + proxyCfg.host + ':' + proxyCfg.port;
}
loadProxyCfg();
startupDiag('stage: proxyCfg loaded', { enabled: !!proxyCfg.enabled, type: proxyCfg.type });

launcherRenderPolicy.appendChromiumSwitches(app, process.arch);

function broadcastVisible(channel, data) {
  Object.values(overlayWins).forEach(function(w) {
    if (w && !w.isDestroyed() && w.isVisible()) {
      try { w.webContents.send(channel, data); } catch(e) {}
    }
  });
}
function broadcastAll(channel, data) {
  BrowserWindow.getAllWindows().forEach(function(w) {
    if (!w.isDestroyed()) { try { w.webContents.send(channel, data); } catch(e) {} }
  });
}


function versionFromFilename(p) {
  var m = path.basename(p).match(/_(\d+)_(\d+)_(\d+)_(\d+)\.dll$/i);
  return m ? (m[1]+'.'+m[2]+'.'+m[3]+'.'+m[4]) : null;
}

function findFlashPlugin() {
  var _flashWantBits  = process.arch === 'x64' ? '64' : '32';
  var _flashOtherBits = process.arch === 'x64' ? '32' : '64';

  var firstDllInDir = function(dir) {
    if (!dir) return null;

    if (!fs.existsSync(dir)) return null;

    var files;
    try {
      var st = fs.statSync(dir);
      if (!st.isDirectory()) return null;
      files = fs.readdirSync(dir);
    } catch(e) {
      console.warn('[Flash] Cannot read dir (skipping):', dir, e.code || e.message);
      return null;
    }

    var candidates = files.slice().sort(function(a, b) {
      var al = a.toLowerCase(), bl = b.toLowerCase();
      var aWant  = al.includes(_flashWantBits)  ? 0 : (al.includes(_flashOtherBits) ? 2 : 1);
      var bWant  = bl.includes(_flashWantBits)  ? 0 : (bl.includes(_flashOtherBits) ? 2 : 1);
      return aWant - bWant;
    });

    for (var i = 0; i < candidates.length; i++) {
      var fname = candidates[i].toLowerCase();
      if (!fname.endsWith('.dll')) continue;
      if (fname.startsWith('pepflashplayer') && fname.includes(_flashOtherBits) && !fname.includes(_flashWantBits)) {
        console.log('[Flash] Skipping wrong-arch DLL:', candidates[i]);
        continue;
      }
      var full = path.join(dir, candidates[i]);
      try {
        var fst = fs.statSync(full);
        if (fst.isFile() && fst.size > 100 * 1024) return full;
      } catch(e) { /* 该文件不可访问，继续 */ }
    }
    return null;
  };

  if (app.isPackaged && process.resourcesPath) {
    var hit = firstDllInDir(path.join(process.resourcesPath, 'flash'));
    if (hit) { console.log('[Flash] Found via extraResources:', hit); return hit; }

    hit = firstDllInDir(path.join(process.resourcesPath, 'app.asar.unpacked', 'flash'));
    if (hit) { console.log('[Flash] Found via asarUnpack fallback:', hit); return hit; }
  }

  var devHit = firstDllInDir(path.join(__dirname, 'flash'));
  if (devHit) { console.log('[Flash] Found via __dirname (dev):', devHit); return devHit; }

  console.warn('[Flash] No DLL found in any candidate directory.');
  return null;
}

function setupFlash() {
  if (process.env.LAUNCHER_AUTOTEST_BYPASS_FLASH === '1') {
    console.log('[AUTOTEST] bypass setupFlash (no real DLL required)');
    return { enabled: false, path: null, version: null };
  }
  var p = findFlashPlugin();

  if (!p) {
    var searchedPaths = [];
    if (app.isPackaged && process.resourcesPath) {
      searchedPaths.push(path.join(process.resourcesPath, 'flash'));
      searchedPaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'flash'));
    }
    searchedPaths.push(path.join(__dirname, 'flash'));
    var _archLabel = process.arch === 'x64' ? '64位 (x64)' : '32位 (ia32)';
    var _archDll   = process.arch === 'x64' ? 'pepflashplayer64_*.dll' : 'pepflashplayer32_*.dll';
    var msg = '无法在 flash 目录下找到有效的 Flash 插件 (.dll 文件)。\n\n' +
              '【用户】请将 ' + _archDll + '（' + _archLabel + '）放入以下目录之一：\n' +
              searchedPaths.join('\n') + '\n\n' +
              '【开发者/打包前必读】\n' +
              '请务必将 ' + _archLabel + ' Flash DLL 放入源码根目录的 flash/ 文件夹中，\n' +
              '再运行 build.bat 打包！否则 extraResources 无法将其复制到安装包。\n\n' +
              '注意：必须使用 ' + _archLabel + ' 版本的 Flash DLL，\n' +
              '位数不匹配的 DLL 将被 Chromium 静默拒绝，不会产生任何错误提示。';
    startupDiag('FATAL: Flash DLL not found', { searched: searchedPaths });
    var _showAndQuit = function() {
      try { dialog.showErrorBox('致命错误 — Flash 插件未找到 (Fatal Error)', msg); } catch(_) {}
      try { app.quit(); } catch(_) { try { process.exit(1); } catch(__) {} }
    };
    if (app.isReady && app.isReady()) {
      _showAndQuit();
    } else {
      try { app.whenReady().then(_showAndQuit).catch(_showAndQuit); } catch(_) { _showAndQuit(); }
      setTimeout(function(){ try { process.exit(1); } catch(_) {} }, 5000);
    }
    return { enabled:false, path:null, version:null };
  }

  var ver = versionFromFilename(p) || '34.0.0.330';

  // Electron 11 may omit per-window plugin enablement for windows created
  // after the game Pepper instance. Keep the process-level plugin switch on;
  // windows without a Flash object still do not instantiate a plugin.
  app.commandLine.appendSwitch('enable-plugins');
  app.commandLine.appendSwitch('ppapi-flash-version', ver);
  app.commandLine.appendSwitch('ppapi-flash-path', p);
  console.log('[Flash] loaded: ' + p);
  console.log('[Flash] version: ' + ver);
  console.log('[Flash] arch: ' + process.arch + ' — matches ' + (process.arch === 'x64' ? '64' : '32') + '-bit PPAPI DLL');
  return { enabled:true, path:p, version:ver };
}
startupDiag('stage: setupFlash begin');
var flashStatus = setupFlash();
startupDiag('stage: setupFlash done', {
  enabled: !!(flashStatus && flashStatus.enabled),
  pathExists: !!(flashStatus && flashStatus.path && fs.existsSync(flashStatus.path)),
  version: (flashStatus && flashStatus.version) || null,
});


var _sysRoot = process.env.SystemRoot || 'C:\\Windows';
var _pshell64 = (function() {
  if (process.arch === 'x64') return 'powershell.exe';
  return path.join(_sysRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
})();
var _pshell32 = (function() {
  if (process.arch === 'x64') return 'powershell.exe';
  return path.join(_sysRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
})();


var _scanInProgress = false;

function _resolvePs1Path() {
  if (app.isPackaged) {
    return app.getAppPath().replace('app.asar', 'app.asar.unpacked') +
           require('path').sep + 'scanner.ps1';
  }
  return path.join(__dirname, 'scanner.ps1');
}

function _resolveScannerExePath() {
  var exeName = (process.arch === 'x64') ? 'scanner-x64.exe' : 'scanner-x86.exe';
  if (app.isPackaged) {
    return app.getAppPath().replace('app.asar', 'app.asar.unpacked') +
           require('path').sep + exeName;
  }
  return path.join(__dirname, exeName);
}

function runScanner(args) {
  return new Promise(function(resolve) {
    var startedAt = Date.now();
    var exePath = _resolveScannerExePath();
    var exeExists = false;
    try { exeExists = fs.existsSync(exePath); } catch(_) {}
    if (exeExists) {
      _runScannerExe(exePath, args).then(function(r) {
        if (r && r.ok !== undefined) {
          _logScannerCall('exe', args, startedAt, r);
          resolve(r); return;
        }
        logWarn('Scanner', 'exe returned invalid output, falling back to ps1', { exe: exePath, error: r && r.error });
        _runScannerPs1(args).then(function(r2) { _logScannerCall('ps1-fallback', args, startedAt, r2); resolve(r2); });
      }).catch(function(e) {
        logWarn('Scanner', 'exe spawn threw, falling back to ps1: ' + (e && e.message ? e.message : e), { exe: exePath });
        _runScannerPs1(args).then(function(r2) { _logScannerCall('ps1-fallback', args, startedAt, r2); resolve(r2); });
      });
    } else {
      logWarn('Scanner', 'native scanner exe missing, using ps1', { expected: exePath, arch: process.arch });
      _runScannerPs1(args).then(function(r) { _logScannerCall('ps1-no-exe', args, startedAt, r); resolve(r); });
    }
  });
}

function _logScannerCall(backend, args, startedAt, r) {
  try {
    var mode = '';
    var pidArg = '';
    var valArg = '';
    var scanType = '';
    for (var i = 0; i < args.length - 1; i++) {
      if (args[i] === '-Mode') mode = String(args[i+1]);
      else if (args[i] === '-CachedPpapiPid') pidArg = String(args[i+1]);
      else if (args[i] === '-Value') valArg = String(args[i+1]).slice(0, 24);
      else if (args[i] === '-ScanType') scanType = String(args[i+1]);
    }
    var elapsedMs = Date.now() - startedAt;
    var ok = r && r.ok;
    var count = (r && typeof r.count === 'number') ? r.count : null;
    var ppCount = (r && r.ppapi && r.ppapi.length !== undefined) ? r.ppapi.length : null;
    var backendLabel = backend;
    if (backend === 'exe') {
      backendLabel = (process.arch === 'x64') ? 'scanner-x64.exe' : 'scanner-x86.exe';
    }
    logInfo('Scanner', 'call done', {
      backend: backendLabel, mode: mode, arch: process.arch,
      pid: pidArg, scanType: scanType, value: valArg,
      elapsedMs: elapsedMs, ok: !!ok,
      count: count, ppapiCount: ppCount,
      err: r && r.error ? String(r.error).slice(0, 200) : null,
    });
  } catch(_) {}
}

function _runScannerExe(exePath, args) {
  return new Promise(function(resolve) {
    var mode = 'new';
    for (var i = 0; i < args.length - 1; i++) { if (args[i] === '-Mode') { mode = String(args[i+1]); break; } }
    var timeoutMs;
    switch (mode) {
      case 'detect-ppapi': timeoutMs = 3000; break;
      case 'read':         timeoutMs = 3000; break;
      case 'write':        timeoutMs = 3000; break;
      case 'batchwrite':   timeoutMs = 8000; break;
      case 'listprocs':    timeoutMs = 3000; break;
      case 'next':         timeoutMs = 15000; break;
      case 'new':          timeoutMs = 15000; break;
      default:             timeoutMs = 15000;
    }
    var stdout = '';
    var stderr = '';
    _scanInProgress = true;
    var proc;
    var settled = false;
    var settle = function(r) { if (!settled) { settled = true; resolve(r); } };
    try {
      proc = spawn(exePath, args.map(function(a) { return String(a); }), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch(e) {
      _scanInProgress = false;
      return settle({ ok: false, error: 'spawn exe: ' + e.message });
    }
    proc.stdout.on('data', function(d) { stdout += d.toString('utf8'); });
    proc.stderr.on('data', function(d) { stderr += d.toString('utf8'); });
    proc.on('close', function(code) {
      setTimeout(function() { _scanInProgress = false; }, 200);
      try {
        if (stderr && stderr.length > 0) {
          var lines = stderr.split(/\r?\n/);
          var keep = 0;
          for (var li = 0; li < lines.length && keep < 50; li++) {
            var line = (lines[li] || '').trim();
            if (!line || line.indexOf('[') !== 0) continue;
            logInfo('Scanner', '(exe) ' + line.slice(0, 300));
            keep++;
          }
        }
      } catch(_) {}

      var jsonStart = stdout.indexOf('{');
      var jsonEnd   = stdout.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        return settle({ ok: false, error: 'exe no JSON (exit=' + code + ', stdoutLen=' + stdout.length + ', stderrLen=' + stderr.length + ')' });
      }
      var pure = stdout.substring(jsonStart, jsonEnd + 1);
      try { settle(JSON.parse(pure)); }
      catch(e) { settle({ ok: false, error: 'exe parse: ' + e.message + ' | raw: ' + pure.slice(0, 200) }); }
    });
    proc.on('error', function(e) {
      _scanInProgress = false;
      settle({ ok: false, error: 'exe error: ' + e.message });
    });
    setTimeout(function() {
      if (settled) return;
      try { proc.kill('SIGKILL'); } catch(_) {}
      _scanInProgress = false;
      logWarn('Scanner', 'exe TIMEOUT, killed', { mode: mode, timeoutMs: timeoutMs });
      settle({ ok: false, error: 'exe Timeout ' + timeoutMs + 'ms (mode=' + mode + ')' });
    }, timeoutMs);
  });
}

function _runScannerPs1(args) {
  return new Promise(function(resolve) {
    var psMode = 'new';
    for (var i = 0; i < args.length - 1; i++) { if (args[i] === '-Mode') { psMode = String(args[i+1]); break; } }
    var psTimeoutMs;
    switch (psMode) {
      case 'detect-ppapi': psTimeoutMs = 6000; break;
      case 'read':         psTimeoutMs = 6000; break;
      case 'write':        psTimeoutMs = 6000; break;
      case 'batchwrite':   psTimeoutMs = 12000; break;
      case 'listprocs':    psTimeoutMs = 6000; break;
      case 'next':         psTimeoutMs = 30000; break;
      case 'new':          psTimeoutMs = 45000; break;
      default:             psTimeoutMs = 45000;
    }
    var ps1Path = _resolvePs1Path();

    if (!fs.existsSync(ps1Path)) {
      if (app.isPackaged && process.resourcesPath) {
        var fallback = path.join(process.resourcesPath, 'app.asar.unpacked', 'scanner.ps1');
        if (fs.existsSync(fallback)) { ps1Path = fallback; }
        else {
          return resolve({ ok:false, error:'scanner.ps1 not found. Expected: ' + ps1Path });
        }
      } else {
        return resolve({ ok:false, error:'scanner.ps1 not found at: ' + ps1Path });
      }
    }

    var ps1PathSafe = ps1Path.replace(/'/g, "''");
    var psArgStr = args.map(function(a) { return String(a); }).join(' ');
    var psArgs = [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & \'' + ps1PathSafe + '\' ' + psArgStr
    ];

    var stdout = '';
    var stderr = '';
    _scanInProgress = true;
    var proc = spawn(_pshell64, psArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    proc.stdout.on('data', function(d) { stdout += d.toString('utf8'); });
    proc.stderr.on('data', function(d) { stderr += d.toString('utf8'); });
    proc.on('close', function() {
      setTimeout(function() { _scanInProgress = false; }, 400);

      try {
        if (stderr && stderr.length > 0) {
          var lines = stderr.split(/\r?\n/);
          var keep = 0;
          for (var li = 0; li < lines.length && keep < 50; li++) {
            var line = (lines[li] || '').trim();
            if (!line) continue;
            if (line.indexOf('[') !== 0) continue;
            logInfo('Scanner', line.slice(0, 300));
            keep++;
          }
        }
      } catch(_) {}

      var outStr = stdout;
      var jsonStart = outStr.indexOf('{');
      var jsonEnd   = outStr.lastIndexOf('}');

      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        var errStr = (stderr + outStr).toLowerCase();
        var isAccessDenied = errStr.indexOf('access') !== -1 ||
                             errStr.indexOf('denied') !== -1 ||
                             errStr.indexOf('拒绝访问') !== -1 ||
                             errStr.indexOf('administrator') !== -1 ||
                             errStr.indexOf('privilege') !== -1;
        if (isAccessDenied) {
          return resolve({
            ok: false,
            error: '权限不足，请右键以管理员身份运行启动器再使用扫描功能'
          });
        }
        return resolve({
          ok: false,
          error: (stderr || outStr || 'No output').trim().slice(0, 300)
        });
      }

      var pureJson = outStr.substring(jsonStart, jsonEnd + 1);
      try {
        var result = JSON.parse(pureJson);
        if (result && !result.ok && result.error) {
          var errLow = result.error.toLowerCase();
          var isAccessErr = errLow.indexOf('access') !== -1 ||
                            errLow.indexOf('denied') !== -1 ||
                            errLow.indexOf('拒绝') !== -1 ||
                            errLow.indexOf('privilege') !== -1;
          if (isAccessErr) {
            return resolve({
              ok: false,
              error: '权限不足，请右键以管理员身份运行启动器再使用扫描功能'
            });
          }
        }
        resolve(result);
      } catch(e) {
        resolve({ ok:false, error: 'Parse: ' + e.message + ' | raw: ' + pureJson.slice(0, 200) });
      }
    });
    proc.on('error', function(e) {
      _scanInProgress = false;
      resolve({ ok:false, error: e.message });
    });
    setTimeout(function() {
      try { proc.kill('SIGKILL'); } catch(e) {}
      _scanInProgress = false;
      logWarn('Scanner', 'ps1 TIMEOUT, killed', { mode: psMode, timeoutMs: psTimeoutMs });
      resolve({ ok:false, error:'ps1 Timeout ' + psTimeoutMs + 'ms (mode=' + psMode + ')' });
    }, psTimeoutMs);
  });
}
function scanArgs(extra) {
  var rendererPids = [];
  if (gameRenderPid) rendererPids.push(String(gameRenderPid));
  try {
    BrowserWindow.getAllWindows().forEach(function(w) {
      try { var p = w.webContents.getOSProcessId(); if (p && rendererPids.indexOf(String(p))===-1) rendererPids.push(String(p)); } catch(e){}
    });
  } catch(e){}
  return ['-BrowserPid', String(process.pid), '-GamePids', rendererPids.join(',')].concat(extra||[]);
}

function _nuclearKillFlash() {
  if (cachedPpapiPid) {
    try {
      process.kill(cachedPpapiPid, 'SIGKILL'); // 强制终止僵尸 Flash 进程
      logInfo('NuclearRefresh', 'SIGKILL sent to Flash PID: ' + cachedPpapiPid);
    } catch(e) {
    }
    cachedPpapiPid = null;
  }
}


function _closeScannerForReload() {
  var sc = overlayWins['scanner'];
  if (sc && !sc.isDestroyed() && !_overlayClosing['scanner']) {
    _overlayClosing['scanner'] = true;
    saveOneOverlayBounds('scanner', sc);
    sc.close();
  }
}

function _collectFlashPidsForReload() {
  var out = [];
  function add(pid) {
    pid = parseInt(pid, 10) || 0;
    if (pid && pid !== process.pid && out.indexOf(pid) === -1) out.push(pid);
  }
  add(cachedPpapiPid);
  if (_speedHookState && _speedHookState.pid) add(_speedHookState.pid);
  try {
    var metrics = app.getAppMetrics();
    for (var i = 0; i < metrics.length; i++) {
      var mt = String(metrics[i].type || '').toLowerCase();
      var nm = String(metrics[i].name || metrics[i].serviceName || '').toLowerCase();
      if (mt.indexOf('ppapi') >= 0 || mt.indexOf('plugin') >= 0 || mt.indexOf('pepper') >= 0 || nm.indexOf('pepflash') >= 0) {
        add(metrics[i].pid);
      }
    }
  } catch(e) {}
  return out;
}

function _scheduleCustomSkinPreviewWindowReload(reason, killedPids, delayMs) {
  var serial = ++_customSkinPreviewPluginResetSerial;
  var scheduledWin = skinToolWins && skinToolWins.preview;
  var scheduledContentsId = scheduledWin && !scheduledWin.isDestroyed() && scheduledWin.webContents &&
    !scheduledWin.webContents.isDestroyed() ? scheduledWin.webContents.id : 0;
  if (_customSkinPreviewReloadTimer) clearTimeout(_customSkinPreviewReloadTimer);
  _customSkinPreviewReloadTimer = setTimeout(function() {
    _customSkinPreviewReloadTimer = null;
    var previewWin = skinToolWins && skinToolWins.preview;
    if (!previewWin || previewWin.isDestroyed() || !previewWin.webContents ||
        previewWin.webContents.isDestroyed() || previewWin.webContents.id !== scheduledContentsId) return;
    var request = Object.assign({}, skinToolLastRequests.preview || {}, { kind:'preview' });
    var wasPinned = !!skinToolPinState.preview;
    var wasFullscreen = false;
    try {
      wasFullscreen = previewWin.isFullScreen();
      if (!wasFullscreen) saveSkinToolBounds('preview', previewWin);
      skinUiReadyWebContents.delete(previewWin.webContents.id);
      skinToolWins.preview = null;
      openCustomSkinToolWindow(request);
      var replacement = skinToolWins.preview;
      if (!replacement || replacement.isDestroyed()) throw new Error('replacement preview window missing');
      previewWin.destroy();
      skinToolPinState.preview = wasPinned;
      if (wasPinned) replacement.setAlwaysOnTop(true, _alwaysOnTop ? 'screen-saver' : 'pop-up-menu');
      if (wasFullscreen) replacement.setFullScreen(true);
      logInfo('CustomSkin', 'Preview window recreated after plugin reset', {
        serial:serial,
        reason:String(reason || 'PluginReset'),
        revision:_customSkinRevision,
        killedPids:(killedPids || []).slice(),
        webContentsId:replacement.webContents.id,
      });
    } catch(e) {
      logWarn('CustomSkin', 'Preview window plugin recovery failed', {
        serial:serial,
        error:e && e.message ? e.message : String(e),
      });
      return;
    }
  }, Math.max(350, parseInt(delayMs, 10) || 600));
}

function _notifyCustomSkinPreviewPluginReset(tag, killedPids) {
  if (tag !== 'CustomSkinReload') return;
  _scheduleCustomSkinPreviewWindowReload(tag, killedPids, 600);
}

function _killFlashForReload(tag) {
  var pids = _collectFlashPidsForReload();
  for (var i = 0; i < pids.length; i++) {
    try {
      process.kill(pids[i], 'SIGKILL');
      logInfo(tag || 'Reload', 'Killed Flash/plugin PID: ' + pids[i]);
    } catch(e) {}
  }
  cachedPpapiPid = null;
  _flashPrioSet = false;
  _metricsCache = null;
  _metricsCacheTime = 0;
  _notifyCustomSkinPreviewPluginReset(tag, pids);
}

function _prepareReload(tag) {
  if (_appQuitting) return;
  _closeScannerForReload();
  _currentGameSpeed = 1.0;
  _loadingComplete = false;
  _speedReloadSeq++;
  _speedHookState = null;
  broadcastAll('speed-reset', { speed: 1.0 });
  _killFlashForReload(tag || 'Reload');
}

function _cleanupForAppExit(tag) {
  _appQuitting = true;
  if (_exitCleanupDone) return;
  _exitCleanupDone = true;
  try { stopFlashPrioWatcher(); } catch(e) {}
  try { stopPeakPoller(); } catch(e) {}
  try { if (_zoomDebounce) { clearTimeout(_zoomDebounce); _zoomDebounce = null; } } catch(e) {}
  try { if (_zoomThrottleTimer) { clearTimeout(_zoomThrottleTimer); _zoomThrottleTimer = null; } } catch(e) {}
  _hasPendingZoom = false;
  _currentGameSpeed = 1.0;
  _loadingComplete = false;
  _speedReloadSeq++;
  _speedHookState = null;
  _killFlashForReload(tag || 'AppExit');
}

function _loadGameEntryWithWatchdog(tag, timeoutMs) {
  if (!gameWin || gameWin.isDestroyed()) { createGame(); return Promise.resolve(false); }
  var win = gameWin;
  var timeout = Math.max(2500, Number(timeoutMs) || 7000);
  return new Promise(function(resolve) {
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      logWarn(tag || 'Reload', 'game entry load timed out; fallback required');
      resolve(false);
    }, timeout);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok === true);
    }
    var onFinished = function() { cleanup(); finish(true); };
    var onFailed = function(_event, errorCode, errorDescription, _validatedURL, isMainFrame) {
      if (isMainFrame !== false && Number(errorCode) !== -3) {
        logWarn(tag || 'Reload', 'game entry did-fail-load: ' +
          String(errorCode) + ' ' + String(errorDescription || ''));
        cleanup();
        finish(false);
      }
    };
    function cleanup() {
      try { win.webContents.removeListener('did-finish-load', onFinished); } catch(_) {}
      try { win.webContents.removeListener('did-fail-load', onFailed); } catch(_) {}
    }
    try {
      win.webContents.once('did-finish-load', onFinished);
      win.webContents.on('did-fail-load', onFailed);
      var loadPromise = win.loadURL(getGameEntryUrl());
      Promise.resolve(loadPromise).then(function() { cleanup(); finish(true); })
        .catch(function(error) {
          logWarn(tag || 'Reload', 'loadURL rejected: ' + String(error && error.message || error));
          cleanup();
          finish(false);
        });
    } catch(error) {
      logWarn(tag || 'Reload', 'loadURL threw: ' + String(error && error.message || error));
      cleanup();
      finish(false);
    }
  });
}

function _navigateGameAfterKill(tag) {
  if (!gameWin || gameWin.isDestroyed()) { createGame(); return Promise.resolve(false); }
  try { gameWin.webContents.stop(); } catch(e) {}
  return _loadGameEntryWithWatchdog(tag || 'ReloadFallback', 7000);
}

function _withTimeout(promise, ms, label) {
  return new Promise(function(resolve) {
    var done = false;
    var timer = setTimeout(function() {
      if (done) return;
      done = true;
      logWarn('ClearReload', (label || 'operation') + ' timed out; continuing reload');
      resolve(false);
    }, ms);
    Promise.resolve(promise).then(function() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    }).catch(function(e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      logWarn('ClearReload', (label || 'operation') + ' failed: ' + (e && e.message ? e.message : e));
      resolve(false);
    });
  });
}

async function doReload() {
  if (_gameReloadInFlight) {
    logInfo('Reload', 'reload request coalesced while another reload is running');
    return { ok:false, busy:true };
  }
  _gameReloadInFlight = ++_gameReloadSerial;
  try {
    clearCapturedIfCaptureEnabled('reload');
    if (!gameWin || gameWin.isDestroyed()) {
      logWarn('Reload', 'gameWin not available, cannot reload');
      return { ok:false, error:'游戏未运行' };
    }
    var loaded = await _loadGameEntryWithWatchdog('Reload', 7000);
    if (!loaded) {
      _prepareReload('ReloadFallback');
      await new Promise(function(resolve) { setTimeout(resolve, 400); });
      loaded = await _navigateGameAfterKill('ReloadFallback');
    }
    return { ok:loaded === true, fallback:loaded !== true };
  } finally {
    _gameReloadInFlight = null;
  }
}

function clearCapturedIfCaptureEnabled(reason) {
  if (coreNet.getCaptureMode && coreNet.getCaptureMode() !== 'off') {
    coreNet.clearCapturedItems();
    broadcastAll('capture-cleared', null);
    logInfo('Capture', 'Captured list cleared: ' + (reason || 'manual'));
    return true;
  }
  return false;
}

async function settlePendingCustomSkinAssignmentsAfterFlashExit() {
  if (!_customSkinAssignmentResetPending) return null;
  await new Promise(function(resolve) { setTimeout(resolve, 120); });
  var pendingAssignmentIds = Array.from(_customSkinAssignmentResetPendingIds);
  if (!_customSkinAssignmentResetAllPending && !pendingAssignmentIds.length) {
    _customSkinAssignmentResetPending = false;
    return null;
  }
  var assignmentReset = clearCustomSkinAssignmentSharedObjects(
    _customSkinAssignmentResetAllPending ? undefined : pendingAssignmentIds
  );
  assignmentReset.fullReset = _customSkinAssignmentResetAllPending === true;
  if (!assignmentReset.errors.length) {
    _customSkinAssignmentResetPending = false;
    _customSkinAssignmentResetAllPending = false;
    _customSkinAssignmentResetPendingIds.clear();
  }
  logInfo('CustomSkin', 'Pending skin assignments settled after Flash exit', assignmentReset);
  return assignmentReset;
}

async function doCustomSkinReload() {
  if (!gameWin || gameWin.isDestroyed()) return;
  if (_gameReloadInFlight) return;
  _gameReloadInFlight = ++_gameReloadSerial;
  _prepareReload('CustomSkinReload');
  try {
    await settlePendingCustomSkinAssignmentsAfterFlashExit();
    logInfo('CustomSkin', 'Reloading Flash with unrelated caches preserved');
    await _navigateGameAfterKill('CustomSkinReload');
  } finally {
    _gameReloadInFlight = null;
    // Keep one follow-up skin reload when a mode toggle arrives during
    // navigation, so the latest route state is not lost.
    var followUpReload = _customSkinReloadPendingAfterFlight;
    _customSkinReloadPendingAfterFlight = false;
    if (followUpReload && gameWin && !gameWin.isDestroyed()) {
      scheduleCustomSkinReload(0);
    }
  }
}

async function doClearCacheAndReload() {
  if (_gameReloadInFlight) {
    logInfo('ClearReload', 'clear-cache reload request coalesced while another reload is running');
    return { ok:false, busy:true };
  }
  _gameReloadInFlight = ++_gameReloadSerial;
  try {
  clearCapturedIfCaptureEnabled('clear-cache-reload');
  _prepareReload('ClearReload');

  await settlePendingCustomSkinAssignmentsAfterFlashExit();

  try {
    var wipeResult = coreNet.clearAllCache();
    logInfo('ClearReload', 'Smart Cache wiped', { deleted: wipeResult.deleted });
  } catch(e) { logWarn('ClearReload', 'Smart Cache wipe failed: ' + e.message); }

  var ses = null;
  try { if (gameWin && !gameWin.isDestroyed()) ses = gameWin.webContents.session; } catch(e) {}
  if (ses) {
    await _withTimeout(ses.clearCache(), 1200, 'session.clearCache');
    await _withTimeout(ses.clearStorageData({ storages:['localstorage','sessionstorage','indexdb','caches'] }), 1200, 'session.clearStorageData');
  }

  var loaded = await _navigateGameAfterKill('ClearReload');
  if (!loaded) {
    _prepareReload('ClearReloadFallback');
    await new Promise(function(resolve) { setTimeout(resolve, 400); });
    loaded = await _navigateGameAfterKill('ClearReloadFallback');
  }
  return { ok:loaded === true, fallback:loaded !== true };
  } finally {
    _gameReloadInFlight = null;
  }
}


var _imageWins = {}, _imageWinPins = {};

function _loadImageWinPos(key) {
  var d = loadAllOverlayBounds();
  var k = 'img-' + key;
  if (d[k] && typeof d[k].x === 'number' && typeof d[k].y === 'number') return d[k];
  return null;
}
function _saveImageWinPos(key, win) {
  if (!win || win.isDestroyed()) return;
  try {
    var b = win.getBounds();
    var d = loadAllOverlayBounds();
    d['img-' + key] = { x: b.x, y: b.y };
    saveAllOverlayBounds();
  } catch(e) {}
}
function closeAllImageWins(force) {
  Object.keys(_imageWins).forEach(function(k) {
    if (!force && _imageWinPins[k]) return;
    var w = _imageWins[k];
    if (w && !w.isDestroyed()) { w.close(); }
    _imageWins[k] = null; _imageWinPins[k] = false;
  });
}
function showImageWin(key) {
  Object.keys(_imageWins).forEach(function(k) {
    if (k === key || _imageWinPins[k]) return;
    var w = _imageWins[k];
    if (w && !w.isDestroyed()) { w.close(); }
    _imageWins[k] = null;
  });
  if (_imageWins[key] && !_imageWins[key].isDestroyed()) {
    _imageWins[key].close(); _imageWins[key] = null; _imageWinPins[key] = false; return;
  }
  var CFG = {
    'qq-group': { title:'加入Q群',  img:'qq-group.jpg',   w:420, h:700, topLabel:'群号：',     topValue:'1057843169',            copyText:'1057843169',           copyBtn:'复制群号' },
    'bilibili': { title:'B站春树',  img:'bilibili.jpg',   w:480, h:640, topLabel:'B站链接：',  topValue:'https://b23.tv/KmoOkU9', copyText:'https://b23.tv/KmoOkU9', copyBtn:'复制链接' },
    'contact':  { title:'联系春树', img:'contact-qq.jpg', w:420, h:760, topLabel:'QQ：',       topValue:'1931062331',            copyText:'1931062331',           copyBtn:'复制QQ号', note:'有星钻需求请联系我(5折),其它任何自称春树的均为骗子,请勿上当受骗' },
  };
  var cfg = CFG[key];
  if (!cfg || !gameWin || gameWin.isDestroyed()) return;
  _imageWinPins[key] = false;
  var savedPos = _loadImageWinPos(key);
  var winOpts = {
    width:cfg.w, height:cfg.h, resizable:false, frame:true, title:cfg.title,
    backgroundColor:'#111',
    alwaysOnTop: false,
    webPreferences:{ nodeIntegration:false, contextIsolation:true, sandbox:false, preload:path.join(__dirname,'image-preload.js'), backgroundThrottling:true, spellcheck:false },
    show:false, skipTaskbar:false,
  };
  if (savedPos) { winOpts.x = savedPos.x; winOpts.y = savedPos.y; }
  if (gameWin && !gameWin.isDestroyed()) {
    winOpts.parent = gameWin;
  }
  if (_alwaysOnTop) {
    winOpts.alwaysOnTop = true;
  }
  var win = new BrowserWindow(winOpts);
  win.setMenu(null);
  var _tImgMove = _makeThrottle(function() { _saveImageWinPos(key, _imageWins[key]); }, 16);
  win.on('moved', _tImgMove);
  var pinTitleUnpinned = '固定窗口（固定后：不被点击游戏关闭，且打开其它窗口时也不会自动关闭，可多窗口共存）';
  var pinTitlePinned = '已固定（多窗口共存中，不被点击或切换关闭）';
  var imgUrl = 'http://127.0.0.1:' + coreNet.getProxyPort() + '/img/' + cfg.img;
  var hasCopy = !!cfg.copyText;
  var noteHtml = cfg.note ? '<div id="note">'+cfg.note+'</div>' : '';
  var hdrHtml = hasCopy
    ? '<div id="hdr"><div id="hdr-row"><span id="lbl">'+cfg.topLabel+'</span><span id="val">'+cfg.topValue+'</span><button id="btnCopy" onclick="doCopy()">'+cfg.copyBtn+'</button><button id="btnPin" class="titlebar-pin titlebar-control" onclick="togglePin()" title="'+pinTitleUnpinned+'">📌</button></div>'+noteHtml+'</div>'
    : '<div id="hdr"><div id="hdr-row" style="justify-content:flex-end"><button id="btnPin" class="titlebar-pin titlebar-control" onclick="togglePin()" title="'+pinTitleUnpinned+'">📌</button></div></div>';
  var css = '*{margin:0;padding:0;box-sizing:border-box;font-family:sans-serif;}body{background:#111;display:flex;flex-direction:column;height:100vh;}button:focus{outline:none;}#hdr{display:flex;flex-direction:column;gap:5px;padding:6px 10px;background:#1a1d2e;border-bottom:1px solid #2a2d3e;flex-shrink:0;}#hdr-row{display:flex;align-items:center;gap:8px;width:100%;}#lbl{color:#888;font-size:13px;}#val{color:#7ec8f7;font-size:14px;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;}#note{color:#ffd166;font-size:12px;line-height:1.35;padding:0 2px 2px 45px;}#btnCopy{margin-left:auto;padding:5px 14px;background:#1a4fa0;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px;flex-shrink:0;outline:none;}#btnCopy:hover{background:#2860cc;}#btnCopy.copied{background:#178a45;}#btnCopy.copied:hover{background:#178a45;}.titlebar-pin{-webkit-app-region:no-drag;width:22px;height:22px;border:none;border-radius:3px;background:transparent;color:#7e93a8;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.5;transition:all .18s;outline:none;flex-shrink:0;}.titlebar-pin:hover{background:rgba(255,255,255,.1);opacity:.85;}.titlebar-pin.pinned{color:#f59e0b;opacity:1;outline:none;}.titlebar-pin:focus{outline:none;}#img-wrap{flex:1;overflow:hidden;}#img-wrap img{width:100%;height:100%;object-fit:contain;display:block;}';
  var copyJs = hasCopy ? 'function doCopy(){window.imgAPI.copyText('+JSON.stringify(cfg.copyText)+');var b=document.getElementById("btnCopy");if(!b)return;if(!b.dataset.oldText)b.dataset.oldText=b.textContent;b.textContent="已复制";b.className="copied";try{b.blur();}catch(_){}clearTimeout(window.__copyTimer);window.__copyTimer=setTimeout(function(){b.textContent=b.dataset.oldText||'+JSON.stringify(cfg.copyBtn)+';b.className="";},1200);}' : '';
  var js = 'var _pinned=false;function togglePin(){_pinned=!_pinned;var b=document.getElementById("btnPin");if(b){b.className="titlebar-pin titlebar-control"+(_pinned?" pinned":"");b.title=_pinned?'+JSON.stringify(pinTitlePinned)+':'+JSON.stringify(pinTitleUnpinned)+';try{b.blur();}catch(_){}}try{window.imgAPI.setPinned(_pinned);}catch(e){}}document.addEventListener("mouseup",function(event){var button=event.target&&event.target.closest?event.target.closest("button"):null;if(button)setTimeout(function(){try{button.blur()}catch(_){}},0);});document.addEventListener("keydown",function(event){if(event.key==="Escape"){window.close();}});' + copyJs;
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body>'+hdrHtml+'<div id="img-wrap"><img src="'+imgUrl+'" /></div><script>'+js+'</script></body></html>';
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', function() {
    var w = _imageWins[key];
    if (w && !w.isDestroyed()) {
      if (gameWin && !gameWin.isDestroyed()) {
        try { w.setParentWindow(gameWin); } catch(_) {}
      }
      if (_alwaysOnTop || _imageWinPins[key]) {
        try { w.setAlwaysOnTop(true, _alwaysOnTop ? 'screen-saver' : 'pop-up-menu'); } catch(_) {}
      }
      try { w.showInactive(); } catch(_) { w.show(); }
      try { w.moveTop(); } catch(_) {}
      if (gameWin && !gameWin.isDestroyed()) {
        try { gameWin.focus(); } catch(_) {}
      }
    }
  });
  win.on('closed', function() {
    try { win.removeAllListeners(); } catch(e) {}
    _imageWins[key] = null;
    _imageWinPins[key] = false;
    if (gameWin && !gameWin.isDestroyed()) {
      try { gameWin.focus(); } catch(_) {}
    }
  });
  _imageWins[key] = win;
}

var OVERLAY_BOUNDS_FILE = path.join(path.dirname(process.execPath), 'overlay-bounds.json');
var _overlayBoundsCache = null;
var _overlayBoundsDirty = false;
var _overlayBoundsWriteTimer = null;
function loadAllOverlayBounds() {
  if (_overlayBoundsCache) return _overlayBoundsCache;
  try { if (fs.existsSync(OVERLAY_BOUNDS_FILE)) _overlayBoundsCache = JSON.parse(fs.readFileSync(OVERLAY_BOUNDS_FILE,'utf8')); } catch(e) {}
  if (!_overlayBoundsCache) _overlayBoundsCache = {};
  return _overlayBoundsCache;
}
function saveAllOverlayBounds() {
  _overlayBoundsDirty = true;
  if (_overlayBoundsWriteTimer) return; // 已有待写任务，不重复调度
  _overlayBoundsWriteTimer = setTimeout(function() {
    _overlayBoundsWriteTimer = null;
    if (!_overlayBoundsDirty) return;
    _overlayBoundsDirty = false;
    var data = JSON.stringify(_overlayBoundsCache || {});
    fs.writeFile(OVERLAY_BOUNDS_FILE, data, 'utf8', function(err) {
      if (err) logWarn('Bounds', 'writeFile failed: ' + err.message);
    });
  }, 500);
}
function gameContentRef() { try { return gameWin.getContentBounds(); } catch(e) { return gameWin.getBounds(); } }
function saveOneOverlayBounds(name, win, cachedGameBounds) {
  if (!win || win.isDestroyed() || !gameWin || gameWin.isDestroyed()) return;
  var sb = win.getBounds(), cb = cachedGameBounds || gameContentRef(), d = loadAllOverlayBounds();
  d[name] = { dx:sb.x-cb.x, dy:sb.y-cb.y, width:sb.width, height:sb.height };
  saveAllOverlayBounds();
}
var GAME_MENUBAR_H = 30;
function clampOverlayBoundsToWorkArea(name, candidate, cfg, gameBounds, allBounds) {
  var original = { x:candidate.x, y:candidate.y, width:candidate.width, height:candidate.height };
  try {
    var electronScreen = require('electron').screen;
    var display = electronScreen.getDisplayMatching(candidate);
    var work = display && display.workArea ? display.workArea : (display && display.bounds);
    if (!work) return candidate;
    var margin = 6;
    var minW = Math.min(cfg.minW || 480, Math.max(1, work.width - margin * 2));
    var minH = Math.min(cfg.minH || 300, Math.max(1, work.height - margin * 2));
    candidate.width = Math.max(minW, Math.min(candidate.width, work.width - margin * 2));
    candidate.height = Math.max(minH, Math.min(candidate.height, work.height - margin * 2));
    candidate.x = Math.max(work.x + margin, Math.min(candidate.x, work.x + work.width - candidate.width - margin));
    candidate.y = Math.max(work.y + margin, Math.min(candidate.y, work.y + work.height - candidate.height - margin));
    if (candidate.x !== original.x || candidate.y !== original.y ||
        candidate.width !== original.width || candidate.height !== original.height) {
      if (allBounds && gameBounds) {
        allBounds[name] = {
          dx:candidate.x-gameBounds.x, dy:candidate.y-gameBounds.y,
          width:candidate.width, height:candidate.height,
        };
        saveAllOverlayBounds();
      }
      logWarn('Overlay', 'restored bounds clamped to display work area', {
        name:name, from:original, to:candidate,
        workArea:{ x:work.x, y:work.y, width:work.width, height:work.height },
      });
    }
  } catch(e) {
    logWarn('Overlay', 'display clamp failed; using requested bounds', { name:name, error:e.message });
  }
  return candidate;
}
function resolveOverlayBounds(name, defW, defH) {
  if (!gameWin || gameWin.isDestroyed()) return { x:300, y:150, width:defW, height:defH };
  var cb = gameContentRef(), d = loadAllOverlayBounds(), cfg = overlayCfg[name] || {};
  // Drop the old oversized quality bounds left by the removed GPU section.
  if (name === 'quality' && d[name] && d[name].height > 360) {
    delete d[name];
    saveAllOverlayBounds();
  }
  var minH = (overlayCfg[name] && overlayCfg[name].minH) ? overlayCfg[name].minH : 300;
  if (d[name] && d[name].dy >= GAME_MENUBAR_H && d[name].height >= minH) {
    return clampOverlayBoundsToWorkArea(name, {
      x:cb.x+d[name].dx, y:cb.y+d[name].dy,
      width:d[name].width, height:d[name].height,
    }, cfg, cb, d);
  }
  if (d[name]) { delete d[name]; saveAllOverlayBounds(); }
  return clampOverlayBoundsToWorkArea(name, {
    x:      cb.x + Math.floor((cb.width - Math.min(defW, cb.width-4)) / 2),
    y:      cb.y + GAME_MENUBAR_H,
    width:  Math.min(defW, cb.width-4),
    height: Math.min(defH, cb.height-GAME_MENUBAR_H-10),
  }, cfg, cb, d);
}

var overlayWins = { scanner:null, cache:null, speed:null, replace:null, skin:null, quality:null };
var skinToolWins = { catalog:null, preview:null, download:null };
var skinToolLastRequests = { catalog:null, preview:null, download:null };
var skinToolPinState = { catalog:false, preview:false, download:false };
var activeSkinToolKind = '';
var skinSurfaceGeneration = 0;
var skinUiReadyWebContents = new Set();
var _customSkinPreviewPluginResetSerial = 0;
var _customSkinPreviewPartitionSerial = 0;
var _customSkinPreviewReloadTimer = null;
var skinThumbnailWin = null;
var skinThumbnailReady = null;
var skinThumbnailQueue = Promise.resolve();
var skinThumbnailLatestGeneration = new Map();
// Reloads can be requested by the menu, cache actions, and automatic skin
// imports at the same time.  Keep one navigation in flight so a second
// request cannot tear down the first document and leave a white/empty game
// surface behind.
var _gameReloadInFlight = null;
var _gameReloadSerial = 0;
var skinToolCfg = {
  catalog:  { title:'赛尔号 1 精灵与皮肤资料库', width:1180, height:620, minWidth:760, minHeight:420, maxHeight:620 },
  preview:  { title:'精灵动画预览', width:940, height:720, minWidth:700, minHeight:520 },
  download: { title:'下载赛尔号 1 官方模型', width:640, height:620, minWidth:620, minHeight:540, maxWidth:680, maxHeight:660 },
};
var overlayCfg  = {
  scanner:  { file:'scanner-overlay.html',  defW:960,  defH:520, minH:380, minW:480, title:'内存扫描器' },
  proxy:    { file:'proxy-overlay.html',    defW:520,  defH:580, minH:520, minW:480, title:'代理设置' },
  cache:    { file:'cache-overlay.html',    defW:820,  defH:560, minH:400, minW:480, title:'缓存管理' },
  speed:    { file:'speed-overlay.html',    defW:420,  defH:300, minH:260, minW:280, title:'游戏变速' },
  replace:  { file:'replace-overlay.html',  defW:760,  defH:500, minH:360, minW:560, title:'请求替换' },
  skin:     { file:'skin-overlay.html',     defW:920,  defH:600, minH:440, minW:720, title:'自定义精灵皮肤' },
  quality:  { file:'quality-overlay.html',  defW:480,  defH:295, minH:275, minW:440, title:'画质' },
};



var _lastGBForOverlays = null;
function onGameWindowMoved() {
  if (!gameWin || gameWin.isDestroyed()) { _lastGBForOverlays = null; return; }
  _lastGBForOverlays = gameContentRef();
}
var _overlayClosing = {}, overlayPinState = {}, _gameMinimized = false;
var _minimizedByGameMin = {};
var skinOverlayVisibility = createOverlayVisibilityIntent();

function visibleSkinToolWindow(kind) {
  var win = kind && skinToolWins[kind];
  return win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() ? win : null;
}

function currentSkinToolWindow() {
  return visibleSkinToolWindow(activeSkinToolKind);
}

function bringCurrentSkinToolToTop() {
  var win = currentSkinToolWindow();
  if (!win) return false;
  try { win.moveTop(); } catch(_) {}
  return true;
}

function applySkinToolTopPolicy(kind, win) {
  if (!win || win.isDestroyed()) return;
  var shouldFloat = !!skinToolPinState[kind] ||
    (!!overlayPinState.skin && activeSkinToolKind === kind);
  try {
    if (shouldFloat) win.setAlwaysOnTop(true, _alwaysOnTop ? 'screen-saver' : 'pop-up-menu');
    else win.setAlwaysOnTop(false);
  } catch(_) {}
}

function retireUnpinnedSkinTool(kind, win) {
  if (!win || win.isDestroyed() || skinToolPinState[kind]) return;
  try { saveSkinToolBounds(kind, win); } catch(_) {}
  if (kind === 'preview') {
    skinToolWins[kind] = null;
    skinToolPinState[kind] = false;
    try { win.close(); } catch(_) { try { win.destroy(); } catch(__) {} }
  } else if (win.isVisible()) {
    win.hide();
  }
}

function activateSkinLibrarySurface() {
  skinSurfaceGeneration++;
  activeSkinToolKind = '';
  Object.keys(skinToolWins).forEach(function(kind) {
    retireUnpinnedSkinTool(kind, skinToolWins[kind]);
  });
}

function activateSkinToolSurface(kind) {
  activeSkinToolKind = kind;
  var generation = ++skinSurfaceGeneration;
  var skinWin = overlayWins.skin;
  if (skinWin && !skinWin.isDestroyed() && skinWin.isVisible()) {
    // Keep the library window available behind the active catalog/download/
    // preview surface.  The tool is shown and moved to the top afterwards;
    // game-focus routing also raises the active tool last, so the library can
    // no longer cover it without being destroyed as a side effect.
    // The skin overlay is already visible here.  Do not mutate its visibility
    // intent while opening a satellite tool window: doing so can race the
    // overlay ready/fallback path and make the library window close itself.
  }
  Object.keys(skinToolWins).forEach(function(otherKind) {
    if (otherKind === kind) return;
    retireUnpinnedSkinTool(otherKind, skinToolWins[otherKind]);
  });
  return generation;
}

function closeUnpinnedOverlays() {
  Object.keys(overlayWins).forEach(function(name) {
    var w = overlayWins[name];
    if (!w || w.isDestroyed() || overlayPinState[name]) return;
    if (name === 'scanner' || name === 'skin') {
      if (name === 'skin') {
        skinOverlayVisibility.requestClose();
        // 皮肤页包含本地皮肤列表、缩略图观察器和 Flash/预览监听器。
        // 关闭游戏后不能只 hide 保活，否则渲染进程会一直驻留并持续占用资源。
        if (!_overlayClosing[name]) {
          _overlayClosing[name] = true;
          saveOneOverlayBounds(name, w);
          disposeSkinThumbnailWorker();
          w.close();
        }
      } else if (w.isVisible()) {
        w.hide();
      }
      return;
    }
    if (!_overlayClosing[name]) { _overlayClosing[name] = true; saveOneOverlayBounds(name, w); w.close(); }
  });
  Object.keys(skinToolWins).forEach(function(kind) {
    var w = skinToolWins[kind];
    if (!w || w.isDestroyed() || skinToolPinState[kind]) return;
    saveSkinToolBounds(kind, w);
    if (kind !== 'preview' || (kind === 'download' && _customSkinDownloadRunning)) {
      if (w.isVisible()) w.hide();
      return;
    }
    w.close();
  });
  if (!currentSkinToolWindow()) activeSkinToolKind = '';
}

function toggleOverlay(name) {
  var cfg = overlayCfg[name];
  if (!cfg || _overlayClosing[name]) return;
  var win = overlayWins[name];
  if (win && !win.isDestroyed()) {
    var wc = win.webContents;
    var dead = false;
    try { dead = !wc || wc.isDestroyed() || wc.isCrashed(); } catch(_) { dead = true; }
    if (dead) {
      try { logWarn('Overlay', 'detected dead webContents, disposing before reopen', { name: name }); } catch(_) {}
      try { win.destroy(); } catch(_) {}
      overlayWins[name] = null;
      overlayPinState[name] = false;
      _overlayClosing[name] = false;
      win = null;
    }
  }
  if (name === 'scanner') {
    if (win && !win.isDestroyed()) {
      if (win.isVisible()) {
        win.hide();
      } else {
        activateSkinLibrarySurface();
        if (gameWin && !gameWin.isDestroyed()) {
          try { win.setParentWindow(gameWin); } catch(_) {}
        }
        win.setAlwaysOnTop(true, _alwaysOnTop ? 'screen-saver' : 'pop-up-menu');
        win.show();
        win.focus();
        try { win.moveTop(); } catch(_) {}
      }
      return;
    }
  } else if (name === 'skin') {
    if (win && !win.isDestroyed()) {
      if (win.isVisible()) {
        skinOverlayVisibility.requestClose();
        _overlayClosing[name] = true;
        saveOneOverlayBounds(name, win);
        disposeSkinThumbnailWorker();
        win.close();
      } else {
        activateSkinLibrarySurface();
        skinOverlayVisibility.requestOpen();
        if (gameWin && !gameWin.isDestroyed()) {
          try { win.setParentWindow(gameWin); } catch(_) {}
        }
        if (_alwaysOnTop) {
          try { win.setAlwaysOnTop(true, 'screen-saver'); } catch(_) {}
        }
        win.show();
        win.focus();
        try { win.moveTop(); } catch(_) {}
      }
      return;
    }
  } else {
    if (win && !win.isDestroyed()) {
      _overlayClosing[name] = true; saveOneOverlayBounds(name, win); win.close(); return;
    }
  }
  if (!gameWin || gameWin.isDestroyed()) return;
  if (name === 'skin') {
    activateSkinLibrarySurface();
    skinOverlayVisibility.requestOpen();
  } else {
    activateSkinLibrarySurface();
  }
  if (gameWin.isMinimized()) { gameWin.restore(); }
  Object.keys(overlayWins).forEach(function(other) {
    if (other === name) return;
    var ow = overlayWins[other];
    if (!ow || ow.isDestroyed() || _overlayClosing[other]) return;
    if (overlayPinState[other]) return; // 已钉住：保持显示，允许多窗口同时存在
    if (other === 'skin') {
      skinOverlayVisibility.requestClose();
      saveOneOverlayBounds(other, ow);
      _overlayClosing[other] = true;
      disposeSkinThumbnailWorker();
      ow.close();
      return;
    }
    _overlayClosing[other] = true; saveOneOverlayBounds(other, ow); ow.close();
  });

  var b = resolveOverlayBounds(name, cfg.defW, cfg.defH);
  _lastGBForOverlays = gameContentRef();
  var winOpts = {
    x:b.x, y:b.y, width:b.width, height:b.height,
    minWidth: Math.min(b.width, cfg.minW || 480), minHeight:cfg.minH||300,
    title:cfg.title, backgroundColor:'#0a0e1a',
    frame:false, thickFrame:true, movable:true, resizable:true,
    icon:path.join(__dirname,'icon.ico'),
    alwaysOnTop: _alwaysOnTop ? true : false,
    webPreferences:{ nodeIntegration:false, contextIsolation:true, sandbox:false, preload:path.join(__dirname,'preload.js'), plugins:false, backgroundThrottling:false, spellcheck:false, enableWebSQL:false, v8CacheOptions:'bypassHeatCheck' },
    show:false, skipTaskbar:false,
  };
  if (gameWin && !gameWin.isDestroyed()) {
    winOpts.parent = gameWin;
  }
  var newWin = new BrowserWindow(winOpts);
  newWin.loadFile(cfg.file);

  var _selfDestroying = false;
  var _disposeForCrash = function(reason) {
    if (_selfDestroying) return;
    _selfDestroying = true;
    try { logError('Overlay', 'crash/unresponsive — disposing', { name: name, reason: reason }); } catch(_) {}
    try { newWin.webContents.removeAllListeners(); } catch(_) {}
    try { newWin.removeAllListeners('moved'); } catch(_) {}
    try { newWin.removeAllListeners('resized'); } catch(_) {}
    try {
      if (newWin && !newWin.isDestroyed()) newWin.destroy();
    } catch(_) {}
    overlayWins[name] = null;
    overlayPinState[name] = false;
    _overlayClosing[name] = false;
    if (name === 'skin') disposeSkinThumbnailWorker();
  };
  newWin.webContents.on('render-process-gone', function(_e, details) {
    _disposeForCrash('render-process-gone:' + (details && details.reason));
  });
  newWin.webContents.on('did-fail-load', function(_e, errorCode, errorDescription, _validatedURL, isMainFrame) {
    if (isMainFrame === false || Number(errorCode) === -3) return;
    _disposeForCrash('did-fail-load:' + String(errorCode) + ':' + String(errorDescription || ''));
  });
  try {
    newWin.webContents.on('crashed', function() { _disposeForCrash('crashed'); });
  } catch(_) {}
  newWin.on('unresponsive', function() {
    try { logWarn('Overlay', 'unresponsive — disposing', { name: name }); } catch(_) {}
    _disposeForCrash('unresponsive');
  });


  var skinReadyFallback = null;
  newWin.__skinReadyFallbackTimer = null;
  function clearSkinReadyFallback() {
    if (skinReadyFallback) clearTimeout(skinReadyFallback);
    skinReadyFallback = null;
    newWin.__skinReadyFallbackTimer = null;
  }
  function showOverlayAfterPaint() {
    var w = overlayWins[name];
    if (!w || w.isDestroyed()) return;
    if (name === 'skin' && !skinUiReadyWebContents.has(w.webContents.id)) return;
    if (name === 'skin' && !skinOverlayVisibility.shouldShow()) return;
    if (name === 'skin' && currentSkinToolWindow()) return;
    clearSkinReadyFallback();
    if (gameWin && !gameWin.isDestroyed()) {
      try { w.setParentWindow(gameWin); } catch(_) {}
    }
    if (_alwaysOnTop || overlayPinState[name]) {
      try { w.setAlwaysOnTop(true, _alwaysOnTop ? 'screen-saver' : 'pop-up-menu'); } catch(_) {}
    }
    w.show();
    try { w.focus(); } catch(_) {}
    try { w.moveTop(); } catch(_) {} // 提升到当前 Z 序顶层
    w.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(function(){});
    console.log('[Overlay] shown:', name);
  }
  newWin.once('ready-to-show', function() {
    if (name !== 'skin' || skinUiReadyWebContents.has(newWin.webContents.id)) {
      showOverlayAfterPaint();
      return;
    }
    skinReadyFallback = setTimeout(function() {
      newWin.__skinReadyFallbackTimer = null;
      skinReadyFallback = null;
      if (newWin.isDestroyed()) return;
      var verify = Promise.resolve().then(function() {
        return newWin.webContents.executeJavaScript(
          'document.documentElement.dataset.skinUiReady === "1"', true);
      }).catch(function() { return false; });
      verify.then(function(ok) {
        if (newWin.isDestroyed()) return;
        if (ok === true) {
          skinUiReadyWebContents.add(newWin.webContents.id);
          showOverlayAfterPaint();
        } else {
          _disposeForCrash('skin-ui-ready-timeout');
        }
      });
    }, 5000);
    newWin.__skinReadyFallbackTimer = skinReadyFallback;
  });
  var _tMove   = _makeThrottle(function() { var w=overlayWins[name]; if(w&&!w.isDestroyed()) saveOneOverlayBounds(name,w,_lastGBForOverlays); }, 16);
  var _tResize = _makeThrottle(function() { var w=overlayWins[name]; if(w&&!w.isDestroyed()) saveOneOverlayBounds(name,w,_lastGBForOverlays); }, 16);
  newWin.on('moved',   _tMove);
  newWin.on('resized', _tResize);
  newWin.on('closed', function() {
    clearSkinReadyFallback();
    try { skinUiReadyWebContents.delete(newWin.webContents.id); } catch(_) {}
    try { newWin.webContents.removeAllListeners(); } catch(e) {}
    try { newWin.removeAllListeners(); } catch(e) {} // 断开 moved/resized/blur 闭包自引用
    overlayWins[name] = null;
    overlayPinState[name] = false;
    _overlayClosing[name] = false;
    if (name === 'skin') skinOverlayVisibility.requestClose();
    if (name === 'skin') disposeSkinThumbnailWorker();
    console.log('[Overlay] closed:', name);
  });
  overlayWins[name] = newWin;
}

function skinToolBoundsKey(kind) { return 'skin-tool-' + kind; }
function resolveSkinToolBounds(kind, cfg) {
  var saved = loadAllOverlayBounds()[skinToolBoundsKey(kind)];
  var base = gameWin && !gameWin.isDestroyed() ? gameWin.getBounds() : { x:180, y:100, width:1280, height:800 };
  var candidate = saved && saved.absolute === true && saved.width >= cfg.minWidth && saved.height >= cfg.minHeight ? {
    x:saved.x, y:saved.y, width:saved.width, height:saved.height,
  } : {
    x:Math.max(0, base.x + Math.floor((base.width - cfg.width) / 2)),
    y:Math.max(0, base.y + Math.floor((base.height - cfg.height) / 2)),
    width:cfg.width,
    height:cfg.height,
  };
  try {
    var display = require('electron').screen.getDisplayMatching(candidate);
    var work = display && display.workArea ? display.workArea : display.bounds;
    var margin = 6;
    var maxWidth = Math.min(work.width - margin * 2, cfg.maxWidth || work.width - margin * 2);
    var maxHeight = Math.min(work.height - margin * 2, cfg.maxHeight || work.height - margin * 2);
    candidate.width = Math.max(cfg.minWidth, Math.min(candidate.width, maxWidth));
    candidate.height = Math.max(cfg.minHeight, Math.min(candidate.height, maxHeight));
    candidate.x = Math.max(work.x + margin, Math.min(candidate.x, work.x + work.width - candidate.width - margin));
    candidate.y = Math.max(work.y + margin, Math.min(candidate.y, work.y + work.height - candidate.height - margin));
  } catch(_) {}
  return candidate;
}
function saveSkinToolBounds(kind, win) {
  if (!win || win.isDestroyed()) return;
  var b = win.getBounds(), all = loadAllOverlayBounds();
  all[skinToolBoundsKey(kind)] = { absolute:true, x:b.x, y:b.y, width:b.width, height:b.height };
  saveAllOverlayBounds();
}
function disposeSkinThumbnailWorker() {
  if (skinThumbnailWin && !skinThumbnailWin.isDestroyed()) {
    try { skinThumbnailWin.destroy(); } catch(_) {}
  }
  skinThumbnailWin = null;
  skinThumbnailReady = null;
}
function closeAllSkinToolWins() {
  activeSkinToolKind = '';
  skinSurfaceGeneration++;
  Object.keys(skinToolWins).forEach(function(kind) {
    var win = skinToolWins[kind];
    skinToolWins[kind] = null;
    skinToolPinState[kind] = false;
    if (!win || win.isDestroyed()) return;
    try { saveSkinToolBounds(kind, win); } catch(_) {}
    try { win.webContents.removeAllListeners(); } catch(_) {}
    try { win.removeAllListeners(); } catch(_) {}
    try { win.close(); } catch(_) { try { win.destroy(); } catch(__) {} }
  });
  disposeSkinThumbnailWorker();
}

function skinThumbnailCacheFile(id, mode) {
  if (!CUSTOM_SKINS_FILE) return '';
  mode = mode === 'normal' ? 'normal' : 'fight';
  return path.join(path.dirname(CUSTOM_SKINS_FILE), 'custom-skin-thumbnails', mode + '-' + id + '-v1.png');
}

function invalidateSkinThumbnailCache() {
  if (!CUSTOM_SKINS_FILE) return 0;
  var directory = path.join(path.dirname(CUSTOM_SKINS_FILE), 'custom-skin-thumbnails');
  if (!fs.existsSync(directory)) return 0;
  var removed = 0;
  try {
    fs.readdirSync(directory).forEach(function(name) {
      var file = path.join(directory, name);
      try {
        if (fs.statSync(file).isFile()) { fs.unlinkSync(file); removed++; }
      } catch(_) {}
    });
    try { fs.rmdirSync(directory); } catch(_) {}
  } catch(_) {}
  return removed;
}

function ensureSkinThumbnailWorker() {
  if (skinThumbnailWin && !skinThumbnailWin.isDestroyed()) return skinThumbnailReady;
  skinThumbnailWin = new BrowserWindow({
    x:8, y:8, width:200, height:200, opacity:0.01,
    frame:false, show:false, skipTaskbar:true, resizable:false,
    backgroundColor:'#07111d',
    webPreferences:{
      nodeIntegration:false, contextIsolation:true, sandbox:false,
      plugins:true, backgroundThrottling:false, spellcheck:false,
      enableWebSQL:false, v8CacheOptions:'bypassHeatCheck',
    },
  });
  try { skinThumbnailWin.webContents.setAudioMuted(true); } catch(_) {}
  skinThumbnailReady = new Promise(function(resolve, reject) {
    var worker = skinThumbnailWin;
    var settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(worker);
    }
    worker.webContents.once('did-finish-load', function() { finish(); });
    worker.webContents.once('did-fail-load', function(_event, code, description) {
      finish(new Error('thumbnail renderer load failed: ' + code + ' ' + description));
    });
    worker.loadFile(path.join(__dirname, 'skin-thumbnail.html'), { query:{
      previewOrigin:'http://127.0.0.1:' + coreNet.getProxyPort(),
    }});
  });
  skinThumbnailWin.on('closed', function() {
    skinThumbnailWin = null;
    skinThumbnailReady = null;
  });
  return skinThumbnailReady;
}

async function recordCustomSkinRenderedThumbnail(id, mode) {
  if (mode !== 'fight') return;
  try {
    var catalog = await loadSeer1OfficialPetCatalog();
    var check = catalog && catalog.modelStructureChecks && catalog.modelStructureChecks[String(id)];
    var labels = check && Array.isArray(check.labels) ? check.labels : [];
    if (labels.length) {
      await markSeer1OfficialPlaybackVerified({ id:id, surface:'new-ui', labels:labels });
    }
  } catch(_) {}
}

async function renderCustomSkinThumbnail(id, preferredMode) {
  id = parseCustomSkinId(id);
  var storageGeneration = _customSkinStorageGeneration;
  if (!id) throw new Error('无效的精灵序号');
  var mode = preferredMode === 'normal' ? 'normal' : 'fight';
  var cacheFile = skinThumbnailCacheFile(id, mode);
  if (cacheFile && fs.existsSync(cacheFile)) {
    var cached = await fs.promises.readFile(cacheFile);
    if (cached.length > 100) {
      await recordCustomSkinRenderedThumbnail(id, mode);
      return { ok:true, id:id, cached:true, dataUrl:'data:image/png;base64,' + cached.toString('base64') };
    }
  }
  var worker = await ensureSkinThumbnailWorker();
  if (!worker || worker.isDestroyed()) throw new Error('缩略图渲染器不可用');
  try { worker.showInactive(); } catch(_) {}
  var source = 'http://127.0.0.1:' + coreNet.getProxyPort() + '/launcher/pet-preview/' + mode + '/' + id + '.swf';
  var serial = await worker.webContents.executeJavaScript(
    'window.renderSkinThumbnail(' + JSON.stringify(source) + ',' + JSON.stringify(mode) + ')'
  );
  await new Promise(function(resolve) { setTimeout(resolve, 900); });
  var paintedPng = (await worker.capturePage()).toPNG();
  if (!paintedPng || paintedPng.length < 8000) {
    await new Promise(function(resolve) { setTimeout(resolve, 1800); });
    paintedPng = (await worker.capturePage()).toPNG();
  }
  if (paintedPng && paintedPng.length >= 8000) {
    try { worker.hide(); } catch(_) {}
    if (storageGeneration !== _customSkinStorageGeneration) {
      return { ok:false, id:id, stale:true };
    }
    if (cacheFile) {
      await fs.promises.mkdir(path.dirname(cacheFile), { recursive:true });
      await fs.promises.writeFile(cacheFile, paintedPng);
    }
    await recordCustomSkinRenderedThumbnail(id, mode);
    return { ok:true, id:id, cached:false, dataUrl:'data:image/png;base64,' + paintedPng.toString('base64') };
  }
  var state = null;
  for (var attempt = 0; attempt < 32; attempt++) {
    await new Promise(function(resolve) { setTimeout(resolve, 100); });
    if (!worker || worker.isDestroyed()) throw new Error('缩略图渲染器已退出');
    state = await worker.webContents.executeJavaScript('window.__skinThumbState');
    if (state && Number(state.serial) === Number(serial) && state.state === 'ready') break;
    if (state && Number(state.serial) === Number(serial) && state.state === 'error') {
      throw new Error(state.message || '模型不可预览');
    }
  }
  if (!state || Number(state.serial) !== Number(serial) || state.state !== 'ready') {
    try {
      var debugRoot = CUSTOM_SKINS_FILE ? path.dirname(CUSTOM_SKINS_FILE) : app.getPath('userData');
      var debugState = await worker.webContents.executeJavaScript(
        "({state:window.__skinThumbState,plugins:Array.from(navigator.plugins||[]).map(function(p){return p.name}),objectCount:document.querySelectorAll('object,embed').length,html:document.getElementById('host').innerHTML.slice(0,800)})"
      );
      fs.writeFileSync(path.join(debugRoot, 'thumbnail-debug.json'), JSON.stringify(debugState, null, 2), 'utf8');
      fs.writeFileSync(path.join(debugRoot, 'thumbnail-debug.png'), (await worker.capturePage()).toPNG());
    } catch(_) {}
    throw new Error('缩略图生成超时');
  }
  await new Promise(function(resolve) { setTimeout(resolve, 180); });
  var png = (await worker.capturePage()).toPNG();
  if (!png || png.length < 100) throw new Error('缩略图截取失败');
  if (storageGeneration !== _customSkinStorageGeneration) {
    return { ok:false, id:id, stale:true };
  }
  if (cacheFile) {
    await fs.promises.mkdir(path.dirname(cacheFile), { recursive:true });
    await fs.promises.writeFile(cacheFile, png);
  }
  await recordCustomSkinRenderedThumbnail(id, mode);
  return { ok:true, id:id, cached:false, dataUrl:'data:image/png;base64,' + png.toString('base64') };
}

function queueCustomSkinThumbnail(request) {
  var id = parseCustomSkinId(request && request.id);
  var mode = String(request && request.mode || '').toLowerCase() === 'normal' ? 'normal' : 'fight';
  var scope = String(request && request.scope || '').trim().slice(0, 80);
  var generation = Math.max(0, parseInt(request && request.generation, 10) || 0);
  if (scope && generation) {
    skinThumbnailLatestGeneration.set(scope, Math.max(generation, skinThumbnailLatestGeneration.get(scope) || 0));
  }
  var job = skinThumbnailQueue.then(function() {
    if (scope && generation && generation < (skinThumbnailLatestGeneration.get(scope) || 0)) {
      return { ok:false, id:id, stale:true };
    }
    return renderCustomSkinThumbnail(id, mode);
  });
  skinThumbnailQueue = job.catch(function() {});
  return job;
}

function skinToolWindowHealthy(kind, win) {
  if (!win || win.isDestroyed()) return false;
  if (win.__skinToolLoadFailed === true) return false;
  try {
    var wc = win.webContents;
    return !!wc && !wc.isDestroyed() && !wc.isCrashed();
  } catch(_) {
    return false;
  }
}

function disposeSkinToolWindowForFailure(kind, win, reason) {
  if (!win || win.__skinToolDisposing) return;
  win.__skinToolDisposing = true;
  win.__skinToolLoadFailed = true;
  try { logWarn('CustomSkin', 'disposing unhealthy tool window', { kind:kind, reason:String(reason || '') }); } catch(_) {}
  if (skinToolWins[kind] === win) {
    skinToolWins[kind] = null;
    skinToolPinState[kind] = false;
    if (activeSkinToolKind === kind) activeSkinToolKind = '';
  }
  try { saveSkinToolBounds(kind, win); } catch(_) {}
  try { if (!win.isDestroyed()) win.destroy(); } catch(_) {}
}

function bindSkinToolWindowHealth(kind, win) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  var wc = win.webContents;
  win.__skinToolLoaded = false;
  win.__skinToolLoadFailed = false;
  win.__skinToolPendingRequest = null;
  wc.on('did-finish-load', function() {
    if (win.isDestroyed()) return;
    win.__skinToolLoaded = true;
    win.__skinToolLoadFailed = false;
    var pending = win.__skinToolPendingRequest;
    win.__skinToolPendingRequest = null;
    if (pending && !win.isDestroyed() && !wc.isDestroyed()) {
      try { wc.send('custom-skin-tool-request', pending); } catch(_) {}
    }
  });
  wc.on('did-fail-load', function(_event, errorCode, errorDescription, _validatedURL, isMainFrame) {
    if (isMainFrame === false || Number(errorCode) === -3) return;
    disposeSkinToolWindowForFailure(kind, win, 'did-fail-load:' + String(errorCode) + ':' + String(errorDescription || ''));
  });
  wc.on('render-process-gone', function(_event, details) {
    disposeSkinToolWindowForFailure(kind, win, 'render-process-gone:' + String(details && details.reason || ''));
  });
  try { wc.on('crashed', function() { disposeSkinToolWindowForFailure(kind, win, 'crashed'); }); } catch(_) {}
  win.on('unresponsive', function() { disposeSkinToolWindowForFailure(kind, win, 'unresponsive'); });
}

function openCustomSkinToolWindow(request) {
  request = request && typeof request === 'object' ? request : {};
  var kind = ['catalog','preview','download'].indexOf(String(request.kind || '')) >= 0 ? String(request.kind) : '';
  if (!kind) return { ok:false, error:'不支持的皮肤工具窗口' };
  if (!_skinModeEnabled) return { ok:false, error:'皮肤模式已关闭，请先开启皮肤模式' };
  var existingWindow = skinToolWins[kind];
  var surfaceGeneration = existingWindow && !existingWindow.isDestroyed() &&
    existingWindow.__skinToolLoaded === false
    ? (activeSkinToolKind = kind, skinSurfaceGeneration)
    : activateSkinToolSurface(kind);
  skinToolLastRequests[kind] = Object.assign({}, request, { kind:kind });
  var current = skinToolWins[kind];
  if (current && !current.isDestroyed()) {
    if (!skinToolWindowHealthy(kind, current)) {
      disposeSkinToolWindowForFailure(kind, current, 'health-check-before-reuse');
      current = null;
    }
  }
  if (current && !current.isDestroyed()) {
    if (current.__skinToolLoaded === false) {
      current.__skinToolPendingRequest = request;
      // Keep an in-flight renderer hidden; did-finish-load will deliver the
      // latest request and the ready handshake will show it once the DOM is
      // actually usable.
      return { ok:true, reused:true, loading:true };
    }
    try { current.webContents.send('custom-skin-tool-request', request); } catch(_) {}
    if (current.isMinimized()) current.restore();
    applySkinToolTopPolicy(kind, current);
    current.show();
    current.focus();
    current.moveTop();
    return { ok:true, reused:true };
  }
  var cfg = skinToolCfg[kind], b = resolveSkinToolBounds(kind, cfg);
  var toolWebPreferences = {
    nodeIntegration:false, contextIsolation:true, sandbox:false,
    preload:path.join(__dirname,'preload.js'), plugins:true,
    webSecurity:false, allowRunningInsecureContent:true,
    backgroundThrottling:false, spellcheck:false,
    enableWebSQL:false, v8CacheOptions:'bypassHeatCheck'
  };
  if (kind === 'preview') {
    // The skin overlay is created first with plugins:false. Electron 11 reuses
    // the same file:// renderer under process-per-site, so setting plugins:true
    // on a later preview window cannot retrofit Flash into that process. Give
    // every preview BrowserWindow an isolated in-memory Session; recreation
    // after a PPAPI reset must also receive a fresh renderer.
    toolWebPreferences.partition = 'seer2-skin-preview-flash-' + (++_customSkinPreviewPartitionSerial);
  }
  var toolWinOpts = {
    x:b.x, y:b.y, width:b.width, height:b.height,
    minWidth:cfg.minWidth, minHeight:cfg.minHeight,
    title:cfg.title, backgroundColor:'#070b13',
    frame:false, thickFrame:true, resizable:true, maximizable:true, minimizable:true,
    icon:path.join(__dirname,'icon.ico'), show:false, skipTaskbar:false,
    webPreferences:toolWebPreferences,
  };
  if (gameWin && !gameWin.isDestroyed()) {
    toolWinOpts.parent = gameWin;
  }
  if (_alwaysOnTop) {
    toolWinOpts.alwaysOnTop = true;
  }
  var win = new BrowserWindow(toolWinOpts);
  skinToolWins[kind] = win;
  bindSkinToolWindowHealth(kind, win);
  applySkinToolTopPolicy(kind, win);
  var query = { view:kind };
  query.previewOrigin = 'http://127.0.0.1:' + coreNet.getProxyPort();
  ['id','name','ids','autoStart','autoClose','category','catalogPreset','localId','previewOnly','queueView','normalAvailable','uClientAvailable','forceRefresh','previewFilter','defaultAction'].forEach(function(key) {
    if (request[key] !== undefined && request[key] !== null) query[key] = String(request[key]);
  });
  win.loadFile('skin-overlay.html', { query:query });
  if (kind === 'preview') {
    win.webContents.once('did-finish-load', function() {
      var prefs = {};
      try { prefs = win.webContents.getLastWebPreferences() || {}; } catch(_) {}
      logInfo('CustomSkin', 'Preview renderer isolated for Flash', {
        webContentsId:win.webContents.id,
        rendererPid:win.webContents.getOSProcessId(),
        partition:String(toolWebPreferences.partition || ''),
        plugins:prefs.plugins === true,
      });
    });
    win.webContents.on('plugin-crashed', function(event, name, version) {
      if (skinToolWins.preview !== win || win.isDestroyed()) return;
      logWarn('CustomSkin', 'Preview plugin crashed', {
        name:String(name || ''), version:String(version || ''),
      });
      _scheduleCustomSkinPreviewWindowReload('PluginCrashed', [], 600);
    });
  }
  var saveBounds = _makeThrottle(function() {
    var active = skinToolWins[kind];
    if (active && !active.isDestroyed() && !active.isFullScreen()) saveSkinToolBounds(kind, active);
  }, 80);
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('focus', function() {
    if (skinToolWins[kind] === win) activeSkinToolKind = kind;
  });
  var readyFallback = null;
  win.__skinReadyFallbackTimer = null;
  function clearReadyFallback() {
    if (readyFallback) clearTimeout(readyFallback);
    readyFallback = null;
    win.__skinReadyFallbackTimer = null;
  }
  win.once('ready-to-show', function() {
    if (win.isDestroyed() || process.env.LAUNCHER_AUTOTEST === '1') return;
    if (skinToolWins[kind] !== win || activeSkinToolKind !== kind || surfaceGeneration !== skinSurfaceGeneration) return;
    if (skinUiReadyWebContents.has(win.webContents.id)) { win.show(); win.focus(); win.moveTop(); return; }
    readyFallback = setTimeout(function() {
      win.__skinReadyFallbackTimer = null;
      readyFallback = null;
      if (win.isDestroyed() || skinToolWins[kind] !== win ||
          activeSkinToolKind !== kind || surfaceGeneration !== skinSurfaceGeneration) return;
      var ready = skinUiReadyWebContents.has(win.webContents.id);
      var verify = ready ? Promise.resolve(true) : Promise.resolve().then(function() {
        return win.webContents.executeJavaScript('document.documentElement.dataset.skinUiReady === "1"', true);
      }).catch(function() { return false; });
      verify.then(function(ok) {
        if (win.isDestroyed() || skinToolWins[kind] !== win ||
            activeSkinToolKind !== kind || surfaceGeneration !== skinSurfaceGeneration) return;
        if (ok === true) {
          skinUiReadyWebContents.add(win.webContents.id);
          win.show();
          win.focus();
          win.moveTop();
        } else {
          disposeSkinToolWindowForFailure(kind, win, 'ui-ready-timeout');
        }
      });
    }, 5000);
    win.__skinReadyFallbackTimer = readyFallback;
  });
  win.on('closed', function() {
    clearReadyFallback();
    try { skinUiReadyWebContents.delete(win.webContents.id); } catch(_) {}
    if (skinToolWins[kind] === win) {
      skinToolWins[kind] = null;
      skinToolPinState[kind] = false;
      if (activeSkinToolKind === kind) activeSkinToolKind = '';
    }
  });
  return { ok:true, reused:false };
}

function toggleScanner()   { toggleOverlay('scanner');  }
function toggleProxy()     { toggleOverlay('proxy');    }
function toggleCache()     { toggleOverlay('cache');    }
function toggleSpeed()     { toggleOverlay('speed');    }
function toggleReplace()   { toggleOverlay('replace');  }
function toggleSkin()      { toggleOverlay('skin');     }
function toggleQuality()   { toggleOverlay('quality');  }

var _alwaysOnTop = false;
function toggleAlwaysOnTop() {
  _alwaysOnTop = !_alwaysOnTop;
  if (gameWin && !gameWin.isDestroyed()) { gameWin.setAlwaysOnTop(_alwaysOnTop, 'floating'); gameWin.setMenu(buildGameMenu()); }
  var overlayLevel = _alwaysOnTop ? 'screen-saver' : 'pop-up-menu';
  Object.keys(overlayWins).forEach(function(name) {
    var w = overlayWins[name];
    if (!w || w.isDestroyed()) return;
    if (_alwaysOnTop || overlayPinState[name]) w.setAlwaysOnTop(true, overlayLevel);
    else w.setAlwaysOnTop(false);
  });
  Object.keys(skinToolWins).forEach(function(kind) {
    var w = skinToolWins[kind];
    if (!w || w.isDestroyed()) return;
    if (_alwaysOnTop || skinToolPinState[kind]) w.setAlwaysOnTop(true, overlayLevel);
    else w.setAlwaysOnTop(false);
  });
  Object.keys(_imageWins).forEach(function(k) {
    var w = _imageWins[k];
    if (!w || w.isDestroyed()) return;
    if (_alwaysOnTop || _imageWinPins[k]) w.setAlwaysOnTop(true, overlayLevel);
    else w.setAlwaysOnTop(false);
  });
  _bringOverlaysToTop();
}

var SEP = { label:'  |  ', enabled:false };
function buildGameMenu() {
  return Menu.buildFromTemplate([
    { label:'  ↺ 刷新  ',     click: () => doReload() },
    { label:'  清缓存刷新  ', click: () => doClearCacheAndReload() },
    SEP,
    { label:'  扫描  ', click: () => toggleScanner() },
    { label:'  替换  ', click: () => toggleReplace() },
    { label:'  变速  ', click: () => toggleSpeed() },
    { label:'  代理  ', click: () => toggleProxy() },
    { label:'  缓存  ', click: () => toggleCache() },
    { label:'  皮肤  ', click: () => toggleSkin() },
    { label:'  画质  ', click: () => toggleQuality() },
    SEP,
    { label:'选择网址', submenu: GAME_SERVERS.map(function(srv) {
      return {
        label: srv.label,
        type: 'radio',
        checked: srv.id === _selectedServerId,
        click: function() {
          if (srv.id === _selectedServerId) return;
          _selectedServerId = srv.id;
          saveSelectedServer(srv.id);
          _customSkinCatalogRefreshedAt = 0;
          try { coreNet.setGameBackend(srv.rootUrl); } catch(e) {}
          try { applyCustomSkinsToCoreNet(); } catch(e) {}
          try { applyReplaceRulesToCoreNet(); } catch(e) {}
          try { notifyReplaceRulesChanged(); } catch(e) {}
          try { broadcastAll('selected-server-changed', { id: srv.id, rootUrl: srv.rootUrl }); } catch(e) {}
          if (gameWin && !gameWin.isDestroyed()) {
            gameWin.setMenu(buildGameMenu());
          }
        }
      };
    })},
    SEP,
    { label:'加入Q群',  click: () => showImageWin('qq-group') },
    { label:'B站春树',  click: () => showImageWin('bilibili') },
    { label:'联系春树', click: () => showImageWin('contact') },
    SEP,
    { label:'开发者工具', click: () => {
      if (!gameWin || gameWin.isDestroyed()) return;
      var wc = gameWin.webContents;
      if (!wc) return;
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools();
    } },
    SEP,
    { label: _alwaysOnTop ? '📌 已置顶' : '📌 置顶', click: () => toggleAlwaysOnTop() },
  ]);
}

var CLEANUP_JS = [
  'try {',
  '  var nb=document.querySelector("div[style*=\'text-align: center\']");if(nb&&!nb.querySelector("embed,object"))nb.remove();',
  '  var mb=document.getElementById("muteBtn");if(mb)mb.remove();',
  '  var ba=document.getElementById("bgAudio");if(ba){try{ba.pause();ba.src="";}catch(_){}ba.remove();}',
  '  document.querySelectorAll("link[rel=preload],link[rel=prefetch],link[rel=dns-prefetch]").forEach(l=>l.remove());',
  '} catch(e) {}',
  'try{if(window.performance&&performance.clearResourceTimings)performance.clearResourceTimings();}catch(e){}',
  'try{if(window.performance&&performance.clearMarks)performance.clearMarks();}catch(e){}',
  'try{if(window.performance&&performance.clearMeasures)performance.clearMeasures();}catch(e){}',
].join('\n');


var gameWin = null, gameRenderPid = null, cachedPpapiPid = null, gameMainPid = null;

function refreshPpapiPid() {
  try {
    if (!app || typeof app.getAppMetrics !== 'function') return null;
    var metrics = app.getAppMetrics() || [];
    var snapshot = []; // 诊断用
    var picked = null;
    for (var i = 0; i < metrics.length; i++) {
      var m = metrics[i];
      var pid = m && m.pid;
      var rawType = String((m && m.type) || '');
      var type = rawType.toLowerCase();
      var name = String((m && m.name) || '').toLowerCase();
      var serviceName = String((m && m.serviceName) || '').toLowerCase();
      snapshot.push({ pid: pid, type: rawType, name: m && m.name, serviceName: m && m.serviceName });

      if (!pid) continue;
      if (pid === process.pid) continue;
      if (type === 'browser' || type === 'renderer' || type === 'gpu' ||
          type === 'utility' || type === 'zygote') continue;

      var isPpapi =
        type.indexOf('ppapi')  >= 0 ||
        type.indexOf('pepper') >= 0 ||
        type.indexOf('plugin') >= 0 ||
        name.indexOf('ppapi')  >= 0 ||
        name.indexOf('pepper') >= 0 ||
        name.indexOf('flash')  >= 0 ||
        serviceName.indexOf('flash') >= 0;
      if (!isPpapi) continue;

      try { process.kill(pid, 0); } catch(_) { continue; }

      picked = pid;
      break;
    }
    if (picked) {
      if (cachedPpapiPid !== picked) {
        logInfo('PPAPI', 'identified via app.getAppMetrics()', { old: cachedPpapiPid, new: picked });
      }
      cachedPpapiPid = picked;
    } else {
      if (cachedPpapiPid !== null) {
        try { process.kill(cachedPpapiPid, 0); }
        catch(_) {
          logWarn('PPAPI', 'cached PID dead, clearing', { pid: cachedPpapiPid });
          cachedPpapiPid = null;
        }
      }
      var summary = snapshot.slice(0, 30).map(function(p) {
        return 'pid=' + p.pid + ' type=' + (p.type || '?') +
               (p.name ? ' name=' + p.name : '') +
               (p.serviceName ? ' svc=' + p.serviceName : '');
      }).join(' | ');
      logWarn('PPAPI', 'app.getAppMetrics did NOT identify PPAPI', {
        metricsCount: metrics.length,
        gameRenderPid: gameRenderPid,
        browserPid: process.pid,
        first30: summary,
      });
    }
    return cachedPpapiPid;
  } catch(e) {
    logWarn('PPAPI', 'refresh threw: ' + (e && e.message ? e.message : e));
    return cachedPpapiPid;
  }
}

async function refreshPpapiPidViaDll() {
  try {
    var args = ['-BrowserPid', String(process.pid), '-Mode', 'detect-ppapi'];
    if (gameRenderPid) args.push('-GamePids', String(gameRenderPid));
    var r = await runScanner(args);
    if (!r || !r.ok) {
      logWarn('PPAPI', 'detect-ppapi fallback returned no candidate', { error: r && r.error, scanned: r && r.scanned });
      return null;
    }
    var arr = r.ppapi;
    if (!arr || (Array.isArray(arr) && arr.length === 0)) return null;
    var pid = Array.isArray(arr) ? arr[0] : Number(arr);
    if (!pid || isNaN(pid)) return null;
    try { process.kill(pid, 0); } catch(_) { return null; } // 验证存活
    if (cachedPpapiPid !== pid) {
      logInfo('PPAPI', 'identified via detect-ppapi DLL fallback', { old: cachedPpapiPid, new: pid });
    }
    cachedPpapiPid = pid;
    return pid;
  } catch(e) {
    logWarn('PPAPI', 'detect-ppapi fallback threw: ' + (e && e.message ? e.message : e));
    return null;
  }
}

var _pageDesignW = 0;
var _pageDesignH = 0;
var _zoomDebounce = null;
var _zoomThrottleTimer = null;
var _hasPendingZoom = false;
var _loadingComplete = false; // did-finish-load 前禁止 resize 触发 zoom 变化
var _isApplyingZoom = false;  // 缩放事务锁，防止在缩放切换过程中被内部事件二次重入
var _appQuitting = false;
var _exitCleanupDone = false;
var _gameBoundsClampBusy = false;

var _bringOverlaysTimer = null;
function _bringOverlaysToTop() {
  if (_bringOverlaysTimer) { clearTimeout(_bringOverlaysTimer); _bringOverlaysTimer = null; }
  _bringOverlaysTimer = setTimeout(function() {
    _bringOverlaysTimer = null;
    if (!gameWin || gameWin.isDestroyed() || _gameMinimized) return;
    var activeSkinTool = visibleSkinToolWindow(activeSkinToolKind);
    Object.keys(overlayWins).forEach(function(name) {
      var w = overlayWins[name];
      if (name === 'skin' && activeSkinTool) return;
      if (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && !_overlayClosing[name]) {
        try { w.moveTop(); } catch(_) {}
      }
    });
    Object.keys(_imageWins).forEach(function(k) {
      var w = _imageWins[k];
      if (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized()) {
        try { w.moveTop(); } catch(_) {}
      }
    });
    bringCurrentSkinToolToTop();
  }, 20);
}

var GAME_PAGE_INIT_JS = [
  'try{',
  '  document.body.style.background="#000";',
  '  var __ss=document.getElementById("__sz_ss");',
  '  if(!__ss){__ss=document.createElement("style");__ss.id="__sz_ss";document.head.appendChild(__ss);}',
  '  __ss.textContent="::-webkit-scrollbar{display:none!important;width:0!important;height:0!important;}";',
  "  var __em=document.querySelector('embed[type*=\"flash\"],embed[src*=\".swf\"],object[type*=\"flash\"]');",
  '  if(__em)__em.setAttribute("scale","showall");',
  '}catch(e){}',
].join('');

// 生成 Flash 页面缩放内嵌脚本。domScale 为数值时走 DOM 缩放（CSS transform）；
// 为 null 时清理 transform 残留（transform: 'none'），尺寸保持设计分辨率，
// 缩放由 webContents 缩放因子物理驱动。qualityValue 始终保持用户配置画质。
function _buildFlashScaleJs(designW, designH, domScale, qualityValue) {
  var qualityLiteral = JSON.stringify(String(qualityValue || 'high'));
  var transformStatement = (domScale === null || domScale === undefined)
    ? "target.style.transform = 'none';"
    : "target.style.transform = 'scale(' + SCALE + ')';";
  return `
(() => {
  const DESIGN_W = ${designW};
  const DESIGN_H = ${designH};
  const SCALE = ${domScale === null || domScale === undefined ? '1' : domScale};
  const QUALITY = ${qualityLiteral};
  window.__sl_frame_zoom_mode = ${domScale === null || domScale === undefined ? 'true' : 'false'};

  const target =
    document.querySelector('embed#Client') ||
    document.querySelector('embed[name="Client"]') ||
    document.querySelector('object#Client') ||
    document.querySelector('embed[type*="flash"]') ||
    document.querySelector('embed[src*=".swf"]') ||
    document.querySelector('object[type*="flash"]');

  if (!target) return false;

  target.setAttribute('quality', QUALITY);
  try {
    const qParam = target.querySelector ? target.querySelector('param[name="quality" i]') : null;
    if (qParam) qParam.setAttribute('value', QUALITY);
  } catch(e) {}

  const flashContent =
    document.getElementById('flashContent') ||
    target.parentElement;

  const bg = document.getElementById('bg');
  const flashCenter = document.getElementById('__flash_center');
  const isBackgroundVariant = !!bg;

  if (isBackgroundVariant) {
    if (!flashCenter) return false;
    document.documentElement.style.width = '100%';
    document.documentElement.style.height = '100%';
    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.documentElement.style.overflow = 'hidden';

    document.body.style.width = '100%';
    document.body.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';

    flashCenter.style.position = 'relative';
    flashCenter.style.width = '100%';
    flashCenter.style.height = '100%';
    flashCenter.style.display = 'flex';
    flashCenter.style.alignItems = 'center';
    flashCenter.style.justifyContent = 'center';
    flashCenter.style.overflow = 'hidden';
    flashCenter.style.zIndex = '1';

    if (flashContent) {
      flashContent.style.width = DESIGN_W + 'px';
      flashContent.style.height = DESIGN_H + 'px';
      flashContent.style.display = 'flex';
      flashContent.style.alignItems = 'center';
      flashContent.style.justifyContent = 'center';
      flashContent.style.overflow = 'visible';
    }

    target.style.width = DESIGN_W + 'px';
    target.style.height = DESIGN_H + 'px';
    target.style.display = 'block';
    target.style.transformOrigin = 'center center';
    target.style.willChange = 'transform';
    target.style.backfaceVisibility = 'hidden';
    target.style.webkitBackfaceVisibility = 'hidden';
    target.style.transition = 'transform 0.08s cubic-bezier(0.25, 0.1, 0.25, 1)';
    ${transformStatement}
    target.setAttribute('width', String(DESIGN_W));
    target.setAttribute('height', String(DESIGN_H));

    return true;
  }

  const flashbox =
    document.getElementById('flashbox') ||
    (flashContent && flashContent.parentElement);

  const flashWrap =
    document.getElementById('flashContentWrap') ||
    (flashbox && flashbox.parentElement);

  const center =
    document.getElementById('__flash_center') ||
    flashWrap ||
    flashbox ||
    flashContent ||
    target.parentElement ||
    document.body;

  if (!center) return false;

  document.documentElement.style.width = '100%';
  document.documentElement.style.height = '100%';
  document.documentElement.style.margin = '0';
  document.documentElement.style.padding = '0';
  document.documentElement.style.overflow = 'hidden';

  document.body.style.width = '100%';
  document.body.style.height = '100%';
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.background = '#000';

  center.style.position = 'relative';
  center.style.width = '100%';
  center.style.height = '100%';
  center.style.display = 'flex';
  center.style.alignItems = 'center';
  center.style.justifyContent = 'center';
  center.style.overflow = 'hidden';
  center.style.zIndex = '0';

  var _menuEls = document.querySelectorAll('#toolbar, #nav, #menu, .toolbar, .menu, .nav, header');
  for (var _mi = 0; _mi < _menuEls.length; _mi++) {
    _menuEls[_mi].style.position = 'relative';
    _menuEls[_mi].style.zIndex = '9999';
  }

  if (flashWrap && flashWrap !== document.body) {
    flashWrap.style.width = DESIGN_W + 'px';
    flashWrap.style.height = DESIGN_H + 'px';
    flashWrap.style.display = 'flex';
    flashWrap.style.alignItems = 'center';
    flashWrap.style.justifyContent = 'center';
    flashWrap.style.overflow = 'visible';
  }

  if (flashbox) {
    flashbox.style.width = DESIGN_W + 'px';
    flashbox.style.height = DESIGN_H + 'px';
    flashbox.style.display = 'flex';
    flashbox.style.alignItems = 'center';
    flashbox.style.justifyContent = 'center';
    flashbox.style.overflow = 'visible';
  }

  if (flashContent) {
    flashContent.style.width = DESIGN_W + 'px';
    flashContent.style.height = DESIGN_H + 'px';
    flashContent.style.display = 'flex';
    flashContent.style.alignItems = 'center';
    flashContent.style.justifyContent = 'center';
    flashContent.style.overflow = 'visible';
  }

  target.style.width = DESIGN_W + 'px';
  target.style.height = DESIGN_H + 'px';
  target.style.display = 'block';
  target.style.transformOrigin = 'center center';
  target.style.willChange = 'transform';
  target.style.backfaceVisibility = 'hidden';
  target.style.webkitBackfaceVisibility = 'hidden';
  target.style.transition = 'transform 0.08s cubic-bezier(0.25, 0.1, 0.25, 1)';
  ${transformStatement}

  target.setAttribute('width', String(DESIGN_W));
  target.setAttribute('height', String(DESIGN_H));

  return true;
})()
    `;
}

function _applyPageZoom() {
  if (!gameWin || gameWin.isDestroyed() || !gameWin.webContents) return;
  if (typeof gameWin.webContents.isDestroyed === 'function' && gameWin.webContents.isDestroyed()) return;
  if (!_pageDesignW || !_pageDesignH) return;
  if (_isApplyingZoom) {
    _hasPendingZoom = true;
    return;
  }
  if (_zoomDebounce) { clearTimeout(_zoomDebounce); _zoomDebounce = null; }
  _isApplyingZoom = true;

  var safetyTimer = setTimeout(function() {
    _isApplyingZoom = false;
    if (_hasPendingZoom) {
      _hasPendingZoom = false;
      _applyPageZoom();
    }
  }, 500);

  var b = null;
  try { b = gameWin.getContentBounds(); } catch(e) { try { b = gameWin.getBounds(); } catch(_) {} }
  if (!b || b.width <= 0 || b.height <= 0) {
    clearTimeout(safetyTimer);
    _isApplyingZoom = false;
    return;
  }

  var widthFactor = b.width / _pageDesignW;
  var heightFactor = b.height / _pageDesignH;
  var factor = Math.min(widthFactor, heightFactor);
  factor = Math.max(0.5, Math.min(factor, 3.0));
  var designW = _pageDesignW || 1200;
  var designH = _pageDesignH || 660;
  var frameZoom = !!(_qualityConfig && _qualityConfig.frameZoom);
  // 画质严格遵从用户配置（low/medium/high/best），严禁强制降为 low
  var configuredQuality = (_qualityConfig && _qualityConfig.quality) ? _qualityConfig.quality : 'high';
  if (launcherRenderPolicy.VALID_QUALITIES.indexOf(configuredQuality) < 0) configuredQuality = 'high';

  try {
    if (!frameZoom) {
      // 帧放大关闭（平滑拉伸防卡顿模式）：
      // 关键时序同步：先将 webContents.setZoomFactor 降回 1，
      // 再执行 JS 将 DOM 应用实际缩放比 scale(factor)，
      // 画面依然根据窗口大小等比放大并完整铺满窗口（绝不留大黑边，绝不缩回 1200x660）；
      // 彻底避免在旧 zoomFactor 残留时叠加 scale 产生倍率跳跃与突兀抽搐；
      // Flash 仅在 1200x660 基准上做基础渲染，由 Blink 渲染器平滑插值拉伸上屏，
      // 避免每帧高分辨率重新计算的高昂 CPU/显存开销，防高特效大招卡顿；
      // 画质 100% 保持用户配置（configuredQuality，严禁强制 low）。
      try {
        if (typeof gameWin.webContents.getZoomFactor === 'function') {
          if (Math.abs(gameWin.webContents.getZoomFactor() - 1) > 0.001) {
            gameWin.webContents.setZoomFactor(1);
          }
        } else {
          gameWin.webContents.setZoomFactor(1);
        }
      } catch(e) {
        try { gameWin.webContents.setZoomFactor(1); } catch(_) {}
      }
      var smoothStretchJs = _buildFlashScaleJs(designW, designH, factor, configuredQuality);
      gameWin.webContents.executeJavaScript(smoothStretchJs)
        .then(function() {
          if (!gameWin || gameWin.isDestroyed()) return;
          _nudgeWmSize();
        })
        .catch(function() {})
        .finally(function() {
          clearTimeout(safetyTimer);
          _isApplyingZoom = false;
          if (_hasPendingZoom) {
            _hasPendingZoom = false;
            _applyPageZoom();
          }
        });
      return;
    }

    // 帧放大开启（每帧矢量重绘极清模式）：
    // 关键时序同步：先执行 executeJavaScript 将 transform 设为 'none'，
    // 在其 Promise 完成（.then）后再设置 webContents.setZoomFactor(factor)！
    // 彻底杜绝在 1~2 帧内同时叠加 zoomFactor(factor) 与 transform: scale(factor) 导致的
    // factor * factor（例如 1.5 * 1.5 = 2.25 倍暴增）瞬态跳跃与画面剧烈抖动；
    // Flash 在目标物理分辨率上每帧重新计算矢量曲线和交点，极致清晰；
    // 画质 100% 保持用户配置（configuredQuality，严禁强制 low）。
    var physicalJs = _buildFlashScaleJs(designW, designH, null, configuredQuality);
    gameWin.webContents.executeJavaScript(physicalJs)
      .then(function() {
        if (!gameWin || gameWin.isDestroyed()) return;
        try { gameWin.webContents.setZoomFactor(factor); } catch(e) {}
        _nudgeWmSize();
      })
      .catch(function() {})
      .finally(function() {
        clearTimeout(safetyTimer);
        _isApplyingZoom = false;
        if (_hasPendingZoom) {
          _hasPendingZoom = false;
          _applyPageZoom();
        }
      });
  } catch(e) {
    clearTimeout(safetyTimer);
    _isApplyingZoom = false;
    if (_hasPendingZoom) {
      _hasPendingZoom = false;
      _applyPageZoom();
    }
  }
}

// 触发 Chromium 绘制表面重绘：
// 废除任何修改宿主原生窗口物理尺寸（setContentSize）的做法，彻底消除窗口边框与画面的物理抽搐及二次 resize 事件；
// 纯粹通过 webContents.invalidate() 触发重绘刷新。
function _nudgeWmSize() {
  if (!gameWin || gameWin.isDestroyed()) return;
  try { gameWin.webContents.invalidate(); } catch(e) {}
}

// 双重触发策略：拖拽过程中以 ~32ms (~30fps) 实时节流平滑跟手放大/缩小，
// 拖拽停止后 40ms 进行尾随精准像素对齐；彻底消除 180ms 滞后导致的巨大黑边。
function _applyPageZoomDebounced() {
  if (!_loadingComplete) return;

  // 1. 尾随对齐定时器（40ms 确保在拖拽或连续变动停止后精准对齐到最终像素）
  if (_zoomDebounce) { clearTimeout(_zoomDebounce); _zoomDebounce = null; }
  _zoomDebounce = setTimeout(function() {
    _zoomDebounce = null;
    _applyPageZoom();
  }, 40);

  // 2. 交互过程节流快速触发（约 32ms 间隔，丝滑跟手不卡顿）
  if (!_zoomThrottleTimer) {
    _applyPageZoom();
    _zoomThrottleTimer = setTimeout(function() {
      _zoomThrottleTimer = null;
    }, 32);
  }
}

function _makeThrottle(fn, ms) {
  var timer = null;
  var pending = false;
  return function() {
    var ctx = this, args = arguments;
    if (!timer) {
      fn.apply(ctx, args);
      timer = setTimeout(function() {
        timer = null;
        if (pending) { pending = false; fn.apply(ctx, args); }
      }, ms);
    } else {
      pending = true;
    }
  };
}



var _speedHookState   = null;   // { pid } — CE Hook 注入状态（无需 dataAddr/hmod）
var _currentGameSpeed = 1.0;    // 跨面板关闭持久化的速度记忆
var _speedReloadSeq = 0;

function _ceDllPath() {
  var dllName = process.arch === 'x64' ? 'speedhook_ce_x64.dll' : 'speedhook_ce_ia32.dll';
  if (app.isPackaged) {
    return app.getAppPath().replace('app.asar', 'app.asar.unpacked') +
           path.sep + dllName;
  }
  return path.join(__dirname, dllName);
}

function _ceInjectorExePath() {
  if (app.isPackaged) {
    return app.getAppPath().replace('app.asar', 'app.asar.unpacked') +
           path.sep + 'speedhook' + path.sep + 'ce_injector.exe';
  }
  return path.join(__dirname, 'speedhook', 'ce_injector.exe');
}

/**
 * 通过预编译 ce_injector.exe 注入 DLL（仅 x64 路径）
 * 启动 ~50ms，相比 PowerShell + Add-Type 的 3-8s 编译耗时快 60-160 倍。
 * 失败/超时/exe 缺失时由调用方回退 PowerShell 路径。
 *
 * exe 退出码：0=成功，非 0=失败；stdout 第一行为错误码：
 *   1xxx=OpenProcess Win32 错误，2000=VirtualAllocEx，3000=CreateRemoteThread,
 *   4000=LoadLibraryW NULL，5000=架构不匹配，6000=DLL不存在，7000=模块基址枚举失败
 */
function _ceInjectViaExe(pid, dllPath) {
  return new Promise(function(resolve) {
    var exePath = _ceInjectorExePath();
    if (!require('fs').existsSync(exePath)) {
      resolve({ ok: false, error: 'ce_injector.exe 不存在' });
      return;
    }
    var out = '', err = '';
    var proc = require('child_process').spawn(exePath, [String(pid), dllPath], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    var settled = false;
    var settle = function(r) { if (!settled) { settled = true; resolve(r); } };
    proc.stdout.on('data', function(d) { out += d.toString('utf8'); });
    proc.stderr.on('data', function(d) { err += d.toString('utf8'); });
    proc.on('error', function(e) { settle({ ok: false, error: 'spawn: ' + e.message }); });
    proc.on('close', function(code) {
      var firstLine = (out.split(/\r?\n/)[0] || '').trim();
      var rcode = parseInt(firstLine, 10);
      if (rcode === 0) { settle({ ok: true }); return; }
      var msg = '注入返回码: ' + (isNaN(rcode) ? code : rcode);
      if (err.trim()) msg += ' | stderr: ' + err.trim().slice(0, 200);
      settle({ ok: false, error: msg });
    });
    setTimeout(function() {
      try { proc.kill(); } catch(_) {}
      settle({ ok: false, error: 'ce_injector.exe 超时 (12s)' });
    }, 12000);
  });
}

/**
 * 将新 CE DLL 注入目标进程（仅需调用一次/会话）
 * x64：优先用预编译 ce_injector.exe，缺失/失败时回退 PowerShell。
 * ia32：直接走 PowerShell 内联 C#（与 ia32 启动器同位数）。
 * 注入过程不干涉目标进程的任何锁，安全性远超 NtSuspendProcess 方案。
 */
async function _ceInject(pid, dllPath) {
  if (process.arch === 'x64') {
    var rExe = await _ceInjectViaExe(pid, dllPath);
    if (rExe.ok) return rExe;
    logWarn('Speed', 'ce_injector.exe 失败，回退 PowerShell 注入', { error: rExe.error });
  }
  return _ceInjectViaPowerShell(pid, dllPath);
}

function _ceInjectViaPowerShell(pid, dllPath) {
  return new Promise(function(resolve) {
    var csharp = [
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class CeInjector {',
      '  [DllImport("kernel32.dll",SetLastError=true)]',
      '  static extern IntPtr OpenProcess(uint a,bool b,uint c);',
      '  [DllImport("kernel32.dll",SetLastError=true)]',
      '  static extern IntPtr VirtualAllocEx(IntPtr h,IntPtr a,uint s,uint t,uint p);',
      '  [DllImport("kernel32.dll",SetLastError=true)]',
      '  static extern bool WriteProcessMemory(IntPtr h,IntPtr a,byte[] b,uint s,out uint w);',
      '  [DllImport("kernel32.dll",SetLastError=true)]',
      '  static extern IntPtr CreateRemoteThread(IntPtr h,IntPtr a,uint s,IntPtr f,IntPtr p,uint c,out uint id);',
      '  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);',
      '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
      '  [DllImport("kernel32.dll")] static extern IntPtr GetProcAddress(IntPtr m,string n);',
      '  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);',
      '  public static int Inject(uint pid, string dll) {',
      '    const uint PROCESS_ALL = 0x1F0FFF;',
      '    IntPtr hp = OpenProcess(PROCESS_ALL, false, pid);',
      '    if (hp == IntPtr.Zero) return Marshal.GetLastWin32Error() + 1000;',
      '    byte[] db = System.Text.Encoding.Unicode.GetBytes(dll + "\\0");',
      '    IntPtr mem = VirtualAllocEx(hp, IntPtr.Zero, (uint)db.Length, 0x3000, 0x40);',
      '    if (mem == IntPtr.Zero) { CloseHandle(hp); return 2000; }',
      '    uint w; WriteProcessMemory(hp, mem, db, (uint)db.Length, out w);',
      '    IntPtr ll = GetProcAddress(GetModuleHandle("kernel32.dll"), "LoadLibraryW");',
      '    uint tid;',
      '    IntPtr ht = CreateRemoteThread(hp, IntPtr.Zero, 0, ll, mem, 0, out tid);',
      '    if (ht == IntPtr.Zero) { CloseHandle(hp); return 3000; }',
      '    WaitForSingleObject(ht, 8000);',
      '    CloseHandle(ht); CloseHandle(hp);',
      '    return 0;',
      '  }',
      '}',
    ].join('\n');

    var safeCs  = csharp.replace(/'/g, "''");
    var safeDll = dllPath.replace(/'/g, "''");

    var psCmd = [
      'Add-Type -TypeDefinition \'' + safeCs + '\' -Language CSharp -ErrorAction Stop;',
      '$r = [CeInjector]::Inject(' + pid + ', \'' + safeDll + '\');',
      'Write-Output $r',
    ].join(' ');

    var out = '', err = '';
    var proc = require('child_process').spawn(_pshell32, [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-Command', psCmd,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', function(d) { out += d.toString('utf8'); });
    proc.stderr.on('data', function(d) { err += d.toString('utf8'); });
    proc.on('error', function(e) { resolve({ ok: false, error: 'spawn: ' + e.message }); });
    proc.on('close', function() {
      var retcode = parseInt(out.trim(), 10);
      if (retcode === 0) {
        resolve({ ok: true });
      } else {
        var errMsg = '注入返回码: ' + retcode;
        if (err.trim()) errMsg += ' | PS错误: ' + err.trim().slice(0, 200);
        resolve({ ok: false, error: errMsg });
      }
    });
    setTimeout(function() {
      try { proc.kill(); } catch(e) {}
      resolve({ ok: false, error: '注入超时 (10s)' });
    }, 10000);
  });
}

/**
 * 通过命名管道向已注入的 CE DLL 发送新速度值
 * 使用 Node.js 内置 net 模块（Windows Named Pipe 在 net 中以 \\.\pipe\ 路径访问）
 *
 * 重试策略（覆盖 DLL 端 Sleep(500ms) 窗口期）：
 *   ・单次连接 200ms 超时
 *   ・40ms 间隔重试
 *   ・总 deadline 700ms（>500ms Sleep 窗口）
 *   ・连续 4 次 ENOENT 提前放弃（pipe 路径根本不存在 = DLL 未加载）
 * 通常单次成功 < 5ms；遇 sleep 窗口期最多重试 ~3-4 次后成功。
 */
function _ceSetSpeedOnce(pid, speed, timeoutMs) {
  return new Promise(function(resolve) {
    var pipePath = '\\\\.\\pipe\\Seer2SpeedHack_' + pid;
    var settled = false;
    var settle = function(r) { if (!settled) { settled = true; resolve(r); } };
    var client;
    var timer = setTimeout(function() {
      try { if (client) client.destroy(); } catch(_) {}
      settle({ ok: false, error: 'connect timeout' });
    }, timeoutMs);
    try {
      client = net.createConnection(pipePath, function() {
        client.write(String(speed), 'utf8', function() {
          client.end();
          clearTimeout(timer);
          settle({ ok: true });
        });
      });
      client.on('error', function(e) {
        clearTimeout(timer);
        settle({ ok: false, error: (e.code ? e.code + ': ' : '') + e.message });
      });
    } catch(e) {
      clearTimeout(timer);
      settle({ ok: false, error: 'net: ' + e.message });
    }
  });
}

async function _ceSetSpeed(pid, speed) {
  var deadline   = Date.now() + 700;
  var enoentRun  = 0;
  var lastErr    = '';
  while (Date.now() < deadline) {
    var r = await _ceSetSpeedOnce(pid, speed, 200);
    if (r.ok) return { ok: true };
    lastErr = r.error || '';
    if (lastErr.indexOf('ENOENT') >= 0) {
      enoentRun++;
      if (enoentRun >= 4) {
        return { ok: false, error: 'pipe ENOENT (DLL未加载?): ' + lastErr };
      }
    } else {
      enoentRun = 0;
    }
    var remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise(function(r2) { setTimeout(r2, Math.min(40, remaining)); });
    }
  }
  return { ok: false, error: 'pipe重试超时(700ms): ' + lastErr };
}


var _flashAffinityMask = (function() {
  var n = os.cpus().length;
  var m = (n >= 30) ? 0x3FFFFFFF : ((1 << n) - 1);
  return (m && m > 0) ? m : 1;
})();

function setFlashPriority(pid, priority) {
  if (!pid) return;
  var ps = '$p=Get-Process -Id '+pid+' -EA SilentlyContinue;if($p){$p.PriorityClass=[System.Diagnostics.ProcessPriorityClass]::'+priority+';([System.Diagnostics.Process]::GetProcessById('+pid+')).ProcessorAffinity='+_flashAffinityMask+'}';
  var proc = require('child_process').spawn(_pshell64,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',ps],{windowsHide:true,stdio:'pipe'});
  proc.stdout.on('data', function(d) { console.log('[FlashPrio]', d.toString().trim()); });
  proc.on('error', function(e) { console.log('[FlashPrio] error:', e.message); });
}

var _flashPrioSet = false, _flashPrioTimer = null, _flashWarmupDone = false;
var WARMUP_SECS = 15, _lastFlashCpuPct = 0;

var _metricsCache = null, _metricsCacheTime = 0;
var _peakPollTimer = null;

function _pollPeaks() {
  if (!gameWin || gameWin.isDestroyed()) return;
  if (_gameMinimized) return;

  try {
    var raw = app.getAppMetrics();
    if (!raw || !raw.length) return;
    var rawFlashCpu = 0;
    raw.forEach(function(p) {
      var cpu = p.cpu ? p.cpu.percentCPUUsage : 0;
      var tp  = (p.type||'').toLowerCase(), nm = (p.name||'').toLowerCase();
      if (tp==='ppapiplugin'||tp==='plugin'||nm.indexOf('flash')!==-1) rawFlashCpu = cpu;
    });
    _lastFlashCpuPct = rawFlashCpu;

    var pidList = [];
    for (var pi = 0; pi < raw.length; pi++) { if (raw[pi].pid) pidList.push(raw[pi].pid); }
    _metricsCache = { procs:raw, _pidList:pidList };
    _metricsCacheTime = Date.now();

  } catch(e) {}
}
function startPeakPoller() {
  if (_peakPollTimer) return;
  _peakPollTimer = setInterval(_pollPeaks, 10000);
  logInfo('Peak', 'Peak poller started (10s idle-safe)');
}
function stopPeakPoller() { if (_peakPollTimer) { clearInterval(_peakPollTimer); _peakPollTimer = null; } }
function stopFlashPrioWatcher() { if (_flashPrioTimer) { clearInterval(_flashPrioTimer); _flashPrioTimer = null; } }

function startFlashPrioWatcher() {
  _flashPrioSet = false; _flashWarmupDone = false; _lastFlashCpuPct = 0;
  stopFlashPrioWatcher();
  var attempts = 0;
  _flashPrioTimer = setInterval(function() {
    try {
      attempts++;
      if (!gameWin || gameWin.isDestroyed()) { stopFlashPrioWatcher(); return; }
      var procs = (_metricsCache && _metricsCache.procs) ? _metricsCache.procs : [];
      procs.forEach(function(p) {
        if (_flashPrioSet) return;
        var tp = (p.type||'').toLowerCase(), nm = (p.name||'').toLowerCase();
        if (tp==='ppapiplugin'||tp==='plugin'||nm.indexOf('flash')!==-1) {
          try { process.kill(p.pid, 0); } catch(e) { return; } // 进程已死，跳过
          cachedPpapiPid = p.pid;
          console.log('[FlashPrio] Flash PID:', p.pid, '→ WARMUP', WARMUP_SECS+'s');
          setFlashPriority(p.pid, 'AboveNormal');
          _flashPrioSet = true;
          setTimeout(function() {
            if (!cachedPpapiPid || !gameWin || gameWin.isDestroyed()) return;
            _flashWarmupDone = true;
            console.log('[FlashPrio] Flash PID:', cachedPpapiPid, '→ STEADY');
            setFlashPriority(cachedPpapiPid, 'Normal');
          }, WARMUP_SECS*1000);
        }
      });
      if (attempts>=30) stopFlashPrioWatcher();
    } catch(e) {
      stopFlashPrioWatcher();
      throw e;
    }
  }, 2000);
}

var CF_BASE = 'https://raw.giteeusercontent.com/laochun_4/seer2-version-gate/raw/master/';





var LOCAL_VERSION = (function () {
  try {
    var vj = require('./version.json');
    var v = String((vj && vj.version) || '').trim();
    if (!v) return 'v0.0.0';
    return v.charAt(0) === 'v' ? v : 'v' + v;
  } catch (e) {
    return 'v0.0.0';
  }
}());

function isNewerVersion(remote, local) {
  try {
    var parse = function(v) {
      return v.replace(/^v/i, '').split('.').map(function(n) { return parseInt(n, 10) || 0; });
    };
    var r = parse(remote), l = parse(local);
    for (var i = 0; i < Math.max(r.length, l.length); i++) {
      var rv = r[i] || 0, lv = l[i] || 0;
      if (rv > lv) return true;
      if (rv < lv) return false;
    }
    return false;
  } catch(e) { return false; }
}

var _updateWin = null;
function showForceUpdateDialog(remoteVer, changelog) {
  return new Promise(function(resolve) {
    if (_updateWin && !_updateWin.isDestroyed()) { _updateWin.focus(); return; }
    _updateWin = new BrowserWindow({
      width: 460, height: 320,
      resizable: false, frame: false, center: true,
      backgroundColor: '#0a0e1a',
      icon: path.join(__dirname, 'icon.ico'),
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
      show: false, skipTaskbar: false,
      title: '发现新版本', alwaysOnTop: true,
    });
    _updateWin.setMenu(null);
    var safeLog = (changelog || '').replace(/'/g, '&#39;').replace(/\n/g, '<br>');
    var html = [
      '<!DOCTYPE html><html><head><meta charset="utf-8">',
      '<style>',
      '*{margin:0;padding:0;box-sizing:border-box;}',
      'body{background:#0a0e1a;color:#e2e8f0;font-family:"Microsoft YaHei","Segoe UI",sans-serif;',
      '  display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px;padding:28px 28px 20px;}',
      '.close-btn{position:fixed;top:8px;right:10px;width:22px;height:22px;border:none;border-radius:4px;',
      '  background:rgba(239,68,68,.08);color:#ef4444;font-size:14px;cursor:pointer;',
      '  display:flex;align-items:center;justify-content:center;transition:background .15s;}',
      '.close-btn:hover{background:rgba(239,68,68,.22);}',
      '.ico{font-size:34px;}',
      '.title{font-size:15px;font-weight:700;color:#00d4ff;letter-spacing:1px;text-align:center;}',
      '.ver{font-size:12px;color:#64748b;}',
      '.ver span{color:#22c55e;font-weight:700;}',
      '.log{font-size:11px;color:#94a3b8;text-align:center;line-height:1.6;max-width:380px;}',
      '.btn-row{display:flex;gap:10px;margin-top:4px;}',
      '.btn{padding:9px 28px;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;}',
      '.btn.dl{background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;box-shadow:0 0 12px rgba(34,197,94,.3);}',
      '.btn.dl:hover{filter:brightness(1.1);}',
      '.btn.quit{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);color:#ef4444;}',
      '.btn.quit:hover{background:rgba(239,68,68,.18);}',
      '.hint{font-size:10px;color:#475569;}',
      '</style></head><body>',
      '<button class="close-btn" onclick="require(\'electron\').ipcRenderer.send(\'close-app\')" title="退出程序">✕</button>',
      '<div class="ico">🚀</div>',
      '<div class="title">版本需要更新，请联系春树获取最新版</div>',
      '<div class="ver">当前版本 <span>' + LOCAL_VERSION + '</span>&nbsp;&nbsp;→&nbsp;&nbsp;最新版本 <span>' + remoteVer + '</span></div>',
      safeLog ? '<div class="log">' + safeLog + '</div>' : '',
      '<div class="btn-row">',
      '<button class="btn quit" onclick="require(\'electron\').ipcRenderer.send(\'close-app\')">退出程序</button>',
      '</div>',
      '<div class="hint">请勿从非春树本人渠道获取安装包</div>',
      '</body></html>',
    ].join('');
    _updateWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    _updateWin.once('ready-to-show', function() {
      if (_updateWin && !_updateWin.isDestroyed()) _updateWin.show();
    });
    _updateWin.webContents.on('will-navigate', function(e, url) {
      if (url && url.startsWith('http')) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
    _updateWin.on('close', function(e) {
      e.preventDefault();
      var choice = dialog.showMessageBoxSync(_updateWin, {
        type: 'question',
        buttons: ['继续等待', '退出程序'],
        defaultId: 0,
        cancelId: 0,
        title: '确认退出',
        message: '尚未更新到最新版本，确定退出吗？',
      });
      if (choice === 1) { app.exit(0); }
    });
    _updateWin.on('closed', function() {
      try { _updateWin.removeAllListeners(); } catch(e) {}
      _updateWin = null;
    });
  });
}

var _versionDialogShown = false;
function showVersionErrorDialog(title, message) {
  if (_versionDialogShown) return;
  _versionDialogShown = true;
  var finalTitle = '无法完成版本验证';
  var finalBody = '无法完成版本验证，请检查网络后重新启动。\n\n' +
                  '详情：' + (title || '') + '\n' + (message || '');
  startupDiag('FATAL: version verification failed, exiting', {
    title: String(title || ''),
    message: String(message || '').slice(0, 500),
  });
  try { writeLog('ERROR', 'Version', finalTitle, { reason: title, message: message }); } catch(_) {}
  try {
    if (app.isReady && app.isReady()) {
      try { dialog.showMessageBoxSync({ type: 'error', title: finalTitle, message: finalTitle, detail: finalBody, buttons: ['确定'], defaultId: 0, noLink: true }); }
      catch(_) { try { dialog.showErrorBox(finalTitle, finalBody); } catch(__) {} }
    } else {
      try { dialog.showErrorBox(finalTitle, finalBody); } catch(_) {}
    }
  } catch(_) {}
  try { app.exit(0); } catch(_) { try { process.exit(0); } catch(__) {} }
}


var VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
var VERSION_CACHE_FILE = app.isPackaged
  ? path.join(path.dirname(process.execPath), 'version-check-cache.json')
  : path.join(__dirname, 'version-check-cache.json');

function _loadVersionCheckCache() {
  try {
    if (!fs.existsSync(VERSION_CACHE_FILE)) return null;
    var raw = fs.readFileSync(VERSION_CACHE_FILE, 'utf8');
    var obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    var ts = Number(obj.lastSuccessAt);
    var tsValid = isFinite(ts) && ts > 0 && ts <= Date.now() + 60000; // 时钟漂移防御
    var fts = Number(obj.forceDetectedAt);
    var ftsValid = isFinite(fts) && fts > 0 && fts <= Date.now() + 60000;
    return {
      lastSuccessAt:      tsValid ? ts : 0,
      lastRemoteVersion:  String(obj.lastRemoteVersion || ''),
      lastLocalVersion:   String(obj.lastLocalVersion  || ''),
      forceRemoteVersion: String(obj.forceRemoteVersion || ''),
      forceDetectedAt:    ftsValid ? fts : 0,
    };
  } catch(_) { return null; } // 缓存文件损坏视为无缓存, 走正常请求
}

function _saveVersionCheckCacheRaw(obj) {
  try {
    fs.writeFileSync(VERSION_CACHE_FILE, JSON.stringify(obj || {}), 'utf8');
    return true;
  } catch(_) { return false; }
}

function _saveVersionCheckSuccess(remoteVer) {
  _saveVersionCheckCacheRaw({
    lastSuccessAt:      Date.now(),
    lastRemoteVersion:  String(remoteVer || ''),
    lastLocalVersion:   String(LOCAL_VERSION || ''),
    forceRemoteVersion: '',
    forceDetectedAt:    0,
  });
}

function _saveVersionCheckForce(remoteVer) {
  var existing = _loadVersionCheckCache() || {};
  _saveVersionCheckCacheRaw({
    lastSuccessAt:      Number(existing.lastSuccessAt) || 0,
    lastRemoteVersion:  String(existing.lastRemoteVersion || ''),
    lastLocalVersion:   String(existing.lastLocalVersion  || ''),
    forceRemoteVersion: String(remoteVer || ''),
    forceDetectedAt:    Date.now(),
  });
}

function _clearVersionCheckForce() {
  var existing = _loadVersionCheckCache();
  if (!existing) return;
  if (!existing.forceRemoteVersion) return; // 本来就没 force, 不用动
  _saveVersionCheckCacheRaw({
    lastSuccessAt:      existing.lastSuccessAt || 0,
    lastRemoteVersion:  existing.lastRemoteVersion || '',
    lastLocalVersion:   existing.lastLocalVersion  || '',
    forceRemoteVersion: '',
    forceDetectedAt:    0,
  });
}

async function checkForUpdate() {
  if (process.env.LAUNCHER_AUTOTEST === '1') {
    logInfo('Version', 'skipped for isolated launcher automation');
    return;
  }
  var cache = _loadVersionCheckCache();

  if (cache && cache.forceRemoteVersion) {
    if (isNewerVersion(cache.forceRemoteVersion, LOCAL_VERSION)) {
      logWarn('Version', 'forced update from cache (no network call)', {
        local:              LOCAL_VERSION,
        forceRemoteVersion: cache.forceRemoteVersion,
        forceDetectedAt:    cache.forceDetectedAt,
      });
      return new Promise(function() {
        showForceUpdateDialog(cache.forceRemoteVersion, '');
      });
    } else {
      logInfo('Version', 'force state cleared (local upgraded)', {
        local:              LOCAL_VERSION,
        forceRemoteVersion: cache.forceRemoteVersion,
      });
      _clearVersionCheckForce();
      cache = _loadVersionCheckCache(); // 重新读取, 后续 6h 判定不带 force
    }
  }

  if (cache && cache.lastSuccessAt > 0 && cache.lastLocalVersion === LOCAL_VERSION) {
    var elapsed = Date.now() - cache.lastSuccessAt;
    if (elapsed >= 0 && elapsed < VERSION_CHECK_INTERVAL_MS) {
      logInfo('Version', 'skipped by cache interval', {
        elapsedMs:        elapsed,
        lastSuccessAt:    cache.lastSuccessAt,
        lastRemoteVersion: cache.lastRemoteVersion,
      });
      return; // 直接继续启动, 不发请求
    }
  }

  return _checkForUpdateOverNetwork();
}

function _checkForUpdateOverNetwork() {
  return new Promise(function(resolve) {
    var settled = false;
    var skipFor = function(reason) {
      if (settled) return;
      settled = true;
      logWarn('Version', 'check failed, skipped for availability', { reason: String(reason || '').slice(0, 200) });
      startupDiag('Version check skipped (availability)', { reason: String(reason || '').slice(0, 200) });
      resolve();
    };
    var timedOut = false;
    var timeout = setTimeout(function() {
      timedOut = true;
      skipFor('timeout 500ms');
    }, 500);

    httpsGetFollow(
      CF_BASE + 'version.json',
      null,
      function(buf) {
        if (timedOut || settled) return;
        clearTimeout(timeout);
        var remoteVer = '';
        try {
          var remote = JSON.parse(buf.toString('utf8'));
          remoteVer = String((remote && remote.version) || '').trim();
          if (!remoteVer) {
            return skipFor('remote version field missing or empty');
          }
          logInfo('Version', 'Version check', { local: LOCAL_VERSION, remote: remoteVer });
          if (isNewerVersion(remoteVer, LOCAL_VERSION)) {
            settled = true;
            try { _saveVersionCheckForce(remoteVer); } catch(_) {}
            logWarn('Version', 'Update required (force persisted)', { local: LOCAL_VERSION, remote: remoteVer });
            showForceUpdateDialog(remoteVer, (remote && remote.changelog) || '');
          } else {
            settled = true;
            _saveVersionCheckSuccess(remoteVer);
            logInfo('Version', 'Up to date');
            resolve();
          }
        } catch(e) {
          skipFor('parse failed: ' + (e && e.message ? e.message : e));
        }
      },
      function(e) {
        if (timedOut || settled) return;
        clearTimeout(timeout);
        skipFor('network: ' + (e && e.message ? e.message : e));
      },
      500  // timeoutMs: electron.net 内层超时与外层 setTimeout 一致, 失败快速回落
    );
  });
}


function _noCacheUrl(url) {
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
}

function _netRequest(url, timeoutMs, onResponse, onErr) {
  var fullUrl = _noCacheUrl(url);
  var electronNet = require('electron').net;
  var req = electronNet.request({ url: fullUrl, redirect: 'follow' });
  req.setHeader('User-Agent',     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  req.setHeader('Accept',         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  req.setHeader('Accept-Language','zh-CN,zh;q=0.9,en;q=0.8');
  req.setHeader('Referer',        'https://gitee.com/');
  req.setHeader('Cache-Control',  'no-cache, no-store');
  req.setHeader('Pragma',         'no-cache');

  var settled = false;
  var timer = setTimeout(function() {
    if (settled) return;
    settled = true;
    try { req.abort(); } catch(_) {}
    onErr(new Error('Timeout'));
  }, timeoutMs || 30000);

  req.on('response', function(res) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onResponse(res);
  });
  req.on('error', function(e) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onErr(e);
  });
  req.end();
}

function httpsGetFollow(url, onData, onEnd, onErr, timeoutMs) {
  _netRequest(url, timeoutMs || 30000, function(res) {
    if (res.statusCode !== 200) { return onErr(new Error('HTTP ' + res.statusCode)); }
    var chunks = [];
    res.on('data',  function(c) { chunks.push(c); onData && onData(c.length); });
    res.on('end',   function()  { onEnd(Buffer.concat(chunks)); });
    res.on('error', onErr);
  }, onErr);
}

function downloadToTmp(url, tmpPath, onData, onDone, onErr, timeoutMs) {
  _netRequest(url, timeoutMs || 120000, function(res) {
    if (res.statusCode !== 200) { return onErr(new Error('HTTP ' + res.statusCode)); }
    var ws = fs.createWriteStream(tmpPath);
    var errFired = false;
    function cleanTmp() { try { fs.unlinkSync(tmpPath); } catch(_) {} }
    res.on('data',  function(chunk) { onData && onData(chunk.length); });
    res.pipe(ws);
    ws.on('finish', function() { if (!errFired) onDone(); });
    ws.on('error',  function(e) { if (errFired) return; errFired = true; ws.destroy(); cleanTmp(); onErr(e); });
    res.on('error', function(e) { if (errFired) return; errFired = true; ws.destroy(); cleanTmp(); onErr(e); });
  }, onErr);
}

var _autoStartPending = true;

var lastWriteAddr=null, lastWriteValue=null, lastWriteTime=null;

function writeFlashMmsCfg() {
  if (!flashStatus||!flashStatus.path) return;
  var cfgPath = path.join(path.dirname(flashStatus.path),'mms.cfg');
  var cfg = ['# Seer2 Launcher — generated Flash player config','DisableDeviceFontEnumeration=1','AssetCacheSize=64','ErrorReportingEnable=0','AutoUpdateDisable=1','SilentAutoUpdateEnable=0','ThrottleIndexedDBWrites=1','AllowUserLocalTrust=0','FullScreenDisable=0','DisableProductDownload=1'].join('\n');
  try { fs.writeFileSync(cfgPath, cfg, 'utf8'); console.log('[Flash] mms.cfg written:', cfgPath); }
  catch(e) { console.log('[Flash] mms.cfg write failed:', e.message); }
}

function _getGameWindowDefaults() {
  var defaults = { width:1200, height:710, minWidth:1024, minHeight:600 };
  // 保持项目既有的默认窗口尺寸。特殊工作区只在窗口真正创建后由
  // _clampGameWindowToWorkArea() 处理，避免高 DPI/多显示器探测改变正常
  // 显示器上的 1200x710 初始布局（这会导致旧版 Flash 出现白块）。
  return defaults;
}

function _clampGameWindowToWorkArea() {
  if (_gameBoundsClampBusy || !gameWin || gameWin.isDestroyed()) return;
  try {
    // 最大化、全屏和最小化由系统负责适配；setBounds 会破坏这些状态。
    if (gameWin.isMaximized() || gameWin.isFullScreen() || gameWin.isMinimized()) return;
    var electronScreen = require('electron').screen;
    var current = gameWin.getBounds();
    var display = electronScreen && electronScreen.getDisplayMatching && electronScreen.getDisplayMatching(current);
    var work = display && (display.workArea || display.bounds);
    if (!work || !isFinite(work.width) || !isFinite(work.height)) return;
    var margin = 8;
    var maxW = Math.max(1, Math.floor(work.width - margin * 2));
    var maxH = Math.max(1, Math.floor(work.height - margin * 2));
    var minW = Math.min(1024, maxW);
    var minH = Math.min(600, maxH);
    try { gameWin.setMinimumSize(minW, minH); } catch (_) {}
    var next = {
      width: Math.min(current.width, maxW),
      height: Math.min(current.height, maxH),
      x: current.x,
      y: current.y,
    };
    next.x = Math.max(work.x + margin, Math.min(next.x, work.x + work.width - margin - next.width));
    next.y = Math.max(work.y + margin, Math.min(next.y, work.y + work.height - margin - next.height));
    if (next.width === current.width && next.height === current.height &&
        next.x === current.x && next.y === current.y) return;
    _gameBoundsClampBusy = true;
    gameWin.setBounds(next, false);
    _gameBoundsClampBusy = false;
  } catch (_) {
    _gameBoundsClampBusy = false;
  }
}

function createGame() {
  if (_appQuitting) return;
  if (gameWin) { gameWin.focus(); return; }
  var upstream  = 'DIRECT'; // core-net 内部在 cache miss 时直连转发
  var pacScript = coreNet.buildPacScript(upstream);
  console.log('[Proxy] PAC upstream=DIRECT(chain) port='+coreNet.getProxyPort());
  var gameWindow = _getGameWindowDefaults();
  gameWin = new BrowserWindow({
    width:gameWindow.width, height:gameWindow.height,
    minWidth:gameWindow.minWidth, minHeight:gameWindow.minHeight,
    title:'阿卡迪亚:传说 by志贺春树(春树哥哥)-' + (process.arch === 'x64' ? 'x64' : 'x32'), backgroundColor:'#ffffff',
    icon:path.join(__dirname,'icon.ico'),
    webPreferences:{
      nodeIntegration:false, contextIsolation:false,
      sandbox:false, plugins:true,
      webSecurity:false, allowRunningInsecureContent:true,
      backgroundThrottling:false,
      preload: path.join(__dirname, 'game-preload.js'),
      v8CacheOptions:'none', spellcheck:false,
      enableWebSQL:false, navigateOnDragDrop:false,
      images:true, javascript:true, webgl:false,
      enableRemoteModule:false,
      additionalArguments:['--max-old-space-size=128','--optimize-for-size'],
    },
    show:false, center:true,
  });
  gameWin.setMenu(buildGameMenu());
  gameWin.webContents.session.setProxy({ pacScript:'data:application/x-ns-proxy-autoconfig;base64,'+Buffer.from(pacScript).toString('base64'), proxyBypassRules:'<local>;127.0.0.1' }).then(() => console.log('[Proxy] PAC applied'));
  try { gameWin.webContents.session.setCacheEnabled(false); console.log('[Cache] disabled'); } catch(e) { console.log('[Cache] setCacheEnabled failed:', e.message); }
  var _ua = process.arch === 'x64'
    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36';
  gameWin.webContents.setUserAgent(_ua);


  gameWin.webContents.on('dom-ready', function() {
    console.log('[Diag] dom-ready pid:', gameWin.webContents.getOSProcessId());
    gameWin.webContents.executeJavaScript(CLEANUP_JS).catch(function(){});
  });
  gameWin.webContents.on('did-finish-load',     () => console.log('[Diag] did-finish-load pid:', gameWin.webContents.getOSProcessId()));
  gameWin.webContents.on('did-fail-load',       (_,c,d,u,m) => console.log('[Diag] did-fail-load', c, d, u, m));
  gameWin.webContents.on('crashed',             (_,k) => console.log('[Diag] crashed killed:', k));
  gameWin.webContents.on('render-process-gone', (_,d) => console.log('[Diag] gone reason:', d.reason));
  gameWin.on('unresponsive', function() { if (_appQuitting) return; logWarn('Game','unresponsive'); _prepareReload('Unresponsive'); _navigateGameAfterKill('unresponsive'); });
    gameWin.loadURL(getGameEntryUrl());
  gameWin.once('ready-to-show', function() {
    var pid0 = gameWin.webContents.getOSProcessId();
    if (global._loadingWin && !global._loadingWin.isDestroyed()) {
      global._loadingWin.close(); global._loadingWin = null;
    }
    // Clamp once before the first show.  Never call setBounds while Windows is
    // processing an interactive border drag: doing so feeds a second resize
    // back into the native sizing loop and makes the window expand/snap toward
    // the whole work area.
    _clampGameWindowToWorkArea();
    if (process.env.LAUNCHER_AUTOTEST !== '1') gameWin.show();
    // 仅当当前工作区确实容纳不下固定默认尺寸时夹紧；正常显示器保持
    // 原始 1200x710，不改变既有布局。
    _clampGameWindowToWorkArea();
    gameRenderPid=pid0; gameMainPid=process.pid;
    logInfo('Game','Game launched',{ renderPid:gameRenderPid, browserPid:process.pid });
    broadcastAll('game-launched',{ renderPid:gameRenderPid, mainPid:gameMainPid });
    if (pid0) require('child_process').spawn(_pshell64,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command','$p=Get-Process -Id '+pid0+' -EA SilentlyContinue;if($p){$p.PriorityClass=[System.Diagnostics.ProcessPriorityClass]::Normal}'],{windowsHide:true,stdio:'ignore'});
    startFlashPrioWatcher();
    startPeakPoller();
  });
  var GAME_TITLE = '阿卡迪亚:传说 by志贺春树(春树哥哥)-' + (process.arch === 'x64' ? 'x64' : 'x32');
  gameWin.on('page-title-updated', e => { e.preventDefault(); gameWin.setTitle(GAME_TITLE); });
  gameWin.webContents.on('did-finish-load', function() {
    gameWin.setTitle(GAME_TITLE);
    try { gameWin.webContents.setZoomFactor(1); } catch(e) {}
    if (!_pageDesignW || !_pageDesignH) {
      _pageDesignW = 1200;
      _pageDesignH = 660;
      logInfo('Zoom', 'Baseline (Flash embed): ' + _pageDesignW + 'x' + _pageDesignH);
    }
    gameWin.webContents.executeJavaScript(GAME_PAGE_INIT_JS).catch(function(){});
    _loadingComplete = true; // 首次 did-finish-load 完成，解锁 resize zoom
    _applyPageZoom();
    var freshPid = gameWin.webContents.getOSProcessId();
    if (freshPid && freshPid!==gameRenderPid) { gameRenderPid = freshPid; logInfo('Game','PID refreshed',{ renderPid:gameRenderPid }); }
    if (gameRenderPid) broadcastAll('game-launched',{ renderPid:gameRenderPid, mainPid:gameMainPid });
    startFlashPrioWatcher();
  });
  gameWin.webContents.on('did-fail-load', (_,c,d) => { logError('Game','Load failed',{errorCode:c,desc:d}); broadcastAll('game-load-error',{errorCode:c,errorDescription:d}); });
  gameWin.webContents.on('render-process-gone', (_,d) => { logError('Game','Gone: '+d.reason); gameRenderPid=null; cachedPpapiPid=null; });
  gameWin.webContents.on('crashed', function() { logError('Game','crashed'); gameRenderPid=null; cachedPpapiPid=null; });
  gameWin.on('close', function() {
    _cleanupForAppExit('WindowClose');
  });
  gameWin.on('closed', function() {
    logWarn('Game','closed',{ renderPid:gameRenderPid, lastWriteAddr, lastWriteValue, lastWriteTime });
    stopFlashPrioWatcher();
    stopPeakPoller();
    _metricsCache=null; _metricsCacheTime=0;
    gameWin=null;gameRenderPid=null;gameMainPid=null;cachedPpapiPid=null;_flashPrioSet=false;
    _speedHookState=null; // 进程已死，钩子随之消失；保留 _currentGameSpeed 供下次会话参考
    _pageDesignW=0; _pageDesignH=0; // 重置页面设计尺寸，防止下次启动使用旧值
    _isApplyingZoom=false;
    _hasPendingZoom=false;
    if (_zoomThrottleTimer) { clearTimeout(_zoomThrottleTimer); _zoomThrottleTimer=null; }
    if (_zoomDebounce) { clearTimeout(_zoomDebounce); _zoomDebounce=null; }
    lastWriteAddr=null;lastWriteValue=null;lastWriteTime=null;_lastGBForOverlays=null;
    Object.keys(overlayWins).forEach(function(name) {
      var w=overlayWins[name];
      if (w&&!w.isDestroyed()) {
        try { w.webContents.removeAllListeners(); } catch(e) {}
        try { w.removeAllListeners(); } catch(e) {}
        try { w.close(); } catch(e) {}
      }
      overlayWins[name]=null;
    });
    closeAllSkinToolWins();
    closeAllImageWins(true);
    if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_LIFECYCLE_RESULT_FILE) {
      try {
        fs.writeFileSync(path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_LIFECYCLE_RESULT_FILE), JSON.stringify({
          ok:Object.keys(skinToolWins).every(function(kind) { return skinToolWins[kind] === null; }),
          skinTools:Object.keys(skinToolWins).reduce(function(out, kind) { out[kind] = skinToolWins[kind] === null; return out; }, {}),
          overlays:Object.keys(overlayWins).every(function(name) { return overlayWins[name] === null; }),
        }, null, 2), 'utf8');
      } catch(_) {}
    }
    broadcastAll('game-closed', null);
  });
  gameWin.on('focus', function() {
    if (_gameMinimized) return;
    _bringOverlaysToTop();
  });
  var _throttledMove = _makeThrottle(function() {
    onGameWindowMoved();
  }, 16);
  var _throttledResize = _makeThrottle(function() {
    _lastGBForOverlays = gameContentRef(); // 只调用一次，缓存结果
    var gb = _lastGBForOverlays;
    Object.keys(overlayWins).forEach(function(name) {
      var w = overlayWins[name]; if (w && !w.isDestroyed()) saveOneOverlayBounds(name, w, gb);
    });
    _applyPageZoomDebounced();
  }, 16);

  function _handleInstantZoom() {
    if (!_loadingComplete) return;
    if (_zoomDebounce) { clearTimeout(_zoomDebounce); _zoomDebounce = null; }
    if (_zoomThrottleTimer) { clearTimeout(_zoomThrottleTimer); _zoomThrottleTimer = null; }
    _applyPageZoom();
    // 延迟 40ms 进行二次对齐校准，消除 Windows DWM 窗口动画过程中的瞬态边框微差
    setTimeout(function() {
      if (!_loadingComplete || !gameWin || gameWin.isDestroyed()) return;
      _applyPageZoom();
    }, 40);
  }

  gameWin.on('move',   _throttledMove);
  gameWin.on('resize', function() {
    _throttledResize();
    _bringOverlaysToTop();
  });
  gameWin.on('resized', function() {
    if (!_loadingComplete) return;
    if (_zoomDebounce) { clearTimeout(_zoomDebounce); _zoomDebounce = null; }
    if (_zoomThrottleTimer) { clearTimeout(_zoomThrottleTimer); _zoomThrottleTimer = null; }
    _applyPageZoom();
    _bringOverlaysToTop();
  });
  gameWin.on('maximize',   function() { _handleInstantZoom(); _bringOverlaysToTop(); });
  gameWin.on('unmaximize', function() { _handleInstantZoom(); _bringOverlaysToTop(); });
  // 全屏切换会改变内容尺寸与 PPAPI 插件矩形，需重算缩放路径。
  gameWin.on('enter-full-screen', function() { _handleInstantZoom(); _bringOverlaysToTop(); });
  gameWin.on('leave-full-screen', function() { _handleInstantZoom(); _bringOverlaysToTop(); });
  gameWin.on('minimize', function() {
    _gameMinimized = true; _minimizedByGameMin = {};
    try {
      if (gameWin.webContents && typeof gameWin.webContents.setBackgroundThrottling === 'function') {
        gameWin.webContents.setBackgroundThrottling(true);
      }
    } catch(e) {}
    Object.keys(overlayWins).forEach(function(name) {
      var w = overlayWins[name];
      if (w && !w.isDestroyed() && w.isVisible()) {
        _minimizedByGameMin[name] = true;
        w.minimize();
      }
    });
    Object.keys(skinToolWins).forEach(function(kind) {
      var w = skinToolWins[kind];
      if (w && !w.isDestroyed() && w.isVisible()) {
        _minimizedByGameMin['__skinTool_' + kind] = true;
        w.minimize();
      }
    });
    Object.keys(_imageWins).forEach(function(k) {
      var w = _imageWins[k];
      if (w && !w.isDestroyed() && w.isVisible()) {
        _minimizedByGameMin['__img_'+k] = true;
        w.minimize();
      }
    });
  });
  gameWin.on('restore', function() {
    _gameMinimized = false;
    try {
      if (gameWin.webContents && typeof gameWin.webContents.setBackgroundThrottling === 'function') {
        gameWin.webContents.setBackgroundThrottling(false);
      }
    } catch(e) {}
    _handleInstantZoom();
    Object.keys(_minimizedByGameMin).forEach(function(name) {
      if (name.indexOf('__img_') === 0) {
        var k = name.slice(6);
        var w = _imageWins[k]; if (!w || w.isDestroyed()) return;
        if (w.isMinimized()) w.restore(); else w.show();
      } else if (name.indexOf('__skinTool_') === 0) {
        var kind = name.slice(11);
        var toolWin = skinToolWins[kind]; if (!toolWin || toolWin.isDestroyed()) return;
        if (toolWin.isMinimized()) toolWin.restore(); else toolWin.show();
      } else {
        var w = overlayWins[name]; if (!w || w.isDestroyed()) return;
        if (w.isMinimized()) w.restore(); else w.show();
      }
    });
    _minimizedByGameMin = {};
    _bringOverlaysToTop();
    setTimeout(function() { bringCurrentSkinToolToTop(); }, 0);
  });
}

var GAME_CACHE_DIR = (function() {
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT) {
    var isolatedCacheDir = path.join(path.resolve(process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT), 'GameCache');
    if (process.env.LAUNCHER_AUTOTEST_SKIN_CACHE_PRESERVE_RESULT_FILE) {
      try {
        fs.mkdirSync(isolatedCacheDir, { recursive:true });
        fs.writeFileSync(path.join(isolatedCacheDir, 'unrelated-cache-probe.bin'), 'unrelated-game-cache-must-survive-skin-reload', 'utf8');
        fs.writeFileSync(path.join(isolatedCacheDir, 'index.json'), JSON.stringify([{
          hash:'unrelated-cache-probe', name:'unrelated-cache-probe.bin',
          diskName:'unrelated-cache-probe.bin', url:'http://example.invalid/unrelated-cache-probe.bin',
          ext:'bin', size:46, cachedAt:Date.now(), hitCount:0,
        }]), 'utf8');
      } catch(e) { console.warn('[AUTOTEST] isolated cache probe setup failed:', e.message); }
    }
    logInfo('Cache', 'Autotest isolated mode: ' + isolatedCacheDir);
    return isolatedCacheDir;
  }
  var exeDir = path.dirname(app.getPath('exe'));
  var testFile = path.join(exeDir, '.write_test_' + Date.now());
  try {
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    var dir = path.join(exeDir, 'GameCache');
    logInfo('Cache', 'Portable mode: ' + dir);
    return dir;
  } catch(e) {
    var dir2 = path.join(app.getPath('userData'), 'GameCache');
    logInfo('Cache', 'AppData mode (UAC): ' + dir2);
    return dir2;
  }
})();

let REPLACE_RULES_FILE  = null; // app.whenReady() 后赋值
var LOCAL_SWF_DIR   = null; // local-res 目录（./前缀的相对路径基准，app.whenReady() 后赋值）
let _replaceRules = [];        // visible rules [{ url, file, enabled, label }]
let SKIN_MODE_STATE_FILE = null;
let SKIN_MODE_RULES_FILE = null;
let CATALOG_INSTALL_RESET_FILE = null;
let SKIN_ASSIGNMENT_INSTALL_RESET_FILE = null;
let _skinModeEnabled = false;
let _skinModeRules = [];
let _catalogInstallResetPending = false;
let _skinAssignmentInstallResetPending = false;
let CUSTOM_SKINS_FILE = null;   // exe 同级 custom-skins.json
let CUSTOM_SKINS_DIR = null;    // exe 同级 custom-skins\（导入文件的托管目录）
let CUSTOM_SKIN_DOWNLOAD_SETTINGS_FILE = null;
let CUSTOM_SKIN_DEFAULT_DOWNLOAD_DIR = null;
let CUSTOM_SKIN_NAME_CACHE_FILE = null;
let CUSTOM_SKIN_CATALOG_CACHE_FILE = null;
let CUSTOM_SKIN_TEMPORARY_MODEL_NAME_EVIDENCE_FILE = null;
let _customSkinDownloadDir = '';
let _customSkinAutoImport = true;
let _customSkinIncludeOfficialSkins = true;
let _customSkinPreferUClient = false;
let _customSkinDownloadInputMode = 'list';
let _customSkinDownloadTypes = ['normal','fight','icon'];
let _customSkinDownloadQueueIds = [];
let _customSkinDownloadQueueRevision = 0;
let _customSkinNameCache = {};
let _customSkins = [];          // [{ skinId, name, files, enabled, autoId }]
let _customSkinRevision = 0;
let _customSkinIssuedIds = new Set();
let _customSkinReloadTimer = null;
let _customSkinReloadPendingAfterFlight = false;
let _customSkinAssignmentResetPending = false;
let _customSkinAssignmentResetAllPending = false;
let _customSkinAssignmentResetPendingIds = new Set();
let _customSkinStorageGeneration = 0;
let _customSkinSuiteCommitDepth = 0;
let _customSkinProjectionWorkerPromise = null;
let _customSkinProjectionWorkerKey = '';
let _customSkinProjectionWorkerPendingKey = '';
let _customSkinProjectionVerifiedKey = '';
let _customSkinProjectionRequestSerial = 0;
let _customSkinCommittedProjection = {
  revision:0,
  generation:0,
  uiEntries:[],
  inventory:{ ids:[], uClientIds:[], entries:[] },
};
let _customSkinSnapshotProjectionCache = {
  key:'',
  uiEntries:null,
  inventory:null,
};

function customSkinSnapshotProjectionKey() {
  var directory = '';
  try { directory = customSkinDownloadDirectory().toLowerCase(); } catch(_) {}
  return [_customSkinRevision, _customSkinStorageGeneration, directory].join('|');
}

function currentCustomSkinSnapshotProjectionCache() {
  var key = customSkinSnapshotProjectionKey();
  if (_customSkinSnapshotProjectionCache.key !== key) {
    _customSkinSnapshotProjectionCache = { key:key, uiEntries:null, inventory:null };
  }
  return _customSkinSnapshotProjectionCache;
}

function invalidateCustomSkinSnapshotProjection() {
  _customSkinSnapshotProjectionCache = { key:'', uiEntries:null, inventory:null };
}

function emptyCustomSkinDownloadedInventory() {
  return { ids:[], uClientIds:[], entries:[] };
}

function cloneCustomSkinProjectionValue(value, fallback) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch(_) { return JSON.parse(JSON.stringify(fallback)); }
}

function normalizeCommittedCustomSkinInventory(value, trustBattleVerification) {
  value = value && typeof value === 'object' ? value : {};
  var entries = (Array.isArray(value.entries) ? value.entries : []).map(function(raw) {
    var sourceId = parseCustomSkinId(raw && raw.sourceId);
    if (!sourceId) return null;
    var files = {};
    ['normal','fight','icon','skill'].forEach(function(type) {
      files[type] = Math.max(0, Number(raw && raw.files && raw.files[type]) || 0);
    });
    var verified = trustBattleVerification === true && raw.battlePlayable === true &&
      raw.battleIntegrityReason === 'verified-at-commit';
    return Object.assign({}, raw, {
      sourceId:sourceId,
      files:files,
      battlePlayable:verified,
      battleIntegrityReason:verified ? 'verified-at-commit' :
        (files.fight > 0 ? 'verification-pending' : 'missing-fight'),
    });
  }).filter(Boolean).sort(function(a,b) { return a.sourceId - b.sourceId; });
  var ids = Array.from(new Set((Array.isArray(value.ids) ? value.ids : entries.map(function(item) {
    return item.sourceId;
  })).map(parseCustomSkinId).filter(Boolean))).sort(function(a,b) { return a - b; });
  var uClientIds = Array.from(new Set((Array.isArray(value.uClientIds) ? value.uClientIds : [])
    .map(parseCustomSkinId).filter(Boolean))).sort(function(a,b) { return a - b; });
  return { ids:ids, uClientIds:uClientIds, entries:entries };
}

function installLoadedCustomSkinProjection(raw) {
  var saved = raw && raw.projection && typeof raw.projection === 'object' ? raw.projection : {};
  var savedRevision = parseInt(saved.revision,10);
  var uiEntries = savedRevision === _customSkinRevision && Array.isArray(saved.uiEntries)
    ? cloneCustomSkinProjectionValue(saved.uiEntries, [])
    : cloneCustomSkinProjectionValue(_customSkins, []);
  // A projection loaded from disk cannot prove that its files were not removed
  // or damaged while the launcher was stopped.  Preserve the inventory shape,
  // but keep battle capability pending until the post-first-screen worker has
  // revalidated the current bytes and manifest closure.
  var inventory = savedRevision === _customSkinRevision
    ? normalizeCommittedCustomSkinInventory(saved.inventory, false)
    : emptyCustomSkinDownloadedInventory();
  _customSkinCommittedProjection = {
    revision:_customSkinRevision,
    generation:_customSkinStorageGeneration,
    uiEntries:uiEntries,
    inventory:inventory,
  };
  invalidateCustomSkinSnapshotProjection();
}

function carryCustomSkinProjection(skins, revision) {
  return {
    revision:revision,
    generation:_customSkinStorageGeneration,
    uiEntries:customSkinUiEntries(skins, { bypassCommitted:true }),
    inventory:normalizeCommittedCustomSkinInventory(_customSkinCommittedProjection.inventory, true),
  };
}

function clearCustomSkinAssignmentSharedObjects(skinIds) {
  var preciseIds = new Set((Array.isArray(skinIds) ? skinIds : []).map(parseCustomSkinId).filter(Boolean));
  var precise = preciseIds.size > 0;
  var summary = {
    deleted:0,
    updated:0,
    untouched:0,
    removedBindings:0,
    skippedUnsupported:0,
    precise:precise,
    errors:[],
    warnings:[],
  };
  // Chromium Pepper and the legacy standalone Flash player use different
  // SharedObject roots.  The old implementation only walked Pepper's
  // userData path, leaving the real Macromedia/#SharedObjects skinDefine.sol
  // files behind on machines that still have the legacy Flash profile.
  var roots = [];
  var seenRoots = new Set();
  function addRoot(candidate) {
    try {
      var absolute = path.resolve(candidate);
      var key = absolute.toLowerCase();
      if (!seenRoots.has(key)) { seenRoots.add(key); roots.push(absolute); }
    } catch(_) {}
  }
  addRoot(path.join(app.getPath('userData'), 'Pepper Data', 'Shockwave Flash',
    'WritableRoot', '#SharedObjects'));
  addRoot(path.join(app.getPath('appData'), 'Macromedia', 'Flash Player', '#SharedObjects'));
  addRoot(path.join(app.getPath('userData'), 'Macromedia', 'Flash Player', '#SharedObjects'));
  addRoot(path.join(app.getPath('appData'), 'Pepper Data', 'Shockwave Flash',
    'WritableRoot', '#SharedObjects'));
  for (var rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    var root = roots[rootIndex];
    if (!fs.existsSync(root)) continue;
    var stack = [root];
    while (stack.length) {
    var current = stack.pop();
    var stat;
    try { stat = fs.lstatSync(current); }
    catch(e) { if (!e || e.code !== 'ENOENT') summary.errors.push(current + ': ' + e.message); continue; }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      var names;
      try { names = fs.readdirSync(current); }
      catch(e) { summary.errors.push(current + ': ' + e.message); continue; }
      names.forEach(function(name) { stack.push(path.join(current, name)); });
      continue;
    }
    if (path.basename(current).toLowerCase() !== 'skindefine.sol') continue;
    try {
      if (!precise) {
        fs.unlinkSync(current);
        summary.deleted++;
        continue;
      }
      var original = fs.readFileSync(current);
      var filtered;
      try {
        filtered = customSkinSol.filterAssignments(original, preciseIds);
      } catch(parseError) {
        summary.untouched++;
        summary.skippedUnsupported++;
        summary.errors.push(current + ': ' + parseError.message);
        continue;
      }
      if (!filtered.changed) {
        summary.untouched++;
        continue;
      }
      summary.removedBindings += filtered.removedBindings;
      if (!filtered.remainingBindings) {
        fs.unlinkSync(current);
        summary.deleted++;
      } else {
        fs.writeFileSync(current, filtered.buffer);
        summary.updated++;
      }
    } catch(e) {
      if (!e || e.code !== 'ENOENT') summary.errors.push(current + ': ' + e.message);
    }
    }
  }
  return summary;
}

function trackCustomSkinAssignmentReset(skinIds, assignmentReset, fullReset) {
  var reset = assignmentReset || {
    deleted:0, updated:0, untouched:0, removedBindings:0,
    skippedUnsupported:0, precise:fullReset !== true, errors:[], warnings:[],
  };
  var ids = new Set((Array.isArray(skinIds) ? skinIds : []).map(parseCustomSkinId).filter(Boolean));
  var liveFlash = !!(gameWin && !gameWin.isDestroyed());
  var retryRequired = liveFlash || (reset.errors || []).length > 0;
  if (fullReset === true) {
    if (retryRequired) {
      _customSkinAssignmentResetAllPending = true;
      _customSkinAssignmentResetPendingIds.clear();
    } else {
      _customSkinAssignmentResetAllPending = false;
      _customSkinAssignmentResetPendingIds.clear();
    }
  } else if (ids.size) {
    if (retryRequired) {
      if (!_customSkinAssignmentResetAllPending) {
        ids.forEach(function(id) { _customSkinAssignmentResetPendingIds.add(id); });
      }
    } else if (!_customSkinAssignmentResetAllPending) {
      ids.forEach(function(id) { _customSkinAssignmentResetPendingIds.delete(id); });
    }
  }
  _customSkinAssignmentResetPending = _customSkinAssignmentResetAllPending ||
    _customSkinAssignmentResetPendingIds.size > 0;
  reset.changedSkinIds = fullReset === true ? [] : Array.from(ids);
  reset.fullReset = fullReset === true;
  reset.pendingAfterFlashExit = liveFlash && (fullReset === true || ids.size > 0);
  reset.retryPending = _customSkinAssignmentResetPending;
  return reset;
}

function customSkinAssignmentStateChanged(previous, next) {
  var nextByStableId = new Map((next || []).map(function(entry) {
    return [String(entry && entry.id || ''), entry];
  }).filter(function(pair) { return !!pair[0]; }));
  var nextById = new Map((next || []).map(function(entry) {
    return [parseCustomSkinId(entry && entry.skinId), entry];
  }).filter(function(pair) { return pair[0] > 0; }));
  var changedIds = new Set();
  (previous || []).forEach(function(entry) {
    var oldId = parseCustomSkinId(entry && entry.skinId);
    if (!oldId) return;
    var stableId = String(entry && entry.id || '');
    var replacement = stableId ? nextByStableId.get(stableId) : nextById.get(oldId);
    var newId = parseCustomSkinId(replacement && replacement.skinId);
    var changed = !replacement || oldId !== newId ||
      (entry.enabled !== false) !== (replacement.enabled !== false) ||
      (entry.officialIdOverride === true) !== (replacement.officialIdOverride === true);
    if (!changed) return;
    changedIds.add(oldId);
    if (newId) changedIds.add(newId);
  });
  return Array.from(changedIds);
}

function scheduleCustomSkinReload(delayMs) {
  if (!gameWin || gameWin.isDestroyed()) return;
  clearTimeout(_customSkinReloadTimer);
  _customSkinReloadTimer = setTimeout(function() {
    _customSkinReloadTimer = null;
    if (gameWin && !gameWin.isDestroyed()) {
      if (_gameReloadInFlight) {
        _customSkinReloadPendingAfterFlight = true;
        return;
      }
      doCustomSkinReload().catch(function(e) {
        logWarn('CustomSkin', 'cache-preserving reload failed', { error:e && e.message ? e.message : String(e) });
      });
    }
  }, Math.max(0, Number.isFinite(Number(delayMs)) ? Number(delayMs) : 350));
}

function saveQualityConfig() {
  return launcherRenderPolicy.writeConfig(fs, EARLY_QUALITY_CONFIG_FILE, _qualityConfig);
}

function readJsonWithBundledFallback(primaryFile, bundledName) {
  var candidates = [];
  if (primaryFile) candidates.push(path.resolve(primaryFile));
  var bundledFile = path.resolve(__dirname, String(bundledName || ''));
  if (bundledName && candidates.indexOf(bundledFile) < 0) candidates.push(bundledFile);
  var failures = [];
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    try {
      if (!fs.existsSync(candidate)) continue;
      return {
        ok:true,
        value:JSON.parse(fs.readFileSync(candidate, 'utf8')),
        file:candidate,
        bundled:candidate === bundledFile,
      };
    } catch(error) {
      failures.push({ file:candidate, error:error && error.message ? error.message : String(error) });
    }
  }
  return { ok:false, value:null, file:'', bundled:false, failures:failures };
}

function consumeCatalogInstallResetMarker() {
  _catalogInstallResetPending = false;
  if (!CATALOG_INSTALL_RESET_FILE) return false;
  try {
    if (!fs.existsSync(CATALOG_INSTALL_RESET_FILE)) return false;
    _catalogInstallResetPending = true;
    try { fs.unlinkSync(CATALOG_INSTALL_RESET_FILE); }
    catch(error) {
      logWarn('Catalog', 'install navigation reset marker could not be removed', {
        file:CATALOG_INSTALL_RESET_FILE,
        error:error && error.message ? error.message : String(error),
      });
    }
    return true;
  } catch(error) {
    logWarn('Catalog', 'install navigation reset marker could not be read', {
      file:CATALOG_INSTALL_RESET_FILE,
      error:error && error.message ? error.message : String(error),
    });
    return false;
  }
}

// The NSIS installer writes this marker on every install/upgrade.  Consume it
// only after the launcher has initialized Electron's userData path, so the
// same precise cleanup used by the skin UI can remove stale in-game bindings
// from both Pepper and legacy Flash SharedObject roots.  No SWF/config files
// under custom-skins are touched.  If a Flash process still holds a file,
// retain the marker and retry on the next launcher start instead of claiming
// that the install cleanup succeeded.
function consumeSkinAssignmentInstallResetMarker() {
  _skinAssignmentInstallResetPending = false;
  if (!SKIN_ASSIGNMENT_INSTALL_RESET_FILE) return false;
  try {
    if (!fs.existsSync(SKIN_ASSIGNMENT_INSTALL_RESET_FILE)) return false;
    var reset = clearCustomSkinAssignmentSharedObjects();
    if (reset && reset.errors && reset.errors.length) {
      logWarn('Install', 'skin assignment cleanup deferred; marker retained', {
        file:SKIN_ASSIGNMENT_INSTALL_RESET_FILE,
        reset:reset,
      });
      return false;
    }
    try { fs.unlinkSync(SKIN_ASSIGNMENT_INSTALL_RESET_FILE); }
    catch(error) {
      logWarn('Install', 'skin assignment reset marker could not be removed', {
        file:SKIN_ASSIGNMENT_INSTALL_RESET_FILE,
        error:error && error.message ? error.message : String(error),
      });
      return false;
    }
    _skinAssignmentInstallResetPending = true;
    logInfo('Install', 'one-shot in-game skin assignment cleanup completed', reset || {});
    return true;
  } catch(error) {
    logWarn('Install', 'skin assignment cleanup failed; marker retained', {
      file:SKIN_ASSIGNMENT_INSTALL_RESET_FILE,
      error:error && error.message ? error.message : String(error),
    });
    return false;
  }
}

function loadReplaceRules() {
  var loaded = readJsonWithBundledFallback(REPLACE_RULES_FILE, 'replace-rules.json');
  if (loaded.ok && Array.isArray(loaded.value)) {
    _replaceRules = loaded.value.map(normalizeReplaceRuleForStorage);
    if (loaded.bundled) console.log('[Replace] using bundled defaults:', loaded.file);
    return;
  }
  if (loaded.failures && loaded.failures.length) {
    console.warn('[Replace] load failed:', JSON.stringify(loaded.failures));
  }
}
function saveReplaceRules() {
  try { fs.writeFileSync(REPLACE_RULES_FILE, JSON.stringify(_replaceRules, null, 2), 'utf8'); }
  catch(e) { console.warn('[Replace] save failed:', e.message); }
}

function normalizeReplaceFileForStorage(file) {
  try {
    if (file == null) return '';
    var f = String(file).trim();
    if (!f) return '';
    if (/^https?:\/\//i.test(f)) return f;
    if (f.indexOf('.\\') === 0 || f.indexOf('./') === 0) {
      return '.\\' + f.slice(2).replace(/[\/\\]+/g, '\\');
    }
    if (LOCAL_SWF_DIR) {
      var localAbs = path.resolve(LOCAL_SWF_DIR);
      var fileAbs = path.resolve(f);
      var rel = path.relative(localAbs, fileAbs);
      if (rel && rel !== '..' && rel.indexOf('..' + path.sep) !== 0 && !path.isAbsolute(rel)) {
        return '.\\' + rel.replace(/[\/\\]+/g, '\\');
      }
    }
    return f.replace(/[\/\\]+/g, path.sep);
  } catch(e) {
    return String(file || '').trim();
  }
}

function normalizeReplaceRuleForStorage(r) {
  r = r || {};
  return {
    url: normalizeUrlForStorage(r.url),
    file: normalizeReplaceFileForStorage(r.file),
    enabled: r.enabled !== false,
    label: String(r.label || '').trim().slice(0, 80),
  };
}

function normalizeSkinModeRuleForStorage(r) {
  var normalized = normalizeReplaceRuleForStorage(r);
  normalized.enabled = true;
  normalized.skinMode = true;
  normalized.locked = true;
  return normalized;
}

function getSkinModeRulesForCurrentServer() {
  return (_skinModeRules || []).map(function(rule) {
    var copy = normalizeSkinModeRuleForStorage(rule);
    copy.url = rewriteUrlForCurrentServer(copy.url);
    return copy;
  });
}

function loadSkinModeState() {
  _skinModeEnabled = false;
  _skinModeRules = [];
  var loadedRules = readJsonWithBundledFallback(SKIN_MODE_RULES_FILE, 'skin-mode-rules.json');
  if (loadedRules.ok) {
    var rawRules = loadedRules.value;
    var list = Array.isArray(rawRules) ? rawRules : (rawRules && rawRules.rules);
    if (Array.isArray(list)) _skinModeRules = list.map(normalizeSkinModeRuleForStorage)
      .filter(function(rule) { return !!rule.url && !!rule.file; });
    if (loadedRules.bundled) console.log('[SkinMode] using bundled locked rules:', loadedRules.file);
  } else if (loadedRules.failures && loadedRules.failures.length) {
    logWarn('SkinMode', 'mode rules load failed', { failures:loadedRules.failures });
  }
  try {
    if (SKIN_MODE_STATE_FILE && fs.existsSync(SKIN_MODE_STATE_FILE)) {
      var rawState = JSON.parse(fs.readFileSync(SKIN_MODE_STATE_FILE, 'utf8'));
      _skinModeEnabled = rawState && rawState.enabled === true;
    }
  } catch(e) {
    logWarn('SkinMode', 'mode state load failed; using disabled mode', { error:e.message });
    _skinModeEnabled = false;
  }
}

function saveSkinModeState() {
  try {
    if (!SKIN_MODE_STATE_FILE) return { ok:false, error:'皮肤模式状态路径未初始化' };
    fs.writeFileSync(SKIN_MODE_STATE_FILE, JSON.stringify({
      version:1,
      enabled:_skinModeEnabled === true,
      updatedAt:new Date().toISOString(),
    }, null, 2), 'utf8');
    return { ok:true };
  } catch(e) {
    return { ok:false, error:e.message };
  }
}

function skinModePayload() {
  return { enabled:_skinModeEnabled === true, ruleCount:_skinModeRules.length };
}

function notifySkinModeChanged() {
  broadcastAll('skin-mode-changed', skinModePayload());
}

let _skinModeTransitionSerial = 0;

async function setSkinModeEnabled(enabled) {
  var desired = enabled === true;
  if (desired === _skinModeEnabled) {
    return Object.assign({ ok:true, unchanged:true }, skinModePayload());
  }
  var transitionSerial = ++_skinModeTransitionSerial;
  var previous = _skinModeEnabled;
  _skinModeEnabled = desired;
  var saved = saveSkinModeState();
  if (!saved.ok) {
    _skinModeEnabled = previous;
    return Object.assign({ ok:false }, saved, skinModePayload());
  }
  try { applyReplaceRulesToCoreNet(); } catch(e) { logWarn('SkinMode', 'replace rules apply failed', { error:e.message }); }
  // Commit and publish the switch itself synchronously.  Catalog refreshes and
  // game reloads are side effects, not prerequisites for an accurate toggle;
  // waiting for them made rapid clicks queue behind several seconds of I/O.
  notifySkinModeChanged();
  notifyCustomSkinsChanged();
  if (_skinModeEnabled) {
    // Re-open the persisted local registry when the mode is enabled.  The
    // mode-off path intentionally keeps the files/config on disk but only
    // clears the runtime CoreDLL snapshot; relying on the old in-memory
    // snapshot here made an already-open launcher show an empty skin library.
    try { loadCustomSkins(); }
    catch(e) { logWarn('SkinMode', 'local skin registry reload failed', { error:e.message }); }
    try { applyCustomSkinsToCoreNet(); } catch(e) { logWarn('SkinMode', 'custom skin routes apply failed', { error:e.message }); }
    // Start the normal cache-preserving game refresh immediately.  The
    // official XML refresh below may take several seconds and must not delay
    // the first mode-on reload.
    try { scheduleCustomSkinReload(); } catch(e) { logWarn('SkinMode', 'skin reload schedule failed', { error:e.message }); }
    // Refresh official IDs in the background.  The transition serial prevents
    // an old enable task from republishing routes after a newer rapid click has
    // already switched the mode off (or off and back on again).
    (async function refreshEnabledSkinMode(serial) {
      try {
        await refreshCustomSkinReservedIds(true);
        if (serial !== _skinModeTransitionSerial || !_skinModeEnabled) return;
        var migrated = migrateCustomSkinsToSafeIds(_customSkins);
        _customSkins = migrated.skins;
        var templatesChanged = applyCustomSkinNativeTemplates(_customSkins);
        if (migrated.changed || templatesChanged) saveCustomSkins();
        if (serial !== _skinModeTransitionSerial || !_skinModeEnabled) return;
        applyCustomSkinsToCoreNet();
        // The initial toggle already scheduled the mode-on reload.  Only
        // schedule another one when the asynchronous catalog refresh really
        // changed local mappings; the unconditional call caused a visible
        // duplicate refresh on every enable.
        if (migrated.changed || templatesChanged) scheduleCustomSkinReload();
        notifyCustomSkinsChanged();
      } catch(e) {
        logWarn('SkinMode', 'local skin catalog refresh failed', { error:e.message });
      }
    })(transitionSerial);
  } else {
    // Turning the mode off removes runtime routes and account bindings, but
    // deliberately leaves local SWF files and the registration JSON intact.
    // Cancel a pending cache-preserving reload left by an earlier enable click;
    // the mode-off path below owns the next reload and clears all skin caches.
    if (_customSkinReloadTimer) {
      clearTimeout(_customSkinReloadTimer);
      _customSkinReloadTimer = null;
    }
    try { applyCustomSkinsToCoreNet([], _customSkinRevision, new Set()); } catch(e) {}
    // Only the skin mapping is cleared here.  Do not call
    // doClearCacheAndReload(): that wipes Smart Cache and all game storage,
    // which is unrelated to disabling local skins and makes this transition
    // noticeably slower than enabling it.
    try {
      var reset = trackCustomSkinAssignmentReset([], clearCustomSkinAssignmentSharedObjects(), true);
      if (reset.deleted || reset.updated || reset.pendingAfterFlashExit) {
        logInfo('SkinMode', 'mode-off binding reset queued', reset);
      }
    } catch(e) { logWarn('SkinMode', 'binding cache clear failed', { error:e.message }); }
    try { scheduleCustomSkinReload(0); }
    catch(e) { logWarn('SkinMode', 'mode-off skin-only reload dispatch failed', { error:e && e.message ? e.message : String(e) }); }
    return Object.assign({ ok:true }, skinModePayload());
  }
  return Object.assign({ ok:true }, skinModePayload());
}

const CUSTOM_SKIN_FILE_TYPES = [
  'normal','fight','physical','special','property','skill','primary','dictionary','icon','demo',
];
const customSkinFolderPackage = createCustomSkinFolderPackage({
  fs:fs,
  path:path,
  parseId:parseCustomSkinId,
  fileTypes:CUSTOM_SKIN_FILE_TYPES,
});
const customSkinConfigPackage = createCustomSkinConfigPackage({
  fs:fs,
  path:path,
  parseId:parseCustomSkinId,
  fileTypes:CUSTOM_SKIN_FILE_TYPES,
  managedRoot:function() { return CUSTOM_SKINS_DIR; },
});
const customSkinScanIdentity = createCustomSkinScanIdentity({
  fs:fs,
  path:path,
  crypto:crypto,
  parseId:parseCustomSkinId,
  getManagedRoot:function() { return CUSTOM_SKINS_DIR; },
  getDownloadRoot:function() { return customSkinDownloadDirectory(); },
  getCurrentSkins:function() { return _customSkins; },
  resolveStoredSource:resolveCustomSkinSourceForRuntime,
});
var _customSkinFolderImportRunning = false;
const CUSTOM_SKIN_ID_MIN = 1;
const CUSTOM_SKIN_ID_MAX = 2147483647;
// Launcher-managed automatic downloads start at 70091 only when the local
// skin registry is empty. Once any local skin exists, automatic allocation
// continues from the current local maximum + 1. Manual renumbering accepts
// any positive game id that passes parsing.
const CUSTOM_SKIN_SAFE_ID_MIN = 70091;
const CUSTOM_SKIN_RESERVED_CONFIG_PATHS = [
  '/config/binaryData/45_com.taomee.seer2.app.config.PetConfig__dictionaryXmlClass.xml',
  '/config/binaryData/64_com.taomee.seer2.app.config.PetConfig__petXmlClass.xml',
  '/config/binaryData/501_com.taomee.seer2.app.config.PetSkinConfig__xmlClass.xml',
  '/config/binaryData/3_com.taomee.seer2.app.arena.util.HitInfoConfig__hitData.xml',
];
let _customSkinReservedIds = new Set();
let _customSkinDefinitionIds = new Set();
let _customSkinNativeByName = new Map();
let _customSkinCatalogRefreshPromise = null;
let _customSkinCatalogRefreshedAt = 0;
let _customSkinDownloadRunning = false;
let _customSkinDownloadTaskSerial = 0;
let _customSkinDownloadTask = null;
let _customSkinStateEventSerial = 0;
const CUSTOM_SKIN_TYPE_LABELS = {
  normal:'地图模型',
  fight:'战斗模型',
  physical:'物攻特效',
  special:'特攻特效',
  property:'属性特效',
  skill:'独立技能特效',
  primary:'首发门模型',
  dictionary:'图鉴模型',
  icon:'静态头像',
  demo:'展示模型',
};

function parseCustomSkinId(value) {
  var text = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(text)) return 0;
  var id = Number(text);
  if (!Number.isSafeInteger(id) || id < CUSTOM_SKIN_ID_MIN || id > CUSTOM_SKIN_ID_MAX) return 0;
  return id;
}

function normalizeCustomSkinSourceForStorage(file) {
  try {
    if (file == null) return '';
    var source = String(file).trim();
    if (!source || /^https?:\/\//i.test(source)) return source;
    if (source.indexOf('.\\') === 0 || source.indexOf('./') === 0) {
      return '.\\' + source.slice(2).replace(/[\/\\]+/g, '\\');
    }
    if (CUSTOM_SKINS_DIR) {
      var base = path.resolve(CUSTOM_SKINS_DIR);
      var absolute = path.resolve(source);
      var relative = path.relative(base, absolute);
      if (relative && relative !== '..' && relative.indexOf('..' + path.sep) !== 0 && !path.isAbsolute(relative)) {
        return '.\\' + relative.replace(/[\/\\]+/g, '\\');
      }
    }
    return source.replace(/[\/\\]+/g, path.sep);
  } catch(e) {
    return String(file || '').trim();
  }
}

function resolveCustomSkinSourceForRuntime(file) {
  var source = String(file || '').trim();
  if (!source || /^https?:\/\//i.test(source)) return source;
  if ((source.indexOf('.\\') === 0 || source.indexOf('./') === 0) && CUSTOM_SKINS_DIR) {
    return path.resolve(CUSTOM_SKINS_DIR, source.slice(2).replace(/[\/\\]+/g, path.sep));
  }
  return path.resolve(source);
}

function normalizeCustomSkinBattleActions(value) {
  return ultimateCapability.normalizeUltimateActions(value);
}

// Battle-variant manifests are generated inside the managed download root. A
// previous download-directory setting can leave an absolute path in
// custom-skins.json that no longer exists. Re-home it only when the current
// managed source already has a usable fight.swf and its canonical manifest;
// preview-only/shared registrations without a managed fight are left alone.
function normalizeCustomSkinBattleVariantManifestReference(value, sourceId) {
  var reference = String(value == null ? '' : value).trim();
  if (!reference || /^https?:\/\//i.test(reference)) return reference;
  var id = parseCustomSkinId(sourceId);
  if (!id) return reference;
  var itemRoot;
  try { itemRoot = path.join(customSkinDownloadDirectory(), String(id)); }
  catch(_) { return reference; }
  var target = path.join(itemRoot, 'battle-variants.json');
  var fight = path.join(itemRoot, 'fight.swf');
  var fightAvailable = false;
  var manifestAvailable = false;
  try {
    var fightStat = fs.statSync(fight);
    fightAvailable = fightStat.isFile() && Number(fightStat.size) > 0;
  } catch(_) {}
  try {
    var manifestStat = fs.statSync(target);
    manifestAvailable = manifestStat.isFile() && Number(manifestStat.size) > 0;
  } catch(_) {}
  if (fightAvailable && manifestAvailable) return target;
  // Do not invent a route for preview-only entries. If a managed fight exists
  // but its manifest disappeared, clear the stale pointer so the UI cannot
  // advertise a non-existent battle variant.
  if (fightAvailable) return '';
  return reference;
}

function normalizeCustomSkinEntryForStorage(raw) {
  raw = raw || {};
  var files = {};
  var inputFiles = raw.files || {};
  CUSTOM_SKIN_FILE_TYPES.forEach(function(type) {
    files[type] = normalizeCustomSkinSourceForStorage(inputFiles[type]);
  });
  var skinId = parseCustomSkinId(raw.skinId || raw.targetPetId);
  var sourceId = parseCustomSkinId(raw.sourceId);
  var nativeTemplateId = parseCustomSkinId(raw.nativeTemplateId);
  var battleVariantManifest = normalizeCustomSkinBattleVariantManifestReference(
    raw.battleVariantManifest, sourceId);
  return {
    id: String(raw.id || ('skin-' + Date.now() + '-' + Math.random().toString(16).slice(2))).slice(0, 120),
    enabled: raw.enabled !== false,
    skinId: skinId,
    sourceId: sourceId,
    nativeTemplateId: nativeTemplateId,
    name: String(raw.name || '').trim().slice(0, 80),
    autoId: raw.autoId === true,
    officialIdOverride: raw.officialIdOverride === true,
    presentationMode: raw.presentationMode === 'legacy' ? 'legacy' : 'full-idle',
    ultimateAction: String(raw.ultimateAction || '').trim().slice(0, 40),
    ultimateSkillId: parseCustomSkinId(raw.ultimateSkillId),
    battleActions: normalizeCustomSkinBattleActions(raw.battleActions),
    previewAdapter: raw.previewAdapter === 'uclient' ? 'uclient' : (raw.previewAdapter === 'swf' ? 'swf' : ''),
    uClientPackageVersion: String(raw.uClientPackageVersion || '').trim().slice(0, 40),
    uClientAssetPath: String(raw.uClientAssetPath || '').trim().slice(0, 240),
    uClientActions: normalizeUClientActions(raw.uClientActions),
    uClientDedicatedUltimate: raw.uClientDedicatedUltimate === true,
    uClientFollowAvailable: raw.uClientFollowAvailable === true,
    uClientIconAvailable: raw.uClientIconAvailable === true,
    uClientExternalSkillAvailable: raw.uClientExternalSkillAvailable === true,
    selectedBattleVariant:raw.selectedBattleVariant === 'uclient-self-contained'
      ? 'uclient-self-contained' : (raw.selectedBattleVariant === 'legacy-swf' ? 'legacy-swf' : ''),
    battleVariantReason:String(raw.battleVariantReason || '').trim().slice(0, 160),
    battleVariantManifest:battleVariantManifest.slice(0, 320),
    legacyFightPlayable:raw.legacyFightPlayable === true,
    legacyStaticPoseWrapper:raw.legacyStaticPoseWrapper === true,
    basePetId: parseCustomSkinId(raw.basePetId),
    officialSkinId: parseCustomSkinId(raw.officialSkinId),
    sourceKind: raw.sourceKind === 'official-skin' ? 'official-skin' : 'pet',
    files: files,
    appearActions: Array.isArray(raw.appearActions) ? raw.appearActions.slice() : [],
    transformActions: Array.isArray(raw.transformActions) ? raw.transformActions.slice() : [],
    availableLabels: Array.isArray(raw.availableLabels) ? raw.availableLabels.slice() : [],
    battlePlacement: raw.battlePlacement || null,
    battleScale: typeof raw.battleScale === 'number' ? raw.battleScale : (raw.battlePlacement && raw.battlePlacement.scale ? Number(raw.battlePlacement.scale) : null),
  };
}

function findExistingCustomSkin(skins, identifier) {
  if (!Array.isArray(skins) || !identifier) return null;
  var isPrimitive = typeof identifier === 'number' || typeof identifier === 'string';
  var rawId = isPrimitive ? parseCustomSkinId(identifier) : 0;
  var skinId = rawId || parseCustomSkinId(identifier.skinId);
  var sourceId = rawId || parseCustomSkinId(identifier.sourceId || identifier.id);
  var officialSkinId = parseCustomSkinId(identifier.officialSkinId || identifier.catalogueId);

  for (var i = 0; i < skins.length; i++) {
    var entry = skins[i];
    if (!entry) continue;
    var eSkinId = parseCustomSkinId(entry.skinId);
    var eSourceId = parseCustomSkinId(entry.sourceId);
    var eOfficialSkinId = parseCustomSkinId(entry.officialSkinId);

    // 1. Direct skinId match
    if (skinId && eSkinId && eSkinId === skinId) return entry;

    // 2. Direct sourceId match
    if (sourceId && eSourceId && eSourceId === sourceId) return entry;

    // 3. sourceId matches existing skinId (e.g. skinId was assigned to petId)
    if (sourceId && eSkinId && eSkinId === sourceId) return entry;

    // 4. Official skin ID matching:
    if (sourceId && eOfficialSkinId && eOfficialSkinId === sourceId) return entry;
    if (sourceId >= 1400000 && eOfficialSkinId && (sourceId - 1400000) === eOfficialSkinId) return entry;
    if (eSourceId >= 1400000 && officialSkinId && (eSourceId - 1400000) === officialSkinId) return entry;
    if (officialSkinId && eOfficialSkinId && eOfficialSkinId === officialSkinId) return entry;
    if (officialSkinId && eSourceId && eSourceId === officialSkinId) return entry;
  }
  return null;
}

function addCustomSkinReservedIdsFromXml(target, xml) {
  collectOfficialIdentityIdsFromXml(xml).forEach(function(id) { target.add(id); });
}

function addCustomSkinDefinitionIdsFromXml(target, xml) {
  var text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml || '');
  var re = /<Monster\b[^>]*\bID\s*=\s*["'](\d+)["'][^>]*>/gi;
  var match;
  while ((match = re.exec(text)) !== null) {
    var id = parseCustomSkinId(match[1]);
    if (id) target.add(id);
  }
}

function normalizeCustomSkinNameKey(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function addCustomSkinNativeNamesFromXml(target, xml) {
  var text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml || '');
  var re = /<Monster\b[^>]*\bID\s*=\s*["'](\d+)["'][^>]*\bDefName\s*=\s*["']([^"']+)["'][^>]*>/gi;
  var match;
  while ((match = re.exec(text)) !== null) {
    var id = parseCustomSkinId(match[1]);
    var key = normalizeCustomSkinNameKey(match[2]);
    if (id && key && !target.has(key)) target.set(key, id);
  }
}

function loadLocalCustomSkinReservedIds() {
  var found = new Set();
  var definitions = new Set();
  var nativeByName = new Map();
  var candidates = [];
  if (LOCAL_SWF_DIR) {
    CUSTOM_SKIN_RESERVED_CONFIG_PATHS.forEach(function(relative) {
      candidates.push({
        relative:relative,
        file:path.join(LOCAL_SWF_DIR, relative.replace(/^\/+/, '').replace(/\//g, path.sep)),
      });
    });
  }
  candidates.forEach(function(item) {
    try {
      if (!fs.existsSync(item.file)) return;
      var buffer = fs.readFileSync(item.file);
      addCustomSkinReservedIdsFromXml(found, buffer);
      if (/\/(?:45|64)_/i.test(item.relative)) addCustomSkinDefinitionIdsFromXml(definitions, buffer);
      if (/\/64_/i.test(item.relative)) addCustomSkinNativeNamesFromXml(nativeByName, buffer);
    } catch(e) {}
  });
  _replaceRules.filter(function(rule) {
    if (!rule || rule.enabled === false || /^https?:\/\//i.test(String(rule.file || ''))) return false;
    var url = String(rule.url || '').toLowerCase();
    return CUSTOM_SKIN_RESERVED_CONFIG_PATHS.some(function(relative) {
      return url.indexOf(relative.toLowerCase()) >= 0;
    });
  }).forEach(function(rule) {
    try {
      var file = normalizeReplaceFileForStorage(rule.file);
      var absolute = file.indexOf('.\\') === 0 && LOCAL_SWF_DIR
        ? path.resolve(LOCAL_SWF_DIR, file.slice(2))
        : path.resolve(file);
      if (fs.existsSync(absolute)) {
        var buffer = fs.readFileSync(absolute);
        addCustomSkinReservedIdsFromXml(found, buffer);
        if (/\/(?:45|64)_/i.test(String(rule.url || '').replace(/\\/g, '/'))) {
          addCustomSkinDefinitionIdsFromXml(definitions, buffer);
        }
        if (/\/64_/i.test(String(rule.url || '').replace(/\\/g, '/'))) {
          addCustomSkinNativeNamesFromXml(nativeByName, buffer);
        }
      }
    } catch(e) {}
  });
  _customSkinReservedIds = found;
  _customSkinDefinitionIds = definitions;
  _customSkinNativeByName = nativeByName;
  return found;
}

function fetchCustomSkinCatalogText(url, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var client = /^https:/i.test(String(url || '')) ? https : http;
    var req = client.get(url, function(res) {
      if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
        if (done) return;
        done = true;
        res.resume();
        var redirectUrl;
        try {
          redirectUrl = new URL(res.headers.location, url).toString();
        } catch(e) {
          reject(e);
          return;
        }
        fetchCustomSkinCatalogText(redirectUrl, timeoutMs).then(resolve, reject);
        return;
      }
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        if (done) return;
        done = true;
        if ((res.statusCode || 0) >= 400) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', function(err) {
        if (done) return;
        done = true;
        reject(err);
      });
    });
    req.setTimeout(timeoutMs || 5000, function() {
      if (done) return;
      done = true;
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', function(err) {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function refreshCustomSkinReservedIds(force) {
  if (!force && _customSkinCatalogRefreshedAt &&
      Date.now() - _customSkinCatalogRefreshedAt < 5 * 60 * 1000) {
    return Promise.resolve(_customSkinReservedIds);
  }
  if (_customSkinCatalogRefreshPromise) return _customSkinCatalogRefreshPromise;
  _customSkinCatalogRefreshPromise = (async function() {
    var found = new Set(loadLocalCustomSkinReservedIds());
    var definitions = new Set(_customSkinDefinitionIds);
    var nativeByName = new Map(_customSkinNativeByName);
    var server = getSelectedServer();
    var root = String((server && server.rootUrl) || BLOOM_ROOT_URL || '').replace(/\/+$/, '');
    if (root) {
      await Promise.all(CUSTOM_SKIN_RESERVED_CONFIG_PATHS.map(async function(relative) {
        var source = root + relative;
        var matchingRule = _replaceRules.find(function(rule) {
          return rule && rule.enabled !== false &&
            String(rule.url || '').toLowerCase().indexOf(relative.toLowerCase()) >= 0;
        });
        if (matchingRule && /^https?:\/\//i.test(String(matchingRule.file || ''))) {
          source = String(matchingRule.file).trim();
        } else if (matchingRule && String(matchingRule.file || '').trim()) {
          return;
        }
        try {
          var xml = await fetchCustomSkinCatalogText(source, 5000);
          addCustomSkinReservedIdsFromXml(found, xml);
          if (/\/(?:45|64)_/i.test(relative)) addCustomSkinDefinitionIdsFromXml(definitions, xml);
          if (/\/64_/i.test(relative)) addCustomSkinNativeNamesFromXml(nativeByName, xml);
        } catch(e) {
          logWarn('CustomSkin', 'catalog refresh skipped', { path:relative, error:e.message });
        }
      }));
    }
    _customSkinReservedIds = found;
    _customSkinDefinitionIds = definitions;
    _customSkinNativeByName = nativeByName;
    _customSkinCatalogRefreshedAt = Date.now();
    return found;
  })();
  _customSkinCatalogRefreshPromise.then(function() {
    _customSkinCatalogRefreshPromise = null;
  }, function() {
    _customSkinCatalogRefreshPromise = null;
  });
  return _customSkinCatalogRefreshPromise;
}

async function customSkinOfficialIdentityIds() {
  var result = new Set(_customSkinReservedIds);
  var catalog = _seer1OfficialPetCatalogCache;
  if (!catalog) {
    try { catalog = await officialCatalogStore.read(); } catch(_) {}
  }
  (catalog && Array.isArray(catalog.items) ? catalog.items : []).forEach(function(item) {
    var petId = parseCustomSkinId(item && item.id);
    if (petId) result.add(petId);
    (Array.isArray(item && item.extraSkins) ? item.extraSkins : []).forEach(function(skin) {
      var skinId = parseCustomSkinId(skin && (skin.resourceId || skin.id));
      if (skinId) result.add(skinId);
    });
  });
  return result;
}

function pruneNativeDefinitionIdsFromIssuedSet() {
  var changed = false;
  _customSkinDefinitionIds.forEach(function(id) {
    if (_customSkinIssuedIds.delete(parseCustomSkinId(id))) changed = true;
  });
  return changed;
}

function applyCustomSkinNativeTemplates(entries) {
  var changed = false;
  (Array.isArray(entries) ? entries : []).forEach(function(entry) {
    if (parseCustomSkinId(entry && entry.nativeTemplateId) !== 0) {
      entry.nativeTemplateId = 0;
      changed = true;
    }
  });
  return changed;
}

function nextAutomaticCustomSkinIdStart(entries, issuedIds) {
  // Automatic ids are derived only from the current local registry. Historical
  // issuedIds and official/native catalog ids are not local occupancy and must
  // never push a new download into the 70091+ range. An empty registry keeps
  // the documented 70091 default; otherwise continue after the local maximum.
  var list = Array.isArray(entries) ? entries : _customSkins;
  var hasLocal = false;
  var maximum = 0;
  list.forEach(function(entry) {
    var id = parseCustomSkinId(entry && entry.skinId);
    if (!id) return;
    hasLocal = true;
    if (id > maximum) maximum = id;
  });
  return hasLocal ? maximum + 1 : CUSTOM_SKIN_SAFE_ID_MIN;
}

function reserveNextCustomSkinId(used, requestedStart) {
  var start = Number(String(requestedStart == null ? CUSTOM_SKIN_SAFE_ID_MIN : requestedStart).trim());
  if (!Number.isSafeInteger(start)) start = CUSTOM_SKIN_SAFE_ID_MIN;
  if (start < CUSTOM_SKIN_ID_MIN) start = CUSTOM_SKIN_ID_MIN;
  if (start > CUSTOM_SKIN_ID_MAX) throw new Error('自定义皮肤自动序号已达到上限 ' + CUSTOM_SKIN_ID_MAX);
  for (var id = start; id <= CUSTOM_SKIN_ID_MAX; id++) {
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error('自定义皮肤自动序号区间 ' + CUSTOM_SKIN_ID_MIN + '-' + CUSTOM_SKIN_ID_MAX + ' 已用完');
}

function suggestedAutomaticCustomSkinId() {
  // Automatic downloads follow the local skin sequence, independently of
  // native game ids, historical issued ids, and deleted registrations.
  var occupied = new Set();
  _customSkins.forEach(function(entry) { occupied.add(parseCustomSkinId(entry && entry.skinId)); });
  try {
    return reserveNextCustomSkinId(
      occupied, nextAutomaticCustomSkinIdStart(_customSkins));
  } catch(_) {
    return 0;
  }
}

function loadCustomSkins() {
  _customSkins = [];
  _customSkinRevision = 0;
  _customSkinIssuedIds = new Set();
  var raw = null;
  try {
    if (!CUSTOM_SKINS_FILE || !fs.existsSync(CUSTOM_SKINS_FILE)) {
      installLoadedCustomSkinProjection(null);
      return;
    }
    raw = JSON.parse(fs.readFileSync(CUSTOM_SKINS_FILE, 'utf8'));
    var list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.skins) ? raw.skins : []);
    _customSkins = list.map(normalizeCustomSkinEntryForStorage).filter(function(entry) {
      return entry.skinId > 0;
    });
    _customSkinRevision = raw && parseInt(raw.revision, 10) > 0 ? parseInt(raw.revision, 10) : 1;
    // issuedIds is historical metadata only.  Rebuild the live set from the
    // current registry so removed ids are immediately reusable.
    _customSkins.filter(function(entry) {
      return entry.officialIdOverride !== true;
    }).map(function(entry) { return entry.skinId; }).forEach(function(value) {
      var id = parseCustomSkinId(value);
      if (id) _customSkinIssuedIds.add(id);
    });
    _customSkins.filter(function(entry) { return entry.officialIdOverride === true; }).forEach(function(entry) {
      _customSkinIssuedIds.delete(parseCustomSkinId(entry.skinId));
    });
  } catch(e) {
    console.warn('[CustomSkin] load failed:', e.message);
  }
  installLoadedCustomSkinProjection(raw);
  ensureCustomSkinActionMetadata().catch(function(err) {
    logWarn('CustomSkin', 'background action metadata discovery failed', { error:err.message });
  });
}

function saveCustomSkins(candidate, revision, issuedIds, projection) {
  try {
    if (CUSTOM_SKINS_DIR && !fs.existsSync(CUSTOM_SKINS_DIR)) {
      fs.mkdirSync(CUSTOM_SKINS_DIR, { recursive:true });
    }
    var manifestRevision = revision == null ? _customSkinRevision : revision;
    var committedProjection = projection || carryCustomSkinProjection(candidate || _customSkins, manifestRevision);
    var manifest = JSON.stringify({
      version:4,
      revision:manifestRevision,
      updatedAt:new Date().toISOString(),
      issuedIds:Array.from(issuedIds || _customSkinIssuedIds).sort(function(a,b) { return a - b; }),
      skins:candidate || _customSkins,
      projection:committedProjection,
    }, null, 2);
    var tmp = CUSTOM_SKINS_FILE + '.tmp-' + process.pid + '-' + Date.now();
    var backup = CUSTOM_SKINS_FILE + '.bak';
    var fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, manifest, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
    if (fs.existsSync(CUSTOM_SKINS_FILE)) fs.renameSync(CUSTOM_SKINS_FILE, backup);
    try {
      fs.renameSync(tmp, CUSTOM_SKINS_FILE);
    } catch(e) {
      if (fs.existsSync(backup) && !fs.existsSync(CUSTOM_SKINS_FILE)) fs.renameSync(backup, CUSTOM_SKINS_FILE);
      throw e;
    }
    invalidateSkinThumbnailCache();
    return { ok:true };
  } catch(e) {
    console.warn('[CustomSkin] save failed:', e.message);
    return { ok:false, error:e.message };
  }
}

function restoreCustomSkinsManifestBackup(hadPrevious) {
  try {
    var backup = CUSTOM_SKINS_FILE + '.bak';
    if (hadPrevious === false) {
      if (fs.existsSync(CUSTOM_SKINS_FILE)) fs.unlinkSync(CUSTOM_SKINS_FILE);
      invalidateSkinThumbnailCache();
      return { ok:true };
    }
    if (!fs.existsSync(backup)) return { ok:false,error:'皮肤清单备份不存在' };
    var failed = CUSTOM_SKINS_FILE + '.failed-' + process.pid + '-' + Date.now();
    if (fs.existsSync(CUSTOM_SKINS_FILE)) fs.renameSync(CUSTOM_SKINS_FILE,failed);
    try {
      fs.renameSync(backup,CUSTOM_SKINS_FILE);
    } catch(error) {
      if (fs.existsSync(failed) && !fs.existsSync(CUSTOM_SKINS_FILE)) {
        fs.renameSync(failed,CUSTOM_SKINS_FILE);
      }
      throw error;
    }
    try { if (fs.existsSync(failed)) fs.unlinkSync(failed); } catch(_) {}
    invalidateSkinThumbnailCache();
    return { ok:true };
  } catch(error) {
    return { ok:false,error:error.message };
  }
}

function applyCustomSkinsToCoreNet(entries, revision, issuedIds) {
  // Skin mode is an explicit runtime gate.  Registrations remain on disk so
  // turning the mode back on is instant, but the game must see an empty
  // snapshot while the switch is off.
  if (!_skinModeEnabled && entries !== undefined) {
    coreNet.setCustomSkins([], {
      revision:revision == null ? _customSkinRevision : revision,
      issuedIds:[],
    });
    return;
  }
  if (!_skinModeEnabled && entries === undefined) {
    coreNet.setCustomSkins([], { revision:_customSkinRevision, issuedIds:[] });
    return;
  }
  var runtime = (entries || _customSkins).map(function(entry) {
    var copy = JSON.parse(JSON.stringify(entry));
    // The persisted flag records the user's original intent, but an id can
    // later be moved into an actually unused game slot.  Only keep official
    // override semantics when the current game XML really reserves that id;
    // otherwise the dictionary must be allowed to use the local icon/model.
    var runtimeSkinId = parseCustomSkinId(copy.skinId);
    if (copy.officialIdOverride === true && runtimeSkinId > 0 &&
        _customSkinDefinitionIds.size > 0 && !_customSkinDefinitionIds.has(runtimeSkinId)) {
      copy.officialIdOverride = false;
    }
    CUSTOM_SKIN_FILE_TYPES.forEach(function(type) {
      copy.files[type] = resolveCustomSkinSourceForRuntime(copy.files[type]);
    });
    delete copy.nativeFightUrl;
    return copy;
  });
  coreNet.setCustomSkins(runtime, {
    revision:revision == null ? _customSkinRevision : revision,
    issuedIds:Array.from(issuedIds || _customSkinIssuedIds),
  });
}

function customSkinUiEntries(entries, options) {
  options = options || {};
  var useSnapshotCache = !entries || entries === _customSkins;
  if (useSnapshotCache && options.bypassCommitted !== true &&
      _customSkinCommittedProjection.revision === _customSkinRevision &&
      Array.isArray(_customSkinCommittedProjection.uiEntries)) {
    return _customSkinCommittedProjection.uiEntries;
  }
  var projectionCache = useSnapshotCache ? currentCustomSkinSnapshotProjectionCache() : null;
  if (projectionCache && projectionCache.uiEntries && options.scanFileSystem !== true) {
    return projectionCache.uiEntries;
  }
  var previousUiById = new Map((_customSkinCommittedProjection.uiEntries || []).map(function(item) {
    return [parseCustomSkinId(item && item.skinId), item];
  }).filter(function(pair) { return pair[0] > 0; }));
  var projected = (entries || _customSkins).map(function(entry) {
    var copy = JSON.parse(JSON.stringify(entry));
    var files = copy.files || {};
    var previousUi = previousUiById.get(parseCustomSkinId(copy.skinId)) || {};
    var previousResourceInfo = previousUi.resourceInfo || {};
    var resourceInfo = {};
    var uniqueLocalFiles = new Set();
    var totalBytes = 0;
    var workerBytes = options.registeredFileBytes &&
      options.registeredFileBytes[String(parseCustomSkinId(copy.skinId))] || {};
    CUSTOM_SKIN_FILE_TYPES.forEach(function(type) {
      var source = String(files[type] || '').trim();
      var previousResource = previousResourceInfo[type] || {};
      var hasWorkerBytes = Object.prototype.hasOwnProperty.call(workerBytes, type);
      var bytes = hasWorkerBytes ? Math.max(0, Number(workerBytes[type]) || 0) :
        (source && source === previousResource.source
          ? Math.max(0, Number(previousResource.bytes) || 0) : 0);
      var localKey = '';
      if (source && !/^https?:\/\//i.test(source)) {
        try { localKey = path.resolve(resolveCustomSkinSourceForRuntime(source)).toLowerCase(); }
        catch(_) {}
      }
      if (options.scanFileSystem === true && source && !/^https?:\/\//i.test(source)) {
        try {
          var absolute = resolveCustomSkinSourceForRuntime(source);
          var stat = fs.statSync(absolute);
          if (stat.isFile()) {
            bytes = Number(stat.size) || 0;
          }
        } catch(e) {}
      }
      // Converted U-client files can be committed before the background
      // projection worker has published byte counts. Never expose a false 0B
      // value when the registered local file is already present.
      if (bytes <= 0 && source && !/^https?:\/\//i.test(source)) {
        try {
          var fallbackAbsolute = resolveCustomSkinSourceForRuntime(source);
          var fallbackStat = fs.statSync(fallbackAbsolute);
          if (fallbackStat.isFile()) bytes = Number(fallbackStat.size) || 0;
        } catch(e) {}
      }
      if (bytes > 0 && localKey && !uniqueLocalFiles.has(localKey)) {
        uniqueLocalFiles.add(localKey);
        totalBytes += bytes;
      }
      resourceInfo[type] = {
        mode:source ? 'direct' : 'missing',
        source:source,
        bytes:bytes,
        derivedFrom:'',
      };
    });
    var fight = String(files.fight || '').trim();
    var normal = String(files.normal || '').trim();
    ['primary','dictionary','demo'].forEach(function(type) {
      if (resourceInfo[type].mode !== 'missing') return;
      if (fight && copy.presentationMode !== 'legacy') {
        resourceInfo[type] = { mode:'derived', source:fight, bytes:resourceInfo.fight.bytes, derivedFrom:'fight' };
      } else if (normal) {
        resourceInfo[type] = { mode:'derived', source:normal, bytes:resourceInfo.normal.bytes, derivedFrom:'normal' };
      }
    });
    if (resourceInfo.icon.mode === 'missing' && fight && copy.presentationMode !== 'legacy') {
      resourceInfo.icon = { mode:'derived', source:fight, bytes:resourceInfo.fight.bytes, derivedFrom:'fight' };
    }
    var actions = normalizeCustomSkinBattleActions(copy.battleActions);
    var hasSkill = !!String(files.skill || '').trim();
    var hasDedicatedUltimate = actions.length > 0 || !!String(copy.ultimateAction || '').trim() ||
      copy.uClientDedicatedUltimate === true;
    var sourcePetId = parseCustomSkinId(copy.basePetId) || parseCustomSkinId(copy.sourceId);
    // Preserve real skin identity independently of the (possibly renumbered)
    // runtime target slot used by the launcher.
    copy.identity = deriveCustomSkinIdentity(copy);
    copy.resourceInfo = resourceInfo;
    copy.totalBytes = totalBytes;
    copy.sizeClass = totalBytes >= 30 * 1024 * 1024 ? 'ultra'
      : totalBytes >= 10 * 1024 * 1024 ? 'large'
      : totalBytes >= 3 * 1024 * 1024 ? 'medium' : 'small';
    copy.appearActions = Array.isArray(copy.appearActions) ? copy.appearActions.slice() : [];
    copy.transformActions = Array.isArray(copy.transformActions) ? copy.transformActions.slice() : [];
    copy.availableLabels = Array.isArray(copy.availableLabels) ? copy.availableLabels.slice() : [];
    copy.capabilities = {
      independentSkill:hasSkill,
      dedicatedUltimate:hasDedicatedUltimate,
      standardOnly:!hasSkill && !hasDedicatedUltimate,
      battleActions:actions,
      uClientActions:normalizeUClientActions(copy.uClientActions),
      appearActions:copy.appearActions,
      transformActions:copy.transformActions,
      availableLabels:copy.availableLabels,
    };
    copy.era = sourcePetId <= 1000 ? 'early'
      : sourcePetId <= 2500 ? 'middle'
      : sourcePetId <= 4000 ? 'late' : 'current';
    return copy;
  });
  if (projectionCache && options.scanFileSystem !== true) projectionCache.uiEntries = projected;
  return projected;
}

function forEachCustomSkinRenderer(callback) {
  var seen = new Set();
  var windows = [overlayWins && overlayWins['skin']].concat(Object.keys(skinToolWins || {}).map(function(key) {
    return skinToolWins[key];
  }));
  windows.forEach(function(win) {
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
    var id = win.webContents.id;
    if (seen.has(id)) return;
    seen.add(id);
    callback(win.webContents);
  });
}

function notifyCustomSkinsChanged() {
  return notifyCustomSkinStateChanged();
}

function validateCustomSkins(skins) {
  if (!Array.isArray(skins)) return { ok:false, error:'配置必须是数组' };
  var normalized = skins.map(normalizeCustomSkinEntryForStorage);
  var seen = new Set();
  var warnings = [];
  for (var i = 0; i < normalized.length; i++) {
    var entry = normalized[i];
    if (!entry.skinId) return { ok:false, error:'第 ' + (i + 1) + ' 项缺少有效的皮肤资源序号' };
    if (_customSkinReservedIds.has(entry.skinId) && entry.officialIdOverride !== true &&
        entry.autoId !== true && entry.previewAdapter !== 'uclient') {
      return { ok:false, error:'序号 ' + entry.skinId + ' 已被真实精灵或已有皮肤占用，不能作为自定义皮肤序号' };
    }
    if (seen.has(entry.skinId)) {
      return { ok:false, error:'皮肤资源序号 ' + entry.skinId + ' 重复' };
    }
    seen.add(entry.skinId);
    var sourceCount = 0;
    CUSTOM_SKIN_FILE_TYPES.forEach(function(type) {
      var source = String(entry.files[type] || '').trim();
      if (!source) return;
      sourceCount++;
      if (/^https?:\/\//i.test(source)) return;
      var absolute = resolveCustomSkinSourceForRuntime(source);
      if (!fs.existsSync(absolute)) {
        warnings.push('序号 ' + entry.skinId + ' 的' + CUSTOM_SKIN_TYPE_LABELS[type] + '不存在：' + source);
      }
    });
    if (entry.enabled && sourceCount === 0) {
      warnings.push('序号 ' + entry.skinId + ' 没有可用 SWF');
    }
  }
  return { ok:true, skins:normalized, warnings:warnings };
}

function persistAndApplyCustomSkins(skins, options) {
  options = options || {};
  var checked = validateCustomSkins(skins);
  if (!checked.ok) return checked;
  var previous = _customSkins;
  var previousRevision = _customSkinRevision;
  var previousIssued = _customSkinIssuedIds;
  var nextRevision = previousRevision + 1;
  // Recompute from the candidate registry.  Keeping the previous set here
  // was the source of the 70092-after-removal bug.
  var nextIssued = new Set();
  checked.skins.forEach(function(entry) {
    if (entry.officialIdOverride === true) nextIssued.delete(entry.skinId);
    else nextIssued.add(entry.skinId);
  });
  var manifestExisted = !!(CUSTOM_SKINS_FILE && fs.existsSync(CUSTOM_SKINS_FILE));
  var nextProjection = carryCustomSkinProjection(checked.skins, nextRevision);
  var saved = saveCustomSkins(checked.skins, nextRevision, nextIssued, nextProjection);
  if (!saved.ok) return saved;
  try { applyCustomSkinsToCoreNet(checked.skins, nextRevision, nextIssued); }
  catch(e) {
    var restored = restoreCustomSkinsManifestBackup(manifestExisted);
    try { applyCustomSkinsToCoreNet(previous,previousRevision,previousIssued); } catch(_) {}
    return { ok:false, error:'应用到网络层失败：' + e.message +
      (restored.ok ? '' : '；旧清单恢复失败：' + restored.error) };
  }
  _customSkins = checked.skins;
  _customSkinRevision = nextRevision;
  _customSkinIssuedIds = nextIssued;
  _customSkinCommittedProjection = nextProjection;
  invalidateCustomSkinSnapshotProjection();
  var assignmentChangedIds = customSkinAssignmentStateChanged(previous, checked.skins);
  var assignmentReset = null;
  if (assignmentChangedIds.length) {
    assignmentReset = clearCustomSkinAssignmentSharedObjects(assignmentChangedIds);
    assignmentReset = trackCustomSkinAssignmentReset(assignmentChangedIds, assignmentReset, false);
  }
  if (options.notify !== false) notifyCustomSkinsChanged();
  if (options.reload !== false) scheduleCustomSkinReload();
  return {
    ok:true,
    skinModeEnabled:_skinModeEnabled === true,
    revision:_customSkinRevision,
    requiresReload:options.reload !== false,
    skins:customSkinUiEntries(_customSkins),
    warnings:checked.warnings,
    assignmentReset:assignmentReset,
    suggestedId:suggestedAutomaticCustomSkinId(),
  };
}

function advanceCustomSkinStateRevision() {
  var nextRevision = _customSkinRevision + 1;
  var manifestExisted = !!(CUSTOM_SKINS_FILE && fs.existsSync(CUSTOM_SKINS_FILE));
  var nextProjection = carryCustomSkinProjection(_customSkins, nextRevision);
  var saved = saveCustomSkins(_customSkins, nextRevision, _customSkinIssuedIds, nextProjection);
  if (!saved.ok) return saved;
  try { applyCustomSkinsToCoreNet(_customSkins, nextRevision, _customSkinIssuedIds); }
  catch(error) {
    var restored = restoreCustomSkinsManifestBackup(manifestExisted);
    try { applyCustomSkinsToCoreNet(_customSkins,_customSkinRevision,_customSkinIssuedIds); } catch(_) {}
    return { ok:false,error:'应用库存 revision 失败：' + error.message +
      (restored.ok ? '' : '；旧清单恢复失败：' + restored.error) };
  }
  _customSkinRevision = nextRevision;
  _customSkinCommittedProjection = nextProjection;
  invalidateCustomSkinSnapshotProjection();
  return { ok:true, revision:_customSkinRevision };
}

function publishCommittedCustomSkinDownloadInventory(suiteCommit, formalImportResult) {
  var committedCount = suiteCommit && Array.isArray(suiteCommit.committedIds)
    ? suiteCommit.committedIds.length : 0;
  if (!committedCount) {
    return { ok:true, unchanged:true, revision:_customSkinRevision, publishedBy:'none' };
  }
  // A successful formal import persists the registry and publishes the shared
  // revision for the same committed inventory.  Preview-only (or otherwise
  // non-imported) suites must publish from the revision that is current *now*;
  // a registry save which completed while the download was running must not
  // suppress this inventory publication.
  var formalImportRevision = parseInt(formalImportResult && formalImportResult.revision,10);
  if (formalImportResult && formalImportResult.ok === true && formalImportRevision > 0) {
    return { ok:true, unchanged:true, revision:_customSkinRevision, publishedBy:'formal-import' };
  }
  var advanced = advanceCustomSkinStateRevision();
  if (!advanced.ok) return advanced;
  advanced.inventoryPublished = true;
  advanced.publishedBy = 'inventory-commit';
  return advanced;
}

const _skinDownloadHttpAgent = new http.Agent({
  keepAlive:true,
  maxSockets:CUSTOM_SKIN_ARCH_POLICY.httpSockets,
  maxFreeSockets:CUSTOM_SKIN_ARCH_POLICY.httpFreeSockets,
});
const _skinDownloadHttpsAgent = new https.Agent({
  keepAlive:true,
  maxSockets:CUSTOM_SKIN_ARCH_POLICY.httpSockets,
  maxFreeSockets:CUSTOM_SKIN_ARCH_POLICY.httpFreeSockets,
});

function fetchCustomSkinBuffer(sourceUrl, timeoutMs, redirects, maxBytes, onProgress) {
  return new Promise(function(resolve, reject) {
    var parsed;
    try { parsed = require('url').parse(String(sourceUrl || '')); }
    catch(e) { reject(e); return; }
    if (!parsed || !/^https?:$/i.test(parsed.protocol || '') || !parsed.hostname) {
      reject(new Error('无效的资源地址'));
      return;
    }
    var isHttps = String(parsed.protocol).toLowerCase() === 'https:';
    var transport = isHttps ? https : http;
    var agent = isHttps ? _skinDownloadHttpsAgent : _skinDownloadHttpAgent;
    var req = transport.get({
      agent:agent,
      hostname:parsed.hostname,
      port:parseInt(parsed.port, 10) || (transport === https ? 443 : 80),
      path:parsed.path || '/',
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Seer2Launcher/1.0',
        'Accept':'application/x-shockwave-flash, application/octet-stream;q=0.9, */*;q=0.5',
        'Accept-Encoding':'gzip, deflate, br',
        'Referer':'https://seer.61.com/',
      },
    }, function(res) {
      var status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && (redirects || 0) < 4) {
        var nextUrl = require('url').resolve(sourceUrl, res.headers.location);
        res.resume();
        fetchCustomSkinBuffer(nextUrl, timeoutMs, (redirects || 0) + 1, maxBytes, onProgress).then(resolve, reject);
        return;
      }
      var chunks = [];
      var total = 0;
      var expected = Math.max(0, parseInt(res.headers['content-length'], 10) || 0);
      var transferStartedAt = Date.now();
      var lastProgressAt = 0;
      var sizeLimit = Math.max(1024 * 1024, parseInt(maxBytes, 10) || (8 * 1024 * 1024));
      res.on('data', function(chunk) {
        total += chunk.length;
        if (total > sizeLimit) {
          req.destroy(new Error('资源文件超过限制（' + Math.round(sizeLimit / 1024 / 1024) + ' MiB）'));
          return;
        }
        chunks.push(chunk);
        var now = Date.now();
        if (typeof onProgress === 'function' && (now - lastProgressAt >= 100 || (expected && total >= expected))) {
          lastProgressAt = now;
          try { onProgress({ receivedBytes:total, totalBytes:expected, elapsedMs:Math.max(1, now - transferStartedAt) }); }
          catch(progressError) {}
        }
      });
      res.on('end', function() {
        if (status !== 200) {
          var httpError = new Error('HTTP ' + status);
          httpError.statusCode = status;
          httpError.retryAfter = parseInt(res.headers['retry-after'], 10) || 0;
          reject(httpError);
          return;
        }
        var raw = Buffer.concat(chunks);
        if (typeof onProgress === 'function') {
          try { onProgress({ receivedBytes:total, totalBytes:expected || total, elapsedMs:Math.max(1, Date.now() - transferStartedAt), finished:true }); }
          catch(progressError) {}
        }
        var encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        function finishDecoded(err, output) {
          if (err) { reject(err); return; }
          if (!output || output.length > sizeLimit) {
            reject(new Error('解压后的资源文件超过限制（' + Math.round(sizeLimit / 1024 / 1024) + ' MiB）'));
            return;
          }
          resolve(output);
        }
        if (encoding === 'gzip') zlib.gunzip(raw, finishDecoded);
        else if (encoding === 'deflate') zlib.inflate(raw, finishDecoded);
        else if (encoding === 'br' && zlib.brotliDecompress) zlib.brotliDecompress(raw, finishDecoded);
        else resolve(raw);
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs || 8000, function() {
      req.destroy(new Error('资源下载超时'));
    });
    req.on('error', reject);
  });
}

const CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES = {
  normal: {
    label:'官方跟随模型',
    file:'normal.swf',
    maxBytes:CUSTOM_SKIN_ARCH_POLICY.normalMaxBytes,
    url:function(id) { return 'https://seer.61.com/resource/groupFightResource/pet/' + id + '.swf'; },
    compatibilityUrl:function(id) { return 'http://seer.61.com/resource/groupFightResource/pet/' + id + '.swf'; },
  },
  fight: {
    label:'官方战斗模型',
    file:'fight.swf',
    resourceKey:'fight',
    maxBytes:CUSTOM_SKIN_ARCH_POLICY.fightMaxBytes,
    url:function(id) { return 'https://seer.61.com/resource/fightResource/pet/swf/' + id + '.swf'; },
    compatibilityUrl:function(id) { return 'http://seer.61.com/resource/fightResource/pet/swf/' + id + '.swf'; },
  },
  ultimate: {
    label:'第五技能独立特效',
    file:'skill.swf',
    resourceKey:'skill',
    maxBytes:CUSTOM_SKIN_ARCH_POLICY.ultimateMaxBytes,
    url:function(id) { return 'https://seer.61.com/resource/fightResource/skill/swf/' + id + '.swf'; },
    compatibilityUrl:function(id) { return 'http://seer.61.com/resource/fightResource/skill/swf/' + id + '.swf'; },
  },
  icon: {
    label:'官方头像',
    file:'icon.swf',
    maxBytes:CUSTOM_SKIN_ARCH_POLICY.iconMaxBytes,
    url:function(id) { return 'https://seer.61.com/resource/pet/head/' + id + '.swf'; },
    compatibilityUrl:function(id) { return 'http://seer.61.com/resource/pet/head/' + id + '.swf'; },
  },
};

function loadCustomSkinDownloadSettings() {
  _customSkinDownloadDir = CUSTOM_SKIN_DEFAULT_DOWNLOAD_DIR || '';
  _customSkinAutoImport = true;
  _customSkinIncludeOfficialSkins = true;
  _customSkinPreferUClient = false;
  _customSkinDownloadInputMode = 'list';
  _customSkinDownloadTypes = ['normal','fight','icon'];
  _customSkinDownloadQueueIds = [];
  _customSkinDownloadQueueRevision = 0;
  _customSkinNameCache = {};
  try {
    if (CUSTOM_SKIN_DOWNLOAD_SETTINGS_FILE && fs.existsSync(CUSTOM_SKIN_DOWNLOAD_SETTINGS_FILE)) {
      var raw = JSON.parse(fs.readFileSync(CUSTOM_SKIN_DOWNLOAD_SETTINGS_FILE, 'utf8'));
      var configured = String(raw && raw.directory || '').trim();
      if (configured && path.isAbsolute(configured)) _customSkinDownloadDir = path.resolve(configured);
      if (raw && typeof raw.autoImport === 'boolean') _customSkinAutoImport = raw.autoImport;
      if (raw && typeof raw.includeOfficialSkins === 'boolean') {
        _customSkinIncludeOfficialSkins = raw.includeOfficialSkins;
      }
      if (raw && typeof raw.preferUClient === 'boolean') {
        _customSkinPreferUClient = raw.preferUClient;
      }
      if (raw && (raw.inputMode === 'list' || raw.inputMode === 'range')) {
        _customSkinDownloadInputMode = raw.inputMode;
      }
      if (raw && Array.isArray(raw.types)) {
        var allowedTypes = new Set(['normal','fight','icon']);
        var configuredTypes = raw.types.map(function(value) { return String(value || '').toLowerCase(); })
          .filter(function(value, index, values) { return allowedTypes.has(value) && values.indexOf(value) === index; });
        if (configuredTypes.length) _customSkinDownloadTypes = configuredTypes;
      }
      if (raw && Array.isArray(raw.queueIds)) {
        _customSkinDownloadQueueIds = parseCustomSkinDownloadIds(raw.queueIds).slice(0, 200);
      }
      _customSkinDownloadQueueRevision = Math.max(0,
        parseInt(raw && raw.queueRevision, 10) || 0);
    }
    if (CUSTOM_SKIN_NAME_CACHE_FILE && fs.existsSync(CUSTOM_SKIN_NAME_CACHE_FILE)) {
      var nameRaw = JSON.parse(fs.readFileSync(CUSTOM_SKIN_NAME_CACHE_FILE, 'utf8'));
      if (nameRaw && nameRaw.names && typeof nameRaw.names === 'object') {
        _customSkinNameCache = nameRaw.names;
      }
    }
  } catch(e) {
    logWarn('CustomSkin', 'download settings load failed', { error:e.message });
  }
}

function saveCustomSkinDownloadSettings() {
  try {
    fs.writeFileSync(CUSTOM_SKIN_DOWNLOAD_SETTINGS_FILE, JSON.stringify({
      version:7,
      directory:_customSkinDownloadDir || CUSTOM_SKIN_DEFAULT_DOWNLOAD_DIR,
      autoImport:_customSkinAutoImport !== false,
      includeOfficialSkins:_customSkinIncludeOfficialSkins !== false,
      preferUClient:_customSkinPreferUClient === true,
      inputMode:_customSkinDownloadInputMode === 'range' ? 'range' : 'list',
      types:_customSkinDownloadTypes.slice(),
      queueIds:_customSkinDownloadQueueIds.slice(0, 200),
      queueRevision:_customSkinDownloadQueueRevision,
      updatedAt:new Date().toISOString(),
    }, null, 2), 'utf8');
    return { ok:true };
  } catch(e) {
    return { ok:false, error:e.message };
  }
}

async function saveCustomSkinNameCache() {
  try {
    if (!CUSTOM_SKIN_NAME_CACHE_FILE) return;
    await fs.promises.writeFile(CUSTOM_SKIN_NAME_CACHE_FILE, JSON.stringify({
      version:1,
      names:_customSkinNameCache,
      updatedAt:new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch(e) {
    logWarn('CustomSkin', 'name cache save failed', { error:e.message });
  }
}

async function fetchCustomSkinPublicName(sourceId) {
  var id = parseCustomSkinId(sourceId);
  if (!id) return '';
  if (_customSkinNameCache[String(id)]) return String(_customSkinNameCache[String(id)]);
  try {
    var api = 'https://wiki.biligame.com/seer/api.php?action=parse&format=json&prop=displaytitle&page=' +
      encodeURIComponent('精灵:' + id);
    var payload = JSON.parse(await fetchCustomSkinCatalogText(api, 8000));
    var name = String(payload && payload.parse && payload.parse.displaytitle || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, function(_, code) { return String.fromCharCode(parseInt(code, 10)); })
      .trim();
    if (name && name !== ('精灵:' + id)) {
      _customSkinNameCache[String(id)] = name.slice(0, 80);
      await saveCustomSkinNameCache();
      return _customSkinNameCache[String(id)];
    }
  } catch(e) {
    logWarn('CustomSkin', 'public name lookup skipped', { id:id, error:e.message });
  }
  return '';
}

async function attachCustomSkinPublicNamesToJobs(jobs) {
  try {
    var identityCatalog = _seer1OfficialPetCatalogCache;
    if (!identityCatalog) identityCatalog = await officialCatalogStore.read();
    var officialNames = {};
    (identityCatalog && Array.isArray(identityCatalog.items) ? identityCatalog.items : []).forEach(function(item) {
      var itemId = parseCustomSkinId(item && item.id);
      var itemName = String(item && item.name || '').trim();
      if (itemId && itemName) officialNames[String(itemId)] = itemName.slice(0, 80);
      (Array.isArray(item && item.extraSkins) ? item.extraSkins : []).forEach(function(skin) {
        var resourceId = parseCustomSkinId(skin && (skin.resourceId || skin.id));
        var skinName = String(skin && skin.name || '').trim();
        if (resourceId && skinName) officialNames[String(resourceId)] = skinName.slice(0, 80);
      });
    });
    (Array.isArray(jobs) ? jobs : []).forEach(function(job) {
      var jobId = parseCustomSkinId(job && job.id);
      var basePetId = parseCustomSkinId(job && job.basePetId);
      if (!job.officialName) {
        if (jobId && officialNames[String(jobId)]) {
          job.officialName = officialNames[String(jobId)];
        } else if (basePetId && officialNames[String(basePetId)]) {
          job.officialName = officialNames[String(basePetId)];
        }
      }
    });
  } catch(e) {
    logWarn('CustomSkin', 'local identity name catalogue unavailable, using public fallback', { error:e.message });
  }
  var pendingIds = [];
  var seen = new Set();
  (Array.isArray(jobs) ? jobs : []).forEach(function(job) {
    var id = parseCustomSkinId(job && job.id);
    if (!id || job.officialName || seen.has(id)) return;
    seen.add(id);
    pendingIds.push(id);
  });
  var names = {};
  for (var offset = 0; offset < pendingIds.length; offset += 6) {
    var batch = pendingIds.slice(offset, offset + 6);
    var resolved = await Promise.all(batch.map(async function(id) {
      return { id:id, name:await fetchCustomSkinPublicName(id) };
    }));
    resolved.forEach(function(item) { if (item.name) names[String(item.id)] = item.name; });
    await new Promise(function(resolve) { setImmediate(resolve); });
  }
  (Array.isArray(jobs) ? jobs : []).forEach(function(job) {
    var resolvedName = names[String(parseCustomSkinId(job && job.id))];
    if (!job.officialName && resolvedName) job.officialName = resolvedName;
  });
  return jobs;
}

let _seer1OfficialSkillConfigPromise = null;

var _seer1OfficialCatalogRefreshNonce = '';

function seer1OfficialFreshUrl(sourceUrl, forceRefresh) {
  if (forceRefresh !== true) return sourceUrl;
  var joiner = String(sourceUrl || '').indexOf('?') >= 0 ? '&' : '?';
  var nonce = _seer1OfficialCatalogRefreshNonce ||
    (Date.now() + '-' + crypto.randomBytes(6).toString('hex'));
  return String(sourceUrl || '') + joiner + '__seer2_catalog_refresh=' + nonce;
}

function seer1OfficialFreshPath(resourcePath) {
  if (!_seer1OfficialCatalogRefreshNonce) return resourcePath;
  var joiner = String(resourcePath || '').indexOf('?') >= 0 ? '&' : '?';
  return String(resourcePath || '') + joiner + '__seer2_catalog_refresh=' +
    _seer1OfficialCatalogRefreshNonce;
}

async function loadSeer1RobotCoreConfig(forceRefresh) {
  var raw = await fetchCustomSkinBuffer(seer1OfficialFreshUrl(
    'https://seer.61.com/dll/RobotCoreDLL.swf', true
  ), 45000, 0, 32 * 1024 * 1024);
  var assets = extractSeer1RobotCoreBinaryAssets(raw);
  if (!assets.petXml || !assets.skillTable) throw new Error('RobotCoreDLL 缺少精灵或技能配置');
  var monsters = parseSeer1RobotCorePetXml(assets.petXml);
  var skillData = zlib.inflateSync(assets.skillTable);
  var skillRoot = new Seer1Amf3Reader(skillData).value();
  var skinTable = selectSeer1RobotCorePetSkinTable(assets.petSkinCandidates);
  var rawHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return {
    monsters:monsters,
    movesById:collectSeer1MovesById(skillRoot),
    skins:skinTable ? { PetSkins:{ Skin:skinTable.rows } } : null,
    skinTableInfo:skinTable ? {
      symbol:skinTable.symbol,
      characterId:skinTable.characterId,
      bytes:skinTable.bytes,
      rows:skinTable.rows.length,
      maxId:skinTable.maxId,
    } : null,
    sha256:crypto.createHash('sha256').update(raw).digest('hex').toUpperCase(),
    checkedAt:new Date().toISOString(),
    versionTag:'robotcore-' + raw.length + '-' + rawHash,
  };
}

function mergeSeer1Monsters(base, current) {
  var left = base && base.Monsters && base.Monsters.Monster;
  var right = current && current.Monsters && current.Monsters.Monster;
  left = Array.isArray(left) ? left : (left ? [left] : []);
  right = Array.isArray(right) ? right : (right ? [right] : []);
  var byId = new Map();
  left.concat(right).forEach(function(item) { var id = parseCustomSkinId(item && item.ID); if (id) byId.set(id, item); });
  return { Monsters:{ Monster:Array.from(byId.values()).sort(function(a, b) { return Number(a.ID) - Number(b.ID); }) } };
}

function mergeSeer1PetSkins(base, current) {
  function rows(value) {
    var root = value && value.PetSkins;
    var list = root && root.Skin;
    return Array.isArray(list) ? list : (list ? [list] : []);
  }
  var byId = new Map();
  rows(base).concat(rows(current)).forEach(function(item) {
    var id = parseCustomSkinId(item && item.ID);
    var monId = parseCustomSkinId(item && item.MonID);
    if (id && monId) byId.set(id, item);
  });
  return { PetSkins:{ Skin:Array.from(byId.values()).sort(function(a, b) {
    return Number(a.ID) - Number(b.ID);
  }) } };
}

function seer1PetSkinCatalogueIds(value) {
  var root = value && value.PetSkins;
  var list = root && root.Skin;
  list = Array.isArray(list) ? list : (list ? [list] : []);
  return new Set(list.map(function(item) { return parseCustomSkinId(item && item.ID); }).filter(Boolean));
}

function seer1MonsterCatalogueIds(value) {
  var list = value && value.Monsters && value.Monsters.Monster;
  list = Array.isArray(list) ? list : (list ? [list] : []);
  return new Set(list.map(function(item) { return parseCustomSkinId(item && item.ID); }).filter(Boolean));
}

async function loadSeer1OfficialSkillConfig(forceRefresh) {
  if (forceRefresh === true) _seer1OfficialSkillConfigPromise = null;
  if (_seer1OfficialSkillConfigPromise) return _seer1OfficialSkillConfigPromise;
  _seer1OfficialSkillConfigPromise = (async function() {
    var currentCore = await loadSeer1RobotCoreConfig(forceRefresh === true);
    if (!currentCore || !currentCore.monsters || !currentCore.skins) {
      throw new Error('当前 U 端 RobotCore 配置不完整');
    }
    var currentSkinIds = seer1PetSkinCatalogueIds(currentCore.skins);
    var currentMonsterIds = seer1MonsterCatalogueIds(currentCore.monsters);
    return {
      monsters:currentCore.monsters,
      replacements:currentCore.replacements || {},
      skins:currentCore.skins,
      skinTableInfo:currentCore.skinTableInfo || null,
      currentPetDiscoveryIds:Array.from(currentMonsterIds).sort(function(a, b) { return a - b; }),
      currentSkinDiscoveryIds:Array.from(currentSkinIds).map(function(id) {
        return 1400000 + id;
      }).sort(function(a, b) { return a - b; }),
      fightModels:{},
      movesById:Object.assign({}, currentCore.movesById || {}),
      headAssets:{},
      officialDiscoverySource:'seer.61.com RobotCoreDLL + newseer.61.com PetAnimPackage',
      officialDiscoveryFingerprint:String(currentCore && currentCore.sha256 || ''),
      officialDiscoveryCheckedAt:String(currentCore && currentCore.checkedAt || new Date().toISOString()),
      versionTag:String(currentCore && currentCore.versionTag || 'uclient') + ':skins-' +
        String(currentCore && currentCore.skinTableInfo && currentCore.skinTableInfo.maxId || 'current'),
    };
  })();
  try {
    return await _seer1OfficialSkillConfigPromise;
  } catch(e) {
    _seer1OfficialSkillConfigPromise = null;
    throw e;
  }
}

let _seer1OfficialPetCatalogCache = null;
let _seer1CatalogAutotestPending = false;
let _seer1DownloadAutotestPending = false;
let _seer1DownloadAutotestKeepalive = null;
var _seer1LegacyHeadValidationCache = new Map();
var _seer1LegacyHeadPlaceholderPromise = null;

function isPngBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 32 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A;
}

function normalizeLegacySeer1Head(buffer) {
  try {
    var image = nativeImage.createFromBuffer(buffer);
    var size = image.getSize();
    if (!size.width || !size.height || size.width > 4096 || size.height > 4096) return '';
    var bitmap = image.toBitmap();
    var minX = size.width, minY = size.height, maxX = -1, maxY = -1;
    for (var y = 0; y < size.height; y++) {
      for (var x = 0; x < size.width; x++) {
        var offset = (y * size.width + x) * 4;
        var b = bitmap[offset], g = bitmap[offset + 1], r = bitmap[offset + 2], a = bitmap[offset + 3];
        if (a > 12 && (r < 246 || g < 246 || b < 246)) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return '';
    var contentW = maxX - minX + 1, contentH = maxY - minY + 1;
    var padding = Math.max(2, Math.round(Math.max(contentW, contentH) * 0.08));
    var cropX = Math.max(0, minX - padding), cropY = Math.max(0, minY - padding);
    var cropRight = Math.min(size.width, maxX + padding + 1);
    var cropBottom = Math.min(size.height, maxY + padding + 1);
    var normalized = image.crop({ x:cropX, y:cropY, width:cropRight - cropX, height:cropBottom - cropY })
      .resize({ width:128, height:128, quality:'best' });
    return 'data:image/png;base64,' + normalized.toPNG().toString('base64');
  } catch(_) {
    return '';
  }
}

async function validatedLegacySeer1HeadUrl(resourceId) {
  var id = parseCustomSkinId(resourceId);
  if (!id) return '';
  if (_seer1LegacyHeadValidationCache.has(id)) return _seer1LegacyHeadValidationCache.get(id);
  var url = 'https://seerh5.61.com/resource/assets/pet/head/' + id + '.png';
  var result = '';
  try {
    if (!_seer1LegacyHeadPlaceholderPromise) {
      _seer1LegacyHeadPlaceholderPromise = fetchCustomSkinBuffer(
        'https://seerh5.61.com/resource/assets/pet/head/5044.png', 6000, 0, 2 * 1024 * 1024
      ).catch(function() { return null; });
    }
    var buffers = await Promise.all([
      fetchCustomSkinBuffer(url, 6000, 0, 2 * 1024 * 1024),
      _seer1LegacyHeadPlaceholderPromise,
    ]);
    var candidate = buffers[0], placeholder = buffers[1];
    if (isPngBuffer(candidate) && (id === 5044 || !Buffer.isBuffer(placeholder) || !candidate.equals(placeholder))) {
      result = normalizeLegacySeer1Head(candidate);
    }
  } catch(_) {}
  _seer1LegacyHeadValidationCache.set(id, result);
  return result;
}

function normalizeSeer1OfficialPetCatalog(config) {
  var monsters = config && config.monsters && config.monsters.Monsters && config.monsters.Monsters.Monster;
  monsters = Array.isArray(monsters) ? monsters : (monsters ? [monsters] : []);
  var skinRoot = config && config.skins && config.skins.PetSkins;
  var skins = skinRoot && skinRoot.Skin;
  skins = Array.isArray(skins) ? skins : (skins ? [skins] : []);
  var skinsByPet = {};
  var headAssets = config && config.headAssets || {};
  function headFileFor(id) {
    var value = String(headAssets[String(id) + '.png'] || '').trim();
    return /^[A-Za-z0-9_.-]+\.png$/i.test(value) ? value : '';
  }
  var modelIndexIds = Object.keys(config && config.fightModels || {}).map(function(key) {
    var match = String(key).match(/^id(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  }).filter(Boolean).sort(function(a, b) { return a - b; });
  skins.forEach(function(item) {
    var basePetId = parseCustomSkinId(item && item.MonID);
    var catalogueId = parseCustomSkinId(item && item.ID);
    if (!basePetId || !catalogueId) return;
    var list = skinsByPet[String(basePetId)] || (skinsByPet[String(basePetId)] = []);
    list.push({
      catalogueId:catalogueId,
      resourceId:1400000 + catalogueId,
      name:String(item.Name || '').trim().slice(0, 80),
      headFile:headFileFor(1400000 + catalogueId),
    });
  });
  Object.keys(skinsByPet).forEach(function(key) {
    skinsByPet[key].sort(function(a, b) { return a.resourceId - b.resourceId; });
  });
  var items = monsters.map(function(monster) {
    var id = parseCustomSkinId(monster && monster.ID);
    if (!id) return null;
    var type = parseInt(monster.Type, 10) || 0;
    var hp = parseInt(monster.HP, 10) || 0;
    var atk = parseInt(monster.Atk, 10) || 0;
    var def = parseInt(monster.Def, 10) || 0;
    var spAtk = parseInt(monster.SpAtk, 10) || 0;
    var spDef = parseInt(monster.SpDef, 10) || 0;
    var spd = parseInt(monster.Spd, 10) || 0;
    return {
      id:id,
      name:String(monster.DefName || '').trim().slice(0, 80),
      realId:parseCustomSkinId(monster && monster.RealId),
      modelIndexed:modelIndexIds.indexOf(id) >= 0,
      officialDefinition:true,
      headFile:headFileFor(id),
      type:type,
      hp:hp,
      atk:atk,
      def:def,
      spAtk:spAtk,
      spDef:spDef,
      spd:spd,
      extraSkins:skinsByPet[String(id)] || [],
    };
  }).filter(Boolean).sort(function(a, b) { return a.id - b.id; });
  return {
    version:5,
    source:'official RobotCoreDLL + UClient manifests',
    versionTag:String(config && config.versionTag || ''),
    updatedAt:new Date().toISOString(),
    modelIndexIds:modelIndexIds,
    currentPetDiscoveryIds:(config && config.currentPetDiscoveryIds || []).map(parseCustomSkinId).filter(Boolean),
    currentSkinDiscoveryIds:(config && config.currentSkinDiscoveryIds || []).map(parseCustomSkinId).filter(Boolean),
    skinTableInfo:config && config.skinTableInfo || null,
    officialDiscoverySource:String(config && config.officialDiscoverySource || ''),
    officialDiscoveryFingerprint:String(config && config.officialDiscoveryFingerprint || ''),
    officialDiscoveryCheckedAt:String(config && config.officialDiscoveryCheckedAt || ''),
    items:items,
  };
}

async function fetchCustomSkinPublicNamesBatch(ids) {
  var output = {};
  var values = Array.from(new Set((ids || []).map(parseCustomSkinId).filter(Boolean)));
  for (var offset = 0; offset < values.length; offset += 40) {
    var batch = values.slice(offset, offset + 40);
    try {
      var titles = batch.map(function(id) { return '\u7cbe\u7075:' + id; }).join('|');
      var api = 'https://wiki.biligame.com/seer/api.php?action=query&format=json&prop=pageprops&ppprop=displaytitle&titles=' +
        encodeURIComponent(titles);
      var payload = JSON.parse(await fetchCustomSkinCatalogText(api, 10000));
      var pages = payload && payload.query && payload.query.pages || {};
      Object.keys(pages).forEach(function(key) {
        var page = pages[key] || {};
        var match = String(page.title || '').match(/:(\d+)$/);
        var name = String(page.pageprops && page.pageprops.displaytitle || '').replace(/<[^>]*>/g, '').trim();
        if (match && name) output[match[1]] = name.slice(0, 80);
      });
    } catch(e) {
      logWarn('CustomSkin', 'public catalogue batch name lookup skipped', { error:e.message });
    }
  }
  Object.keys(output).forEach(function(id) { _customSkinNameCache[id] = output[id]; });
  if (Object.keys(output).length) await saveCustomSkinNameCache();
  return output;
}

function sanitizeSeer1OfficialOnlyCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.items)) return catalog;
  catalog.items = catalog.items.filter(function(item) { return item && item.publicDiscovery !== true; });
  catalog.items.forEach(function(item) {
    delete item.publicDiscovery;
    delete item.publicSource;
    delete item.publicSourceUrl;
    delete item.publicHeadUrl;
    delete item.publicHeadDataUrl;
  });
  catalog.publicDiscoveryIds = [];
  delete catalog.publicCatalogSource;
  delete catalog.publicCatalogUrl;
  delete catalog.publicCatalogFingerprint;
  delete catalog.publicCatalogCheckedAt;
  delete catalog.publicCatalogRefreshError;
  catalog.resourceSupplementVersion = 3;
  catalog.resourceSupplementIds = [];
  return catalog;
}

function probeSeer1OfficialHeadResource(id) {
  return new Promise(function(resolve) {
    var req = https.request({
      hostname:'seer.61.com', port:443, method:'HEAD',
      path:seer1OfficialFreshPath('/resource/pet/head/' + id + '.swf'),
      headers:{ 'User-Agent':'Mozilla/5.0 Seer2LauncherCatalog' },
      rejectUnauthorized:false,
    }, function(res) {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(7000, function() { req.destroy(); });
    req.on('error', function() { resolve(false); });
    req.end();
  });
}

function probeSeer1OfficialResourcePathInfo(resourcePath) {
  return new Promise(function(resolve) {
    var settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }
    var req = https.request({
      hostname:'seer.61.com', port:443, method:'HEAD', path:seer1OfficialFreshPath(resourcePath),
      headers:{ 'User-Agent':'Mozilla/5.0 Seer2LauncherCatalog' },
      rejectUnauthorized:false,
    }, function(res) {
      res.resume();
      var status = parseInt(res.statusCode, 10) || 0;
      if (status === 200) finish({
        available:true,
        bytes:parseInt(res.headers['content-length'], 10) || 0,
        etag:String(res.headers.etag || ''),
        lastModified:String(res.headers['last-modified'] || ''),
      });
      else if (status === 404 || status === 410) finish({ available:false });
      else finish({ available:null, statusCode:status });
    });
    req.setTimeout(7000, function() { req.destroy(); finish({ available:null, error:'timeout' }); });
    req.on('error', function(e) { finish({ available:null, error:e.message }); });
    req.end();
  });
}

async function probeSeer1OfficialResourcePath(resourcePath) {
  var info = await probeSeer1OfficialResourcePathInfo(resourcePath);
  return info && info.available;
}

async function probeSeer1OfficialModelResource(id) {
  var fight = await probeSeer1OfficialResourcePath('/resource/fightResource/pet/swf/' + id + '.swf');
  if (fight === true) return true;
  var normal = await probeSeer1OfficialResourcePath('/resource/groupFightResource/pet/' + id + '.swf');
  if (normal === true) return true;
  if (fight === false && normal === false) return false;
  return null;
}

function seer1OfficialResourceFingerprint(info) {
  if (!info || info.available !== true) return '';
  return [parseInt(info.bytes, 10) || 0, String(info.etag || ''), String(info.lastModified || '')].join('|');
}

function loadSeer1TemporaryModelNameEvidence(catalog) {
  if (!CUSTOM_SKIN_TEMPORARY_MODEL_NAME_EVIDENCE_FILE || !catalog) return {};
  try {
    var document = JSON.parse(fs.readFileSync(CUSTOM_SKIN_TEMPORARY_MODEL_NAME_EVIDENCE_FILE, 'utf8'));
    if (!document || parseInt(document.schemaVersion, 10) !== 1) return {};
    if (String(document.catalogVersionTag || '') !== String(catalog.versionTag || '')) return {};
    var expiresAt = Date.parse(String(document.expiresAt || ''));
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) return {};
    return (Array.isArray(document.entries) ? document.entries : []).reduce(function(out, entry) {
      var id = parseCustomSkinId(entry && entry.id);
      var name = String(entry && entry.name || '').trim().slice(0, 80);
      var fingerprint = String(entry && entry.fightFingerprint || '');
      if (!id || !name || !fingerprint) return out;
      out[String(id)] = {
        name:name,
        fightFingerprint:fingerprint,
        canonicalResourceId:parseCustomSkinId(entry.canonicalResourceId),
        basePetId:parseCustomSkinId(entry.basePetId),
        evidence:String(entry.evidence || 'temporary-manual-verification').slice(0, 80),
      };
      return out;
    }, {});
  } catch(e) {
    if (e && e.code !== 'ENOENT') logWarn('CustomSkin', 'temporary model name evidence ignored', { error:e.message });
    return {};
  }
}

function applySeer1TemporaryModelNameEvidence(target, rawId, check, identities) {
  if (target && (target.temporaryModelNameEvidenceApplied === true || target.modelIdentityVerified === true) &&
      typeof target.configName === 'string') {
    target.name = target.configName;
  }
  if (target) {
    delete target.temporaryModelNameEvidenceApplied;
    delete target.temporaryModelNameEvidenceFingerprint;
    delete target.temporaryModelNameEvidenceCanonicalResourceId;
    delete target.temporaryModelNameEvidenceBasePetId;
    delete target.temporaryModelNameEvidenceType;
    delete target.modelIdentityVerified;
    delete target.modelIdentityFingerprint;
    delete target.modelIdentityCanonicalResourceId;
    delete target.modelIdentityBasePetId;
    delete target.modelIdentityEvidence;
  }
  var id = parseCustomSkinId(rawId);
  var identity = id && identities ? identities[String(id)] : null;
  var actualFingerprint = String(check && check.fightFingerprint || '');
  if (!target || !identity || !actualFingerprint || actualFingerprint !== identity.fightFingerprint) return false;
  if (typeof target.configName !== 'string') target.configName = String(target.name || '');
  target.name = identity.name;
  target.temporaryModelNameEvidenceApplied = true;
  target.temporaryModelNameEvidenceFingerprint = actualFingerprint;
  target.temporaryModelNameEvidenceCanonicalResourceId = identity.canonicalResourceId;
  target.temporaryModelNameEvidenceBasePetId = identity.basePetId;
  target.temporaryModelNameEvidenceType = identity.evidence;
  return true;
}

const { inspectPetActionBranches } = require('./swf-battle-capability');
const SEER1_BATTLE_INSPECTION_VERSION = 3;
const SEER1_MODEL_AVAILABILITY_VERSION = 5;

async function inspectCustomSkinBattleModel(buffer) {
  var info = await customSkinReadRectSizeAsync(buffer);
  if (!info || !info.data || info.data.length < 20) {
    return { ok:false, labels:[], reason:'battle-swf-unreadable' };
  }
  var data = info.data;
  var nbits = data[8] >> 3;
  var rectBytes = Math.ceil((5 + 4 * nbits) / 8);
  var rootStart = 8 + rectBytes + 4;
  var labels = [];
  var visited = 0;
  var spriteCount = 0;
  var showFrameCount = 0;
  var multiFrameSpriteCount = 0;
  var maxSpriteFrameCount = 0;
  var bitmapTagCount = 0;
  function addLabel(start, end) {
    var zero = start;
    while (zero < end && data[zero] !== 0) zero++;
    var label = data.slice(start, zero).toString('utf8').trim().toLowerCase();
    if (label && labels.indexOf(label) < 0) labels.push(label);
  }
  function scan(start, end, depth) {
    if (depth > 18) return;
    var position = start;
    while (position < end && visited < 600000) {
      var tag = customSkinReadTagHeader(data, position, end);
      if (!tag) break;
      visited++;
      if (tag.code === 1) showFrameCount++;
      if (tag.code === 20 || tag.code === 21 || tag.code === 35 || tag.code === 36 || tag.code === 90) {
        bitmapTagCount++;
      }
      if (tag.code === 43) addLabel(tag.body, tag.end);
      if (tag.code === 39 && tag.body + 4 <= tag.end) {
        spriteCount++;
        var spriteFrameCount = data.readUInt16LE(tag.body + 2);
        if (spriteFrameCount > 1) multiFrameSpriteCount++;
        if (spriteFrameCount > maxSpriteFrameCount) maxSpriteFrameCount = spriteFrameCount;
        scan(tag.body + 4, tag.end, depth + 1);
      }
      position = tag.end;
      if (tag.code === 0) break;
    }
  }
  scan(rootStart, data.length, 0);
  var branchInspection = inspectPetActionBranches(data, rootStart, customSkinReadTagHeader);
  var core = labels.filter(function(label) {
    return /^(?:attack\d*|sa\d*|cp\d*|hited\d*|appear\d*|dead\d*|win\d*|hidemove\d*)$/.test(label);
  });
  var hasAttack = core.some(function(label) { return /^attack\d*$|^sa\d*$/.test(label); });
  var hasReaction = core.some(function(label) { return /^cp\d*$|^hited\d*$/.test(label); });
  var dedicatedUltimateActions = ultimateCapability.normalizeUltimateActions(
    branchInspection.dynamicCoreActions || []);
  var dedicatedUltimate = dedicatedUltimateActions.length > 0;
  var reactionActions = core.filter(function(label) {
    return /^(?:cp\d*|hited\d*|dead\d*|win\d*)$/.test(label);
  });
  var requiredAttackLabels = core.filter(function(label) {
    return /^(?:attack\d*|sa\d*|cp\d*)$/.test(label);
  });
  var staticAttackLabels = branchInspection.staticCoreActions.filter(function(label) {
    return /^(?:attack\d*|sa\d*|cp\d*)$/.test(label);
  });
  var branchStaticShell = branchInspection.found && requiredAttackLabels.length > 0 &&
    staticAttackLabels.length > 0;
  var globalStaticShell = bitmapTagCount > 0 && multiFrameSpriteCount <= 8 &&
    maxSpriteFrameCount > 0 && maxSpriteFrameCount <= 30;
  var staticPoseWrapper = hasAttack && hasReaction && (branchStaticShell || globalStaticShell);
  var legacyPlayable = hasAttack && hasReaction && !staticPoseWrapper;
  return {
    ok:legacyPlayable,
    labels:labels.slice(0, 80),
    coreLabels:core,
    hasAttack:hasAttack,
    hasReaction:hasReaction,
    legacyPlayable:legacyPlayable,
    staticPoseWrapper:staticPoseWrapper,
    structure:{
      spriteCount:spriteCount,
      showFrameCount:showFrameCount,
      multiFrameSpriteCount:multiFrameSpriteCount,
      maxSpriteFrameCount:maxSpriteFrameCount,
      bitmapTagCount:bitmapTagCount,
    },
    actionBranches:branchInspection.actions,
    dynamicCoreActions:branchInspection.dynamicCoreActions,
    staticCoreActions:branchInspection.staticCoreActions,
    inspectionVersion:SEER1_BATTLE_INSPECTION_VERSION,
    dedicatedUltimate:dedicatedUltimate,
    dedicatedUltimateActions:dedicatedUltimateActions,
    reactionActions:reactionActions,
    nonStandardTimeline:!legacyPlayable,
    reason:staticPoseWrapper ? 'battle-static-pose-wrapper' :
      (legacyPlayable ? '' : 'battle-actions-nonstandard'),
  };
}

let _seer1OfficialPetCatalogSupplementPromise = null;
async function supplementSeer1OfficialPetCatalog(catalog, onProgress, forceOfficialRefresh) {
  if (!catalog || !Array.isArray(catalog.items)) return catalog;
  if (forceOfficialRefresh !== true && parseInt(catalog.resourceSupplementVersion, 10) >= 3) {
    return catalog;
  }
  if (_seer1OfficialPetCatalogSupplementPromise) return await _seer1OfficialPetCatalogSupplementPromise;
  _seer1OfficialPetCatalogSupplementPromise = (async function() {
    if (typeof onProgress === 'function') onProgress({ phase:'supplement', completed:0, total:1,
      message:'正在清理旧第三方发现记录并确认官方发布快照' });
    sanitizeSeer1OfficialOnlyCatalog(catalog);
    catalog.updatedAt = new Date().toISOString();
    await saveSeer1OfficialPetCatalogCache(catalog);
    if (typeof onProgress === 'function') onProgress({ phase:'supplement', completed:1, total:1,
      message:'官方 RobotCore 与 UClient 发布快照已确认，正在验证模型能力' });
    return catalog;
  })();
  try { return await _seer1OfficialPetCatalogSupplementPromise; }
  finally { _seer1OfficialPetCatalogSupplementPromise = null; }
}

const officialCatalogStore = createOfficialCatalogStore({
  fs:fs, path:path, crypto:crypto, parseId:parseCustomSkinId,
  getFile:function() { return CUSTOM_SKIN_CATALOG_CACHE_FILE; },
});
let _seer1OfficialCatalogRefreshDraft = null;
let _seer1OfficialCatalogRefreshUClientSnapshot = null;

async function commitSeer1OfficialPetCatalogCache(catalog, options) {
  return await officialCatalogStore.commit(catalog, options);
}

async function saveSeer1OfficialPetCatalogCache(catalog) {
  if (_seer1OfficialCatalogRefreshDraft === catalog) return;
  try { await commitSeer1OfficialPetCatalogCache(catalog); }
  catch(e) { logWarn('CustomSkin', 'official pet catalog cache save failed', { error:e.message }); }
}

function hasValidSeer1OfficialPetDefinition(item) {
  return !!item && item.officialDefinition === true;
}

function hasUsableSeer1OfficialModel(item) {
  if (!item || item.modelAvailable === false) return false;
  return item.uClientModelAvailable === true || item.modelIndexed === true || item.resourceVerified === true ||
    item.fightAvailable === true || item.normalAvailable === true;
}

function seer1OfficialPlaybackVerifiedForFingerprint(check, fingerprint) {
  if (!check || (check.playbackVerifiedOldUi !== true && check.playbackVerifiedNewUi !== true)) return false;
  var currentFingerprint = String(fingerprint || check.fightFingerprint || '');
  if (!currentFingerprint) return false;
  var evidenceFingerprint = String(check.playbackVerifiedFingerprint || '');
  if (!evidenceFingerprint) return String(check.fightFingerprint || '') === currentFingerprint;
  return evidenceFingerprint === currentFingerprint;
}

function applySeer1OfficialModelAvailability(catalog) {
  var unavailable = new Set((catalog.modelUnavailableIds || []).map(parseCustomSkinId).filter(Boolean));
  var indexed = new Set((catalog.modelIndexIds || []).map(parseCustomSkinId).filter(Boolean));
  var checks = catalog.modelStructureChecks && typeof catalog.modelStructureChecks === 'object'
    ? catalog.modelStructureChecks : {};
  var temporaryNameEvidence = loadSeer1TemporaryModelNameEvidence(catalog);
  function triState(value) {
    return value === true ? true : (value === false ? false : null);
  }
  function annotate(target, rawId, isSkin) {
    var id = parseCustomSkinId(rawId);
    if (!target || !id) return;
    var check = checks[String(id)] || {};
    var managedUClient = findSeer1ManagedUClientEntry(id);
    if (managedUClient && managedUClient.legacyStaticPoseWrapper === true) {
      check.fightPlayable = false;
      check.staticPoseWrapper = true;
      check.nonStandardTimeline = true;
      check.reason = 'battle-static-pose-wrapper';
      delete check.localFightFingerprint;
    }
    applySeer1TemporaryModelNameEvidence(target, id, check, temporaryNameEvidence);
    var modelIndexed = target.modelIndexed === true || indexed.has(id);
    var uClientModelAvailable = target.uClientModelAvailable === true;
    var fightAvailable = triState(check.fightAvailable);
    var normalAvailable = triState(check.normalAvailable);
    var iconAvailable = triState(check.iconAvailable);
    if (iconAvailable === null && String(target.headFile || '').trim()) iconAvailable = true;
    var staticPoseWrapper = check.staticPoseWrapper === true ||
      String(check.reason || '') === 'battle-static-pose-wrapper';
    if (staticPoseWrapper) {
      delete check.playbackVerifiedAt;
      delete check.playbackVerifiedOldUi;
      delete check.playbackVerifiedNewUi;
      delete check.playbackVerifiedFingerprint;
    }
    var playbackVerified = !staticPoseWrapper &&
      seer1OfficialPlaybackVerifiedForFingerprint(check, check.fightFingerprint);
    var rawFightPlayable = playbackVerified ? true : triState(check.fightPlayable);
    var labels = Array.isArray(check.labels) ? check.labels.slice(0, 80) : [];
    var status = 'pending';
    if (fightAvailable === true) {
      status = rawFightPlayable === true ? 'battle-verified' :
        (rawFightPlayable === false ? 'battle-nonstandard' : 'battle-available');
    } else if (normalAvailable === true) {
      status = 'follow-only';
    } else if (fightAvailable === false && normalAvailable === false) {
      status = uClientModelAvailable ? 'battle-nonstandard' : 'unavailable';
    } else if (modelIndexed) {
      status = 'indexed';
    } else if (unavailable.has(id)) {
      status = 'unavailable';
    }
    var nonStandardTimeline = check.nonStandardTimeline === true ||
      (fightAvailable === true && rawFightPlayable === false);
    var reactionActions = Array.isArray(check.reactionActions)
      ? check.reactionActions.slice(0, 20)
      : labels.filter(function(label) { return /^(?:cp\d*|hited\d*|dead\d*|win\d*)$/i.test(label); });
    var legacyDedicatedActions = check.fightPlayable === true && staticPoseWrapper !== true
      ? ultimateCapability.normalizeUltimateActions(check.dynamicCoreActions || []) : [];
    var hasUnifiedUltimate = Number(target.ultimateCapabilitySchemaVersion || 0) ===
      ultimateCapability.SCHEMA_VERSION;
    var dedicatedUltimate = hasUnifiedUltimate
      ? target.ultimateCapabilityState === 'verified' : legacyDedicatedActions.length > 0;
    target.modelIndexed = modelIndexed;
    target.modelAvailable = uClientModelAvailable || status !== 'unavailable';
    target.availabilityStatus = status;
    target.fightAvailable = fightAvailable;
    target.fightPlayable = rawFightPlayable;
    var preferredBattle = battleResourceSelector.selectBattleResource({
      legacy:{
        available:fightAvailable !== false,
        playable:rawFightPlayable === true,
        playbackVerified:playbackVerified,
        staticPoseWrapper:staticPoseWrapper,
      },
      uclient:{
        available:uClientModelAvailable,
        complete:uClientModelAvailable,
        conversionReady:true,
      },
    });
    target.preferredBattleVariant = preferredBattle.selectedBattleVariant;
    target.preferredBattleReason = preferredBattle.selectionReason;
    target.normalAvailable = normalAvailable;
    target.iconAvailable = iconAvailable;
    target.skillAvailable = triState(check.skillAvailable);
    target.dedicatedUltimate = dedicatedUltimate;
    if (!hasUnifiedUltimate) target.dedicatedUltimateActions = legacyDedicatedActions;
    target.reactionActions = reactionActions;
    target.nonStandardTimeline = nonStandardTimeline;
    target.staticPoseWrapper = staticPoseWrapper;
    target.playbackVerifiedOldUi = playbackVerified && check.playbackVerifiedOldUi === true;
    target.playbackVerifiedNewUi = playbackVerified && check.playbackVerifiedNewUi === true;
    target.labels = labels;
    target.availabilityReason = uClientModelAvailable && fightAvailable === false && normalAvailable === false
      ? 'uclient-model-fallback' : String(check.reason || '');
    if (isSkin) target.entryType = 'official-skin';
    else if (target.publicDiscovery === true) target.entryType = 'public-discovery';
    else if (target.resourceVerified === true) target.entryType = 'supplemented-resource';
    else if (hasValidSeer1OfficialPetDefinition(target) && !modelIndexed &&
      (fightAvailable === true || normalAvailable === true)) target.entryType = 'special-model';
    else target.entryType = 'pet';
  }
  (catalog.items || []).forEach(function(item) {
    item.officialDefinition = hasValidSeer1OfficialPetDefinition(item);
    annotate(item, item.id, false);
    (item.extraSkins || []).forEach(function(skin) {
      annotate(skin, skin.resourceId, true);
    });
  });
  return catalog;
}

async function ensureSeer1VisibleModelAvailability(catalog, rawIds) {
  if (!catalog || !Array.isArray(catalog.items)) return catalog;
  var ids = Array.from(new Set((rawIds || []).map(parseCustomSkinId).filter(Boolean))).slice(0, 36);
  if (!ids.length) return catalog;
  var targets = new Map();
  catalog.items.forEach(function(item) {
    targets.set(parseCustomSkinId(item && item.id), item);
    (item && item.extraSkins || []).forEach(function(skin) {
      targets.set(parseCustomSkinId(skin && skin.resourceId), skin);
    });
  });
  var checks = catalog.modelStructureChecks && typeof catalog.modelStructureChecks === 'object'
    ? catalog.modelStructureChecks : (catalog.modelStructureChecks = {});
  var now = Date.now();
  var maxAge = 12 * 60 * 60 * 1000;
  function localFightEntry(id) {
    return (_customSkins || []).find(function(entry) {
      var sourceId = parseCustomSkinId(entry && entry.sourceId);
      var skinId = parseCustomSkinId(entry && entry.skinId);
      var source = String(entry && entry.files && entry.files.fight || '').trim();
      return !!source && !findSeer1ManagedUClientEntry(id) &&
        (sourceId === id || (!sourceId && skinId === id));
    }) || null;
  }
  function localFightNeedsInspection(id, check) {
    if (findSeer1ManagedUClientEntry(id) && check.localFightFingerprint) return true;
    var entry = localFightEntry(id);
    if (!entry) return false;
    var source = String(entry.files && entry.files.fight || '').trim();
    if (!source || /^https?:\/\//i.test(source)) return false;
    try {
      var absolute = resolveCustomSkinSourceForRuntime(source);
      var stat = fs.statSync(absolute);
      var fingerprint = [Number(stat.size) || 0, Math.round(Number(stat.mtimeMs) || 0)].join('|');
      return check.inspectionVersion !== SEER1_BATTLE_INSPECTION_VERSION ||
        check.localFightFingerprint !== fingerprint;
    } catch(_) { return false; }
  }
  var candidates = ids.filter(function(id) {
    if (!targets.has(id)) return false;
    var check = checks[String(id)] || {};
    var checkedAt = Date.parse(String(check.visibleProbeAt || ''));
    var hasVerdict = typeof check.fightAvailable === 'boolean' && typeof check.normalAvailable === 'boolean';
    return localFightNeedsInspection(id, check) ||
      (check.fightAvailable === true && check.inspectionVersion !== SEER1_BATTLE_INSPECTION_VERSION) || !hasVerdict ||
      !Number.isFinite(checkedAt) || now - checkedAt >= maxAge;
  });
  if (!candidates.length) return applySeer1OfficialModelAvailability(catalog);
  var changed = false;
  var cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      var id = candidates[cursor++];
      var infos = await Promise.all([
        probeSeer1OfficialResourcePathInfo('/resource/fightResource/pet/swf/' + id + '.swf'),
        probeSeer1OfficialResourcePathInfo('/resource/groupFightResource/pet/' + id + '.swf'),
        probeSeer1OfficialResourcePathInfo('/resource/pet/head/' + id + '.swf'),
      ]);
      var previous = checks[String(id)] || {};
      var check = Object.assign({}, previous);
      if (infos[0] && typeof infos[0].available === 'boolean') check.fightAvailable = infos[0].available;
      if (infos[1] && typeof infos[1].available === 'boolean') check.normalAvailable = infos[1].available;
      if (infos[2] && typeof infos[2].available === 'boolean') check.iconAvailable = infos[2].available;
      var fightFingerprint = seer1OfficialResourceFingerprint(infos[0]);
      if (fightFingerprint) check.fightFingerprint = fightFingerprint;
      if (check.fightAvailable === false) {
        check.fightPlayable = false;
        check.nonStandardTimeline = false;
        check.reason = 'fight-resource-missing';
      } else if (check.fightAvailable === true) {
        var localEntry = localFightEntry(id);
        var localSource = String(localEntry && localEntry.files && localEntry.files.fight || '').trim();
        if (localSource && !/^https?:\/\//i.test(localSource)) {
          try {
            var localAbsolute = resolveCustomSkinSourceForRuntime(localSource);
            var localStat = await fs.promises.stat(localAbsolute);
            var localFingerprint = [Number(localStat.size) || 0, Math.round(Number(localStat.mtimeMs) || 0)].join('|');
            if (check.inspectionVersion !== SEER1_BATTLE_INSPECTION_VERSION ||
                check.localFightFingerprint !== localFingerprint) {
              var inspection = await inspectCustomSkinBattleModel(await fs.promises.readFile(localAbsolute));
              var localPlaybackVerified = inspection.staticPoseWrapper !== true &&
                seer1OfficialPlaybackVerifiedForFingerprint(check, check.fightFingerprint);
              check.fightPlayable = inspection.staticPoseWrapper === true ? false :
                (inspection.ok === true || localPlaybackVerified ? true : null);
              check.labels = inspection.coreLabels || inspection.labels || [];
              check.dedicatedUltimate = inspection.dedicatedUltimate === true;
              check.dedicatedUltimateActions = inspection.dedicatedUltimateActions || [];
              check.dynamicCoreActions = inspection.dynamicCoreActions || [];
              check.staticCoreActions = inspection.staticCoreActions || [];
              check.reactionActions = inspection.reactionActions || [];
              check.nonStandardTimeline = inspection.ok !== true;
              check.staticPoseWrapper = inspection.staticPoseWrapper === true;
              check.reason = inspection.ok === true ? '' :
                (localPlaybackVerified ? 'playback-verified-nonstandard' :
                  (inspection.reason || 'battle-actions-nonstandard'));
              if (localPlaybackVerified) check.playbackVerifiedFingerprint = String(check.fightFingerprint || '');
              check.inspectionVersion = SEER1_BATTLE_INSPECTION_VERSION;
              check.localFightFingerprint = localFingerprint;
            }
            var localSkill = String(localEntry && localEntry.files && localEntry.files.skill || '').trim();
            check.skillAvailable = !!(localSkill && !/^https?:\/\//i.test(localSkill) &&
              fs.existsSync(resolveCustomSkinSourceForRuntime(localSkill)));
          } catch(e) {
            check.localInspectionError = String(e && e.message || e).slice(0, 160);
          }
        } else if (check.inspectionVersion !== SEER1_BATTLE_INSPECTION_VERSION ||
                   previous.fightFingerprint !== fightFingerprint ||
                   previous.localFightFingerprint ||
                   !Object.prototype.hasOwnProperty.call(previous, 'fightPlayable')) {
          try {
            var fetched = await fetchOfficialCustomSkinModel(id, CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES.fight);
            var remoteInspection = await inspectCustomSkinBattleModel(fetched.buffer);
            var previousPlaybackVerified = remoteInspection.staticPoseWrapper !== true &&
              previous.fightFingerprint === fightFingerprint &&
              seer1OfficialPlaybackVerifiedForFingerprint(previous, fightFingerprint);
            check.fightPlayable = remoteInspection.staticPoseWrapper === true ? false :
              (remoteInspection.ok === true || previousPlaybackVerified ? true : null);
            check.labels = remoteInspection.coreLabels || remoteInspection.labels || [];
            check.dedicatedUltimate = remoteInspection.dedicatedUltimate === true;
            check.dedicatedUltimateActions = remoteInspection.dedicatedUltimateActions || [];
            check.dynamicCoreActions = remoteInspection.dynamicCoreActions || [];
            check.staticCoreActions = remoteInspection.staticCoreActions || [];
            check.reactionActions = remoteInspection.reactionActions || [];
            check.nonStandardTimeline = remoteInspection.nonStandardTimeline === true;
            check.staticPoseWrapper = remoteInspection.staticPoseWrapper === true;
            check.reason = remoteInspection.ok === true ? '' :
              (previousPlaybackVerified ? 'playback-verified-nonstandard' : (remoteInspection.reason || ''));
            check.inspectionVersion = SEER1_BATTLE_INSPECTION_VERSION;
            delete check.localFightFingerprint;
            if (previousPlaybackVerified) {
              check.playbackVerifiedAt = previous.playbackVerifiedAt;
              check.playbackVerifiedOldUi = previous.playbackVerifiedOldUi === true;
              check.playbackVerifiedNewUi = previous.playbackVerifiedNewUi === true;
              check.playbackVerifiedFingerprint = fightFingerprint;
            }
          } catch(e) {
            if (!previous.localFightFingerprint && previous.fightFingerprint === fightFingerprint &&
                Object.prototype.hasOwnProperty.call(previous, 'fightPlayable')) {
              check.fightPlayable = previous.fightPlayable;
              check.staticPoseWrapper = previous.staticPoseWrapper === true;
              check.reason = String(previous.reason || '');
            } else {
              check.fightPlayable = null;
              check.reason = 'verification-temporarily-unavailable';
            }
            check.remoteInspectionError = String(e && e.message || e).slice(0, 160);
          }
        }
      }
      if (typeof check.fightAvailable === 'boolean' && typeof check.normalAvailable === 'boolean') {
        check.visibleProbeAt = new Date().toISOString();
      }
      checks[String(id)] = check;
      changed = true;
    }
  }
  await Promise.all(Array.from({ length:Math.min(6, candidates.length) }, worker));
  if (!changed) return catalog;
  var available = new Set((catalog.modelAvailabilityIds || []).map(parseCustomSkinId).filter(Boolean));
  var unavailable = new Set((catalog.modelUnavailableIds || []).map(parseCustomSkinId).filter(Boolean));
  candidates.forEach(function(id) {
    var check = checks[String(id)] || {};
    var target = targets.get(id);
    if (check.fightAvailable === true || check.normalAvailable === true ||
        target && target.uClientModelAvailable === true) {
      available.add(id);
      unavailable.delete(id);
    } else if (check.fightAvailable === false && check.normalAvailable === false) {
      available.delete(id);
      unavailable.add(id);
    }
  });
  catalog.modelAvailabilityVersion = SEER1_MODEL_AVAILABILITY_VERSION;
  catalog.modelAvailabilityIds = Array.from(available).sort(function(a, b) { return a - b; });
  catalog.modelUnavailableIds = Array.from(unavailable).sort(function(a, b) { return a - b; });
  catalog.modelUnavailablePetCount = catalog.items.filter(function(item) {
    return unavailable.has(parseCustomSkinId(item && item.id));
  }).length;
  catalog.modelUnavailableSkinCount = catalog.items.reduce(function(total, item) {
    return total + (item && item.extraSkins || []).filter(function(skin) {
      return unavailable.has(parseCustomSkinId(skin && skin.resourceId));
    }).length;
  }, 0);
  applySeer1OfficialModelAvailability(catalog);
  await saveSeer1OfficialPetCatalogCache(catalog);
  return catalog;
}

function migrateSeer1OfficialModelAvailabilityV3(catalog) {
  var indexed = new Set((catalog.modelIndexIds || []).map(parseCustomSkinId).filter(Boolean));
  var checks = catalog.modelStructureChecks && typeof catalog.modelStructureChecks === 'object'
    ? catalog.modelStructureChecks : {};
  var available = new Set();
  var unavailable = new Set();
  var uClientAvailable = new Set();
  (catalog.items || []).forEach(function(item) {
    if (item && item.uClientModelAvailable === true) uClientAvailable.add(parseCustomSkinId(item.id));
    (item && item.extraSkins || []).forEach(function(skin) {
      if (skin && skin.uClientModelAvailable === true) uClientAvailable.add(parseCustomSkinId(skin.resourceId));
    });
  });
  (catalog.items || []).forEach(function(item) {
    [item.id].concat((item.extraSkins || []).map(function(skin) { return skin.resourceId; })).forEach(function(rawId) {
      var id = parseCustomSkinId(rawId);
      if (!id) return;
      var check = checks[String(id)] || {};
      if (check.fightAvailable === false && check.normalAvailable === false && !uClientAvailable.has(id)) {
        unavailable.add(id);
      }
      else available.add(id);
      if (indexed.has(id)) {
        unavailable.delete(id);
        available.add(id);
      }
    });
  });
  catalog.modelAvailabilityVersion = SEER1_MODEL_AVAILABILITY_VERSION;
  catalog.modelAvailabilityIds = Array.from(available).sort(function(a, b) { return a - b; });
  catalog.modelUnavailableIds = Array.from(unavailable).sort(function(a, b) { return a - b; });
  catalog.modelUnavailablePetCount = (catalog.items || []).filter(function(item) { return unavailable.has(item.id); }).length;
  catalog.modelUnavailableSkinCount = (catalog.items || []).reduce(function(total, item) {
    return total + (item.extraSkins || []).filter(function(skin) { return unavailable.has(skin.resourceId); }).length;
  }, 0);
  return applySeer1OfficialModelAvailability(catalog);
}

let _seer1OfficialModelAvailabilityPromise = null;
async function ensureSeer1OfficialModelAvailability(catalog, forceRefresh, onProgress) {
  if (!catalog || !Array.isArray(catalog.items)) return catalog;
  if (!forceRefresh && catalog.modelAvailabilityVersion === SEER1_MODEL_AVAILABILITY_VERSION &&
      Array.isArray(catalog.modelUnavailableIds)) {
    return applySeer1OfficialModelAvailability(catalog);
  }
  if (!forceRefresh && catalog.modelAvailabilityVersion === 2 && Array.isArray(catalog.modelUnavailableIds)) {
    migrateSeer1OfficialModelAvailabilityV3(catalog);
    await saveSeer1OfficialPetCatalogCache(catalog);
    return catalog;
  }
  if (_seer1OfficialModelAvailabilityPromise) return await _seer1OfficialModelAvailabilityPromise;
  _seer1OfficialModelAvailabilityPromise = (async function() {
    var indexed = new Set((catalog.modelIndexIds || []).map(parseCustomSkinId).filter(Boolean));
    var candidates = [];
    var seen = new Set();
    var uClientAvailable = new Set();
    (catalog.items || []).forEach(function(item) {
      [item].concat(item.extraSkins || []).forEach(function(target) {
        var id = parseCustomSkinId(target && (target.resourceId || target.id));
        if (!id || seen.has(id)) return;
        if (target && target.uClientModelAvailable === true) uClientAvailable.add(id);
        seen.add(id);
        candidates.push(id);
      });
    });
    var available = new Set();
    var unavailable = new Set();
    var previousChecks = catalog.modelStructureChecks && typeof catalog.modelStructureChecks === 'object'
      ? catalog.modelStructureChecks : {};
    var structureChecks = {};
    function reusePreviousStructureVerdict(check, previous) {
      check.fightPlayable = previous.fightPlayable;
      check.labels = Array.isArray(previous.labels) ? previous.labels : [];
      check.reason = String(previous.reason || '');
      [
        'dedicatedUltimate', 'dedicatedUltimateActions', 'dynamicCoreActions', 'staticCoreActions',
        'reactionActions', 'nonStandardTimeline', 'structure',
        'staticPoseWrapper',
        'inspectionVersion', 'visibleProbeAt', 'playbackVerifiedAt',
        'playbackVerifiedOldUi', 'playbackVerifiedNewUi', 'playbackVerifiedFingerprint',
      ].forEach(function(key) {
        if (previous[key] !== undefined) check[key] = previous[key];
      });
      if (previous.reason === 'battle-static-pose-wrapper') check.staticPoseWrapper = true;
      if (check.staticPoseWrapper !== true &&
          seer1OfficialPlaybackVerifiedForFingerprint(check, check.fightFingerprint)) {
        check.fightPlayable = true;
        check.reason = check.nonStandardTimeline === true
          ? 'playback-verified-nonstandard' : 'playback-verified';
        check.playbackVerifiedFingerprint = String(check.fightFingerprint || '');
      }
      return check.fightPlayable === true;
    }
    candidates.forEach(function(id) { if (indexed.has(id)) available.add(id); });
    var unknown = candidates.filter(function(id) { return !indexed.has(id); });
    var probeResults = {};
    var probeCursor = 0;
    var probeCompleted = 0;
    if (typeof onProgress === 'function') onProgress({ phase:'model-head', completed:0, total:unknown.length,
      message:'正在区分传统 SWF 与 UClient 包装资源' });
    async function probeWorker() {
      while (probeCursor < unknown.length) {
        var probeId = unknown[probeCursor++];
        probeResults[String(probeId)] = await Promise.all([
          probeSeer1OfficialResourcePathInfo('/resource/fightResource/pet/swf/' + probeId + '.swf'),
          probeSeer1OfficialResourcePathInfo('/resource/groupFightResource/pet/' + probeId + '.swf'),
          probeSeer1OfficialResourcePathInfo('/resource/pet/head/' + probeId + '.swf'),
        ]);
        probeCompleted++;
        if (typeof onProgress === 'function' && (probeCompleted === unknown.length || probeCompleted % 24 === 0)) {
          onProgress({ phase:'model-head', completed:probeCompleted, total:unknown.length,
            message:'正在核对 SWF 资源路径 ' + probeCompleted + ' / ' + unknown.length });
        }
      }
    }
    await Promise.all(Array.from({ length:24 }, probeWorker));
    var structureCursor = 0;
    var structureCompleted = 0;
    if (typeof onProgress === 'function') onProgress({ phase:'model-structure', completed:0, total:unknown.length,
      message:'正在读取实际动作结构并判定 UClient 子分类' });
    async function structureWorker() {
      while (structureCursor < unknown.length) {
        var id = unknown[structureCursor++];
        var paths = probeResults[String(id)] || await Promise.all([
          probeSeer1OfficialResourcePathInfo('/resource/fightResource/pet/swf/' + id + '.swf'),
          probeSeer1OfficialResourcePathInfo('/resource/groupFightResource/pet/' + id + '.swf'),
          probeSeer1OfficialResourcePathInfo('/resource/pet/head/' + id + '.swf'),
        ]);
        var fightInfo = paths[0] || { available:null };
        var normalInfo = paths[1] || { available:null };
        var iconInfo = paths[2] || { available:null };
        var fingerprint = seer1OfficialResourceFingerprint(fightInfo);
        var previous = previousChecks[String(id)] || {};
        var fightPlayable = false;
        var check = {
          fightFingerprint:fingerprint,
          fightAvailable:fightInfo.available,
          normalAvailable:normalInfo.available,
          iconAvailable:iconInfo.available,
          checkedAt:new Date().toISOString(),
        };
        if (fightInfo.available === true) {
          if (previous.fightFingerprint === fingerprint &&
              previous.inspectionVersion === SEER1_BATTLE_INSPECTION_VERSION &&
              Object.prototype.hasOwnProperty.call(previous, 'fightPlayable')) {
            fightPlayable = reusePreviousStructureVerdict(check, previous);
          } else {
            try {
              var fetched = await fetchOfficialCustomSkinModel(id, CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES.fight);
              var inspection = await inspectCustomSkinBattleModel(fetched.buffer);
              var previousPlaybackVerified = inspection.staticPoseWrapper !== true &&
                previous.fightFingerprint === fingerprint &&
                seer1OfficialPlaybackVerifiedForFingerprint(previous, fingerprint);
              fightPlayable = inspection.ok === true || previousPlaybackVerified;
              check.fightPlayable = inspection.staticPoseWrapper === true ? false :
                (fightPlayable ? true : null);
              check.labels = inspection.coreLabels || inspection.labels || [];
              check.dedicatedUltimate = inspection.dedicatedUltimate === true;
              check.dedicatedUltimateActions = inspection.dedicatedUltimateActions || [];
              check.dynamicCoreActions = inspection.dynamicCoreActions || [];
              check.staticCoreActions = inspection.staticCoreActions || [];
              check.reactionActions = inspection.reactionActions || [];
              check.nonStandardTimeline = inspection.nonStandardTimeline === true;
              check.staticPoseWrapper = inspection.staticPoseWrapper === true;
              check.reason = inspection.ok === true ? '' :
                (previousPlaybackVerified ? 'playback-verified-nonstandard' : (inspection.reason || ''));
              check.inspectionVersion = SEER1_BATTLE_INSPECTION_VERSION;
              if (previousPlaybackVerified) {
                check.playbackVerifiedAt = previous.playbackVerifiedAt;
                check.playbackVerifiedOldUi = previous.playbackVerifiedOldUi === true;
                check.playbackVerifiedNewUi = previous.playbackVerifiedNewUi === true;
                check.playbackVerifiedFingerprint = fingerprint;
              }
            } catch(e) {
              if (Object.prototype.hasOwnProperty.call(previous, 'fightPlayable')) {
                fightPlayable = reusePreviousStructureVerdict(check, previous);
              } else {
                check.fightPlayable = null;
                check.reason = 'verification-temporarily-unavailable';
              }
            }
          }
        } else {
          check.fightPlayable = false;
          check.reason = fightInfo.available === false ? 'fight-resource-missing' : 'fight-resource-unverified';
        }
        structureChecks[String(id)] = check;
        if (fightInfo.available === true || fightPlayable || normalInfo.available === true ||
            uClientAvailable.has(id)) available.add(id);
        else if (fightInfo.available === false && normalInfo.available === false) unavailable.add(id);
        else if (Array.isArray(catalog.modelAvailabilityIds) && catalog.modelAvailabilityIds.indexOf(id) >= 0) available.add(id);
        else available.add(id);
        structureCompleted++;
        if (typeof onProgress === 'function' && (structureCompleted === unknown.length || structureCompleted % 8 === 0)) {
          onProgress({ phase:'model-structure', completed:structureCompleted, total:unknown.length,
            message:'正在校验动作结构 ' + structureCompleted + ' / ' + unknown.length });
        }
      }
    }
    await Promise.all(Array.from({ length:4 }, structureWorker));
    catalog.modelAvailabilityVersion = SEER1_MODEL_AVAILABILITY_VERSION;
    catalog.modelAvailabilityIds = Array.from(available).sort(function(a, b) { return a - b; });
    catalog.modelUnavailableIds = Array.from(unavailable).sort(function(a, b) { return a - b; });
    catalog.modelStructureChecks = structureChecks;
    catalog.modelUnavailablePetCount = catalog.items.filter(function(item) { return unavailable.has(item.id); }).length;
    catalog.modelUnavailableSkinCount = catalog.items.reduce(function(total, item) {
      return total + (item.extraSkins || []).filter(function(skin) { return unavailable.has(skin.resourceId); }).length;
    }, 0);
    applySeer1OfficialModelAvailability(catalog);
    await saveSeer1OfficialPetCatalogCache(catalog);
    return catalog;
  })();
  try { return await _seer1OfficialModelAvailabilityPromise; }
  finally { _seer1OfficialModelAvailabilityPromise = null; }
}

async function loadSeer1OfficialPetCatalog(forceRefresh, options) {
  options = options || {};
  var publish = options.publish !== false;
  if (_seer1OfficialPetCatalogCache && !forceRefresh && publish) return _seer1OfficialPetCatalogCache;
  try {
    var config = await loadSeer1OfficialSkillConfig(forceRefresh === true);
    var loadedCatalog = normalizeSeer1OfficialPetCatalog(config);
    var previous = options.previousCatalog || await officialCatalogStore.read();
    if (previous && Array.isArray(previous.items)) {
      var known = new Set(loadedCatalog.items.map(function(item) { return item.id; }));
      previous.items.filter(function(item) {
        return item && item.resourceVerified === true && item.publicDiscovery !== true;
      }).forEach(function(item) {
        if (!known.has(item.id)) loadedCatalog.items.push(item);
      });
      loadedCatalog.items.sort(function(a, b) { return a.id - b.id; });
      ['resourceSupplementVersion','resourceSupplementIds','modelAvailabilityVersion','modelAvailabilityIds',
        'modelUnavailableIds','modelUnavailablePetCount','modelUnavailableSkinCount','modelStructureChecks',
        'uClientBattlePackageVersion','uClientModelRequestIds','uClientCheckedAt','uClientRefreshError',
        'uClientPetPackageVersion','uClientPetIds','uClientPetCheckedAt','uClientPetRefreshError',
        'uClientIdentityVersion','uClientSnapshotFingerprint','uClientPackageVersions',
        'uClientManifestSha256','uClientCounts'].forEach(function(key) {
        if (previous[key] !== undefined) loadedCatalog[key] = previous[key];
      });
    }
    officialCatalogStore.migrate(loadedCatalog);
    sanitizeSeer1OfficialOnlyCatalog(loadedCatalog);
    if (options.deferSave !== true) await saveSeer1OfficialPetCatalogCache(loadedCatalog);
    if (publish) _seer1OfficialPetCatalogCache = loadedCatalog;
    return loadedCatalog;
  } catch(networkError) {
    if (options.allowCacheFallback === false) throw networkError;
    try {
      var cached = await officialCatalogStore.read();
      if (!cached || !Array.isArray(cached.items) || !cached.items.length) throw networkError;
      if ((parseInt(cached.version, 10) || 0) < 2) cached.version = 2;
      officialCatalogStore.migrate(cached);
      sanitizeSeer1OfficialOnlyCatalog(cached);
      cached.fromCache = true;
      if (publish) _seer1OfficialPetCatalogCache = cached;
      return cached;
    } catch(cacheError) {
      throw networkError;
    }
  }
}

function findSeer1ManagedUClientEntry(rawId) {
  var id = parseCustomSkinId(rawId);
  return (_customSkins || []).find(function(entry) {
    var entryId = parseCustomSkinId(entry && (entry.sourceId || entry.skinId));
    return entryId === id && (entry.previewAdapter === 'uclient' ||
      entry.selectedBattleVariant === 'uclient-self-contained');
  }) || null;
}

async function refreshSeer1OfficialPetCatalog(onProgress) {
  function report(payload) {
    if (typeof onProgress === 'function') {
      try { onProgress(Object.assign({ at:Date.now() }, payload || {})); } catch(_) {}
    }
  }
  var previousCatalog = _seer1OfficialPetCatalogCache;
  if (!previousCatalog) {
    try { previousCatalog = await officialCatalogStore.read(); } catch(ignored) {}
  }
  _seer1OfficialCatalogRefreshNonce = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
  try {
    report({ phase:'catalog', completed:0, total:2, message:'正在无缓存获取 U 端当前身份清单' });
    var stagedSnapshot = await uClientSnapshotService.stageIdentitySnapshot(true);
    report({ phase:'catalog', completed:1, total:2, message:'正在生成精灵本体与官方皮肤身份目录' });
    var catalog = uClientIdentityCatalog.build(stagedSnapshot);
    _seer1OfficialCatalogRefreshDraft = catalog;
    catalog.fromCache = false;
    catalog.updatedAt = new Date().toISOString();
    await commitSeer1OfficialPetCatalogCache(catalog, {
      injectFailure:process.env.LAUNCHER_AUTOTEST_CATALOG_COMMIT_FAIL_PHASE
        ? function(phase) {
          if (phase === process.env.LAUNCHER_AUTOTEST_CATALOG_COMMIT_FAIL_PHASE) {
            throw new Error('injected official catalog commit failure at ' + phase);
          }
        } : null,
    });
    // stageIdentitySnapshot() intentionally contains only ConfigPackage and
    // identity data.  It must never enter the four-package resource cache:
    // downloads started immediately after a catalog refresh need to rebuild a
    // complete battle/follow/timeline snapshot.
    uClientSnapshotService.clear();
    _seer1OfficialPetCatalogCache = catalog;
    report({ phase:'finished', completed:2, total:2, message:'U 端身份资料已无缓存刷新并原子更新' });
    return {
      ok:true,
      updatedAt:catalog.updatedAt,
      catalogRevision:String(catalog.catalogRevision || ''),
      petCount:(catalog.items || []).length,
      skinCount:(catalog.items || []).reduce(function(total, item) {
        return total + (item.extraSkins || []).length;
      }, 0),
      officialDiscoverySource:String(catalog.officialDiscoverySource || ''),
      officialDiscoveryFingerprint:String(catalog.officialDiscoveryFingerprint || ''),
      officialDiscoveryCheckedAt:String(catalog.officialDiscoveryCheckedAt || ''),
      uClientPackageVersions:Object.assign({}, catalog.uClientPackageVersions || {}),
      manualSupplementIds:(catalog.manualSupplementIds || []).slice(),
    };
  } catch(e) {
    _seer1OfficialPetCatalogCache = previousCatalog;
    report({ phase:'failed', completed:0, total:1, message:'刷新失败：' + e.message, error:e.message });
    throw e;
  } finally {
    _seer1OfficialCatalogRefreshDraft = null;
    _seer1OfficialCatalogRefreshNonce = '';
  }
}

async function markSeer1OfficialPlaybackVerified(request) {
  var id = parseCustomSkinId(request && request.id);
  var surface = String(request && request.surface || 'new-ui').toLowerCase();
  var labels = (Array.isArray(request && request.labels) ? request.labels : []).map(function(label) {
    return String(label || '').trim().toLowerCase();
  }).filter(function(label, index, all) {
    return !!label && label.length <= 80 && all.indexOf(label) === index;
  }).slice(0, 80);
  if (!id || !labels.length) return { ok:false, error:'缺少可播放动作证据' };
  var catalog = await loadSeer1OfficialPetCatalog();
  if (!catalog || !Array.isArray(catalog.items)) return { ok:false, error:'官方目录尚未加载' };
  var known = catalog.items.some(function(item) {
    if (parseCustomSkinId(item && item.id) === id) return true;
    return (item && item.extraSkins || []).some(function(skin) {
      return parseCustomSkinId(skin && skin.resourceId) === id;
    });
  });
  if (!known) return { ok:false, error:'该资源不属于当前官方目录' };
  catalog = await ensureSeer1VisibleModelAvailability(catalog, [id]);
  if (!catalog.modelStructureChecks || typeof catalog.modelStructureChecks !== 'object') {
    catalog.modelStructureChecks = {};
  }
  var check = catalog.modelStructureChecks[String(id)] || {};
  if (check.inspectionVersion !== SEER1_BATTLE_INSPECTION_VERSION) {
    return { ok:false, error:'动作结构尚未按当前规则完成审计' };
  }
  var staticPoseWrapper = check.inspectionVersion === SEER1_BATTLE_INSPECTION_VERSION &&
    (check.staticPoseWrapper === true || check.reason === 'battle-static-pose-wrapper');
  if (staticPoseWrapper || (check.fightPlayable !== true && request.motionVerified !== true)) {
    return { ok:false, error:staticPoseWrapper ? '传统 SWF 是静态兼容壳' : '仅有动作标签，缺少连续画面变化证据' };
  }
  var structurallyNonStandard = check.nonStandardTimeline === true ||
    (check.fightAvailable === true && check.fightPlayable !== true);
  check.fightAvailable = true;
  check.fightPlayable = staticPoseWrapper ? false : true;
  check.staticPoseWrapper = staticPoseWrapper;
  check.nonStandardTimeline = structurallyNonStandard;
  check.labels = Array.from(new Set((Array.isArray(check.labels) ? check.labels : []).concat(labels))).slice(0, 80);
  check.reason = staticPoseWrapper ? 'battle-static-pose-wrapper' :
    (structurallyNonStandard ? 'playback-verified-nonstandard' : 'playback-verified');
  check.playbackVerifiedAt = new Date().toISOString();
  check.playbackVerifiedFingerprint = String(check.fightFingerprint || '');
  if (surface === 'old-ui') check.playbackVerifiedOldUi = true;
  else check.playbackVerifiedNewUi = true;
  catalog.modelStructureChecks[String(id)] = check;
  catalog.modelAvailabilityVersion = SEER1_MODEL_AVAILABILITY_VERSION;
  catalog.modelAvailabilityIds = Array.from(new Set((catalog.modelAvailabilityIds || []).concat([id]))).sort(function(a, b) { return a - b; });
  catalog.modelUnavailableIds = (catalog.modelUnavailableIds || []).map(parseCustomSkinId).filter(function(value) {
    return !!value && value !== id;
  }).sort(function(a, b) { return a - b; });
  var unavailable = new Set(catalog.modelUnavailableIds);
  catalog.modelUnavailablePetCount = catalog.items.filter(function(item) {
    return unavailable.has(parseCustomSkinId(item && item.id));
  }).length;
  catalog.modelUnavailableSkinCount = catalog.items.reduce(function(total, item) {
    return total + (item.extraSkins || []).filter(function(skin) {
      return unavailable.has(parseCustomSkinId(skin && skin.resourceId));
    }).length;
  }, 0);
  applySeer1OfficialModelAvailability(catalog);
  await saveSeer1OfficialPetCatalogCache(catalog);
  var item = null;
  catalog.items.some(function(pet) {
    if (pet.id === id) { item = pet; return true; }
    var skin = (pet.extraSkins || []).find(function(candidate) { return candidate.resourceId === id; });
    if (skin) { item = skin; return true; }
    return false;
  });
  return {
    ok:true,
    id:id,
    availabilityStatus:item && item.availabilityStatus,
    fightPlayable:item && item.fightPlayable === true,
    playbackVerifiedOldUi:item && item.playbackVerifiedOldUi === true,
    playbackVerifiedNewUi:item && item.playbackVerifiedNewUi === true,
    nonStandardTimeline:item && item.nonStandardTimeline === true,
  };
}

async function loadSeer1OfficialPetCatalogFast() {
  if (_seer1OfficialPetCatalogCache && Array.isArray(_seer1OfficialPetCatalogCache.items)) {
    return _seer1OfficialPetCatalogCache;
  }
  try {
    var cached = await officialCatalogStore.read();
    if (cached && cached.source === 'u-client-config' && Array.isArray(cached.items) && cached.items.length) {
      cached.fromCache = true;
      _seer1OfficialPetCatalogCache = cached;
      return cached;
    }
  } catch(error) {
    logWarn('CustomSkin', 'U-client identity catalog cache read failed', { error:error.message });
  }
  await refreshSeer1OfficialPetCatalog();
  if (!_seer1OfficialPetCatalogCache) throw new Error('U-client identity catalog refresh did not publish a snapshot');
  return _seer1OfficialPetCatalogCache;
}

async function querySeer1OfficialPetCatalog(request) {
  var queryStartedAt = Date.now();
  var catalog = await loadSeer1OfficialPetCatalogFast();
  var result = uClientIdentityCatalog.query(catalog, request || {}, customSkinDownloadedSourceIds());
  result.fast = true;
  result.elapsedMs = Date.now() - queryStartedAt;
  return result;
}

function normalizeSeer1GroupFightEffectName(value) {
  value = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(value) ? value : '';
}

function seer1MoveById(config, moveId) {
  return config && config.movesById ? config.movesById[String(parseCustomSkinId(moveId))] || null : null;
}

function seer1MonsterById(config, monsterId) {
  var monsters = config && config.monsters && config.monsters.Monsters && config.monsters.Monsters.Monster;
  monsters = Array.isArray(monsters) ? monsters : (monsters ? [monsters] : []);
  return monsters.find(function(item) { return parseInt(item && item.ID, 10) === parseCustomSkinId(monsterId); }) || null;
}

async function resolveSeer1OfficialActionEffects(sourceId, basePetId) {
  var id = parseCustomSkinId(sourceId);
  var config = await loadSeer1OfficialSkillConfig();
  var monsterId = parseCustomSkinId(basePetId) || id;
  var monster = seer1MonsterById(config, monsterId);
  if (!monster) throw new Error('官方当前 RobotCore 中没有该精灵');
  var rawMoves = monster.LearnableMoves && monster.LearnableMoves.Move;
  rawMoves = Array.isArray(rawMoves) ? rawMoves : (rawMoves ? [rawMoves] : []);
  var recommended = rawMoves.filter(function(item) { return String(item && item.Rec || '') === '1'; });
  if (!recommended.length) recommended = rawMoves;
  var categoryMap = { 1:'physical', 2:'special', 4:'property' };
  var effects = {};
  recommended.forEach(function(item) {
    var skillId = parseCustomSkinId(item && item.ID);
    var move = seer1MoveById(config, skillId);
    var type = move ? categoryMap[parseInt(move.Category, 10)] : '';
    var effectName = move ? normalizeSeer1GroupFightEffectName(move.Url) : '';
    if (!type || !effectName || effects[type]) return;
    effects[type] = {
      type:type,
      skillId:skillId,
      name:String(move.Name || '').trim(),
      effectName:effectName,
    };
  });
  return { sourceId:id, basePetId:monsterId, name:String(monster.DefName || '').trim(), effects:effects };
}

async function resolveSeer1OfficialUltimate(sourceId, basePetId, officialSkinId) {
  var id = parseCustomSkinId(sourceId);
  if (!id) throw new Error('精灵序号无效');
  var config = await loadSeer1OfficialSkillConfig();
  var monsterId = parseCustomSkinId(basePetId) || id;
  var monster = seer1MonsterById(config, monsterId);
  if (!monster) throw new Error('官方当前 RobotCore 中没有该精灵');
  var extra = monster.ExtraMoves && monster.ExtraMoves.Move;
  var extraMoves = Array.isArray(extra) ? extra : (extra ? [extra] : []);
  var skillId = extraMoves.length ? parseCustomSkinId(extraMoves[extraMoves.length - 1].ID) : 0;
  if (!skillId) {
    var noFifth = new Error('官方配置未声明第五技能资源 ID');
    noFifth.code = 'ULTIMATE_UNAVAILABLE';
    noFifth.category = 'unsupported-action';
    noFifth.optional = true;
    throw noFifth;
  }
  var root = config.replacements && config.replacements.Root;
  var replacements = root && root.item;
  replacements = Array.isArray(replacements) ? replacements : (replacements ? [replacements] : []);
  var catalogueSkinId = parseCustomSkinId(officialSkinId);
  var mapping = replacements.find(function(item) {
    return (parseInt(item && item.skinid, 10) === catalogueSkinId || parseInt(item && item.petid, 10) === monsterId) &&
      parseInt(item && item.skill && item.skill.id, 10) === skillId;
  });
  var replacementSkillId = parseCustomSkinId(mapping && mapping.skill && mapping.skill.replaceId);
  var effectMove = seer1MoveById(config, replacementSkillId || skillId) || seer1MoveById(config, skillId);
  return {
    sourceId:id,
    basePetId:monsterId,
    name:String(monster.DefName || '').trim(),
    skillId:skillId,
    action:String(mapping && mapping.skill && mapping.skill.action || '').trim(),
    replacementSkillId:replacementSkillId,
    effectName:normalizeSeer1GroupFightEffectName(effectMove && effectMove.Url),
  };
}

async function annotateDirectSeer1OfficialSkinJobs(request, jobs) {
  if (!request || Array.isArray(request.jobs) || !Array.isArray(jobs) || !jobs.length) return jobs;
  var directIds = new Set(parseCustomSkinDownloadIds(request.ids));
  if (!directIds.size) return jobs;
  var identityCatalog = _seer1OfficialPetCatalogCache;
  if (!identityCatalog) {
    try { identityCatalog = await officialCatalogStore.read(); } catch(_) {}
  }
  var skins = [];
  (identityCatalog && Array.isArray(identityCatalog.items) ? identityCatalog.items : []).forEach(function(item) {
    (Array.isArray(item && item.extraSkins) ? item.extraSkins : []).forEach(function(skin) {
      skins.push({
        resourceId:parseCustomSkinId(skin && (skin.resourceId || skin.id)),
        monId:parseCustomSkinId(skin && skin.basePetId) || parseCustomSkinId(item && item.id),
        id:parseCustomSkinId(skin && (skin.officialSkinId || skin.catalogueId)),
        name:String(skin && skin.name || '').trim(),
      });
    });
  });
  var byResourceId = {};
  skins.forEach(function(item) {
    var resourceId = parseCustomSkinId(item && item.resourceId);
    if (resourceId) byResourceId[String(resourceId)] = item;
  });
  jobs.forEach(function(job) {
    var item = byResourceId[String(job.id)];
    if (!item) return;
    job.basePetId = parseCustomSkinId(item.monId);
    job.officialSkinId = parseCustomSkinId(item.id);
    job.officialName = String(item.name || '').trim().slice(0, 80);
    job.sourceKind = 'official-skin';
  });
  return jobs;
}

async function expandSeer1OfficialSkinJobs(request, jobs) {
  if (!request || request.includeSkins !== true || Array.isArray(request.jobs)) return jobs;
  var identityCatalog = _seer1OfficialPetCatalogCache;
  if (!identityCatalog) {
    try { identityCatalog = await officialCatalogStore.read(); } catch(_) {}
  }
  var ids = new Set(parseCustomSkinDownloadIds(request.ids));
  var types = (Array.isArray(request.types) ? request.types : []).filter(function(type) {
    return type !== 'ultimate' && !!CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES[type];
  });
  var seen = new Set(jobs.map(function(job) { return job.id + ':' + job.type; }));
  (identityCatalog && Array.isArray(identityCatalog.items) ? identityCatalog.items : []).forEach(function(item) {
    var basePetId = parseCustomSkinId(item && item.id);
    if (!basePetId || !ids.has(basePetId)) return;
    (Array.isArray(item.extraSkins) ? item.extraSkins : []).forEach(function(skin) {
      var resourceId = parseCustomSkinId(skin && (skin.resourceId || skin.id));
      var officialSkinId = parseCustomSkinId(skin && (skin.officialSkinId || skin.catalogueId));
      if (!resourceId) return;
      types.forEach(function(type) {
        var key = resourceId + ':' + type;
        if (seen.has(key)) return;
        seen.add(key);
        jobs.push({
          id:resourceId,
          type:type,
          queueRootId:basePetId,
          basePetId:basePetId,
          officialSkinId:officialSkinId,
          officialName:String(skin && skin.name || '').trim().slice(0, 80),
          sourceKind:'official-skin',
        });
      });
    });
  });
  return jobs;
}

function customSkinDownloadDirectory() {
  return path.resolve(_customSkinDownloadDir || CUSTOM_SKIN_DEFAULT_DOWNLOAD_DIR);
}

const UCLIENT_PET_PACKAGE_ROOT = 'https://newseer.61.com/Assets/StandaloneWindows64/PetAnimPackage/';
const UCLIENT_PET_VERSION_URL = UCLIENT_PET_PACKAGE_ROOT + 'PackageManifest_PetAnimPackage.version';
const _uClientPetPreviewPrepareJobs = new Map();

function backfillRegisteredUClientPetMetadata(expectedRevision, expectedGeneration) {
  var changed = false;
  var candidateSkins = cloneCustomSkinProjectionValue(_customSkins || [], []);
  candidateSkins.forEach(function(entry) {
    var sourceId = parseCustomSkinId(entry && entry.sourceId);
    if (!sourceId || !entry.files || !entry.files.fight) return;
    var metadataFile = path.join(customSkinDownloadDirectory(), String(sourceId), 'uclient-preview', 'uclient-preview.json');
    try {
      var metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
      var capabilities = uClientActionCapabilities(metadata.actions);
      // Extractor-owned preview metadata can be observed before the parent
      // download process enriches it with package identity.  Treat missing or
      // empty identity fields as "no new evidence" so a background backfill
      // can never erase a previously committed registry value.
      var metadataPackageVersion = String(metadata.packageVersion || '').trim().slice(0, 40);
      var metadataAssetPath = String(metadata.assetPath || '').trim().slice(0, 240);
      var packageVersionChanged = !!metadataPackageVersion &&
        String(entry.uClientPackageVersion || '') !== metadataPackageVersion;
      var assetPathChanged = !!metadataAssetPath &&
        String(entry.uClientAssetPath || '') !== metadataAssetPath;
      if (entry.previewAdapter !== 'uclient' ||
          JSON.stringify(normalizeUClientActions(entry.uClientActions)) !== JSON.stringify(capabilities.actions) ||
          entry.uClientDedicatedUltimate !== capabilities.dedicatedUltimate ||
          packageVersionChanged || assetPathChanged) {
        entry.previewAdapter = 'uclient';
        entry.uClientActions = capabilities.actions;
        entry.uClientDedicatedUltimate = capabilities.dedicatedUltimate;
        if (metadataPackageVersion) entry.uClientPackageVersion = metadataPackageVersion;
        if (metadataAssetPath) entry.uClientAssetPath = metadataAssetPath;
        changed = true;
      }
    } catch(_) {}
  });
  if (changed) {
    if ((expectedRevision != null && expectedRevision !== _customSkinRevision) ||
        (expectedGeneration != null && expectedGeneration !== _customSkinStorageGeneration) ||
        _customSkinSuiteCommitDepth > 0) return false;
    var persisted = persistAndApplyCustomSkins(candidateSkins, { reload:false });
    if (!persisted.ok) logWarn('CustomSkin', 'UClient metadata backfill failed', { error:persisted.error });
  }
  return changed;
}

const uClientSnapshotService = createUClientSnapshotService({
  fs:fs, path:path, crypto:crypto, catalog:uClientCatalog,
  fetchBuffer:fetchCustomSkinBuffer, freshUrl:seer1OfficialFreshUrl,
  writeBuffer:writeCustomSkinDownloadFile, runExtractor:runUClientPetExtractor,
  cacheDirectory:function() {
    var root = process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT
      ? path.resolve(process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT) : app.getPath('userData');
    return path.join(root, 'cache', 'uclient-resource-snapshot');
  },
});

async function getCurrentUClientSnapshot(forceRefresh) {
  return await uClientSnapshotService.getSnapshot(!!forceRefresh);
}

async function getCurrentUClientPetManifest(forceRefresh, options) {
  if (options && options.stageSnapshot === true) {
    var staged = await uClientSnapshotService.stageSnapshot(!!forceRefresh);
    _seer1OfficialCatalogRefreshUClientSnapshot = staged;
    return uClientSnapshotService.modelManifestFromSnapshot(staged);
  }
  return await uClientSnapshotService.getModelManifest(!!forceRefresh);
}

async function ensureSeer1OfficialUClientAvailability(catalog, forceRefresh, onProgress, options) {
  catalog = catalog || {};
  try {
    if (typeof onProgress === 'function') onProgress({ phase:'uclient-manifest', completed:0, total:1,
      message:'正在同步官方 UClient PetAnimPackage 清单' });
    var current = await getCurrentUClientPetManifest(!!forceRefresh, options);
    var changed = String(catalog.uClientBattlePackageVersion || '') !== String(current.version || '') ||
      String(catalog.uClientSnapshotFingerprint || '') !== String(current.fingerprint || '') ||
      !Array.isArray(catalog.uClientModelRequestIds) ||
      catalog.uClientModelRequestIds.length !== current.modelRequestIds.length;
    mergeUClientIdentityIntoCatalog(catalog,current.snapshot);
    catalog.uClientBattlePackageVersion = String(current.version || '');
    catalog.uClientModelRequestIds = current.modelRequestIds.slice();
    catalog.uClientCheckedAt = new Date().toISOString();
    delete catalog.uClientRefreshError;
    if (changed) await saveSeer1OfficialPetCatalogCache(catalog);
    if (typeof onProgress === 'function') onProgress({ phase:'uclient-manifest', completed:1, total:1,
      message:'UClient 清单已同步，正在与 SWF 结构结果交叉分类' });
    return catalog;
  } catch(error) {
    if (forceRefresh || !Array.isArray(catalog.uClientModelRequestIds)) throw error;
    catalog.uClientRefreshError = error.message;
    return catalog;
  }
}

function resolveUClientPetExtractor() {
  var executableName = process.arch === 'x64'
    ? 'uclient-pet-extractor-x64.exe'
    : 'uclient-pet-extractor.exe';
  var candidates = [];
  if (process.env.SEER_UCLIENT_PET_EXTRACTOR) candidates.push(process.env.SEER_UCLIENT_PET_EXTRACTOR);
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', executableName));
    candidates.push(path.join(process.resourcesPath, executableName));
  }
  candidates.push(path.join(__dirname.replace(/app\.asar([\\/]|$)/i,
    'app.asar.unpacked$1'), executableName));
  candidates.push(path.join(__dirname, executableName));
  return candidates.map(function(file) { return path.resolve(file); }).find(function(file) {
    try { return fs.existsSync(file); } catch(_) { return false; }
  }) || '';
}

function runUClientPetExtractorNative(bundleFile, outputDirectory, sourceId, dependencyFiles, options) {
  return new Promise(function(resolve, reject) {
    options = options || {};
    var executable = resolveUClientPetExtractor();
    if (!executable) return reject(new Error('UClient pet animation extractor is missing'));
    var childArguments = [
      '--bundle', bundleFile,
      '--output', outputDirectory,
      '--source-id', String(sourceId),
    ];
    if (options.mode) childArguments.push('--mode',String(options.mode));
    if (options.assetPath) childArguments.push('--asset-path',String(options.assetPath));
    (Array.isArray(dependencyFiles) ? dependencyFiles : []).forEach(function(file) {
      childArguments.push('--dependency', String(file));
    });
    var child = spawn(executable, childArguments, { windowsHide:true, stdio:['ignore', 'pipe', 'pipe'] });
    var stdout = '';
    var stderr = '';
    var timer = setTimeout(function() {
      try { child.kill(); } catch(_) {}
      reject(new Error('UClient pet animation extraction timed out'));
    }, 180000);
    child.stdout.on('data', function(chunk) { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', function(chunk) { stderr += chunk.toString('utf8'); });
    child.on('error', function(error) { clearTimeout(timer); reject(error); });
    child.on('close', function(code) {
      clearTimeout(timer);
      var lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      var result = null;
      try { result = JSON.parse(lines[lines.length - 1] || '{}'); } catch(_) {}
      if (code !== 0 || !result || result.ok !== true) {
        reject(new Error(String(result && result.error || stderr.trim() || 'UClient pet animation extraction failed')));
      } else resolve(result);
    });
  });
}

function uClientExtractorNeedsShortPath(bundleFile, outputDirectory, dependencyFiles) {
  if (process.platform !== 'win32') return false;
  var files = [bundleFile].concat(Array.isArray(dependencyFiles) ? dependencyFiles : []);
  if (files.some(function(file) { return String(file || '').length >= 236; })) return true;
  // Native extraction creates atlas/metadata files and temporary `.part` names
  // below the requested output directory.  Keep enough headroom for those
  // suffixes before Windows' traditional MAX_PATH boundary is reached.
  return String(outputDirectory || '').length + 72 >= 236;
}

async function copyUClientExtractorTree(sourceRoot, targetRoot) {
  await fs.promises.mkdir(targetRoot, { recursive:true });
  var entries = await fs.promises.readdir(sourceRoot, { withFileTypes:true });
  for (var index = 0; index < entries.length; index++) {
    var entry = entries[index];
    var source = path.join(sourceRoot, entry.name);
    var target = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) await copyUClientExtractorTree(source, target);
    else if (entry.isFile()) await fs.promises.copyFile(source, target);
  }
}

const _uClientExtractorBridgeRoots = new Set();

function isManagedUClientExtractorBridgeRoot(root) {
  var resolved = path.resolve(String(root || ''));
  return path.dirname(resolved).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase() &&
    /^seer2-uclient-extract-\d+-[a-z0-9_-]+$/i.test(path.basename(resolved));
}

function removeUClientExtractorTreeSync(root) {
  if (!fs.existsSync(root)) return;
  var entries = fs.readdirSync(root, { withFileTypes:true });
  entries.forEach(function(entry) {
    var target = path.join(root, entry.name);
    if (entry.isDirectory()) removeUClientExtractorTreeSync(target);
    else fs.unlinkSync(target);
  });
  fs.rmdirSync(root);
}

function removeUClientExtractorBridgeSync(root) {
  if (!isManagedUClientExtractorBridgeRoot(root)) return;
  removeUClientExtractorTreeSync(root);
}

async function removeUClientExtractorBridgeWithRetry(root) {
  if (!isManagedUClientExtractorBridgeRoot(root)) return false;
  var lastError = null;
  for (var attempt = 0; attempt < 12; attempt++) {
    try {
      await fs.promises.rmdir(root, { recursive:true });
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return true;
      lastError = error;
      if (!error || ['EBUSY','EPERM','EACCES','ENOTEMPTY'].indexOf(error.code) < 0) break;
      await new Promise(function(resolve) { setTimeout(resolve, 100 + attempt * 75); });
    }
  }
  if (lastError) logWarn('CustomSkin', 'UClient extractor bridge cleanup deferred to process exit', {
    root:root, error:lastError.message });
  return false;
}

function cleanupStaleUClientExtractorBridgesSync() {
  var entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes:true }); } catch(_) { return; }
  entries.forEach(function(entry) {
    var match = entry.isDirectory() && /^seer2-uclient-extract-(\d+)-[a-z0-9_-]+$/i.exec(entry.name);
    if (!match) return;
    var ownerPid = Number(match[1]) || 0;
    if (!ownerPid || ownerPid === process.pid) return;
    var ownerAlive = false;
    try { process.kill(ownerPid, 0); ownerAlive = true; }
    catch(error) { if (error && error.code === 'EPERM') ownerAlive = true; }
    if (ownerAlive) return;
    try { removeUClientExtractorBridgeSync(path.join(os.tmpdir(), entry.name)); } catch(_) {}
  });
}

cleanupStaleUClientExtractorBridgesSync();
process.once('exit', function() {
  Array.from(_uClientExtractorBridgeRoots).forEach(function(root) {
    try { removeUClientExtractorBridgeSync(root); } catch(_) {}
  });
});

async function runUClientPetExtractor(bundleFile, outputDirectory, sourceId, dependencyFiles, options) {
  var dependencies = Array.isArray(dependencyFiles) ? dependencyFiles : [];
  if (!uClientExtractorNeedsShortPath(bundleFile, outputDirectory, dependencies)) {
    return await runUClientPetExtractorNative(
      bundleFile, outputDirectory, sourceId, dependencies, options);
  }
  var bridgeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(),
    'seer2-uclient-extract-' + process.pid + '-'));
  _uClientExtractorBridgeRoots.add(bridgeRoot);
  var bridgeBundle = path.join(bridgeRoot, 'bundle.bin');
  var bridgeOutput = path.join(bridgeRoot, 'output');
  var bridgeDependencies = [];
  try {
    await fs.promises.copyFile(bundleFile, bridgeBundle);
    for (var index = 0; index < dependencies.length; index++) {
      var bridgeDependency = path.join(bridgeRoot, 'dependency-' + index + '.bin');
      await fs.promises.copyFile(dependencies[index], bridgeDependency);
      bridgeDependencies.push(bridgeDependency);
    }
    await fs.promises.mkdir(bridgeOutput, { recursive:true });
    var result = await runUClientPetExtractorNative(
      bridgeBundle, bridgeOutput, sourceId, bridgeDependencies, options);
    await copyUClientExtractorTree(bridgeOutput, outputDirectory);
    return result;
  } finally {
    if (await removeUClientExtractorBridgeWithRetry(bridgeRoot)) {
      _uClientExtractorBridgeRoots.delete(bridgeRoot);
    }
  }
}

// The extractor may preserve an internal model id in uclient-preview.json
// (especially for namespaced official skins).  The preview/build pipeline is
// keyed by the request id, so persist that external identity before any forced
// SWF rebuild.  Keep assetId untouched: it still describes the actual U-client
// model bundle.
async function normalizeUClientPreviewMetadataIdentity(previewRoot, sourceId) {
  var id = parseCustomSkinId(sourceId);
  if (!id) throw new Error('UClient preview source id is invalid');
  var metadataFile = path.join(previewRoot, 'uclient-preview.json');
  var metadata;
  try {
    metadata = JSON.parse(await fs.promises.readFile(metadataFile, 'utf8'));
  } catch(error) {
    throw new Error('UClient preview metadata is missing or invalid: ' + error.message);
  }
  metadata.sourceId = id;
  await writeCustomSkinDownloadFile(metadataFile,
    Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'));
  return metadata;
}

function uClientPetDependencyCacheDirectory(packageVersion) {
  return path.join(app.getPath('userData'), 'cache', 'uclient-pet-materials',
    String(packageVersion || 'current').replace(/[^0-9A-Za-z._-]+/g, '_'));
}

async function ensureUClientFtrDependencies(current, asset, forceDownload, onProgress) {
  var bundles = current && current.manifest && Array.isArray(current.manifest.bundles)
    ? current.manifest.bundles : [];
  var dependencyIds = Array.isArray(asset && asset.dependIDs) ? asset.dependIDs : [];
  var selected = dependencyIds.map(function(id) {
    return { id:Number(id), bundle:bundles[Number(id)] };
  }).filter(function(item) {
    var bundle = item.bundle || {};
    var name = String(bundle.bundleName || '');
    var size = Number(bundle.fileSize || 0);
    return /^[0-9a-f]{32}$/i.test(String(bundle.fileHash || '')) &&
      size > 0 && size <= 8 * 1024 * 1024 &&
      /(?:flashtools.*materials?|unityshaders?)/i.test(name);
  });
  var totalBytes = selected.reduce(function(total, item) {
    return total + Number(item.bundle.fileSize || 0);
  }, 0);
  if (!selected.length || totalBytes > 16 * 1024 * 1024) {
    throw new Error('UClient FlashTools material dependency set is unavailable or unsafe');
  }
  var cacheRoot = uClientPetDependencyCacheDirectory(current.version);
  await fs.promises.mkdir(cacheRoot, { recursive:true });
  var files = [];
  var evidence = [];
  for (var index = 0; index < selected.length; index++) {
    var record = selected[index].bundle;
    var file = path.join(cacheRoot, String(record.fileHash).toLowerCase() + '.bundle');
    var reusable = false;
    try {
      reusable = !forceDownload && (await fs.promises.stat(file)).size === Number(record.fileSize);
    } catch(_) {}
    if (!reusable) {
      if (typeof onProgress === 'function') onProgress({
        phase:'uclient-materials', completed:index, total:selected.length,
        message:'正在同步 UClient FlashTools 共享材质 ' + (index + 1) + '/' + selected.length,
      });
      var buffer = await fetchCustomSkinBuffer(UCLIENT_PET_PACKAGE_ROOT + record.fileHash,
        30000, 0, Number(record.fileSize) + 1024);
      if (buffer.length !== Number(record.fileSize)) {
        throw new Error('UClient FlashTools material dependency size does not match the live manifest');
      }
      await writeCustomSkinDownloadFile(file, buffer);
    }
    files.push(file);
    evidence.push({
      bundleName:String(record.bundleName || ''),
      fileHash:String(record.fileHash || ''),
      bytes:Number(record.fileSize || 0),
      cacheFile:path.basename(file),
    });
  }
  return { files:files, evidence:evidence };
}

async function ensureUClientModelDependencies(current, credential, forceDownload, onProgress) {
  var route = credential && credential.conversionRoute;
  var routeFamily = String(route && route.family || '');
  if (!routeFamily || routeFamily !== String(credential && credential.family || '')) {
    throw new Error('U-client conversion route is missing or conflicts with the credential family');
  }
  if (routeFamily !== 'spine') {
    var asset = current && current.manifest && current.manifest.assets.find(function(item) {
      return String(item.assetPath || '') === String(credential && credential.model && credential.model.assetPath || '');
    });
    return await ensureUClientFtrDependencies(current,asset,forceDownload,onProgress);
  }
  var manifest = current.manifest;
  var ids = Array.isArray(credential.model.dependIDs) ? credential.model.dependIDs : [];
  var records = ids.map(function(id) { return manifest.bundles[Number(id)]; }).filter(function(bundle) {
    return bundle && /^[0-9a-f]{32}$/i.test(String(bundle.fileHash || '')) &&
      Number(bundle.fileSize || 0) > 0 && Number(bundle.fileSize || 0) <= 16 * 1024 * 1024;
  });
  var totalBytes = records.reduce(function(total,bundle) { return total + Number(bundle.fileSize || 0); },0);
  if (!records.length || totalBytes > 32 * 1024 * 1024) {
    throw new Error('U Spine dependency set is unavailable or exceeds the x32 bound');
  }
  var cacheRoot = uClientPetDependencyCacheDirectory(current.version);
  await fs.promises.mkdir(cacheRoot,{recursive:true});
  var files = [], evidence = [];
  for (var index = 0; index < records.length; index++) {
    var record = records[index];
    var file = path.join(cacheRoot,String(record.fileHash).toLowerCase() + '.bundle');
    var reusable = false;
    try { reusable = !forceDownload && (await fs.promises.stat(file)).size === Number(record.fileSize); } catch(_) {}
    if (!reusable) {
      if (typeof onProgress === 'function') onProgress({
        phase:'uclient-spine-dependencies', completed:index, total:records.length,
        message:'\u6b63\u5728\u540c\u6b65 U \u7aef Spine \u4f9d\u8d56 ' + (index + 1) + '/' + records.length,
      });
      var buffer = await fetchCustomSkinBuffer(UCLIENT_PET_PACKAGE_ROOT + record.fileHash,
        60000,0,Number(record.fileSize) + 1024,onProgress);
      if (buffer.length !== Number(record.fileSize)) throw new Error('U Spine dependency size mismatch');
      await writeCustomSkinDownloadFile(file,buffer);
    }
    files.push(file);
    evidence.push({
      bundleName:String(record.bundleName || ''), fileHash:String(record.fileHash || '').toLowerCase(),
      bytes:Number(record.fileSize || 0), cacheFile:path.basename(file),
    });
  }
  return { files:files, evidence:evidence };
}

async function promoteCachedUClientPetPreview(sourceId, previewRoot, packageVersion) {
  var id = parseCustomSkinId(sourceId);
  var cachedRoot = path.join(uClientPetPreviewCacheDirectory(), String(id), 'uclient-preview');
  if (!id || path.resolve(cachedRoot) === path.resolve(previewRoot)) return false;
  var cached = await readUClientPetPreviewRoot(id, cachedRoot, 'preview-cache');
  if (!cached.ok || cached.stale || String(cached.metadata && cached.metadata.packageVersion || '') !== String(packageVersion || '')) {
    return false;
  }
  var atlasName = String(cached.animation && cached.animation.atlas && cached.animation.atlas.file || 'uclient-atlas.webp');
  if (!/^[^\\/:*?"<>|]+$/.test(atlasName)) return false;
  var sourceAtlasName = String(cached.animation && cached.animation.sourceAtlas &&
    cached.animation.sourceAtlas.file || atlasName);
  if (!/^[^\\/:*?"<>|]+$/.test(sourceAtlasName)) return false;
  await fs.promises.mkdir(previewRoot, { recursive:true });
  var files = Array.from(new Set(['uclient-preview.json', 'uclient-animation.json.gz', atlasName, sourceAtlasName]));
  for (var fileIndex = 0; fileIndex < files.length; fileIndex++) {
    var fileName = files[fileIndex];
    await writeCustomSkinDownloadFile(path.join(previewRoot, fileName), await fs.promises.readFile(path.join(cachedRoot, fileName)));
  }
  return true;
}

function selectUClientVideoEvidence(credential) {
  var assetId = parseCustomSkinId(credential && credential.assetId);
  var videos = Array.isArray(credential && credential.videos) ? credential.videos : [];
  if (!assetId || !videos.length) return null;
  var exactPath = new RegExp('^Assets/SkillTimeline/Videos/' + assetId + '/' + assetId + '\\.mp4$','i');
  var exact = videos.filter(function(item) { return exactPath.test(String(item && item.assetPath || '')); });
  if (exact.length === 1) return exact[0];
  var ownedPath = new RegExp('^Assets/SkillTimeline/Videos/' + assetId + '/[^/]+\\.mp4$','i');
  var owned = videos.filter(function(item) { return ownedPath.test(String(item && item.assetPath || '')); });
  return owned.length === 1 ? owned[0] : null;
}

function uClientMetadataMatchesSnapshot(metadata, current, credential) {
  if (!metadata || !current || !credential) return false;
  if (String(metadata.snapshotFingerprint || '') !== String(current.fingerprint || '')) return false;
  var expected = credential.packageVersions || {};
  var actual = metadata.packageVersions || {};
  var families = credential.resourceFamilies || {};
  var skillTimeline = families.skillTimeline || {};
  var hasSupplemental = (families.standardEventVideos || []).length ||
    (skillTimeline.timelines || []).length || (skillTimeline.effects || []).length ||
    (skillTimeline.videos || []).length;
  var metadataFamily = String(metadata.family || '').toLowerCase();
  var credentialFamily = String(credential.family || '').toLowerCase();
  if (!credentialFamily || metadataFamily !== credentialFamily) return false;
  var expectedResourcePlanVersion = credentialFamily === 'spine' ? 3 : 2;
  if (hasSupplemental && Number(metadata.resourcePlanVersion || 0) !== expectedResourcePlanVersion) return false;
  if (hasSupplemental && expectedResourcePlanVersion === 3) {
    var cachedResourcePlan = metadata.resourcePlan || {};
    var cachedClosure = String(metadata.resourcePlanClosureSha256 || '').toUpperCase();
    var currentResourcePlan;
    try {
      currentResourcePlan = uClientResourceFamily.buildResourcePlan(
        credential,null,{ skillTimeline:'all-owned' });
    } catch(_) { return false; }
    if (Number(cachedResourcePlan.version || 0) !== 3 ||
        !/^[0-9A-F]{64}$/.test(cachedClosure) ||
        cachedClosure !== String(cachedResourcePlan.closureSha256 || '').toUpperCase() ||
        cachedClosure !== String(currentResourcePlan && currentResourcePlan.closureSha256 || '').toUpperCase() ||
        Number(currentResourcePlan && currentResourcePlan.ownerId) !== Number(credential.assetId) ||
        Number(metadata.sourceId) !== Number(credential.requestId) ||
        Number(metadata.assetId) !== Number(credential.assetId) ||
        String(metadata.assetPath || '').toLowerCase() !==
          String(credential.model && credential.model.assetPath || '').toLowerCase() ||
        String(metadata.bundleHash || '').toLowerCase() !==
          String(credential.model && credential.model.fileHash || '').toLowerCase()) return false;
  }
  return ['config','battle','follow','timeline'].every(function(key) {
    return String(actual[key] || '') === String(expected[key] || '');
  });
}

async function ensureUClientSkillVideo(credential, itemRoot, previewRoot, onProgress, forceDownload) {
  var evidence = selectUClientVideoEvidence(credential);
  var declaredVideos = (Array.isArray(credential && credential.videos) ? credential.videos : [])
    .filter(function(item) {
      return /^Assets\/SkillTimeline\/Videos\//i.test(String(item && item.assetPath || ''));
    });
  if (!evidence && declaredVideos.length) {
    var ambiguous = new Error('U-client video credential has no unique identity-matched MP4');
    ambiguous.code = 'UCLIENT_VIDEO_IDENTITY_UNRESOLVED';
    ambiguous.category = 'invalid-official-package';
    throw ambiguous;
  }
  if (!evidence) return null;
  var target = path.join(itemRoot,'skill.swf');
  var buildFile = path.join(itemRoot,'uclient-video-build.json');
  var videoMetadataFile = path.join(previewRoot,'uclient-video.json');
  async function prepareEmbedded(metadata, reused) {
    if (!metadata || String(metadata.assetPath || '').toLowerCase() !==
        String(evidence.assetPath || '').toLowerCase() ||
        String(metadata.bundleFileHash || '').toLowerCase() !== String(evidence.fileHash || '').toLowerCase()) {
      return null;
    }
    var mp4 = path.join(previewRoot,String(metadata.file || 'uclient-video.mp4'));
    var mp4Stat = await fs.promises.stat(mp4);
    if (mp4Stat.size !== Number(metadata.bytes || 0)) return null;
    var embedded = await uClientEmbeddedCinematic.prepare(previewRoot,metadata);
    if (!embedded) return null;
    try { await fs.promises.unlink(target); } catch(error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    var record = {
      version:1,family:'video',sourceId:credential.requestId,
      assetPath:String(metadata.assetPath || ''),sourceUrl:String(metadata.sourceUrl || ''),
      packageKey:String(metadata.packageKey || ''),packageVersion:String(metadata.packageVersion || ''),
      bundleFileHash:String(metadata.bundleFileHash || ''),bundleBytes:Number(metadata.bundleBytes || 0),
      bundleSha256:String(metadata.bundleSha256 || ''),mp4Bytes:Number(metadata.bytes || 0),
      mp4Sha256:String(metadata.sha256 || ''),embeddedInFight:true,selfContained:true,
      conversionPolicy:'audited-native-timeline-embedded-in-uclient-fight',
      cinematic:embedded,reused:reused === true,artifactLayer:'converted-build',
    };
    await writeCustomSkinDownloadFile(buildFile,Buffer.from(JSON.stringify(record,null,2),'utf8'));
    return record;
  }
  if (!forceDownload) {
    try {
      var cachedMetadata = JSON.parse(await fs.promises.readFile(videoMetadataFile,'utf8'));
      var cachedEmbedded = await prepareEmbedded(cachedMetadata,true);
      if (cachedEmbedded) return cachedEmbedded;
    } catch(error) {
      if (!error || error.code !== 'ENOENT') logWarn('CustomSkin','cached embedded cinematic skipped',{error:error.message});
    }
    try {
      var existing = JSON.parse(await fs.promises.readFile(buildFile,'utf8'));
      var existingAudit = resourceVariantIntegrity.inspectVideoSkillRoot(itemRoot, {
        sourceId:credential.requestId,
        assetPath:String(evidence.assetPath || ''),
        bundleFileHash:String(evidence.fileHash || ''),
      });
      // A legacy standalone skill.swf is not a valid cache hit once the exact
      // source video has an audited in-fight cinematic profile.  Continue into
      // the official bundle extraction below so preview and battle builds are
      // upgraded to the same self-contained timeline.
      var embeddedProfile = uClientEmbeddedCinematic.select({
        assetPath:String(existing && existing.assetPath || evidence.assetPath || ''),
        sha256:String(existing && (existing.mp4Sha256 || existing.sourceVideoSha256) || ''),
      });
      if (existingAudit.ok && existing && existing.family === 'video' && existing.selfContained === true &&
          !embeddedProfile &&
          String(existing.assetPath || '').toLowerCase() === String(evidence.assetPath || '').toLowerCase() &&
          String(existing.bundleFileHash || '').toLowerCase() === String(evidence.fileHash || '').toLowerCase()) {
        return Object.assign({file:existingAudit.file,reused:true,artifactLayer:'primary'},existing);
      }
    } catch(_) {}
  }
  var bundle = await fetchCustomSkinBuffer(String(evidence.url),90000,0,
    Math.max(Number(evidence.bytes || 0) + 1024,64 * 1024 * 1024),onProgress);
  if (bundle.length !== Number(evidence.bytes)) throw new Error('U-client video bundle size mismatch');
  var bundleFile = path.join(itemRoot,'uclient-video.bundle');
  await writeCustomSkinDownloadFile(bundleFile,bundle);
  var extracted = await runUClientPetExtractor(bundleFile,previewRoot,credential.assetId,[],{
    mode:'video', assetPath:String(evidence.assetPath || ''),
  });
  if (String(extracted.assetPath || '').toLowerCase() !== String(evidence.assetPath || '').toLowerCase()) {
    throw new Error('U-client extracted video identity does not match the live manifest');
  }
  extracted.sourceId = credential.requestId;
  extracted.assetId = credential.assetId;
  extracted.sourceUrl = String(evidence.url || '');
  extracted.packageKey = String(evidence.packageKey || '');
  extracted.packageVersion = String(credential.packageVersions &&
    credential.packageVersions[evidence.packageKey] || '');
  extracted.bundleFileHash = String(evidence.fileHash || '').toLowerCase();
  extracted.bundleBytes = bundle.length;
  extracted.bundleSha256 = sha256Buffer(bundle);
  await writeCustomSkinDownloadFile(videoMetadataFile,
    Buffer.from(JSON.stringify(extracted,null,2),'utf8'));
  var embeddedBuild = await prepareEmbedded(extracted,false);
  if (embeddedBuild) return embeddedBuild;
  var unsupportedTimelineVideo = new Error(
    'U-client SkillTimeline video has no verified self-contained fight conversion profile');
  unsupportedTimelineVideo.code = 'UCLIENT_SKILL_TIMELINE_VIDEO_UNCONVERTED';
  unsupportedTimelineVideo.category = 'invalid-official-package';
  throw unsupportedTimelineVideo;
}

async function downloadOfficialUClientBuild(sourceId, directory, onProgress, forceManifestRefresh, forceDownload, options) {
  options = options || {};
  var id = parseCustomSkinId(sourceId);
  if (!id) throw new Error('UClient pet source id is invalid');
  var current = await getCurrentUClientPetManifest(!!forceManifestRefresh);
  var credential = uClientCatalog.credential(current.snapshot,id,options.identity || {});
  if (!credential.complete || !credential.model) {
    var presentationOnly = !!(credential && credential.presentation &&
      !credential.model && !credential.follow);
    var unavailable = new Error(presentationOnly
      ? '官方仅提供展示或飞行坐骑资源，未提供可用于皮肤的战斗模型'
      : 'The current U-client packages do not contain an identity-matched battle model');
    unavailable.statusCode = 404;
    unavailable.optional = true;
    unavailable.category = 'unsupported-model';
    if (presentationOnly) {
      unavailable.code = 'UCLIENT_PRESENTATION_ONLY';
      unavailable.presentationOnly = true;
    }
    throw unavailable;
  }
  var conversionRoute = credential.conversionRoute || {};
  var conversionFamily = String(conversionRoute.family || '');
  if (!conversionFamily || conversionFamily !== String(credential.family || '') ||
      parseCustomSkinId(conversionRoute.ownerId) !== parseCustomSkinId(credential.assetId)) {
    throw new Error('The U-client conversion route does not match the identity credential');
  }
  var assetPath = String(credential.model.assetPath || '');
  var asset = current.byPath.get(assetPath.toLowerCase());
  if (!asset) throw new Error('The U-client credential does not resolve to the live PetAnimPackage');
  var bundle = current.manifest.bundles[asset.bundleID];
  if (!bundle || !/^[0-9a-f]{32}$/i.test(String(bundle.fileHash || ''))) {
    throw new Error('The UClient pet bundle record is invalid');
  }
  var itemRoot = path.join(directory, String(id));
  var previewRoot = path.join(itemRoot, 'uclient-preview');
  var metadataFile = path.join(previewRoot, 'uclient-preview.json');
  var bundleFile = path.join(itemRoot, 'uclient-pet.bundle');
  var materialDependencies = await ensureUClientModelDependencies(
    current, credential, !!forceDownload, onProgress);
  if (conversionFamily === 'spine') {
    var spineExisting = null;
    try { spineExisting = JSON.parse(await fs.promises.readFile(metadataFile,'utf8')); } catch(_) {}
    var spineFight = path.join(itemRoot,'fight.swf');
    if (!forceDownload && spineExisting && spineExisting.family === 'spine' &&
        uClientMetadataMatchesSnapshot(spineExisting,current,credential) && fs.existsSync(spineFight)) {
      var cachedSpineBuild = null;
      try {
        cachedSpineBuild = JSON.parse(await fs.promises.readFile(
          path.join(itemRoot,'uclient-fight-build.json'),'utf8'));
      } catch(_) {}
      var cachedTimeline = await uClientFtrFlashPipeline.reconcileCachedUClientSpineSkillTimeline(
        previewRoot,id,credential,spineExisting,cachedSpineBuild);
      if (cachedTimeline.ok) {
        var cachedSpine = await uClientFtrFlashPipeline.validateUClientFtrPetCompactDownload(itemRoot,id);
        if (cachedSpine.ok) {
          var reusedSpineVideo = await ensureUClientSkillVideo(
            credential,itemRoot,previewRoot,onProgress,!!forceDownload);
          if (embeddedCinematicMatchesFightBuild(reusedSpineVideo,cachedSpineBuild)) {
            spineExisting.flashBattleSwf = Object.assign({},spineExisting.flashBattleSwf || {},{
              file:cachedSpine.fightFile,bytes:cachedSpine.fightBytes,
              fightSha256:cachedSpine.fightSha256,
            });
            return {
              metadata:spineExisting, metadataFile:metadataFile, bundleFile:bundleFile,
              battleFile:cachedSpine.fightFile,
              bundleEvidence:spineExisting.bundleEvidence,
              videoBuild:reusedSpineVideo,
              skillTimelineCache:cachedTimeline,
              reused:true, compacted:cachedSpine.metadataOnly === true,
              previewOnly:options.previewOnly === true,
            };
          }
          logWarn('CustomSkin','cached U-client Spine fight requires cinematic rebuild',{
            id:id,previewOnly:options.previewOnly === true,
          });
        }
      }
    }
    var spineBundleUrl = String(credential.model.url || UCLIENT_PET_PACKAGE_ROOT + bundle.fileHash);
    var spineBundle = options.prefetchedBundleFile && fs.existsSync(options.prefetchedBundleFile)
      ? await fs.promises.readFile(options.prefetchedBundleFile)
      : await fetchCustomSkinBuffer(spineBundleUrl,90000,0,
        Math.max(64 * 1024 * 1024,Number(bundle.fileSize) + 1024),onProgress);
    if (spineBundle.length !== Number(bundle.fileSize)) throw new Error('U Spine bundle size does not match live manifest');
    await writeCustomSkinDownloadFile(bundleFile,spineBundle);
    var spineMetadata = await runUClientPetExtractor(
      bundleFile,previewRoot,credential.assetId,materialDependencies.files,{mode:'spine'});
    spineMetadata.sourceId = id;
    spineMetadata.assetId = credential.assetId;
    spineMetadata.name = credential.name;
    spineMetadata.family = 'spine';
    spineMetadata.actions = normalizeUClientActions(spineMetadata.actions);
    spineMetadata.actionCapabilities = uClientActionCapabilities(spineMetadata.actions);
    spineMetadata.packageVersion = current.version;
    spineMetadata.packageVersions = credential.packageVersions;
    spineMetadata.snapshotFingerprint = current.fingerprint;
    spineMetadata.bundleHash = String(bundle.fileHash || '').toLowerCase();
    spineMetadata.assetPath = assetPath;
    spineMetadata.conversionRoute = conversionRoute;
    spineMetadata.materialDependencies = materialDependencies.evidence;
    var spineResourcePlan = uClientResourceFamily.buildResourcePlan(
      credential,null,{ skillTimeline:'all-owned' });
    spineMetadata.resourcePlanVersion = spineResourcePlan.version;
    spineMetadata.resourcePlanClosureSha256 = spineResourcePlan.closureSha256;
    spineMetadata.resourcePlan = spineResourcePlan;
    var spineSourceForTimeline = JSON.parse(await fs.promises.readFile(
      path.join(previewRoot,'spine-source.json'),'utf8'));
    var skillTimelineAdaptation = conversionRoute.supplementalConverter === 'spine-skill-timeline'
      ? await uClientSkillTimelineAutoAdapter.prepare({
      previewRoot:previewRoot,
      credential:credential,
      spineSource:spineSourceForTimeline,
      resourcePlan:spineResourcePlan,
      onProgress:function(event) {
        if (typeof onProgress !== 'function') return;
        var phase = String(event && event.phase || 'prepare');
        onProgress(Object.assign({},event,{
          phase:'uclient-skill-timeline-' + phase,
          message:phase === 'run'
            ? '正在自动适配 U 端完整技能特效…'
            : '正在准备 U 端技能特效 ' + phase,
        }));
      },
      }) : null;
    spineMetadata.skillTimelineAdaptation = skillTimelineAdaptation ? {
      status:String(skillTimelineAdaptation.status || ''),
      ownerId:Number(skillTimelineAdaptation.ownerId || credential.assetId),
      cacheKey:String(skillTimelineAdaptation.cacheKey || ''),
    } : { status:'not-applicable',ownerId:Number(credential.assetId || 0),cacheKey:'' };
    spineMetadata.identity = {
      requestId:id, assetId:credential.assetId, kind:credential.kind,
      catalogueId:credential.catalogueId, basePetId:credential.basePetId,
      ownershipVerified:credential.ownershipVerified,
    };
    spineMetadata.bundleEvidence = {
      url:spineBundleUrl, bytes:spineBundle.length, sha256:sha256Buffer(spineBundle),
      fileHash:String(bundle.fileHash || '').toLowerCase(),
    };
    var spineVideo = await ensureUClientSkillVideo(
      credential,itemRoot,previewRoot,onProgress,!!forceDownload);
    var spineBuild = await uClientFtrFlashPipeline.buildUClientSpineBattleSwf(
      previewRoot,id,true,credential);
    spineMetadata.flashBattleSwf = spineBuild;
    await writeCustomSkinDownloadFile(metadataFile,
      Buffer.from(JSON.stringify(spineMetadata,null,2),'utf8'));
    return {
      metadata:spineMetadata, metadataFile:metadataFile, bundleFile:bundleFile,
      battleFile:spineBuild.file, bundleEvidence:spineMetadata.bundleEvidence,
      videoBuild:spineVideo,
      reused:false, previewOnly:options.previewOnly === true,
    };
  }
  if (!forceDownload) {
    try { await promoteCachedUClientPetPreview(id, previewRoot, current.version); }
    catch(error) { logWarn('CustomSkin', 'UClient preview cache promotion skipped', { id:id, error:error.message }); }
  }
  try {
    var existing = JSON.parse(await fs.promises.readFile(metadataFile, 'utf8'));
    if (!forceDownload && !options.previewOnly && existing && Number(existing.version || 0) >= 4 &&
        existing.packageVersion === current.version &&
        uClientMetadataMatchesSnapshot(existing,current,credential)) {
      var compact = await uClientFtrFlashPipeline.validateUClientFtrPetCompactDownload(itemRoot, id);
      if (compact.ok) {
        existing.flashBattleSwf = Object.assign({}, existing.flashBattleSwf || {}, {
          file:compact.fightFile, bytes:compact.fightBytes, fightSha256:compact.fightSha256,
        });
        var compactVideo = await ensureUClientSkillVideo(
          credential,itemRoot,previewRoot,onProgress,!!forceDownload);
        return { metadata:existing, metadataFile:metadataFile, bundleFile:bundleFile,
          battleFile:compact.fightFile, bundleEvidence:compact.bundleEvidence,
          videoBuild:compactVideo,
          reused:true, compacted:true };
      }
    }
    if (!forceDownload && options.previewOnly && existing && Number(existing.version || 0) >= 4 &&
        existing.packageVersion === current.version &&
        uClientMetadataMatchesSnapshot(existing,current,credential)) {
      var previewExisting = await readUClientPetPreviewRoot(id, previewRoot, 'preview-cache');
      if (previewExisting.ok) return { metadata:existing, metadataFile:metadataFile,
        bundleFile:bundleFile, battleFile:'', reused:true, previewOnly:true };
    }
    if (!forceDownload && existing && Number(existing.version || 0) >= 4 &&
        existing.packageVersion === current.version &&
        uClientMetadataMatchesSnapshot(existing,current,credential) &&
        fs.existsSync(bundleFile) &&
        fs.existsSync(path.join(previewRoot, 'uclient-animation.json.gz')) &&
        (fs.existsSync(path.join(previewRoot, 'uclient-atlas.webp')) ||
         (fs.existsSync(path.join(previewRoot, 'uclient-atlas.png')) &&
          fs.existsSync(path.join(previewRoot, 'uclient-atlas.bc7'))))) {
       var reusableMetadata = existing;
       var hasNativeBc7 = fs.existsSync(path.join(previewRoot, 'uclient-atlas.png')) &&
         fs.existsSync(path.join(previewRoot, 'uclient-atlas.bc7'));
       if (!hasNativeBc7) {
         reusableMetadata = await runUClientPetExtractor(
           bundleFile, previewRoot, credential.assetId, materialDependencies.files,{mode:'ftr'});
         reusableMetadata.actionCapabilities = uClientActionCapabilities(reusableMetadata.actions);
         reusableMetadata.packageVersion = current.version;
         reusableMetadata.bundleHash = bundle.fileHash;
       reusableMetadata.sourceId = id;
       reusableMetadata.assetId = credential.assetId;
       reusableMetadata.family = 'ftr';
       reusableMetadata.snapshotFingerprint = current.fingerprint;
       reusableMetadata.packageVersions = credential.packageVersions;
       reusableMetadata.assetPath = assetPath;
       reusableMetadata.conversionRoute = conversionRoute;
       reusableMetadata.materialDependencies = materialDependencies.evidence;
       await normalizeUClientPreviewMetadataIdentity(previewRoot, id);
       }
       var reusableAnimation = JSON.parse(zlib.gunzipSync(
         await fs.promises.readFile(path.join(previewRoot,'uclient-animation.json.gz'))).toString('utf8'));
       var reusableResourcePlan = uClientResourceFamily.buildResourcePlan(credential,reusableAnimation);
       reusableMetadata.resourcePlanVersion = reusableResourcePlan.version;
       reusableMetadata.resourcePlan = reusableResourcePlan;
       var reusableEventVideos = options.previewOnly ? null :
         await uClientResourceFamilyConverter.prepareFtrEventVideos(reusableResourcePlan,{
           previewRoot:previewRoot,onProgress:onProgress,
         });
       reusableMetadata.resourceFamilyConversionComplete = options.previewOnly
         ? reusableResourcePlan.requiredResourceCount === 0
         : !!(reusableEventVideos && reusableEventVideos.converted);
       reusableMetadata.eventVideoBuild = reusableEventVideos;
       var reusedBattle = options.previewOnly ? null :
         await buildUClientFtrBattleAssetsIsolated(previewRoot, id, directory, !hasNativeBc7);
       if (reusedBattle) {
         reusableMetadata.flashBattle = reusedBattle.flashBattle;
         reusableMetadata.flashBattleSwf = reusedBattle.flashBattleSwf;
       }
       reusableMetadata.lowMemoryAtlasMigrated = !hasNativeBc7;
       await writeCustomSkinDownloadFile(metadataFile,
         Buffer.from(JSON.stringify(reusableMetadata, null, 2), 'utf8'));
       var reusedVideo = options.previewOnly ? null : await ensureUClientSkillVideo(
         credential,itemRoot,previewRoot,onProgress,!!forceDownload);
       return { metadata:reusableMetadata, metadataFile:metadataFile, bundleFile:bundleFile,
         battleFile:reusedBattle ? reusableMetadata.flashBattleSwf.file : '',
         videoBuild:reusedVideo,
         reused:true, migrated:!hasNativeBc7, previewOnly:options.previewOnly === true };
    }
  } catch(_) {}
  var bundleUrl = UCLIENT_PET_PACKAGE_ROOT + bundle.fileHash;
  var bundleBuffer = options.prefetchedBundleFile && fs.existsSync(options.prefetchedBundleFile)
    ? await fs.promises.readFile(options.prefetchedBundleFile)
    : await fetchCustomSkinBuffer(bundleUrl, 90000, 0,
      Math.max(64 * 1024 * 1024, Number(bundle.fileSize) + 1024), onProgress);
  if (Number(bundle.fileSize) > 0 && bundleBuffer.length !== Number(bundle.fileSize)) {
    throw new Error('UClient pet bundle size does not match the live manifest');
  }
  await writeCustomSkinDownloadFile(bundleFile, bundleBuffer);
  var metadata = await runUClientPetExtractor(bundleFile, previewRoot, credential.assetId,
    materialDependencies.files,{mode:'ftr'});
  metadata.sourceId = id;
  metadata.assetId = credential.assetId;
  metadata.family = 'ftr';
  metadata.actionCapabilities = uClientActionCapabilities(metadata.actions);
  metadata.packageVersion = current.version;
  metadata.bundleHash = bundle.fileHash;
  metadata.snapshotFingerprint = current.fingerprint;
  metadata.packageVersions = credential.packageVersions;
  metadata.assetPath = assetPath;
  metadata.conversionRoute = conversionRoute;
  metadata.materialDependencies = materialDependencies.evidence;
  await normalizeUClientPreviewMetadataIdentity(previewRoot, id);
  var extractedAnimation = JSON.parse(zlib.gunzipSync(
    await fs.promises.readFile(path.join(previewRoot,'uclient-animation.json.gz'))).toString('utf8'));
  var resourcePlan = uClientResourceFamily.buildResourcePlan(credential,extractedAnimation);
  metadata.resourcePlanVersion = resourcePlan.version;
  metadata.resourcePlan = resourcePlan;
  var eventVideoBuild = options.previewOnly ? null :
    await uClientResourceFamilyConverter.prepareFtrEventVideos(resourcePlan,{
      previewRoot:previewRoot,onProgress:onProgress,
    });
  metadata.resourceFamilyConversionComplete = options.previewOnly
    ? resourcePlan.requiredResourceCount === 0
    : !!(eventVideoBuild && eventVideoBuild.converted);
  metadata.eventVideoBuild = eventVideoBuild;
  var builtBattle = options.previewOnly ? null :
    await buildUClientFtrBattleAssetsIsolated(previewRoot, id, directory, true);
  if (builtBattle) {
    metadata.flashBattle = builtBattle.flashBattle;
    metadata.flashBattleSwf = builtBattle.flashBattleSwf;
  }
  await writeCustomSkinDownloadFile(metadataFile, Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'));
  var builtVideo = options.previewOnly ? null : await ensureUClientSkillVideo(
    credential,itemRoot,previewRoot,onProgress,!!forceDownload);
  if (options.previewOnly) {
    var previewAtlasName = String(metadata && metadata.animation && metadata.animation.atlas &&
      metadata.animation.atlas.file || '');
    try {
      var previewAnimation = JSON.parse(zlib.gunzipSync(
        await fs.promises.readFile(path.join(previewRoot, 'uclient-animation.json.gz'))
      ).toString('utf8'));
      previewAtlasName = String(previewAnimation && previewAnimation.atlas && previewAnimation.atlas.file || previewAtlasName);
      var previewSourceAtlasName = String(previewAnimation && previewAnimation.sourceAtlas &&
        previewAnimation.sourceAtlas.file || previewAtlasName);
      if (previewSourceAtlasName && previewSourceAtlasName !== previewAtlasName &&
          /^[^\\/:*?"<>|]+$/.test(previewSourceAtlasName)) {
        try { await fs.promises.unlink(path.join(previewRoot, previewSourceAtlasName)); } catch(_) {}
      }
    } catch(_) {}
    try { await fs.promises.unlink(bundleFile); } catch(_) {}
  }
  return { metadata:metadata, metadataFile:metadataFile, bundleFile:bundleFile,
    battleFile:builtBattle ? metadata.flashBattleSwf.file : '', reused:false,
    videoBuild:builtVideo,
    previewOnly:options.previewOnly === true };
}

async function downloadOfficialUClientFollowBuild(sourceId, directory, onProgress,
  forceManifestRefresh, forceDownload, options) {
  options = options || {};
  var id = parseCustomSkinId(sourceId);
  if (!id) throw new Error('U-client follow source id is invalid');
  var current = await getCurrentUClientPetManifest(!!forceManifestRefresh);
  var credential = uClientCatalog.credential(current.snapshot,id,options.identity || {});
  var follow = credential && credential.follow;
  if (!follow) {
    var presentationOnly = !!(credential && credential.presentation &&
      !credential.model && !credential.follow);
    var unavailable = new Error(presentationOnly
      ? '官方仅提供展示或飞行坐骑资源，未提供可用于皮肤的跟随模型'
      : 'The current U-client FollowPackage has no identity-matched follow model');
    unavailable.statusCode = 404;
    unavailable.optional = true;
    unavailable.category = 'unsupported-follow';
    unavailable.code = 'UCLIENT_FOLLOW_UNAVAILABLE';
    unavailable.presentationOnly = presentationOnly;
    throw unavailable;
  }
  if (!/^[0-9a-f]{32}$/i.test(String(follow.fileHash || '')) || !(Number(follow.bytes) > 0)) {
    throw new Error('The U-client follow bundle evidence is invalid');
  }
  var itemRoot = path.join(directory,String(id));
  var previewRoot = path.join(itemRoot,'uclient-follow-preview');
  var metadataFile = path.join(itemRoot,'uclient-follow-metadata.json');
  var normalFile = path.join(itemRoot,'normal.swf');
  if (!forceDownload) {
    try {
      var existing = JSON.parse(await fs.promises.readFile(metadataFile,'utf8'));
      var existingNormal = await fs.promises.readFile(normalFile);
      if (existing && Number(existing.version || 0) >= 1 &&
          String(existing.snapshotFingerprint || '') === String(current.fingerprint || '') &&
          String(existing.bundleHash || '').toLowerCase() === String(follow.fileHash || '').toLowerCase() &&
          Number(existing.normalBytes || 0) === existingNormal.length &&
          String(existing.normalSha256 || '').toUpperCase() === sha256Buffer(existingNormal)) {
        validateOfficialCustomSkinModel('normal',existingNormal);
        return { metadata:existing, metadataFile:metadataFile, followFile:normalFile,
          bundleEvidence:existing.bundleEvidence, reused:true, compacted:true };
      }
    } catch(_) {}
  }
  await fs.promises.mkdir(previewRoot,{recursive:true});
  var bundleFile = path.join(itemRoot,'uclient-follow.bundle');
  var bundleUrl = String(follow.url || '');
  var bundleBuffer = options.prefetchedBundleFile && fs.existsSync(options.prefetchedBundleFile)
    ? await fs.promises.readFile(options.prefetchedBundleFile)
    : await fetchCustomSkinBuffer(bundleUrl,90000,0,
      Math.max(64 * 1024 * 1024,Number(follow.bytes) + 1024),onProgress);
  if (bundleBuffer.length !== Number(follow.bytes)) {
    throw new Error('U-client follow bundle size does not match the live FollowPackage manifest');
  }
  await writeCustomSkinDownloadFile(bundleFile,bundleBuffer);
  var dependencyEvidence = Array.isArray(follow.dependencyBundles) ? follow.dependencyBundles : [];
  var dependencyBytes = dependencyEvidence.reduce(function(total,item) {
    return total + Math.max(0,Number(item && item.bytes || 0));
  },0);
  if (dependencyEvidence.length > 16 || dependencyBytes > 32 * 1024 * 1024) {
    throw new Error('U-client follow dependency set exceeds the x32 conversion bound');
  }
  var dependencyFiles = [];
  for (var dependencyIndex = 0; dependencyIndex < dependencyEvidence.length; dependencyIndex++) {
    var dependency = dependencyEvidence[dependencyIndex] || {};
    if (!/^[0-9a-f]{32}$/i.test(String(dependency.fileHash || '')) ||
        !(Number(dependency.bytes) > 0) || Number(dependency.bytes) > 16 * 1024 * 1024) {
      throw new Error('U-client follow dependency evidence is invalid');
    }
    var dependencyFile = path.join(itemRoot,'uclient-follow-dependency-' + dependencyIndex + '.bundle');
    var dependencyBuffer = await fetchCustomSkinBuffer(String(dependency.url || ''),60000,0,
      Number(dependency.bytes) + 1024,onProgress);
    if (dependencyBuffer.length !== Number(dependency.bytes)) {
      throw new Error('U-client follow dependency size does not match the live FollowPackage manifest');
    }
    await writeCustomSkinDownloadFile(dependencyFile,dependencyBuffer);
    dependencyFiles.push(dependencyFile);
  }
  var extracted = await runUClientPetExtractor(bundleFile,previewRoot,credential.assetId,
    dependencyFiles,{mode:'ftr',assetPath:String(follow.assetPath || '')});
  await ensureUClientPetFlashAssets(previewRoot,true);
  var build = await uClientFtrFlashPipeline.buildUClientFtrFollowSwf(previewRoot,id);
  var normalBuffer = await fs.promises.readFile(build.file || normalFile);
  validateOfficialCustomSkinModel('normal',normalBuffer);
  var metadata = {
    version:1,
    sourceId:id,
    assetId:credential.assetId,
    kind:credential.kind,
    catalogueId:credential.catalogueId,
    basePetId:credential.basePetId,
    name:credential.name,
    family:'follow-ftr',
    assetPath:String(follow.assetPath || ''),
    packageKey:'follow',
    packageVersion:String(credential.packageVersions && credential.packageVersions.follow || ''),
    packageVersions:credential.packageVersions || {},
    snapshotFingerprint:String(current.fingerprint || ''),
    bundleHash:String(follow.fileHash || '').toLowerCase(),
    bundleEvidence:{
      url:bundleUrl,bytes:bundleBuffer.length,sha256:sha256Buffer(bundleBuffer),
      fileHash:String(follow.fileHash || '').toLowerCase(),
      dependencies:dependencyEvidence.map(function(item,index) {
        return { index:index,url:String(item.url || ''),bytes:Number(item.bytes || 0),
          fileHash:String(item.fileHash || '').toLowerCase() };
      }),
    },
    actions:normalizeUClientActions(extracted && extracted.actions),
    normalBytes:normalBuffer.length,
    normalSha256:sha256Buffer(normalBuffer),
    selfContained:true,
    conversionPolicy:'uclient-followpackage-ftr-self-contained-normal',
    flashFollowSwf:Object.assign({},build || {},{
      file:normalFile,bytes:normalBuffer.length,normalSha256:sha256Buffer(normalBuffer),
    }),
  };
  await writeCustomSkinDownloadFile(metadataFile,Buffer.from(JSON.stringify(metadata,null,2),'utf8'));
  var cleanupSummary = { deletedFiles:0,deletedDirectories:0,freedBytes:0,errors:[] };
  var cleanupTargets = [bundleFile].concat(dependencyFiles).concat([previewRoot]);
  for (var cleanupIndex = 0; cleanupIndex < cleanupTargets.length; cleanupIndex++) {
    try { await deleteCustomSkinManagedTree(cleanupTargets[cleanupIndex],itemRoot,cleanupSummary); }
    catch(cleanupError) { cleanupSummary.errors.push(cleanupError.message); }
  }
  return { metadata:metadata, metadataFile:metadataFile, followFile:normalFile,
    bundleEvidence:metadata.bundleEvidence, build:build, reused:false, compacted:true,
    storageOptimization:cleanupSummary };
}

function uClientPetPreviewCacheDirectory() {
  return path.join(app.getPath('userData'), 'cache', 'uclient-pet-preview');
}

async function readUClientPetPreviewRoot(sourceId, root, location) {
  var id = parseCustomSkinId(sourceId);
  try {
    var metadata = JSON.parse(await fs.promises.readFile(path.join(root, 'uclient-preview.json'), 'utf8'));
    var family = String(metadata.family || '').toLowerCase();
    var previewIntegrity = resourceVariantIntegrity.inspectPreviewRoot(path.dirname(root), root, {
      sourceId:id,
      location:location,
    });
    if (previewIntegrity.ok && previewIntegrity.flashReady) {
      var flashCapabilities = uClientActionCapabilities(metadata.actions);
      metadata.actions = flashCapabilities.actions;
      metadata.actionCapabilities = flashCapabilities;
      var currentManifest = uClientSnapshotService.peekModelManifest();
      var flashStale = !!(currentManifest && metadata.snapshotFingerprint &&
        String(metadata.snapshotFingerprint) !== String(currentManifest.fingerprint || ''));
      return {
        ok:true, sourceId:id, metadata:metadata, animation:null, flashModel:true,
        location:location, stale:flashStale, capabilities:flashCapabilities,
        artifactLayer:previewIntegrity.artifactLayer,
        mainBuildReady:previewIntegrity.mainBuildReady === true,
        selectedBattleVariant:String(previewIntegrity.selectedBattleVariant || ''),
        battleFile:previewIntegrity.file,
      };
    }
    if (family === 'spine') throw new Error(previewIntegrity.reason || 'U-client preview build is missing');
    if (!previewIntegrity.ok || !previewIntegrity.canvasReady) {
      throw new Error(previewIntegrity.reason || 'U-client preview payload is missing');
    }
    var compressed = await fs.promises.readFile(path.join(root, 'uclient-animation.json.gz'));
    var animation = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    var atlasFile = path.join(root, String(animation && animation.atlas && animation.atlas.file || 'uclient-atlas.webp'));
    if (!fs.existsSync(atlasFile)) throw new Error('UClient animation atlas is missing');
    var atlasStat = await fs.promises.stat(atlasFile);
    if (!atlasStat.size) throw new Error('UClient animation atlas is empty');
    var actionCapabilities = uClientActionCapabilities(metadata.actions || animation.actions);
    metadata.actions = actionCapabilities.actions;
    metadata.actionCapabilities = actionCapabilities;
    var currentManifest = uClientSnapshotService.peekModelManifest();
    var stale = !!(currentManifest && metadata.packageVersion &&
      String(metadata.packageVersion) !== String(currentManifest.version || ''));
    return { ok:true, sourceId:id, metadata:metadata, animation:animation,
      atlasUrl:'http://127.0.0.1:' + coreNet.getProxyPort() + '/launcher/uclient-pet-preview/' + id +
        (/\.png$/i.test(atlasFile) ? '/atlas.png' : '/atlas.webp'),
      location:location, stale:stale, capabilities:actionCapabilities,
      artifactLayer:'preview-inventory', mainBuildReady:false, selectedBattleVariant:'' };
  } catch(error) {
    return { ok:false, sourceId:id, error:error.message };
  }
}

async function getUClientPetPreview(sourceId) {
  var id = parseCustomSkinId(sourceId);
  if (!id) return { ok:false, sourceId:id, error:'UClient pet source id is invalid' };
  var downloaded = await readUClientPetPreviewRoot(id,
    path.join(customSkinDownloadDirectory(), String(id), 'uclient-preview'), 'downloaded');
  return downloaded;
}

async function prepareUClientPetPreview(sourceId, onProgress) {
  var id = parseCustomSkinId(sourceId);
  if (!id) return { ok:false, sourceId:id, error:'UClient pet source id is invalid' };
  if (_uClientPetPreviewPrepareJobs.has(id)) return await _uClientPetPreviewPrepareJobs.get(id);
  var job = (async function() {
    try {
      var cached = await getUClientPetPreview(id);
      if (cached.ok && cached.location === 'downloaded' && !cached.stale) return cached;
      var cacheRoot = uClientPetPreviewCacheDirectory();
      var prepared = await downloadOfficialUClientBuild(id, cacheRoot, onProgress, true, false,
        { previewOnly:true });
      var result = await readUClientPetPreviewRoot(id,
        path.join(cacheRoot, String(id), 'uclient-preview'), 'preview-cache');
      if (!result.ok) throw new Error(result.error || 'UClient preview cache could not be read');
      result.reused = prepared.reused === true;
      return result;
    } catch(error) {
      return { ok:false, sourceId:id, error:error.message,
        statusCode:error.statusCode || 0, optional:error.optional === true };
    }
  })();
  _uClientPetPreviewPrepareJobs.set(id, job);
  try { return await job; }
  finally { if (_uClientPetPreviewPrepareJobs.get(id) === job) _uClientPetPreviewPrepareJobs.delete(id); }
}

function parseCustomSkinDownloadIds(values) {
  var output = [];
  var seen = new Set();
  (Array.isArray(values) ? values : []).forEach(function(value) {
    var id = parseCustomSkinId(value);
    if (id && !seen.has(id)) {
      seen.add(id);
      output.push(id);
    }
  });
  return output;
}

function customSkinDownloadedInventory() {
  if (_customSkinCommittedProjection.revision === _customSkinRevision &&
      _customSkinCommittedProjection.inventory) {
    return _customSkinCommittedProjection.inventory;
  }
  return emptyCustomSkinDownloadedInventory();
}

// Removing a registered skin with "delete files" must also evict its source
// from the committed download inventory.  The inventory is intentionally
// served from the in-memory projection between verification passes; leaving
// the old entry there makes the catalog/downloaded tab resurrect a skin that
// has already been deleted from disk.  Only evict a source when no remaining
// registration references the same official source directory.
function evictCustomSkinDownloadedInventory(removedEntries, remainingEntries) {
  var remainingSources = new Set((remainingEntries || []).map(function(entry) {
    return parseCustomSkinId(entry && entry.sourceId);
  }).filter(Boolean));
  var removedSources = new Set();
  (removedEntries || []).forEach(function(entry) {
    var sourceId = parseCustomSkinId(entry && entry.sourceId);
    if (sourceId && !remainingSources.has(sourceId)) removedSources.add(sourceId);
  });
  var current = customSkinDownloadedInventory();
  var next = {
    ids:(current.ids || []).filter(function(id) { return !removedSources.has(parseCustomSkinId(id)); }),
    uClientIds:(current.uClientIds || []).filter(function(id) { return !removedSources.has(parseCustomSkinId(id)); }),
    entries:(current.entries || []).filter(function(entry) {
      return !removedSources.has(parseCustomSkinId(entry && entry.sourceId));
    }),
  };
  next = normalizeCommittedCustomSkinInventory(next, true);

  // A destructive removal changes the bytes represented by the projection
  // even when its source is shared by another registration.  Advance the
  // generation so any worker started before deletion cannot republish stale
  // disk state, then persist a complete same-revision projection.  The second
  // manifest save also makes .bak contain the already-deleted registration
  // state instead of allowing rollback to resurrect the removed skin.
  _customSkinStorageGeneration++;
  var nextProjection = {
    revision:_customSkinRevision,
    generation:_customSkinStorageGeneration,
    uiEntries:customSkinUiEntries(_customSkins, { bypassCommitted:true }),
    inventory:next,
  };
  var saved = saveCustomSkins(_customSkins, _customSkinRevision, _customSkinIssuedIds,
    nextProjection);
  _customSkinCommittedProjection = nextProjection;
  invalidateCustomSkinSnapshotProjection();
  scheduleCustomSkinProjectionVerification();
  if (!saved.ok) return saved;
  return {
    ok:true,
    changed:removedSources.size > 0,
    removedIds:Array.from(removedSources).sort(function(a,b) { return a - b; }),
  };
}

function scanCustomSkinDownloadedInventory() {
  var ids = new Set();
  var uClientIds = new Set();
  var entries = [];
  try {
    var root = customSkinDownloadDirectory();
    if (fs.existsSync(root)) {
      fs.readdirSync(root).forEach(function(name) {
        var id = parseCustomSkinId(name);
        if (!id) return;
        var itemRoot = path.join(root, String(name));
        var hasUClientPreviewPayload = fs.existsSync(path.join(itemRoot, 'uclient-preview', 'uclient-preview.json')) &&
          fs.existsSync(path.join(itemRoot, 'uclient-preview', 'uclient-animation.json.gz')) &&
          (fs.existsSync(path.join(itemRoot, 'uclient-preview', 'uclient-atlas.webp')) ||
           fs.existsSync(path.join(itemRoot, 'uclient-preview', 'uclient-atlas.png')));
        var files = {};
        ['normal.swf','fight.swf','icon.swf','skill.swf'].forEach(function(file) {
          try {
            var stat = fs.statSync(path.join(itemRoot, file));
            files[file.replace(/\.swf$/i, '')] = stat.isFile() ? Number(stat.size) || 0 : 0;
          } catch(_) { files[file.replace(/\.swf$/i, '')] = 0; }
        });
        var variantManifest = null;
        try {
          var parsed = JSON.parse(fs.readFileSync(path.join(itemRoot, 'battle-variants.json'), 'utf8'));
          if (parsed && parsed.version === CUSTOM_SKIN_BATTLE_VARIANT_MANIFEST_VERSION &&
              parseCustomSkinId(parsed.sourceId) === id) variantManifest = parsed;
        } catch(_) {}
        // This scanner only runs in the single post-first-screen projection
        // task.  UI IPC reads consume the last committed in-memory projection
        // and never reach this directory/hash path directly.
        var fightBuild = null;
        try {
          var parsedFightBuild = JSON.parse(fs.readFileSync(path.join(itemRoot, 'uclient-fight-build.json'), 'utf8'));
          if (parsedFightBuild && parseCustomSkinId(parsedFightBuild.sourceId) === id) fightBuild = parsedFightBuild;
        } catch(_) {}
        var fightBytes = Number(files.fight) || 0;
        var selectedBattleVariant = String(variantManifest && variantManifest.selectedBattleVariant || '');
        var battleIntegrity = fightBytes > 0 && variantManifest
          ? resourceVariantIntegrity.inspectBattleRoot(itemRoot, { sourceId:id })
          : null;
        var battlePlayable = !!(battleIntegrity && battleIntegrity.ok === true &&
          (battleIntegrity.selectedBattleVariant === 'legacy-swf' ||
           battleIntegrity.selectedBattleVariant === 'uclient-self-contained'));
        var videoBuildExists = fs.existsSync(path.join(itemRoot, 'uclient-video-build.json'));
        var previewAvailable = hasUClientPreviewPayload;
        var hasUClient = !!((battlePlayable && selectedBattleVariant === 'uclient-self-contained') || previewAvailable);
        if (hasUClient) uClientIds.add(id);
        if (hasUClient || Object.keys(files).some(function(key) { return files[key] > 0; })) {
          ids.add(id);
          entries.push({
            sourceId:id,
            files:files,
            uClientAvailable:hasUClient,
            selectedBattleVariant:selectedBattleVariant,
            selectionReason:String(variantManifest && variantManifest.selectionReason || ''),
            battlePlayable:battlePlayable,
            battleArtifactLayer:battlePlayable
              ? String(fightBuild && fightBuild.artifactLayer || 'battle') : 'missing',
            battleIntegrityReason:battlePlayable ? 'verified-at-commit' :
              (fightBytes > 0 ? String(battleIntegrity && battleIntegrity.reason ||
                (variantManifest ? 'battle-integrity-unverified' : 'battle-manifest-missing')) : 'missing-fight'),
            previewAvailable:previewAvailable,
            previewArtifactLayer:previewAvailable ? 'preview-inventory' : 'missing',
            skillBuildReady:files.skill > 0,
            skillIntegrityReason:videoBuildExists && files.skill <= 0 ? 'missing-skill' : '',
            legacyStaticPoseWrapper:!!(variantManifest && variantManifest.variants &&
              variantManifest.variants.legacySwf && variantManifest.variants.legacySwf.staticPoseWrapper),
            variantManifest:variantManifest,
          });
        }
      });
    }
  } catch(e) {
    logWarn('CustomSkin', 'downloaded source scan failed', { error:e.message });
  }
  var inventory = {
    ids:Array.from(ids).sort(function(a, b) { return a - b; }),
    uClientIds:Array.from(uClientIds).sort(function(a, b) { return a - b; }),
    entries:entries.sort(function(a, b) { return a.sourceId - b.sourceId; }),
  };
  return inventory;
}

function customSkinDownloadedSourceIds() {
  return customSkinDownloadedInventory().ids;
}

function customSkinInventoryEntriesForUi(inventory) {
  return (inventory && Array.isArray(inventory.entries) ? inventory.entries : []).map(function(entry) {
    var compact = Object.assign({}, entry);
    delete compact.variantManifest;
    return compact;
  });
}

function customSkinDownloadStatePayload() {
  var inventory = customSkinDownloadedInventory();
  return {
    revision:_customSkinRevision,
    skinModeEnabled:_skinModeEnabled === true,
    queueRevision:_customSkinDownloadQueueRevision,
    skins:customSkinUiEntries(_customSkins),
    queueIds:_customSkinDownloadQueueIds.slice(),
    downloadedIds:inventory.ids,
    downloadedUClientIds:inventory.uClientIds,
    inventory:customSkinInventoryEntriesForUi(inventory),
    running:_customSkinDownloadRunning,
    task:cloneCustomSkinDownloadTask(),
    suggestedId:suggestedAutomaticCustomSkinId(),
    autoImport:_customSkinAutoImport !== false,
    includeOfficialSkins:_customSkinIncludeOfficialSkins !== false,
    preferUClient:_customSkinPreferUClient === true,
    inputMode:_customSkinDownloadInputMode === 'range' ? 'range' : 'list',
    types:_customSkinDownloadTypes.slice(),
  };
}

function notifyCustomSkinStateChanged() {
  var payload = customSkinDownloadStatePayload();
  payload.eventId = ++_customSkinStateEventSerial;
  forEachCustomSkinRenderer(function(contents) {
    contents.send('custom-skins-changed', payload);
    contents.send('custom-skin-download-state-changed', payload);
  });
  return payload;
}

function notifyCustomSkinDownloadStateChanged() {
  return notifyCustomSkinStateChanged();
}

function waitCustomSkinDownload(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function isCustomSkinTransportCompatibilityError(error) {
  var code = String(error && error.code || '').toUpperCase();
  var message = String(error && error.message || '');
  return /CERT|TLS|SSL|EPROTO|ECONNRESET|UNABLE_TO_VERIFY|SELF_SIGNED|WRONG_VERSION/.test(code + ' ' + message.toUpperCase());
}

async function fetchOfficialCustomSkinModel(idOrConfig, configOrId) {
  var id;
  var config;
  if (idOrConfig && typeof idOrConfig === 'object') {
    config = idOrConfig;
    id = parseCustomSkinId(configOrId);
  } else {
    id = parseCustomSkinId(idOrConfig);
    config = configOrId;
  }
  if (!id || !config || typeof config.url !== 'function') {
    throw new Error('官方资源下载参数无效');
  }
  var urls = [config.url(id)];
  if (typeof config.compatibilityUrl === 'function') urls.push(config.compatibilityUrl(id));
  urls = urls.filter(function(url) { return /^https?:\/\//i.test(String(url || '')); });
  if (!urls.length) throw new Error('官方资源地址无效');
  var fetchBuffer = typeof config.fetchBuffer === 'function' ? config.fetchBuffer : fetchCustomSkinBuffer;
  var lastError = null;
  for (var urlIndex = 0; urlIndex < urls.length; urlIndex++) {
    var modelUrl = urls[urlIndex];
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        var shouldBustCache = attempt > 0 || !!(config && (config.forceRefresh === true || config.forceRefresh === '1'));
        var requestUrl = shouldBustCache
          ? modelUrl + (modelUrl.indexOf('?') >= 0 ? '&' : '?') + 'launcher_fetch=' + Date.now() + '-' + attempt
          : modelUrl;
        var buffer = await fetchBuffer(requestUrl, 45000, 0, config.maxBytes, config.onProgress);
        if (!Buffer.isBuffer(buffer) || buffer.length < 20) {
          var invalid = new Error('官方资源内容为空或尺寸无效');
          invalid.url = modelUrl;
          throw invalid;
        }
        return { buffer:buffer, url:modelUrl, compatibilityFallback:urlIndex > 0 };
      } catch(e) {
        lastError = e;
        e.url = modelUrl;
        var status = parseInt(e && e.statusCode, 10) || 0;
        if (status === 403 && attempt < 4) {
          await waitCustomSkinDownload(Math.min(10000, 1200 * Math.pow(2, attempt)));
          continue;
        }
        if ((status === 429 || status === 503 || status === 502) && attempt < 4) {
          var delay = Math.max(2500, Math.min(15000, (e.retryAfter || (attempt + 1) * 3) * 1000));
          await waitCustomSkinDownload(delay);
          continue;
        }
        if (urlIndex + 1 < urls.length && isCustomSkinTransportCompatibilityError(e)) break;
        throw e;
      }
    }
    if (!isCustomSkinTransportCompatibilityError(lastError)) break;
  }
  throw lastError || new Error('官方下载失败');
}

function customSkinDownloadFailure(id, type, config, error) {
  var statusCode = parseInt(error && error.statusCode, 10) || 0;
  var message = String(error && error.message || '未知错误');
  var errorCode = String(error && error.code || '');
  var retryable = errorCode === 'NO_PLAYABLE_BATTLE_VARIANT' || statusCode === 403 ||
    (!(error && error.optional === true) &&
      (statusCode === 429 || statusCode === 502 || statusCode === 503 ||
       (!statusCode && !/不是有效的 SWF|无法解析|未声明可适配|大小无效|超过限制/.test(message))));
  return {
    id:id,
    type:type,
    label:config.label,
    error:message,
    code:errorCode || undefined,
    category:error && error.category ? String(error.category) : undefined,
    optional:error && error.optional === true,
    statusCode:statusCode || undefined,
    retryAfter:parseInt(error && error.retryAfter, 10) || undefined,
    retryable:retryable,
    url:String(error && error.url || config.url(id)),
  };
}

function isCustomSkinResourceUnavailable(error) {
  var statusCode = parseInt(error && error.statusCode, 10) || 0;
  if (String(error && error.code || '') === 'NO_PLAYABLE_BATTLE_VARIANT') return false;
  return statusCode === 404 || statusCode === 410 ||
    (error && error.optional === true &&
      (error.category === 'unsupported-action' || error.category === 'unsupported-model'));
}

function customSkinDownloadUnavailable(id, type, config, error, job) {
  return {
    id:id,
    type:type,
    label:config.label,
    reason:String(error && error.message || '官方未提供该资源'),
    statusCode:parseInt(error && error.statusCode, 10) || undefined,
    basePetId:job && job.basePetId,
    officialSkinId:job && job.officialSkinId,
    officialName:job && job.officialName,
    sourceKind:job && job.sourceKind,
    code:error && error.code ? String(error.code) : undefined,
    category:error && error.category ? String(error.category) : undefined,
    presentationOnly:error && error.presentationOnly === true ? true : undefined,
    uClientFollowAvailable:error && error.code === 'UCLIENT_FOLLOW_UNAVAILABLE' ? false : undefined,
  };
}

function validateOfficialCustomSkinModel(type, buffer) {
  var signature = buffer && buffer.length >= 20 ? buffer.slice(0, 3).toString('ascii') : '';
  if (signature !== 'FWS' && signature !== 'CWS' && signature !== 'ZWS') {
    throw new Error('返回内容不是有效的 SWF');
  }
  if (type === 'icon') {
    var iconInfo = customSkinStaticIconInfo(buffer);
    if (!iconInfo.ok) throw new Error(iconInfo.error);
  }
}

async function inspectCustomSkinSkillVisuals(buffer) {
  var info = await customSkinReadRectSizeAsync(buffer);
  if (!info || !info.data || info.data.length < 20) return { ok:false, visualTags:0 };
  var data = info.data;
  var nbits = data[8] >> 3;
  var rectBytes = Math.ceil((5 + 4 * nbits) / 8);
  var rootStart = 8 + rectBytes + 4;
  var visualCodes = new Set([2,6,11,21,22,32,33,35,37,46,83,84,90]);
  var visualTags = 0;
  var visited = 0;
  function scan(start, end, depth) {
    if (depth > 16) return;
    var position = start;
    while (position < end && visited < 500000) {
      var tag = customSkinReadTagHeader(data, position, end);
      if (!tag) break;
      visited++;
      if (visualCodes.has(tag.code) && tag.end > tag.body) visualTags++;
      if (tag.code === 39 && tag.body + 4 <= tag.end) scan(tag.body + 4, tag.end, depth + 1);
      position = tag.end;
      if (tag.code === 0) break;
    }
  }
  scan(rootStart, data.length, 0);
  return { ok:visualTags > 0, visualTags:visualTags };
}

async function fetchSeer1GroupFightEffect(effectMeta, transferConfig) {
  var effectName = normalizeSeer1GroupFightEffectName(effectMeta && effectMeta.effectName);
  if (!effectName) {
    var missing = new Error('官方技能表未声明独立特效地址');
    missing.code = 'SKILL_EFFECT_UNAVAILABLE';
    missing.category = 'unsupported-action';
    missing.optional = true;
    throw missing;
  }
  var config = Object.assign({}, transferConfig || {}, {
    maxBytes:Math.max(Number(transferConfig && transferConfig.maxBytes) || 0,
      CUSTOM_SKIN_ARCH_POLICY.ultimateMaxBytes),
    url:function() { return 'https://seer.61.com/resource/groupFightResource/skill/' + effectName + '.swf'; },
    compatibilityUrl:function() { return 'http://seer.61.com/resource/groupFightResource/skill/' + effectName + '.swf'; },
  });
  var fetched = await fetchOfficialCustomSkinModel(1, config);
  var visual = await inspectCustomSkinSkillVisuals(fetched.buffer);
  if (!visual.ok) {
    var empty = new Error('官方技能 SWF 不含可渲染特效');
    empty.code = 'SKILL_VISUAL_EMPTY';
    empty.category = 'unsupported-action';
    empty.optional = true;
    throw empty;
  }
  return { fetched:fetched, resourceId:parseCustomSkinId(effectMeta && effectMeta.skillId), visual:visual };
}

async function fetchSeer1UltimateEffect(ultimateMeta, config) {
  var originalId = parseCustomSkinId(ultimateMeta && ultimateMeta.skillId);
  var preferredId = parseCustomSkinId(ultimateMeta && ultimateMeta.replacementSkillId) || originalId;
  var numericIds = [preferredId];
  if (originalId && originalId !== preferredId) numericIds.push(originalId);
  var lastError = null;
  for (var i = 0; i < numericIds.length; i++) {
    try {
      var fetched = await fetchOfficialCustomSkinModel(numericIds[i], config);
      var visual = await inspectCustomSkinSkillVisuals(fetched.buffer);
      if (visual.ok) return {
        fetched:fetched, resourceId:numericIds[i], replacementWasEmpty:i > 0, visual:visual,
      };
    } catch(error) { lastError = error; }
  }
  try {
    var current = await fetchSeer1GroupFightEffect(ultimateMeta, config);
    current.replacementWasEmpty = false;
    return current;
  } catch(error) { lastError = error; }
  throw lastError || new Error('官方未提供可用的独立技能特效');
}

function customSkinReadTagHeader(data, position, limit) {
  if (!data || position + 2 > limit) return null;
  var header = data.readUInt16LE(position);
  var code = header >> 6;
  var length = header & 0x3f;
  var body = position + 2;
  if (length === 0x3f) {
    if (body + 4 > limit) return null;
    length = data.readUInt32LE(body);
    body += 4;
  }
  if (length < 0 || body + length > limit) return null;
  return { code:code, body:body, end:body + length };
}

async function inspectCustomSkinUltimateActions(buffer) {
  var info = await customSkinReadRectSizeAsync(buffer);
  if (!info || !info.data || info.data.length < 20) {
    return { ok:false, labels:[], error:'战斗包无法解析动作时间轴' };
  }
  var data = info.data;
  var nbits = data[8] >> 3;
  var rectBytes = Math.ceil((5 + 4 * nbits) / 8);
  var rootStart = 8 + rectBytes + 4;
  var timelines = [];
  var tagsVisited = 0;
  function addLabel(target, start, end) {
    var zero = start;
    while (zero < end && data[zero] !== 0) zero++;
    var label = data.slice(start, zero).toString('utf8').trim();
    if (label && target.indexOf(label) < 0) target.push(label);
  }
  function scan(start, end, depth) {
    if (depth > 16) return [];
    var labels = [];
    var position = start;
    while (position < end && tagsVisited < 500000) {
      var tag = customSkinReadTagHeader(data, position, end);
      if (!tag) break;
      tagsVisited++;
      if (tag.code === 43) addLabel(labels, tag.body, tag.end);
      if (tag.code === 39 && tag.body + 4 <= tag.end) scan(tag.body + 4, tag.end, depth + 1);
      position = tag.end;
      if (tag.code === 0) break;
    }
    if (labels.length) timelines.push({ depth:depth, labels:labels });
    return labels;
  }
  var rootLabels = scan(rootStart, data.length, 0);
  var candidates = ['attack1','sa5','as5','hidemove','add1','ultimate','ultra','power'];
  function normalizeLabel(label) {
    return String(label || '').toLowerCase().replace(/[\s_-]+/g, '');
  }
  function matching(labels) {
    return labels.filter(function(label) {
      var normalized = normalizeLabel(label);
      return /^moves?\d+(?:\d+)?$/.test(normalized) || candidates.some(function(candidate) {
        return normalized === normalizeLabel(candidate);
      });
    });
  }
  var matched = [];
  timelines.forEach(function(timeline) {
    var normalized = timeline.labels.map(normalizeLabel);
    var isPetActionTimeline = normalized.indexOf('attack') >= 0 &&
      normalized.indexOf('sa') >= 0 && normalized.indexOf('hited') >= 0;
    if (!isPetActionTimeline) return;
    matching(timeline.labels).forEach(function(label) {
      var n = normalizeLabel(label);
      if ((n === 'attack1' || n === 'at1') && normalized.indexOf('attack') < 0 && normalized.indexOf('atk') < 0) return;
      if (matched.indexOf(label) < 0) matched.push(label);
    });
  });
  var semantic = new Set(['idle','stand','wait','normal','base','attack','atk','attack1','at1','physical',
    'sa','special','magic','attack2','at2','cp','property','buff','effect','sa5','as5','attack5','hidemove',
    'ultimate','ultra','power','hited','hurt','hit','dying','weak','dead','die','win','victory',
    'appear','entrance','show','present','transform','change','morph','add1','add2','add3']);
  var bestTimeline = timelines.slice().sort(function(a, b) {
    function score(timeline) {
      return timeline.labels.reduce(function(total, label) {
        return total + (semantic.has(normalizeLabel(label)) ? 100 : 1);
      }, 0);
    }
    return score(b) - score(a);
  })[0];
  var allLabels = Array.from(new Set(timelines.flatMap(function(t) { return t.labels || []; }).concat(rootLabels || [])));
  var appearActions = allLabels.filter(function(label) { return /appear|entrance|present|show|出场|入场/i.test(label); });
  var transformActions = allLabels.filter(function(label) { return /transform|morph|change|miracle|变身|赋形/i.test(label); });
  var availableLabels = bestTimeline ? bestTimeline.labels.slice() : (allLabels.length ? allLabels.slice() : rootLabels.slice());
  return {
    ok:matched.length > 0,
    labels:matched,
    evidence:matched.map(function(label) {
      return { label:label, status:normalizeLabel(label) === 'hidemove' ? 'compatibility-candidate' : 'verified-candidate' };
    }),
    rootLabels:rootLabels,
    availableLabels:availableLabels,
    allLabels:allLabels,
    appearActions:appearActions,
    transformActions:transformActions,
    error:matched.length ? '' : '官方战斗包未声明可适配的专属大招动作',
  };
}

async function getCustomSkinPreviewActions(skinId) {
  var id = parseCustomSkinId(skinId);
  var entry = _customSkins.find(function(item) { return parseCustomSkinId(item.skinId) === id; });
  var source = String(entry && entry.files && entry.files.fight || '').trim();
  if (!id || !source) return { ok:false, labels:[], error:'尚未下载战斗模型' };
  try {
    var buffer = /^https?:\/\//i.test(source)
      ? await fetchCustomSkinBuffer(source, 20000, 0, 64 * 1024 * 1024)
      : await fs.promises.readFile(resolveCustomSkinSourceForRuntime(source));
    var info = await inspectCustomSkinUltimateActions(buffer);
    var battleInfo = await inspectCustomSkinBattleModel(buffer);
    var uClientLabels = entry && (entry.previewAdapter === 'uclient' ||
      entry.selectedBattleVariant === 'uclient-self-contained')
      ? normalizeUClientActions(entry.uClientActions) : [];
    if (uClientLabels.indexOf('standby') >= 0 && uClientLabels.indexOf('idle') < 0) uClientLabels.unshift('idle');
    var previewLabels = Array.from(new Set(
      (Array.isArray(info.allLabels) && info.allLabels.length ? info.allLabels : (Array.isArray(info.availableLabels) ? info.availableLabels : [])).concat(uClientLabels)
    ));
    return {
      ok:true,
      labels:previewLabels,
      ultimateLabels:Array.isArray(info.labels) ? info.labels : [],
      hasSkill:!!String(entry && entry.files && entry.files.skill || '').trim(),
      legacyFightPlayable:battleInfo && battleInfo.legacyPlayable !== false,
      staticPoseWrapper:!!(battleInfo && battleInfo.staticPoseWrapper),
      structure:battleInfo && battleInfo.structure || null,
    };
  } catch(e) {
    return { ok:false, labels:[], error:e.message };
  }
}

let _customSkinActionMetadataScanRevision = -1;
let _customSkinActionMetadataScanPromise = null;
let _customSkinActionMetadataEvidence = new Map();
async function ensureCustomSkinActionMetadata() {
  if (_customSkinActionMetadataScanRevision === _customSkinRevision) return;
  if (_customSkinActionMetadataScanPromise) return await _customSkinActionMetadataScanPromise;
  _customSkinActionMetadataScanPromise = (async function() {
    var targetRevision = _customSkinRevision;
    var candidateSkins = JSON.parse(JSON.stringify(_customSkins));
    var changed = false;
    for (var i = 0; i < candidateSkins.length; i++) {
      var entry = candidateSkins[i];
      var isUClient = (entry.previewAdapter === 'uclient' ||
           entry.selectedBattleVariant === 'uclient-self-contained');
      if (isUClient && normalizeUClientActions(entry.uClientActions).length) {
        var uActs = normalizeUClientActions(entry.uClientActions);
        var uAppear = uActs.filter(function(a) { return /appear|entrance|present|show|出场|入场/i.test(a); });
        var uTransform = uActs.filter(function(a) { return /transform|morph|change|miracle|变身|赋形/i.test(a); });
        if (!Array.isArray(entry.appearActions) || entry.appearActions.length !== uAppear.length ||
            !Array.isArray(entry.transformActions) || entry.transformActions.length !== uTransform.length ||
            !Array.isArray(entry.availableLabels) || entry.availableLabels.length !== uActs.length) {
          entry.appearActions = uAppear;
          entry.transformActions = uTransform;
          entry.availableLabels = uActs.slice();
          changed = true;
        }
        continue;
      }
      var existingActions = normalizeCustomSkinBattleActions(entry.battleActions);
      var hasStoredAppear = Array.isArray(entry.appearActions);
      var hasStoredTransform = Array.isArray(entry.transformActions);
      var hasStoredLabels = Array.isArray(entry.availableLabels);
      var hasValidLabels = hasStoredLabels && entry.availableLabels.length > 0;
      if (hasValidLabels && hasStoredAppear && hasStoredTransform &&
          (existingActions.length > 0 || entry.__actionsScanned === true)) {
        continue;
      }
      var source = String(entry && entry.files && entry.files.fight || '').trim();
      if (!source || /^https?:\/\//i.test(source)) continue;
      try {
        var absolute = resolveCustomSkinSourceForRuntime(source);
        var stat = await fs.promises.stat(absolute);
        if (!stat.isFile()) continue;
        var evidenceKey = [path.resolve(absolute).toLowerCase(), Number(stat.size) || 0,
          Math.trunc(Number(stat.mtimeMs) || 0)].join('|');
        var evidence = _customSkinActionMetadataEvidence.get(evidenceKey);
        if (!evidence) {
          var buffer = await fs.promises.readFile(absolute);
          var info = await inspectCustomSkinUltimateActions(buffer);
          evidence = {
            actions: normalizeCustomSkinBattleActions(info && info.labels),
            appearActions: (info && info.appearActions) || [],
            transformActions: (info && info.transformActions) || [],
            availableLabels: (info && info.availableLabels) || [],
          };
          _customSkinActionMetadataEvidence.set(evidenceKey, evidence);
        }
        entry.__actionsScanned = true;
        if (!existingActions.length && evidence.actions.length) {
          entry.battleActions = evidence.actions;
          if (!String(entry.ultimateAction || '').trim()) entry.ultimateAction = evidence.actions[0];
          changed = true;
        }
        if (!hasStoredAppear || JSON.stringify(entry.appearActions) !== JSON.stringify(evidence.appearActions)) {
          entry.appearActions = evidence.appearActions.slice();
          changed = true;
        }
        if (!hasStoredTransform || JSON.stringify(entry.transformActions) !== JSON.stringify(evidence.transformActions)) {
          entry.transformActions = evidence.transformActions.slice();
          changed = true;
        }
        if (!hasStoredLabels || JSON.stringify(entry.availableLabels) !== JSON.stringify(evidence.availableLabels)) {
          entry.availableLabels = evidence.availableLabels.slice();
          changed = true;
        }
      } catch(e) {
        logWarn('CustomSkin', 'battle action metadata scan skipped', { skinId:entry.skinId, error:e.message });
      }
    }
    if (targetRevision !== _customSkinRevision) {
      _customSkinActionMetadataScanRevision = -1;
      return;
    }
    if (changed) {
      candidateSkins.forEach(function(e) { delete e.__actionsScanned; });
      var persisted = persistAndApplyCustomSkins(candidateSkins, { reload:false });
      if (!persisted.ok) logWarn('CustomSkin', 'battle action metadata save failed', { error:persisted.error });
    }
    _customSkinActionMetadataScanRevision = _customSkinRevision;
  })();
  try { await _customSkinActionMetadataScanPromise; }
  finally { _customSkinActionMetadataScanPromise = null; }
}

function publishVerifiedCustomSkinProjection(revision, generation, uiEntries, inventory) {
  if (revision !== _customSkinRevision || generation !== _customSkinStorageGeneration ||
      _customSkinSuiteCommitDepth > 0) return false;
  _customSkinCommittedProjection = {
    revision:revision,
    generation:generation,
    uiEntries:cloneCustomSkinProjectionValue(uiEntries, []),
    inventory:normalizeCommittedCustomSkinInventory(inventory, true),
  };
  // Persist the verified byte metadata so a fresh launcher does not reload a
  // stale projection showing 0B for files that were converted successfully.
  try {
    var persisted = saveCustomSkins(_customSkins, revision, _customSkinIssuedIds,
      _customSkinCommittedProjection);
    if (!persisted.ok) logWarn('CustomSkin', 'verified projection save failed', { error:persisted.error });
  } catch(error) {
    logWarn('CustomSkin', 'verified projection save failed', { error:error.message });
  }
  invalidateCustomSkinSnapshotProjection();
  notifyCustomSkinStateChanged();
  return true;
}

function customSkinProjectionVerificationKey() {
  var directory = '';
  try { directory = path.resolve(customSkinDownloadDirectory()).toLowerCase(); } catch(_) {}
  return [_customSkinRevision, _customSkinStorageGeneration, directory].join('|');
}

function customSkinProjectionWorkerEntries() {
  return _customSkins.map(function(entry) {
    var files = {};
    CUSTOM_SKIN_FILE_TYPES.forEach(function(type) {
      var source = String(entry && entry.files && entry.files[type] || '').trim();
      if (!source || /^https?:\/\//i.test(source)) { files[type] = ''; return; }
      try { files[type] = resolveCustomSkinSourceForRuntime(source); }
      catch(_) { files[type] = ''; }
    });
    return { skinId:parseCustomSkinId(entry && entry.skinId), files:files };
  });
}

function runCustomSkinProjectionWorker(request) {
  return new Promise(function(resolve, reject) {
    // Node workers cannot resolve an entry path inside app.asar on Electron 11.
    // Electron's fs bridge can read the small script, so execute that exact
    // packaged source with eval while all large file I/O remains in the worker.
    var workerSource = fs.readFileSync(
      path.join(__dirname, 'modules', 'custom-skin-projection-worker.js'), 'utf8');
    var worker = new Worker(workerSource, {
      eval:true,
      workerData:request,
    });
    var settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch(_) {}
      if (error) reject(error); else resolve(value);
    }
    worker.once('message', function(message) {
      if (!message || message.ok !== true) {
        finish(new Error(message && message.error || '皮肤完整性 worker 返回无效结果'));
        return;
      }
      finish(null, message);
    });
    worker.once('error', function(error) { finish(error); });
    worker.once('exit', function(code) {
      if (!settled) finish(new Error('皮肤完整性 worker 未返回结果，退出码：' + code));
    });
  });
}

function scheduleCustomSkinProjectionVerification() {
  var key = customSkinProjectionVerificationKey();
  if (_customSkinProjectionWorkerPromise) {
    if (_customSkinProjectionWorkerKey !== key) _customSkinProjectionWorkerPendingKey = key;
    return _customSkinProjectionWorkerPromise;
  }
  if (_customSkinProjectionVerifiedKey === key) return Promise.resolve(false);
  if (_customSkinSuiteCommitDepth > 0) {
    _customSkinProjectionWorkerPendingKey = key;
    return Promise.resolve(false);
  }
  var requestId = ++_customSkinProjectionRequestSerial;
  var request = {
    requestId:requestId,
    downloadRoot:path.resolve(customSkinDownloadDirectory()),
    manifestVersion:CUSTOM_SKIN_BATTLE_VARIANT_MANIFEST_VERSION,
    registeredEntries:customSkinProjectionWorkerEntries(),
  };
  _customSkinProjectionWorkerKey = key;
  _customSkinProjectionWorkerPromise = runCustomSkinProjectionWorker(request).then(function(result) {
    var targetRevision = _customSkinRevision;
    var targetGeneration = _customSkinStorageGeneration;
    if (requestId !== result.requestId || key !== customSkinProjectionVerificationKey() ||
        _customSkinSuiteCommitDepth > 0) return false;
    var inventory = normalizeCommittedCustomSkinInventory(result.inventory, true);
    var uiEntries = customSkinUiEntries(_customSkins, {
      bypassCommitted:true,
      registeredFileBytes:result.registeredFileBytes || {},
    });
    var published = publishVerifiedCustomSkinProjection(
      targetRevision, targetGeneration, uiEntries, inventory);
    if (published) _customSkinProjectionVerifiedKey = key;
    return published;
  }).catch(function(error) {
    logWarn('CustomSkin', 'background committed projection verification failed', {
      error:error && error.message ? error.message : String(error),
    });
    return false;
  }).finally(function() {
    _customSkinProjectionWorkerPromise = null;
    _customSkinProjectionWorkerKey = '';
    if (_customSkinProjectionWorkerPendingKey) {
      var pendingKey = _customSkinProjectionWorkerPendingKey;
      _customSkinProjectionWorkerPendingKey = '';
      if (pendingKey === customSkinProjectionVerificationKey() && _customSkinSuiteCommitDepth === 0) {
        scheduleCustomSkinProjectionVerification();
      }
    }
  });
  return _customSkinProjectionWorkerPromise;
}

function customSkinDownloadedFiles(downloaded) {
  var completeOfficialSkinIds = new Set();
  (Array.isArray(downloaded) ? downloaded : []).forEach(function(item) {
    if (item && item.sourceKind === 'official-skin' && item.type === 'fight') {
      completeOfficialSkinIds.add(parseCustomSkinId(item.id));
    }
  });
  var seen = new Set();
  return (Array.isArray(downloaded) ? downloaded : []).filter(function(item) {
    return item && item.type !== 'uclient';
  }).map(function(item) {
    if (item && item.sourceKind === 'official-skin' && !completeOfficialSkinIds.has(parseCustomSkinId(item.id))) {
      return '';
    }
    return item && item.file;
  }).filter(function(file) {
    var key = String(file || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function customSkinDownloadedMetadata(downloaded) {
  var output = {};
  (Array.isArray(downloaded) ? downloaded : []).forEach(function(item) {
    var id = parseCustomSkinId(item && item.id);
    if (!id) return;
    var current = output[String(id)] || (output[String(id)] = {});
    ['officialName','basePetId','officialSkinId','sourceKind','ultimateAction','ultimateSkillId',
      'fightPlayable','nonStandardTimeline','availabilityReason','uClientPackageVersion','uClientAssetPath',
      'uClientDedicatedUltimate','previewAdapter','legacyFightPlayable','staticPoseWrapper',
      'selectedBattleVariant','selectionReason','variantManifest'].forEach(function(key) {
      if (item[key] !== undefined && item[key] !== null && item[key] !== '') current[key] = item[key];
    });
    if (Array.isArray(item.actionLabels)) {
      current.actionLabels = normalizeCustomSkinBattleActions(
        (current.actionLabels || []).concat(item.actionLabels)
      );
    }
    if (Array.isArray(item.battleLabels)) {
      current.battleLabels = normalizeCustomSkinBattleActions(
        (current.battleLabels || []).concat(item.battleLabels)
      );
    }
    if (Array.isArray(item.uClientActions)) {
      current.uClientActions = normalizeUClientActions(
        (current.uClientActions || []).concat(item.uClientActions)
      );
    }
  });
  return output;
}

function customSkinPlayableAutoImportBatch(downloaded, requiredUClientFightIds) {
  var required = requiredUClientFightIds instanceof Set ? requiredUClientFightIds : new Set();
  var ready = new Set();
  (Array.isArray(downloaded) ? downloaded : []).forEach(function(item) {
    var id = parseCustomSkinId(item && item.id);
    if (!id || item.type !== 'fight' || item.fightPlayable !== true) return;
    var integrity = resourceVariantIntegrity.inspectDownloadRecord(item);
    if (!integrity.ok ||
        (integrity.selectedBattleVariant !== 'uclient-self-contained' &&
         integrity.selectedBattleVariant !== 'legacy-swf')) {
      item.file = '';
      item.bytes = 0;
      item.artifactLayer = 'missing';
      item.integrityReason = String(integrity.reason || 'battle-build-missing');
      return;
    }
    item.file = integrity.file;
    item.bytes = integrity.bytes;
    item.selectedBattleVariant = integrity.selectedBattleVariant;
    item.artifactLayer = 'primary';
    item.integrityReason = '';
    ready.add(id);
  });
  var skippedIds = [];
  required.forEach(function(id) { if (!ready.has(id)) skippedIds.push(id); });
  var skipped = new Set(skippedIds);
  return {
    records:(Array.isArray(downloaded) ? downloaded : []).filter(function(item) {
      return !skipped.has(parseCustomSkinId(item && item.id));
    }),
    skippedIds:skippedIds.sort(function(a, b) { return a - b; }),
  };
}

async function rollbackSourceSuiteTransactions(transactions) {
  var values = Array.from(transactions && transactions.values ? transactions.values() : []).reverse();
  var errors = [];
  for (var index = 0; index < values.length; index++) {
    try { await values[index].rollback(); }
    catch(error) { errors.push(error.message); }
  }
  return errors;
}

async function finalizeSourceSuiteTransactions(transactions) {
  var values = Array.from(transactions && transactions.values ? transactions.values() : []);
  var errors = [];
  for (var index = 0; index < values.length; index++) {
    try {
      if (values[index].state() === 'swapped') {
        var result = await values[index].finalize();
        errors = errors.concat(result.cleanupErrors || []);
      }
    } catch(error) { errors.push(error.message); }
  }
  return errors;
}

async function importCustomSkinFolderPackage(packageInfo, sender, baseRevision, options) {
  options = options || {};
  if (_customSkinFolderImportRunning) {
    return { ok:false, busy:true, error:'另一个文件夹扫描任务仍在处理中' };
  }
  if (parseInt(baseRevision, 10) !== _customSkinRevision) {
    return { ok:false, conflict:true, error:'皮肤库已在扫描期间更新，请重新扫描',
      revision:_customSkinRevision };
  }
  _customSkinFolderImportRunning = true;
  var managedTransactions = new Map();
  try {
    var scanIdentityResolver = packageInfo.configFile ? null : await customSkinScanIdentity.createResolver();
    var staged = await importCustomSkinSources(packageInfo.sources, sender, {
      configFile:packageInfo.configFile,
      configBindingsBySource:packageInfo.bindingsBySource,
      scanIdentityResolver:scanIdentityResolver,
      skipSupplement:true,
      deferPersist:true,
      managedTransactions:managedTransactions,
    });
    if (!staged || !staged.ok) {
      var initialRollbackErrors = await rollbackSourceSuiteTransactions(managedTransactions);
      if (staged && initialRollbackErrors.length) {
        staged.error = String(staged.error || '文件夹导入失败') + '；托管草稿回滚：' +
          initialRollbackErrors.join('; ');
      }
      return staged;
    }
    if (_customSkinRevision !== parseInt(baseRevision, 10)) {
      await rollbackSourceSuiteTransactions(managedTransactions);
      return { ok:false, conflict:true, error:'皮肤库已在扫描期间更新，请重新扫描',
        revision:_customSkinRevision };
    }
    for (var managedTransaction of managedTransactions.values()) await managedTransaction.swap();
    var touchedIds = new Set((staged.imported || []).map(function(item) {
      return parseCustomSkinId(item && item.skinId);
    }).filter(Boolean));
    var stagedSkins = (staged.stagedSkins || []).map(normalizeCustomSkinEntryForStorage);
    var touchedEntries = stagedSkins.filter(function(entry) {
      return touchedIds.has(parseCustomSkinId(entry && entry.skinId));
    });
    for (var touchedIndex = 0; touchedIndex < touchedEntries.length; touchedIndex++) {
      await expandCustomSkinLinkedModelsAsync(touchedEntries[touchedIndex]);
    }
    applyCustomSkinNativeTemplates(touchedEntries);
    var iconResults = options.skipSupplement === true ? [] : await ensureCustomSkinStaticIcons(touchedEntries);
    var followResults = options.skipSupplement === true ? [] : await ensureCustomSkinFollowModels(touchedEntries);
    if (_customSkinRevision !== parseInt(baseRevision, 10)) {
      var conflictRollbackErrors = await rollbackSourceSuiteTransactions(managedTransactions);
      return { ok:false, conflict:true, error:'皮肤库已在扫描期间更新，托管草稿已回滚' +
        (conflictRollbackErrors.length ? '；' + conflictRollbackErrors.join('; ') : ''),
        revision:_customSkinRevision };
    }
    var persisted = persistAndApplyCustomSkins(stagedSkins, { reload:false, notify:false });
    if (!persisted.ok) {
      var persistedRollbackErrors = await rollbackSourceSuiteTransactions(managedTransactions);
      if (persistedRollbackErrors.length) {
        persisted.error = String(persisted.error || '持久化失败') + '；托管套件回滚：' +
          persistedRollbackErrors.join('; ');
      }
      return persisted;
    }
    persisted.managedTransactionCleanupErrors = await finalizeSourceSuiteTransactions(managedTransactions);
    persisted.imported = staged.imported || [];
    persisted.warnings = (staged.warnings || []).concat(persisted.warnings || []);
    persisted.configFile = staged.configFile || '';
    persisted.configMappings = staged.configMappings || [];
    persisted.iconResults = iconResults;
    persisted.followResults = followResults;
    persisted.scannedRoot = packageInfo.root;
    persisted.scannedSwfCount = packageInfo.swfCount;
    persisted.configEntryCount = packageInfo.configEntryCount;
    persisted.configMappings.forEach(function(mapping) {
      if (mapping.from && mapping.to && mapping.from !== mapping.to) {
        persisted.warnings.push('配置编号 ' + mapping.from + ' 已被占用，安全续接为 ' + mapping.to);
      }
    });
    notifyCustomSkinStateChanged();
    scheduleCustomSkinReload();
    persisted.requiresReload = true;
    return persisted;
  } catch(error) {
    var rollbackErrors = await rollbackSourceSuiteTransactions(managedTransactions);
    if (rollbackErrors.length) error.message += '；托管套件回滚：' + rollbackErrors.join('; ');
    throw error;
  } finally {
    _customSkinFolderImportRunning = false;
  }
}

async function importDownloadedCustomSkinRecords(downloaded, sender, options) {
  options = options || {};
  var managedTransactions = new Map();
  try {
  var files = customSkinDownloadedFiles(downloaded);
  var downloadedTypeBySource = {};
  var downloadedTypesById = new Map();
  (Array.isArray(downloaded) ? downloaded : []).forEach(function(item) {
    if (!item || !item.file || item.type === 'uclient') return;
    var type = item.type === 'ultimate' ? 'skill' : String(item.type || '');
    if (CUSTOM_SKIN_FILE_TYPES.indexOf(type) < 0) return;
    downloadedTypeBySource[path.resolve(String(item.file)).toLowerCase()] = type;
    var id = parseCustomSkinId(item.id);
    if (!id) return;
    var types = downloadedTypesById.get(id);
    if (!types) { types = new Set(); downloadedTypesById.set(id,types); }
    types.add(type);
  });
  var result;
  if (files.length) {
    result = await importCustomSkinSources(files, sender, Object.assign({}, options, {
      downloadMetadataBySource:customSkinDownloadedMetadata(downloaded),
      downloadedTypeBySource:downloadedTypeBySource,
      notify:false,
      reload:false,
      deferPersist:true,
      managedTransactions:managedTransactions,
    }));
    if (!result || result.ok === false) {
      var initialRollbackErrors = await rollbackSourceSuiteTransactions(managedTransactions);
      if (result && initialRollbackErrors.length) {
        result.error = String(result.error || '导入失败') + '；托管草稿回滚：' + initialRollbackErrors.join('; ');
      }
      return result;
    }
  } else {
    result = { ok:true, unchanged:true, imported:[], skins:customSkinUiEntries(_customSkins), revision:_customSkinRevision };
  }
  var uClientRecords = (downloaded || []).filter(function(item) { return item && item.type === 'uclient'; });
  var next = Array.isArray(result.stagedSkins)
    ? result.stagedSkins.map(normalizeCustomSkinEntryForStorage)
    : _customSkins.map(normalizeCustomSkinEntryForStorage);
  // U-client auto imports use the local sequence. Native catalog ids and
  // historical issuedIds are not local occupancy and must not affect the
  // next id; only entries already present in the staged local registry do.
  var reservedIds = new Set();
  var staleManagedSuiteFiles = new Set();
  next.forEach(function(entry) { reservedIds.add(parseCustomSkinId(entry.skinId)); });
  var automaticIdCursor = nextAutomaticCustomSkinIdStart(next);
  var changed = files.length > 0;
  uClientRecords.forEach(function(record) {
    var sourceId = parseCustomSkinId(record.id);
    if (!sourceId) return;
    var existingInCurrent = findExistingCustomSkin(_customSkins, {
      sourceId:sourceId,
      officialSkinId:parseCustomSkinId(record.officialSkinId),
      basePetId:parseCustomSkinId(record.basePetId),
    });
    var entry = findExistingCustomSkin(next, {
      skinId:existingInCurrent && existingInCurrent.skinId,
      sourceId:sourceId,
      officialSkinId:parseCustomSkinId(record.officialSkinId),
      basePetId:parseCustomSkinId(record.basePetId),
    });
    if (!entry) {
      var initialEnabled = (existingInCurrent && existingInCurrent.enabled !== false)
        ? true : options.initialEnabled === true;
      entry = normalizeCustomSkinEntryForStorage({
        skinId:existingInCurrent ? existingInCurrent.skinId : reserveNextCustomSkinId(reservedIds, automaticIdCursor),
        sourceId:sourceId,
        autoId:true,
        enabled:initialEnabled,
        name:(existingInCurrent && existingInCurrent.name) || record.officialName || ('赛尔1精灵 ' + sourceId),
        files:existingInCurrent && existingInCurrent.files ? Object.assign({}, existingInCurrent.files) : {},
        battlePlacement:existingInCurrent ? existingInCurrent.battlePlacement : null,
        battleScale:existingInCurrent ? existingInCurrent.battleScale : null,
        ultimateAction:existingInCurrent ? existingInCurrent.ultimateAction : '',
        ultimateSkillId:existingInCurrent ? existingInCurrent.ultimateSkillId : 0,
        presentationMode:existingInCurrent ? existingInCurrent.presentationMode : 'full-idle',
      });
      if (!existingInCurrent) automaticIdCursor = entry.skinId + 1;
      next.push(entry);
    }
    if (existingInCurrent && existingInCurrent.enabled !== false) {
      entry.enabled = true;
    } else if (options.initialEnabled === true) {
      entry.enabled = true;
    }
    if (existingInCurrent) {
      if (existingInCurrent.battlePlacement && !entry.battlePlacement) {
        entry.battlePlacement = Object.assign({}, existingInCurrent.battlePlacement);
      }
      if (typeof existingInCurrent.battleScale === 'number' && typeof entry.battleScale !== 'number') {
        entry.battleScale = existingInCurrent.battleScale;
      }
      if (existingInCurrent.ultimateAction && !entry.ultimateAction) {
        entry.ultimateAction = existingInCurrent.ultimateAction;
      }
      if (existingInCurrent.ultimateSkillId && !entry.ultimateSkillId) {
        entry.ultimateSkillId = existingInCurrent.ultimateSkillId;
      }
    }
    var recordUsesUClientPrimary = record.selectedBattleVariant !== 'legacy-swf';
    entry.previewAdapter = recordUsesUClientPrimary ? 'uclient' : 'swf';
    entry.uClientPackageVersion = recordUsesUClientPrimary
      ? String(record.uClientPackageVersion || '').slice(0, 40) : '';
    entry.uClientAssetPath = recordUsesUClientPrimary
      ? String(record.uClientAssetPath || '').slice(0, 240) : '';
    entry.uClientActions = recordUsesUClientPrimary
      ? normalizeUClientActions(record.uClientActions || record.battleLabels) : [];
    entry.uClientDedicatedUltimate = recordUsesUClientPrimary && record.uClientDedicatedUltimate === true;
    entry.selectedBattleVariant = record.selectedBattleVariant === 'legacy-swf'
      ? 'legacy-swf' : 'uclient-self-contained';
    entry.battleVariantReason = String(record.selectionReason || '').slice(0, 160);
    entry.battleVariantManifest = String(record.variantManifest || '').slice(0, 320);
    entry.legacyFightPlayable = record.legacyFightPlayable === true;
    entry.legacyStaticPoseWrapper = record.staticPoseWrapper === true;
    var suiteTypes = downloadedTypesById.get(sourceId) || new Set();
    ['normal','icon','skill'].forEach(function(type) {
      if (suiteTypes.has(type) || !entry.files || !entry.files[type]) return;
      try { staleManagedSuiteFiles.add(resolveCustomSkinSourceForRuntime(entry.files[type])); } catch(_) {}
      delete entry.files[type];
    });
    entry.uClientFollowAvailable = suiteTypes.has('normal');
    entry.uClientIconAvailable = suiteTypes.has('icon');
    entry.uClientExternalSkillAvailable = suiteTypes.has('skill');
    if (record.officialName && (!existingInCurrent || !existingInCurrent.name)) entry.name = String(record.officialName).trim().slice(0, 80);
    entry.basePetId = parseCustomSkinId(record.basePetId);
    entry.officialSkinId = parseCustomSkinId(record.officialSkinId);
    entry.sourceKind = record.sourceKind === 'official-skin' ? 'official-skin' : 'pet';
    changed = true;
  });
  if (!changed) {
    var unchangedRollbackErrors = await rollbackSourceSuiteTransactions(managedTransactions);
    if (unchangedRollbackErrors.length) {
      throw new Error('未变更托管草稿回滚失败：' + unchangedRollbackErrors.join('; '));
    }
    return result;
  }
  for (var managedTransaction of managedTransactions.values()) await managedTransaction.swap();
  var persisted = persistAndApplyCustomSkins(next, { reload:false, notify:false });
  if (!persisted.ok) {
    var persistedRollbackErrors = await rollbackSourceSuiteTransactions(managedTransactions);
    if (persistedRollbackErrors.length) {
      persisted.error = String(persisted.error || '持久化失败') +
        '；托管套件回滚：' + persistedRollbackErrors.join('; ');
    }
    return persisted;
  }
  persisted.managedTransactionCleanupErrors = await finalizeSourceSuiteTransactions(managedTransactions);
  if (staleManagedSuiteFiles.size) {
    var activeManagedFiles = new Set();
    _customSkins.forEach(function(entry) {
      Object.keys(entry && entry.files || {}).forEach(function(type) {
        try { activeManagedFiles.add(path.resolve(resolveCustomSkinSourceForRuntime(entry.files[type])).toLowerCase()); }
        catch(_) {}
      });
    });
    var managedRoot = path.resolve(CUSTOM_SKINS_DIR,'files');
    var staleCleanup = { deletedFiles:0,deletedDirectories:0,freedBytes:0,errors:[] };
    for (var staleFile of staleManagedSuiteFiles) {
      var resolvedStale = path.resolve(staleFile);
      if (activeManagedFiles.has(resolvedStale.toLowerCase()) ||
          !customSkinCleanupPathInside(managedRoot,resolvedStale)) continue;
      try { await deleteCustomSkinManagedTree(resolvedStale,managedRoot,staleCleanup); }
      catch(error) { staleCleanup.errors.push(error.message); }
    }
    persisted.suiteCleanup = staleCleanup;
  }
  var anyEnabledUpdated = false;
  (Array.isArray(downloaded) ? downloaded : []).forEach(function(item) {
    var id = parseCustomSkinId(item && item.id);
    if (!id) return;
    var matching = findExistingCustomSkin(next, {
      sourceId:id,
      skinId:id,
      officialSkinId:parseCustomSkinId(item.officialSkinId),
    });
    if (matching && matching.enabled !== false) anyEnabledUpdated = true;
  });
  persisted.anyEnabledUpdated = anyEnabledUpdated;
  if (options.initialEnabled === true || anyEnabledUpdated) {
    persisted.requiresReload = true;
  }
  persisted.imported = result.imported || [];
  persisted.warnings = (result.warnings || []).concat(persisted.warnings || []);
  return persisted;
  } catch(error) {
    var rollbackErrors = await rollbackSourceSuiteTransactions(managedTransactions);
    if (rollbackErrors.length) error.message += '; managed suite rollback: ' + rollbackErrors.join('; ');
    throw error;
  }
}

async function writeCustomSkinDownloadFile(target, buffer) {
  var temp = target + '.part';
  await fs.promises.mkdir(path.dirname(target), { recursive:true });
  await fs.promises.writeFile(temp, buffer);
  try {
    try { await fs.promises.unlink(target); } catch(e) {
      if (e && e.code !== 'ENOENT') throw e;
    }
    await fs.promises.rename(temp, target);
  } finally {
    try { await fs.promises.unlink(temp); } catch(e) {}
  }
}

async function cleanupUnselectedUClientBattleArtifacts(itemRoot) {
  itemRoot = path.resolve(itemRoot);
  var downloadRoot = path.resolve(customSkinDownloadDirectory());
  if (!customSkinCleanupPathInside(downloadRoot, itemRoot)) {
    throw new Error('拒绝清理皮肤下载目录之外的 U 端产物');
  }
  var summary = {
    ok:true, promotedLegacySkill:false, removedUClientSkill:false,
    deletedFiles:0, deletedDirectories:0, freedBytes:0, errors:[],
  };
  var buildFile = path.join(itemRoot, 'uclient-video-build.json');
  var skillFile = path.join(itemRoot, 'skill.swf');
  var fallbackSkill = path.join(itemRoot, 'variants', 'swf', 'skill.swf');
  try {
    var videoBuild = JSON.parse(await fs.promises.readFile(buildFile, 'utf8'));
    var expectedSkillSha = String(videoBuild && videoBuild.skillSha256 || '').toUpperCase();
    var currentSkill = await fs.promises.readFile(skillFile);
    if (/^[0-9A-F]{64}$/.test(expectedSkillSha) && sha256Buffer(currentSkill) === expectedSkillSha) {
      try {
        var legacySkill = await fs.promises.readFile(fallbackSkill);
        await writeCustomSkinDownloadFile(skillFile, legacySkill);
        summary.promotedLegacySkill = true;
      } catch(fallbackError) {
        if (!fallbackError || fallbackError.code !== 'ENOENT') throw fallbackError;
        await deleteCustomSkinManagedTree(skillFile, itemRoot, summary);
        summary.removedUClientSkill = true;
      }
    }
  } catch(videoBuildError) {
    if (!videoBuildError || videoBuildError.code !== 'ENOENT') {
      summary.errors.push('视频 Skill 判定：' + videoBuildError.message);
    }
  }
  var managedFiles = [
    'uclient-pet.bundle', 'uclient-video.bundle', 'uclient-fight-build.json',
    'uclient-video-build.json', path.join('variants', 'swf', 'fight.swf'),
  ];
  for (var fileIndex = 0; fileIndex < managedFiles.length; fileIndex++) {
    try {
      await deleteCustomSkinManagedTree(path.join(itemRoot, managedFiles[fileIndex]), itemRoot, summary);
    } catch(fileError) {
      summary.errors.push(managedFiles[fileIndex] + '：' + fileError.message);
    }
  }
  var managedDirectories = ['uclient-preview', path.join('variants', 'uclient')];
  for (var dirIndex = 0; dirIndex < managedDirectories.length; dirIndex++) {
    try {
      await deleteCustomSkinManagedTree(path.join(itemRoot, managedDirectories[dirIndex]), itemRoot, summary);
    } catch(directoryError) {
      summary.errors.push(managedDirectories[dirIndex] + '：' + directoryError.message);
    }
  }
  [path.join(itemRoot, 'variants', 'swf'), path.join(itemRoot, 'variants')].forEach(function(directory) {
    try { fs.rmdirSync(directory); } catch(error) {
      if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY')) {
        summary.errors.push(path.relative(itemRoot, directory) + '：' + error.message);
      }
    }
  });
  summary.ok = summary.errors.length === 0;
  return summary;
}

const CUSTOM_SKIN_BATTLE_VARIANT_MANIFEST_VERSION = 1;

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function uClientActionSetComplete(capabilities) {
  return !!(capabilities && capabilities.standby && capabilities.physical &&
    capabilities.special && capabilities.property && capabilities.hurt);
}

async function cleanupUClientMixedSuiteArtifacts(itemRoot, options) {
  options = options || {};
  itemRoot = path.resolve(itemRoot);
  var downloadRoot = path.resolve(customSkinDownloadDirectory());
  if (!customSkinCleanupPathInside(downloadRoot,itemRoot)) {
    throw new Error('拒绝清理皮肤下载目录之外的混源产物');
  }
  var summary = { ok:true,deletedFiles:0,deletedDirectories:0,freedBytes:0,errors:[] };
  var targets = [
    path.join(itemRoot,'icon.swf'),
    path.join(itemRoot,'variants','swf','skill.swf'),
  ];
  if (options.keepNormal !== true) targets.push(path.join(itemRoot,'normal.swf'));
  if (options.keepSkill !== true) targets.push(path.join(itemRoot,'skill.swf'));
  for (var index = 0; index < targets.length; index++) {
    try { await deleteCustomSkinManagedTree(targets[index],itemRoot,summary); }
    catch(error) { summary.errors.push(error.message); }
  }
  if (summary.errors.length) {
    throw new Error('U-client suite stale Flash cleanup failed: ' + summary.errors.join('; '));
  }
  return summary;
}

function customSkinPlaybackEvidence(catalog, sourceId) {
  var check = catalog && catalog.modelStructureChecks &&
    catalog.modelStructureChecks[String(parseCustomSkinId(sourceId))] || {};
  var verified = check.staticPoseWrapper !== true &&
    seer1OfficialPlaybackVerifiedForFingerprint(check, check.fightFingerprint);
  return {
    verified:verified,
    fingerprint:String(check.fightFingerprint || ''),
    oldUi:verified && check.playbackVerifiedOldUi === true,
    newUi:verified && check.playbackVerifiedNewUi === true,
    verifiedAt:String(check.playbackVerifiedAt || ''),
    labels:Array.isArray(check.labels) ? check.labels.slice(0, 80) : [],
  };
}

async function writeCustomSkinBattleVariantManifest(itemRoot, manifest) {
  var target = path.join(itemRoot, 'battle-variants.json');
  var output = Object.assign({
    version:CUSTOM_SKIN_BATTLE_VARIANT_MANIFEST_VERSION,
    updatedAt:new Date().toISOString(),
  }, manifest || {});
  await writeCustomSkinDownloadFile(target,
    Buffer.from(JSON.stringify(output, null, 2), 'utf8'));
  return target;
}

const uClientNativeVideoTimeline = createUClientNativeVideoTimeline({
  fs:fs,path:path,crypto:crypto,spawn:spawn,process:process,
});
const uClientResourceFamilyConverter = createUClientResourceFamilyConverter({
  fs:fs,path:path,crypto:crypto,process:process,
  resourceAdapter:uClientResourceFamily,
  fetchBuffer:fetchCustomSkinBuffer,
  runExtractor:runUClientPetExtractor,
  nativeVideo:uClientNativeVideoTimeline,
  writeAtomic:writeCustomSkinDownloadFile,
});
function firstExistingUClientAutoAdapterPath(candidates, directory) {
  for (var index = 0; index < candidates.length; index++) {
    var candidate = String(candidates[index] || '').trim();
    if (!candidate) continue;
    try {
      var stat = fs.statSync(candidate);
      if (directory ? stat.isDirectory() : stat.isFile()) return path.resolve(candidate);
    } catch(_) {}
  }
  return '';
}
const uClientSkillTimelineAutoAdapter = createUClientSkillTimelineAutoAdapter({
  fs:fs,path:path,crypto:crypto,spawn:spawn,process:process,app:app,
  moduleDirectory:__dirname,fetchBuffer:fetchCustomSkinBuffer,
  writeAtomic:writeCustomSkinDownloadFile,
  pwshExecutable:String(process.env.SEER_PWSH || 'pwsh.exe'),
  nodeExecutable:firstExistingUClientAutoAdapterPath([
    process.env.SEER_NODE,
    'D:\\seer2-development-kit\\runtimes\\node22\\node.exe',
    'D:\\seer2-development-kit\\downloads\\node-v22.23.2-win-x64\\node.exe',
  ],false) || 'node',
  pythonExecutable:firstExistingUClientAutoAdapterPath([
    process.env.SEER_PYTHON,
    'D:\\seer2-development-kit\\runtimes\\python312-x86\\python.exe',
    'D:\\seer2-toolchains\\python311-x86\\python.exe',
  ],false) || 'python',
  runtimeDirectory:firstExistingUClientAutoAdapterPath([
    process.env.SEER_UCLIENT_CAPTURE_RUNTIME,
    path.join(path.dirname(process.execPath),'uclient-capture-runtime'),
    'D:\\swf-work-622\\4000-full-action-cinematics-v2-20260816\\uclient-capture-runtime',
  ],true),
  mxmlcExecutable:firstExistingUClientAutoAdapterPath([
    process.env.SEER_MXMLC,
    'D:\\swf-work-622\\downloads\\apache-flex-sdk-4.16.1\\bin\\mxmlc.bat',
  ],false),
  javaHome:firstExistingUClientAutoAdapterPath([
    process.env.SEER_JAVA8_HOME,
    'D:\\swf-work-622\\downloads\\temurin8-jre\\runtime\\jdk8u502-b07-jre',
  ],true),
  playerGlobalHome:firstExistingUClientAutoAdapterPath([
    process.env.SEER_PLAYERGLOBAL_HOME,
    'D:\\swf-work-622\\downloads\\apache-flex-sdk-4.16.1\\frameworks\\libs\\player',
  ],true),
  ffmpegExecutable:firstExistingUClientAutoAdapterPath([
    process.env.SEER_FFMPEG,
    'D:\\seer2-development-kit\\tools\\ffmpeg\\bin\\ffmpeg.exe',
    'D:\\seer2-development-kit\\downloads\\ffmpeg-release-essentials-20260812\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe',
  ],false),
  pluginFile:firstExistingUClientAutoAdapterPath([
    path.join(__dirname,'resources','uclient-skill-timeline-auto-adapter','tools',
      '4000-uclient-capture-plugin','bin','Release','net6.0','Seer4000TimelineCapture.dll'),
    path.join(__dirname,'..','..','tools','4000-uclient-capture-plugin','bin','Release',
      'net6.0','Seer4000TimelineCapture.dll'),
  ],false),
});
const uClientFtrFlashPipeline = createUClientFtrFlashPipeline({
  fs:fs,
  path:path,
  zlib:zlib,
  crypto:crypto,
  app:app,
  process:process,
  spawn:spawn,
  uClientFtrNativeConverter:uClientFtrNativeConverter,
  parseId:parseCustomSkinId,
  writeAtomic:writeCustomSkinDownloadFile,
  resourceAdapter:uClientResourceFamily,
  getCustomSkinsFile:function() { return CUSTOM_SKINS_FILE; },
  moduleDirectory:__dirname,
});
const uClientEmbeddedCinematic = createUClientEmbeddedCinematic({
  fs:fs, path:path, crypto:crypto,
  writeAtomic:writeCustomSkinDownloadFile,
  moduleDirectory:__dirname,
});
const buildUClientPetBattleSwf = uClientFtrFlashPipeline.buildUClientFtrPetBattleSwf;
const buildUClientFtrBattleAssetsIsolated = uClientFtrFlashPipeline.buildUClientFtrPetBattleAssetsIsolated;
const compactUClientPetDownloadArtifacts = uClientFtrFlashPipeline.compactUClientFtrPetDownloadArtifacts;
const ensureUClientPetFlashAssets = uClientFtrFlashPipeline.ensureUClientFtrPetFlashAssets;
const skinStorage = createSkinStorage({
  fs:fs, path:path, crypto:crypto, process:process,
  getDownloadDirectory:customSkinDownloadDirectory,
  getManagedDirectory:function() {
    return CUSTOM_SKINS_DIR ? path.join(CUSTOM_SKINS_DIR, 'files') : '';
  },
});
const materializeCustomSkinManagedFile = skinStorage.materializeManagedFile;
const materializeCustomSkinManagedFileSync = skinStorage.materializeManagedFileSync;
async function cleanupCustomSkinDownloadParts(directory) {
  var root = path.resolve(directory);
  var summary = { deletedFiles:0, freedBytes:0, errors:[] };
  async function walk(dir) {
    var entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes:true }); }
    catch(e) { if (e && e.code === 'ENOENT') return; throw e; }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && /\.part$/i.test(entry.name)) {
        try {
          var stat = await fs.promises.lstat(target);
          await fs.promises.unlink(target);
          summary.deletedFiles++;
          summary.freedBytes += Number(stat.size) || 0;
        } catch(e) {
          if (e && e.code !== 'ENOENT') summary.errors.push(target + '：' + e.message);
        }
      }
    }
  }
  await walk(root);
  return summary;
}

function cloneCustomSkinDownloadTask() {
  if (!_customSkinDownloadTask) return null;
  try { return JSON.parse(JSON.stringify(_customSkinDownloadTask)); }
  catch(_) { return null; }
}

function beginCustomSkinDownloadTask(request, total, directory) {
  var now = Date.now();
  _customSkinDownloadTask = {
    id:++_customSkinDownloadTaskSerial,
    running:true,
    state:'preparing',
    request:JSON.parse(JSON.stringify(request || {})),
    progress:{ state:'preparing', completed:0, total:total, directory:directory },
    result:null,
    error:'',
    startedAt:now,
    updatedAt:now,
    finishedAt:0,
  };
}

function finishCustomSkinDownloadTask(result, error, completed, total, directory) {
  if (!_customSkinDownloadTask) return;
  var failedMessage = String(error && error.message || error || '');
  var outcome = failedMessage ? 'failed' : (result && result.rateLimited ? 'rate-limited' : 'completed');
  _customSkinDownloadTask.running = false;
  _customSkinDownloadTask.state = outcome;
  _customSkinDownloadTask.result = result || null;
  _customSkinDownloadTask.error = failedMessage;
  _customSkinDownloadTask.progress = {
    state:'finished', outcome:outcome, completed:completed, total:total,
    directory:directory, error:failedMessage,
  };
  _customSkinDownloadTask.updatedAt = Date.now();
  _customSkinDownloadTask.finishedAt = _customSkinDownloadTask.updatedAt;
}

function sendCustomSkinDownloadProgress(sender, payload) {
  payload = Object.assign({}, payload || {});
  if (_customSkinDownloadTask) {
    _customSkinDownloadTask.progress = payload;
    if (_customSkinDownloadTask.running && payload.state) _customSkinDownloadTask.state = payload.state;
    _customSkinDownloadTask.updatedAt = Date.now();
  }
  var delivered = new Set();
  forEachCustomSkinRenderer(function(contents) {
    try {
      delivered.add(contents.id);
      contents.send('custom-skin-download-progress', payload);
    } catch(_) {}
  });
  try {
    if (sender && !sender.isDestroyed() && !delivered.has(sender.id)) {
      sender.send('custom-skin-download-progress', payload);
    }
  } catch(_) {}
}

function customSkinDownloadJobs(request) {
  var jobs = [];
  var seen = new Set();
  function add(idValue, typeValue, metadata) {
    var id = parseCustomSkinId(idValue);
    var type = String(typeValue || '').toLowerCase();
    if (!id || !CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES[type]) return;
    var key = id + ':' + type;
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push(Object.assign({ id:id, type:type }, metadata || {}));
  }
  if (request && Array.isArray(request.jobs)) {
    request.jobs.forEach(function(job) { add(job && job.id, job && job.type, job); });
  } else {
    var ids = parseCustomSkinDownloadIds(request && request.ids);
    var types = (Array.isArray(request && request.types) ? request.types : []).filter(function(type, index, all) {
      return !!CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES[type] && all.indexOf(type) === index;
    });
    ids.forEach(function(id) { types.forEach(function(type) { add(id, type); }); });
  }
  return jobs;
}

function customSkinDownloadQueueRootIds(request, jobs) {
  var roots = parseCustomSkinDownloadIds(request && request.queueRootIds);
  if (!roots.length) roots = parseCustomSkinDownloadIds(request && request.ids);
  if (!roots.length) {
    roots = parseCustomSkinDownloadIds((Array.isArray(jobs) ? jobs : []).map(function(job) {
      return job && (job.queueRootId || job.basePetId || job.id);
    }));
  }
  return roots;
}

function customSkinDownloadQueueRootForItem(item, jobs) {
  var explicit = parseCustomSkinId(item && item.queueRootId);
  if (explicit) return explicit;
  var id = parseCustomSkinId(item && item.id);
  var type = String(item && item.type || '');
  var match = (Array.isArray(jobs) ? jobs : []).find(function(job) {
    return parseCustomSkinId(job && job.id) === id && (!type || String(job && job.type || '') === type);
  });
  return parseCustomSkinId(match && (match.queueRootId || match.basePetId || match.id)) ||
    parseCustomSkinId(item && item.basePetId) || id;
}

function planCustomSkinDownloadQueueSettlement(queueIds, request, finalResult, jobs) {
  var current = parseCustomSkinDownloadIds(queueIds);
  if (!finalResult || request && request.previewOnly === true || request && request.consumeQueue === false) {
    return { changed:false, before:current, after:current.slice(), consumed:[], retained:[] };
  }
  var requestedRoots = new Set(customSkinDownloadQueueRootIds(request, jobs));
  if (!requestedRoots.size) {
    return { changed:false, before:current, after:current.slice(), consumed:[], retained:[] };
  }
  var retryRoots = new Set();
  ;['failed','pending'].forEach(function(key) {
    (Array.isArray(finalResult[key]) ? finalResult[key] : []).forEach(function(item) {
      var root = customSkinDownloadQueueRootForItem(item, jobs);
      if (root) retryRoots.add(root);
    });
  });
  (Array.isArray(finalResult.incompleteUClientIds) ? finalResult.incompleteUClientIds : []).forEach(function(idValue) {
    var id = parseCustomSkinId(idValue);
    var matches = (Array.isArray(jobs) ? jobs : []).filter(function(job) {
      return parseCustomSkinId(job && job.id) === id;
    });
    if (!matches.length && id) retryRoots.add(id);
    matches.forEach(function(job) {
      var root = parseCustomSkinId(job && (job.queueRootId || job.basePetId || job.id));
      if (root) retryRoots.add(root);
    });
  });
  var consumed = [];
  var after = current.filter(function(id) {
    if (!requestedRoots.has(id) || retryRoots.has(id)) return true;
    consumed.push(id);
    return false;
  });
  return {
    changed:consumed.length > 0,
    before:current,
    after:after,
    consumed:consumed,
    retained:Array.from(retryRoots).filter(function(id) { return requestedRoots.has(id); }),
  };
}

function settleCustomSkinDownloadQueue(request, finalResult, jobs) {
  var plan = planCustomSkinDownloadQueueSettlement(
    _customSkinDownloadQueueIds, request || {}, finalResult, jobs);
  if (!plan.changed) return Object.assign({ ok:true }, plan);
  var previous = _customSkinDownloadQueueIds.slice();
  var previousRevision = _customSkinDownloadQueueRevision;
  _customSkinDownloadQueueIds = plan.after.slice();
  _customSkinDownloadQueueRevision++;
  var saved = saveCustomSkinDownloadSettings();
  if (!saved || saved.ok === false) {
    _customSkinDownloadQueueIds = previous;
    _customSkinDownloadQueueRevision = previousRevision;
    return Object.assign({ ok:false, error:String(saved && saved.error || '待下载列表保存失败') }, plan, {
      after:previous,
      consumed:[],
    });
  }
  return Object.assign({ ok:true }, plan);
}

function customSkinDownloadSuiteRoutes(jobs, forceUClient) {
  var suiteRoutes = new Map();
  (Array.isArray(jobs) ? jobs : []).forEach(function(job) {
    if (!job) return;
    var id = parseCustomSkinId(job.id);
    if (!id) return;
    var route = suiteRoutes.get(id);
    if (!route) {
      route = forceUClient === true ? {
        id:id,
        source:'u-client',
        traditionalSwf:false,
        uClient:true,
        reason:'user-preferred-u-client',
      } : officialBattleRouting.route(id);
      suiteRoutes.set(id,route);
    }
    job.suiteRoute = route;
    job.battleRoute = route;
  });
  return jobs;
}

function traditionalFallbackRoute(id) {
  return {
    id:id,
    source:'traditional-swf',
    traditionalSwf:true,
    uClient:false,
    reason:'u-client-model-unavailable-traditional-resource-fallback',
  };
}

async function settleCustomSkinDownloadSuiteDrafts(transactions, downloaded, failed,
  unavailable, requiredFightIds) {
  var failedIds = new Set((failed || []).map(function(item) {
    return parseCustomSkinId(item && item.id);
  }).filter(Boolean));
  (unavailable || []).forEach(function(item) {
    var id = parseCustomSkinId(item && item.id);
    if (id && String(item && item.type || '') === 'fight') failedIds.add(id);
  });
  var recordsById = new Map();
  (downloaded || []).forEach(function(record) {
    var id = parseCustomSkinId(record && record.id);
    if (!id) return;
    if (!recordsById.has(id)) recordsById.set(id,[]);
    recordsById.get(id).push(record);
  });
  var committedIds = [];
  var rolledBackIds = [];
  for (var entry of transactions.entries()) {
    var id = entry[0];
    var transaction = entry[1];
    var records = recordsById.get(id) || [];
    var needsFight = requiredFightIds && requiredFightIds.has(id);
    var fightRecord = records.find(function(record) {
      return record && (record.type === 'fight' || record.type === 'uclient');
    });
    if (needsFight) {
      var integrity = fightRecord ? resourceVariantIntegrity.inspectDownloadRecord(fightRecord) : null;
      if (!integrity || !integrity.ok) failedIds.add(id);
    }
    if (failedIds.has(id) || !records.length) {
      await transaction.rollback();
      rolledBackIds.push(id);
      continue;
    }
    await transaction.swap();
    records.forEach(function(record) {
      if (record.file) record.file = transaction.mapFile(record.file);
      if (record.variantManifest) record.variantManifest = transaction.mapFile(record.variantManifest);
      if (record.uClientVideoBuild && record.uClientVideoBuild.file) {
        record.uClientVideoBuild.file = transaction.mapFile(record.uClientVideoBuild.file);
      }
    });
    committedIds.push(id);
  }
  if (rolledBackIds.length) {
    for (var index = downloaded.length - 1; index >= 0; index--) {
      if (rolledBackIds.indexOf(parseCustomSkinId(downloaded[index] && downloaded[index].id)) >= 0) {
        downloaded.splice(index,1);
      }
    }
  }
  return { committedIds:committedIds,rolledBackIds:rolledBackIds };
}

// Download the large U-client bundles in a bounded batch before the existing
// per-job extract/convert pipeline runs.  The converter remains serial and
// transactional; this only removes the old download→convert→download bubble.
async function stageUClientBatchBundles(jobs, directory, forceManifestRefresh, forceDownload,
  suiteTransactions, onProgress) {
  var candidates = (Array.isArray(jobs) ? jobs : []).filter(function(job) {
    var route = job && (job.suiteRoute || job.battleRoute);
    if (!route || !route.uClient || (job.type !== 'fight' && job.type !== 'normal')) return false;
    if (forceDownload) return true;
    // Do not download compacted source bundles before the converter has a
    // chance to validate and reuse an already committed result.  A false
    // positive here is safe: the serial converter performs the authoritative
    // metadata/hash validation and downloads normally when rebuilding.
    var id = parseCustomSkinId(job.id);
    if (!id) return false;
    var itemRoot = path.join(directory, String(id));
    if (job.type === 'normal') {
      return !(fs.existsSync(path.join(itemRoot, 'normal.swf')) &&
        fs.existsSync(path.join(itemRoot, 'uclient-follow-metadata.json')));
    }
    return !(fs.existsSync(path.join(itemRoot, 'fight.swf')) &&
      fs.existsSync(path.join(itemRoot, 'battle-variants.json')) &&
      fs.existsSync(path.join(itemRoot, 'uclient-preview', 'uclient-preview.json')));
  });
  var result = new Map();
  if (!candidates.length) return result;
  var current = await getCurrentUClientPetManifest(!!forceManifestRefresh);
  var queue = candidates.slice();
  var workerCount = Math.min(CUSTOM_SKIN_ARCH_POLICY.uClientStageWorkers, queue.length);
  var completed = 0;
  // A normal/fight pair for the same source id may be claimed by different
  // staging workers.  Cache the in-flight begin promise synchronously so both
  // workers share one suite draft instead of racing two transactions and
  // leaking the losing draft/bundle.
  var transactionPromises = new Map();
  async function getSuiteTransaction(id) {
    var existing = suiteTransactions.get(id);
    if (existing) return existing;
    var pending = transactionPromises.get(id);
    if (!pending) {
      pending = sourceSuiteTransaction.begin(directory, id).then(function(transaction) {
        suiteTransactions.set(id, transaction);
        return transaction;
      });
      transactionPromises.set(id, pending);
    }
    return await pending;
  }
  async function worker() {
    while (queue.length) {
      var job = queue.shift();
      var id = parseCustomSkinId(job && job.id);
      if (!id) continue;
      var key = String(id) + ':' + String(job.type);
      try {
        var credential = uClientCatalog.credential(current.snapshot, id, {
          basePetId:job.basePetId, catalogueId:job.officialSkinId, name:job.officialName,
        });
        var record = job.type === 'normal' ? credential && credential.follow : credential && credential.model;
        if (!record || !record.fileHash || !(Number(record.bytes || record.fileSize) > 0)) {
          throw new Error('U-client staging credential is incomplete');
        }
        var bytes = Number(record.bytes || record.fileSize || 0);
        var url = String(record.url || (UCLIENT_PET_PACKAGE_ROOT + String(record.fileHash)));
        var transaction = await getSuiteTransaction(id);
        var itemRoot = path.join(transaction.parent, String(id));
        await fs.promises.mkdir(itemRoot, { recursive:true });
        var target = path.join(itemRoot, job.type === 'normal' ? 'uclient-follow.bundle' : 'uclient-pet.bundle');
        var reusable = false;
        if (!forceDownload) {
          try { reusable = (await fs.promises.stat(target)).size === bytes; } catch(_) {}
        }
        if (!reusable) {
          if (typeof onProgress === 'function') onProgress({state:'staging',id:id,type:job.type,
            completed:completed,total:candidates.length,message:'正在批量下载 U 端资源'});
          var buffer = await fetchCustomSkinBuffer(url, 90000, 0,
            Math.max(64 * 1024 * 1024, bytes + 1024), onProgress);
          if (buffer.length !== bytes) throw new Error('U-client staging bundle size mismatch');
          await writeCustomSkinDownloadFile(target, buffer);
        }
        result.set(key, { file:target, bytes:bytes, hash:String(record.fileHash || '').toLowerCase(),
          url:url, credential:credential });
      } catch(error) {
        // Staging is an optimization.  The original per-job path remains the
        // safe fallback if a single prefetch fails.
        logWarn('CustomSkin','U-client batch staging skipped',{id:id,type:job.type,error:error.message});
      } finally {
        completed++;
        if (typeof onProgress === 'function') onProgress({state:'staging',id:id,type:job.type,
          completed:completed,total:candidates.length});
      }
    }
  }
  await Promise.all(Array.from({length:workerCount}, worker));
  return result;
}

async function downloadOfficialCustomSkinModels(request, sender) {
  if (_customSkinDownloadRunning) return {
    ok:false,
    busy:true,
    error:'已有模型下载任务正在进行',
    task:cloneCustomSkinDownloadTask(),
  };
  request = Object.assign({}, request || {});
  request.previewOnly = request.previewOnly === true || String(request.previewOnly) === '1';
  // Refreshing the official package snapshot must not also discard a verified
  // converted build.  A changed snapshot fingerprint still invalidates the
  // cached metadata inside downloadOfficialUClientBuild; forceDownload is an
  // explicit hard-rebuild escape hatch, not an alias of forceRefresh.
  request.forceRefresh = request.forceRefresh === true || String(request.forceRefresh) === '1';
  request.forceDownload = request.forceDownload === true || String(request.forceDownload) === '1';
  request.forceUClient = typeof request.forceUClient === 'boolean'
    ? request.forceUClient
    : _customSkinPreferUClient === true;
  request.autoImport = typeof request.autoImport === 'boolean'
    ? request.autoImport
    : _customSkinAutoImport === true;
  // Preview downloads belong to the downloaded preview inventory only.  They
  // still advance the shared state revision below so every open library sees
  // the same snapshot, but they must not create a formal skin registration.
  // A normal catalog download always becomes a disabled library entry so it is
  // visible and manageable afterwards.  The checkbox controls only whether the
  // new entry is immediately enabled.  Preview-only downloads remain isolated
  // from the formal registry.
  var shouldImportDownloaded = request.previewOnly !== true;
  var shouldEnableImported = request.previewOnly !== true && request.autoImport === true;
  if (typeof request.includeSkins !== 'boolean') {
    request.includeSkins = _customSkinIncludeOfficialSkins !== false;
  }
  var jobs = customSkinDownloadJobs(request);
  jobs.forEach(function(job) {
    if (!parseCustomSkinId(job && job.queueRootId)) {
      job.queueRootId = parseCustomSkinId(job && (job.basePetId || job.id));
    }
  });
  request.queueRootIds = customSkinDownloadQueueRootIds(request, jobs);
  jobs = await annotateDirectSeer1OfficialSkinJobs(request, jobs);
  jobs = await expandSeer1OfficialSkinJobs(request, jobs);
  // The authoritative traditional-SWF whitelist is bundled and initialized
  // once with the app. Route the whole suite before any network or transaction
  // work. U-client head jobs are filtered only after the suite is known to have
  // a usable U-client model; model-less ids may fall back to direct traditional
  // resources so icon-only/no-battle pets can still be imported.
  customSkinDownloadSuiteRoutes(jobs, request.forceUClient);
  var uClientFilteredIcons = [];
  // An owner is downgraded as a whole only when its U-client battle model is
  // absent. A missing FollowPackage is independent: normal may fall back to a
  // direct resource while fight still uses the U-client PetAnimPackage.
  var uClientFallbackIds = new Set();
  jobs = await attachCustomSkinPublicNamesToJobs(jobs);
  var downloadCatalog = _seer1OfficialPetCatalogCache;
  if (!downloadCatalog) {
    try { downloadCatalog = await officialCatalogStore.read(); } catch(_) {}
  }
  if (!downloadCatalog || !Array.isArray(downloadCatalog.items)) downloadCatalog = {};
  var uClientVariantDownloadIds = new Set(jobs.map(function(job) {
    if (!job) return 0;
    var id = parseCustomSkinId(job.id);
    return id && job.suiteRoute && job.suiteRoute.uClient ? id : 0;
  }).filter(Boolean));
  var requiredFightDownloadIds = new Set(jobs.filter(function(job) {
    return job && job.type === 'fight';
  }).map(function(job) { return parseCustomSkinId(job.id); }).filter(Boolean));
  if (!jobs.length) return {
    ok:false,
    error:uClientFilteredIcons.length
      ? '所选项目均为 U 端资源，头像已在下载前过滤；请至少选择跟随模型或战斗模型'
      : '没有有效的精灵序号或资源类型',
    filtered:uClientFilteredIcons,
  };
  var uniqueIds = new Set(jobs.map(function(job) { return job.id; }));
  if (uniqueIds.size > 200 || jobs.length > 800) {
    return { ok:false, error:'单次最多下载 200 个精灵、800 个资源任务' };
  }

  var directory = customSkinDownloadDirectory();
  // Invalidate any verification task before the first live-suite rename and
  // keep the old committed projection readable until the matching revision is
  // published.  This closes both rename windows without exposing an empty or
  // mixed directory snapshot to UI IPC.
  _customSkinStorageGeneration++;
  var storageGeneration = _customSkinStorageGeneration;
  _customSkinSuiteCommitDepth++;
  var total = jobs.length;
  var completed = 0;
  var downloaded = [];
  var failed = [];
  var unavailable = [];
  var pending = [];
  var resourceCaches = {};
  var suiteTransactions = new Map();
  var uClientBatchStage = new Map();
  var uClientManifestRefreshPending = request.forceRefresh === true;
  function consumeUClientManifestRefresh() {
    if (!uClientManifestRefreshPending) return false;
    uClientManifestRefreshPending = false;
    return true;
  }
  var finalResult = null;
  var finalError = null;
  _customSkinDownloadRunning = true;
  beginCustomSkinDownloadTask(request, total, directory);
  sendCustomSkinDownloadProgress(sender, {
    state:'preparing', completed:0, total:total, directory:directory,
  });
  try {
    await fs.promises.mkdir(directory, { recursive:true });
    await cleanupCustomSkinDownloadParts(directory);
    if (request.batchUClient !== false) {
      uClientBatchStage = await stageUClientBatchBundles(jobs, directory,
        consumeUClientManifestRefresh(), request.forceDownload === true,
        suiteTransactions, function(progress) {
          sendCustomSkinDownloadProgress(sender, Object.assign({
            state:'staging', completed:0, total:total, directory:directory,
          }, progress || {}));
        });
      sendCustomSkinDownloadProgress(sender, {
        state:'converting', completed:0, total:total, directory:directory,
      });
    }
    for (var jobIndex = 0; jobIndex < jobs.length; jobIndex++) {
      var job = jobs[jobIndex];
      var id = job.id;
      var type = job.type;
      var suiteTransaction = null;
      var jobDirectory = '';
      var suiteRoute = job.suiteRoute || job.battleRoute || officialBattleRouting.route(id);
      if (suiteRoute && suiteRoute.uClient && request.forceUClient !== true &&
          uClientFallbackIds.has(id)) {
        suiteRoute = job.suiteRoute = job.battleRoute = traditionalFallbackRoute(id);
      }
      if (type === 'icon' && suiteRoute && suiteRoute.uClient) {
        if (!uClientFallbackIds.has(id)) {
          uClientFilteredIcons.push({ id:id, type:'icon', reason:'uclient-head-bundle-filtered-before-download' });
          completed++;
          sendCustomSkinDownloadProgress(sender, {
            state:'unavailable', id:id, type:type, completed:completed,
            total:total, directory:directory,
          });
          continue;
        }
        suiteRoute = job.suiteRoute = job.battleRoute = traditionalFallbackRoute(id);
      }
      if (suiteRoute && suiteRoute.uClient && type === 'ultimate') {
        var omitted = new Error('U-client suite does not request a Flash skill companion; cinematic capability is embedded in fight.swf');
        omitted.statusCode = 404;
        omitted.optional = true;
        omitted.category = 'uclient-embedded-skill';
        omitted.code = 'UCLIENT_SKILL_NOT_STANDALONE';
        unavailable.push(customSkinDownloadUnavailable(id,type,CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES[type],omitted,job));
        completed++;
        sendCustomSkinDownloadProgress(sender, {
          state:'unavailable', id:id, type:type, completed:completed,
          total:total, directory:directory,
        });
        continue;
      }
      suiteTransaction = suiteTransactions.get(id);
      if (!suiteTransaction) {
        suiteTransaction = await sourceSuiteTransaction.begin(directory,id);
        suiteTransactions.set(id,suiteTransaction);
      }
      jobDirectory = suiteTransaction.parent;
      var cfg = CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES[type];
      function withTransferProgress(baseConfig, transferLabel) {
        return Object.assign({}, baseConfig, {
          onProgress:function(progress) {
            var elapsedMs = Math.max(1, Number(progress && progress.elapsedMs) || 1);
            var receivedBytes = Math.max(0, Number(progress && progress.receivedBytes) || 0);
            sendCustomSkinDownloadProgress(sender, {
              state:'transfer', id:id, type:type, label:transferLabel || cfg.label,
              completed:completed, total:total, directory:directory,
              receivedBytes:receivedBytes,
              totalBytes:Math.max(0, Number(progress && progress.totalBytes) || 0),
              speedBytesPerSecond:Math.round(receivedBytes * 1000 / elapsedMs),
            });
          },
        });
      }
      sendCustomSkinDownloadProgress(sender, {
        state:'downloading', id:id, type:type, label:cfg.label,
        completed:completed, total:total, directory:directory,
      });
      try {
        var resourceKey = String(cfg.resourceKey || type);
        var resourceCache = resourceCaches[String(id)] || (resourceCaches[String(id)] = {});
        var cached = resourceCache[resourceKey];
        var buffer;
        var ultimateInfo = null;
        var ultimateMeta = null;
        var battleInspection = null;
        var uClientBuild = null;
        var uClientFollowBuild = null;
        var uClientDownloadRecord = null;
        var uClientCapabilities = null;
        var legacyFightFetch = null;
        var legacyBattleInspection = null;
        var legacyVariantFile = '';
        var legacyVariantError = '';
        var selectedBattleVariant = '';
        var selectedBattleReason = '';
        var battleVariantManifestFile = '';
        var legacyStorageCleanup = null;
        if (type === 'normal' && uClientVariantDownloadIds.has(id) && !uClientFallbackIds.has(id)) {
          try {
            var uClientFollowTransfer = withTransferProgress(
              { label:'U-client follow animation' },'U-client follow animation');
            var stagedFollow = uClientBatchStage.get(String(id) + ':normal');
            uClientFollowBuild = await downloadOfficialUClientFollowBuild(
              id,jobDirectory,uClientFollowTransfer.onProgress,
              consumeUClientManifestRefresh(),request.forceDownload === true,
              { identity:{ basePetId:job.basePetId, catalogueId:job.officialSkinId, name:job.officialName },
                prefetchedBundleFile:stagedFollow && stagedFollow.file }
            );
            var followBuffer = await fs.promises.readFile(uClientFollowBuild.followFile);
            resourceCache.uClientFollowBuild = uClientFollowBuild;
            buffer = followBuffer;
            cached = resourceCache[resourceKey] = {
              buffer:followBuffer,
              written:true,
              target:uClientFollowBuild.followFile,
              url:String(uClientFollowBuild.metadata && uClientFollowBuild.metadata.bundleEvidence &&
                uClientFollowBuild.metadata.bundleEvidence.url || ''),
              compatibilityFallback:false,
              suiteSource:'uclient',
            };
          } catch(uClientFollowError) {
            if (request.forceUClient !== true && uClientFollowError &&
                uClientFollowError.statusCode === 404 && uClientFollowError.optional === true &&
                uClientFollowError.category === 'unsupported-follow') {
              // A missing U-client follow model is a capability absence, not
              // a conversion failure. Continue into the direct legacy fetch
              // below while keeping the U-client fight route intact.
              cached = null;
              suiteRoute = job.suiteRoute = job.battleRoute = traditionalFallbackRoute(id);
            } else {
              uClientFollowError.message = '白名单判定为 U 端资源，官方 FollowPackage 下载或转换失败：' +
                uClientFollowError.message;
              throw uClientFollowError;
            }
          }
        }
        if (type === 'fight' && uClientVariantDownloadIds.has(id) && !uClientFallbackIds.has(id)) {
          try {
            var uClientTransfer = withTransferProgress({ label:'U-client battle animation' }, 'U-client battle animation');
            var stagedFight = uClientBatchStage.get(String(id) + ':fight');
            uClientBuild = await downloadOfficialUClientBuild(
              id, jobDirectory, uClientTransfer.onProgress,
              consumeUClientManifestRefresh(), request.forceDownload === true,
              { identity:{ basePetId:job.basePetId, catalogueId:job.officialSkinId, name:job.officialName },
                prefetchedBundleFile:stagedFight && stagedFight.file }
            );
            uClientCapabilities = uClientActionCapabilities(uClientBuild.metadata.actions);
            var uClientBuildEvidence = uClientBuild.metadata.flashBattleSwf || {};
            var uClientBuildIntegrity = resourceVariantIntegrity.inspectFile(uClientBuild.battleFile, {
              bytes:uClientBuildEvidence.bytes,
              sha256:uClientBuildEvidence.fightSha256 || uClientBuildEvidence.sha256,
            });
            if (!uClientBuildIntegrity.ok) {
              throw new Error('U-client self-contained fight build integrity failed: ' + uClientBuildIntegrity.reason);
            }
            uClientBuild.battleFile = uClientBuildIntegrity.file;
            uClientDownloadRecord = {
                id:id,
                type:'uclient',
                label:'U-client battle animation',
                file:uClientBuildIntegrity.file,
                bytes:uClientBuildIntegrity.bytes,
                artifactLayer:'converted-build',
                sourceUrl:UCLIENT_PET_PACKAGE_ROOT + String(uClientBuild.metadata.bundleHash || ''),
                uClientPackageVersion:uClientBuild.metadata.packageVersion,
                uClientAssetPath:uClientBuild.metadata.assetPath,
                battleLabels:uClientCapabilities.actions,
                uClientActions:uClientCapabilities.actions,
                uClientDedicatedUltimate:uClientCapabilities.dedicatedUltimate,
                uClientDedicatedUltimateActions:uClientCapabilities.dedicatedUltimateActions,
                uClientVideoAvailable:!!uClientBuild.videoBuild,
                uClientVideoAssetPath:uClientBuild.videoBuild && uClientBuild.videoBuild.assetPath,
                uClientVideoBuild:uClientBuild.videoBuild || undefined,
                uClientFollowAvailable:!!resourceCache.uClientFollowBuild,
                uClientIconAvailable:false,
                uClientExternalSkillAvailable:!!(uClientBuild.videoBuild && uClientBuild.videoBuild.file),
                officialName:job.officialName,
                basePetId:job.basePetId,
                officialSkinId:job.officialSkinId,
                sourceKind:job.sourceKind,
              };
            selectedBattleVariant = 'uclient-self-contained';
            selectedBattleReason = job.battleRoute && job.battleRoute.reason ||
              'not-in-verified-traditional-swf-whitelist';
            resourceCache.uClientFightBuild = uClientBuild;
          } catch(uClientError) {
            if (request.forceUClient !== true && uClientError &&
                uClientError.statusCode === 404 && uClientError.optional === true &&
                uClientError.category === 'unsupported-model') {
              uClientFallbackIds.add(id);
              // Do not require a playable U-client fight for a pet that has
              // no U-client battle model. The normal direct-resource branch
              // will try the traditional endpoint next, and later icon jobs
              // may use the same owner-level fallback.
              requiredFightDownloadIds.delete(id);
              suiteRoute = job.suiteRoute = job.battleRoute = traditionalFallbackRoute(id);
              cached = null;
            } else {
              uClientError.message = '白名单判定为 U 端资源，自动下载或转换失败：' + uClientError.message;
              throw uClientError;
            }
          }
        }
        if (type === 'ultimate') {
          ultimateMeta = await resolveSeer1OfficialUltimate(id, job.basePetId, job.officialSkinId);
          var officialFight = await fetchOfficialCustomSkinModel(id, withTransferProgress(CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES.fight, '战斗模型'));
          ultimateInfo = await inspectCustomSkinUltimateActions(officialFight.buffer);
          var declaredAction = String(ultimateMeta.action || '').toLowerCase();
          var scannedActions = ultimateInfo.labels.map(function(label) { return String(label).toLowerCase(); });
          if (declaredAction && scannedActions.indexOf(declaredAction) < 0) {
            var actionMissing = new Error('官方配置声明动作 ' + ultimateMeta.action + '，但战斗包中未扫描到该动作');
            actionMissing.code = 'ULTIMATE_ACTION_MISSING';
            actionMissing.category = 'invalid-official-package';
            throw actionMissing;
          }
          var skillConfig = Object.assign({}, cfg, {
            url:function(skillId) { return 'https://seer.61.com/resource/fightResource/skill/swf/' + skillId + '.swf'; },
            compatibilityUrl:function(skillId) { return 'http://seer.61.com/resource/fightResource/skill/swf/' + skillId + '.swf'; },
          });
          var skillResolved = await fetchSeer1UltimateEffect(ultimateMeta, withTransferProgress(skillConfig, '独立技能特效'));
          var skillFetched = skillResolved.fetched;
          buffer = skillFetched.buffer;
          cached = resourceCache[resourceKey] = {
            buffer:buffer,
            written:false,
            target:'',
            url:skillFetched.url,
            compatibilityFallback:skillFetched.compatibilityFallback,
          };
        }
        if (type !== 'ultimate' && uClientDownloadRecord && uClientBuild && uClientBuild.battleFile) {
          var playbackEvidence = customSkinPlaybackEvidence(downloadCatalog, id);
          if (uClientActionSetComplete(uClientCapabilities)) {
            buffer = await fs.promises.readFile(uClientBuild.battleFile);
            selectedBattleVariant = selectedBattleVariant || 'uclient-self-contained';
            selectedBattleReason = selectedBattleReason || 'not-in-verified-traditional-swf-whitelist';
            cached = resourceCache[resourceKey] = {
              buffer:buffer,
              written:true,
              target:uClientBuild.battleFile,
              url:UCLIENT_PET_PACKAGE_ROOT + String(uClientBuild.metadata.bundleHash || ''),
              compatibilityFallback:false,
            };
          } else {
            var noBattle = new Error('UClient 动作表不完整，且传统 SWF 未通过双 UI 实际播放验证');
            noBattle.code = 'NO_PLAYABLE_BATTLE_VARIANT';
            noBattle.category = 'unsupported-model';
            noBattle.optional = true;
            throw noBattle;
          }
        } else if (type !== 'ultimate' && cached && cached.error) {
          throw cached.error;
        } else if (type !== 'ultimate' && cached && cached.buffer) {
          buffer = cached.buffer;
        } else if (type !== 'ultimate') {
          try {
            var fetched = await fetchOfficialCustomSkinModel(id, withTransferProgress(cfg, cfg.label));
            buffer = fetched.buffer;
            cached = resourceCache[resourceKey] = {
              buffer:buffer,
              written:false,
              target:'',
              url:fetched.url,
              compatibilityFallback:fetched.compatibilityFallback,
            };
          } catch(fetchError) {
            resourceCache[resourceKey] = { error:fetchError };
            throw fetchError;
          }
        }
        validateOfficialCustomSkinModel(type, buffer);
        if (type === 'fight') {
          battleInspection = await inspectCustomSkinBattleModel(buffer);
          if (battleInspection.staticPoseWrapper === true && !uClientDownloadRecord) {
            var staticLegacy = new Error('静态 SWF 无 UClient 战斗资源');
            staticLegacy.code = 'STATIC_LEGACY_WITHOUT_UClient_PRIMARY';
            staticLegacy.category = 'unsupported-model';
            throw staticLegacy;
          }
        }
        var battlePlaybackEvidence = type === 'fight'
          ? customSkinPlaybackEvidence(downloadCatalog, id) : null;
        var effectiveLegacyFightPlayable = type === 'fight' && battleInspection &&
          battleInspection.staticPoseWrapper !== true &&
          (battleInspection.ok === true || !!(battlePlaybackEvidence && battlePlaybackEvidence.verified));
        if (type === 'fight' && uClientDownloadRecord) {
          uClientDownloadRecord.legacyFightPlayable = legacyBattleInspection &&
            legacyBattleInspection.staticPoseWrapper !== true &&
            (legacyBattleInspection.ok === true || !!(battlePlaybackEvidence && battlePlaybackEvidence.verified));
          uClientDownloadRecord.staticPoseWrapper = !!(legacyBattleInspection && legacyBattleInspection.staticPoseWrapper);
          uClientDownloadRecord.selectedBattleVariant = selectedBattleVariant;
          uClientDownloadRecord.selectionReason = selectedBattleReason;
          uClientDownloadRecord.previewAdapter = selectedBattleVariant === 'uclient-self-contained' ? 'uclient' : 'swf';
          uClientDownloadRecord.fightPlayable = true;
        }
        if (type === 'fight' && !ultimateInfo) {
          ultimateInfo = await inspectCustomSkinUltimateActions(buffer);
        }
        var target = path.join(jobDirectory, String(id), cfg.file);
        cached = resourceCache[resourceKey];
        if (!cached.written) {
          await writeCustomSkinDownloadFile(target, buffer);
          cached.written = true;
          cached.target = target;
        }
        if (type === 'fight' && !selectedBattleVariant && effectiveLegacyFightPlayable) {
          selectedBattleVariant = 'legacy-swf';
          selectedBattleReason = 'capability-verified-playable-legacy-primary';
        }
        if (type === 'fight' && selectedBattleVariant === 'legacy-swf') {
          var legacyPrimaryBuffer = await fs.promises.readFile(cached.target || target);
          var legacyEvidenceFile = legacyVariantFile || (cached.target || target);
          var legacyEvidenceBuffer = legacyFightFetch && legacyFightFetch.buffer
            ? legacyFightFetch.buffer : legacyPrimaryBuffer;
          battleVariantManifestFile = await writeCustomSkinBattleVariantManifest(
            path.join(jobDirectory, String(id)), {
              sourceId:id,
              selectedBattleVariant:'legacy-swf',
              selectionReason:selectedBattleReason,
              primary:{
                file:'fight.swf', bytes:legacyPrimaryBuffer.length,
                sha256:sha256Buffer(legacyPrimaryBuffer), selfContained:false,
              },
              variants:{
                legacySwf:{
                  sourceUrl:String(legacyFightFetch && legacyFightFetch.url || cached.url || cfg.url(id)),
                  bytes:legacyEvidenceBuffer.length,
                  sha256:sha256Buffer(legacyEvidenceBuffer),
                  file:path.relative(path.join(jobDirectory, String(id)), legacyEvidenceFile).replace(/\\/g, '/'),
                  labels:battleInspection && battleInspection.labels || [],
                  capabilities:battleInspection || {},
                  staticPoseWrapper:!!(battleInspection && battleInspection.staticPoseWrapper),
                  playback:customSkinPlaybackEvidence(downloadCatalog, id),
                },
              },
            }
          );
          var verifiedLegacyPrimary = resourceVariantIntegrity.inspectBattleRoot(
            path.join(jobDirectory, String(id)), { sourceId:id });
          if (!verifiedLegacyPrimary.ok) {
            throw new Error('Legacy fight primary integrity failed: ' + verifiedLegacyPrimary.reason);
          }
          cached.target = verifiedLegacyPrimary.file;
          buffer = await fs.promises.readFile(verifiedLegacyPrimary.file);
          legacyStorageCleanup = await cleanupUnselectedUClientBattleArtifacts(
            path.join(jobDirectory, String(id)));
          if (!legacyStorageCleanup || legacyStorageCleanup.ok === false) {
            throw new Error('Legacy suite cleanup failed before commit: ' +
              String(legacyStorageCleanup && legacyStorageCleanup.errors || 'unknown error'));
          }
        }
        if (type === 'fight' && uClientDownloadRecord) {
          var bundleBytes = 0;
          var bundleSha256 = '';
          try {
            var bundleBuffer = await fs.promises.readFile(uClientBuild.bundleFile);
            bundleBytes = bundleBuffer.length;
            bundleSha256 = sha256Buffer(bundleBuffer);
          } catch(bundleReadError) {
            bundleBytes = Number(uClientBuild.bundleEvidence && uClientBuild.bundleEvidence.bytes || 0);
            bundleSha256 = String(uClientBuild.bundleEvidence && uClientBuild.bundleEvidence.sha256 || '');
            if (!bundleBytes || !/^[0-9A-F]{64}$/i.test(bundleSha256)) throw bundleReadError;
          }
          var primaryBuffer = await fs.promises.readFile(cached.target || target);
          var legacyPlayback = customSkinPlaybackEvidence(downloadCatalog, id);
          battleVariantManifestFile = await writeCustomSkinBattleVariantManifest(
            path.join(jobDirectory, String(id)), {
              sourceId:id,
              selectedBattleVariant:selectedBattleVariant,
              selectionReason:selectedBattleReason,
              primary:{
                file:'fight.swf', bytes:primaryBuffer.length, sha256:sha256Buffer(primaryBuffer),
                selfContained:selectedBattleVariant === 'uclient-self-contained',
              },
              variants:{
                uclient:{
                  sourceUrl:UCLIENT_PET_PACKAGE_ROOT + String(uClientBuild.metadata.bundleHash || ''),
                  packageVersion:String(uClientBuild.metadata.packageVersion || ''),
                  assetPath:String(uClientBuild.metadata.assetPath || ''),
                  bundleBytes:bundleBytes,
                  bundleSha256:bundleSha256,
                  actions:uClientCapabilities.actions,
                  capabilities:uClientCapabilities,
                  complete:uClientActionSetComplete(uClientCapabilities),
                  conversion:Object.assign({}, uClientBuild.metadata.flashBattleSwf || {}, {
                    ok:true, selfContained:true, file:'fight.swf',
                    templateVersion:Number(uClientBuild.metadata.flashBattleSwf &&
                      uClientBuild.metadata.flashBattleSwf.version || 0),
                    bytes:Number(uClientBuild.metadata.flashBattleSwf && uClientBuild.metadata.flashBattleSwf.bytes || primaryBuffer.length),
                    sha256:sha256Buffer(await fs.promises.readFile(uClientBuild.battleFile)),
                  }),
                },
                legacySwf:legacyFightFetch ? {
                  sourceUrl:String(legacyFightFetch.url || cfg.url(id)),
                  bytes:legacyFightFetch.buffer.length,
                  sha256:sha256Buffer(legacyFightFetch.buffer),
                  file:path.relative(path.join(jobDirectory, String(id)), legacyVariantFile).replace(/\\/g, '/'),
                  labels:legacyBattleInspection && legacyBattleInspection.labels || [],
                  capabilities:legacyBattleInspection || {},
                  staticPoseWrapper:!!(legacyBattleInspection && legacyBattleInspection.staticPoseWrapper),
                  playback:legacyPlayback,
                } : { available:false, error:'not-requested-by-whitelist-policy' },
              },
            }
          );
          uClientDownloadRecord.variantManifest = battleVariantManifestFile;
          try {
            uClientDownloadRecord.storageOptimization = await compactUClientPetDownloadArtifacts(
              path.join(jobDirectory, String(id)), id);
          } catch(compactError) {
            uClientDownloadRecord.storageOptimization = { ok:false, error:compactError.message };
            logWarn('CustomSkin', 'UClient compact storage skipped', { id:id, error:compactError.message });
          }
          var verifiedUClientPrimary = resourceVariantIntegrity.inspectBattleRoot(
            path.join(jobDirectory, String(id)), { sourceId:id });
          if (!verifiedUClientPrimary.ok || verifiedUClientPrimary.selectedBattleVariant !== 'uclient-self-contained') {
            throw new Error('U-client fight primary integrity failed: ' + verifiedUClientPrimary.reason);
          }
          uClientDownloadRecord.file = verifiedUClientPrimary.file;
          uClientDownloadRecord.bytes = verifiedUClientPrimary.bytes;
          uClientDownloadRecord.artifactLayer = 'primary';
          cached.target = verifiedUClientPrimary.file;
          buffer = await fs.promises.readFile(verifiedUClientPrimary.file);
          uClientDownloadRecord.suiteCleanup = await cleanupUClientMixedSuiteArtifacts(
            path.join(jobDirectory,String(id)),{
              keepNormal:!!resourceCache.uClientFollowBuild,
              keepSkill:!!(uClientBuild.videoBuild && uClientBuild.videoBuild.file),
            });
          downloaded.push(uClientDownloadRecord);
          if (uClientBuild.videoBuild && uClientBuild.videoBuild.file) {
            downloaded.push({
              id:id,
              type:'skill',
              label:'U-client official cinematic',
              file:uClientBuild.videoBuild.file,
              bytes:Number(uClientBuild.videoBuild.skillBytes || 0),
              artifactLayer:'primary',
              resourceRole:'primary-build',
              sourceUrl:String(uClientBuild.videoBuild.sourceUrl || ''),
              actionLabels:['video'],
              actionEvidence:{
                family:'video',
                assetPath:String(uClientBuild.videoBuild.assetPath || ''),
                packageKey:String(uClientBuild.videoBuild.packageKey || ''),
                bundleFileHash:String(uClientBuild.videoBuild.bundleFileHash || ''),
                conversionPolicy:String(uClientBuild.videoBuild.conversionPolicy || ''),
                selfContained:uClientBuild.videoBuild.selfContained === true,
              },
              officialName:job.officialName,
              basePetId:job.basePetId,
              officialSkinId:job.officialSkinId,
              sourceKind:job.sourceKind,
            });
          }
        }
        downloaded.push({
          id:id,
          type:type,
          label:cfg.label,
          file:cached.target || target,
          bytes:buffer.length,
          sourceUrl:cached.url || cfg.url(id),
          compatibilityFallback:cached.compatibilityFallback === true,
          sharedResource:resourceKey,
          actionLabels:ultimateInfo ? ultimateInfo.labels : undefined,
          actionEvidence:ultimateInfo ? ultimateInfo.evidence : undefined,
          battleLabels:selectedBattleVariant === 'uclient-self-contained'
            ? uClientCapabilities.actions : (battleInspection ? battleInspection.labels : undefined),
          fightPlayable:selectedBattleVariant === 'uclient-self-contained'
            ? true : (effectiveLegacyFightPlayable ? true :
              (battleInspection && battleInspection.staticPoseWrapper === true ? false : undefined)),
          previewAdapter:type === 'fight'
            ? (selectedBattleVariant === 'uclient-self-contained' ? 'uclient' : 'swf') : undefined,
          legacyFightPlayable:type === 'fight' && battleInspection
            ? effectiveLegacyFightPlayable : undefined,
          staticPoseWrapper:type === 'fight' && battleInspection
            ? battleInspection.staticPoseWrapper === true : undefined,
          nonStandardTimeline:selectedBattleVariant === 'uclient-self-contained'
            ? false : (battleInspection ? battleInspection.ok !== true : undefined),
          availabilityReason:selectedBattleVariant === 'uclient-self-contained'
            ? undefined : (battleInspection && battleInspection.ok !== true
            ? (battleInspection.reason || 'battle-actions-nonstandard')
            : undefined),
          ultimateAction:ultimateMeta ? ultimateMeta.action : undefined,
          ultimateSkillId:ultimateMeta ? ultimateMeta.skillId : undefined,
          officialName:job.officialName || (ultimateMeta ? ultimateMeta.name : undefined),
          basePetId:job.basePetId,
          officialSkinId:job.officialSkinId,
          sourceKind:job.sourceKind,
          suiteSource:suiteRoute && suiteRoute.uClient ? 'uclient' : 'traditional-swf',
          resourceSourceKind:type === 'normal' && suiteRoute && suiteRoute.uClient
            ? 'uclient-follow' : undefined,
          uClientFollowAvailable:type === 'normal' && suiteRoute && suiteRoute.uClient ? true : undefined,
          uClientFollowAssetPath:type === 'normal' && uClientFollowBuild && uClientFollowBuild.metadata
            ? String(uClientFollowBuild.metadata.assetPath || '') : undefined,
          uClientFollowPackageVersion:type === 'normal' && uClientFollowBuild && uClientFollowBuild.metadata
            ? String(uClientFollowBuild.metadata.packageVersion || '') : undefined,
          artifactLayer:type === 'fight' ? 'primary' : 'direct-resource',
          resourceRole:type === 'fight' ? 'primary-build' : 'primary-resource',
          selectedBattleVariant:type === 'fight'
            ? (selectedBattleVariant || 'legacy-swf') : undefined,
          selectionReason:type === 'fight'
            ? (selectedBattleReason || 'playable-legacy-swf-preferred') : undefined,
          variantManifest:battleVariantManifestFile || undefined,
          storageOptimization:type === 'fight' && selectedBattleVariant === 'legacy-swf'
            ? legacyStorageCleanup : undefined,
        });
        if (type === 'fight' && !(suiteRoute && suiteRoute.uClient)) {
          try {
            var companionMeta = await resolveSeer1OfficialUltimate(id, job.basePetId, job.officialSkinId);
            var companionInfo = ultimateInfo || await inspectCustomSkinUltimateActions(buffer);
          var companionResolved = await fetchSeer1UltimateEffect(companionMeta, withTransferProgress(CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES.ultimate, '独立技能特效'));
          var companionResourceId = companionResolved.resourceId;
          var companionFetched = companionResolved.fetched;
            validateOfficialCustomSkinModel('ultimate', companionFetched.buffer);
            var hasUClientVideo = !!(uClientBuild && uClientBuild.videoBuild &&
              (uClientBuild.videoBuild.file || uClientBuild.videoBuild.embeddedInFight === true));
            var companionTarget = hasUClientVideo
              ? path.join(jobDirectory, String(id), 'variants', 'swf', 'skill.swf')
              : path.join(jobDirectory, String(id), 'skill.swf');
            await writeCustomSkinDownloadFile(companionTarget, companionFetched.buffer);
            if (!hasUClientVideo) downloaded.push({
              id:id,
              type:'skill',
              label:'独立技能特效',
              file:companionTarget,
              bytes:companionFetched.buffer.length,
              sourceUrl:companionFetched.url,
              compatibilityFallback:companionFetched.compatibilityFallback === true,
              actionLabels:companionInfo.labels,
              actionEvidence:companionInfo.evidence,
              ultimateAction:companionMeta.action || companionInfo.labels[0] || '',
              ultimateSkillId:companionResourceId,
              officialName:job.officialName || companionMeta.name,
              basePetId:job.basePetId || companionMeta.basePetId,
              officialSkinId:job.officialSkinId,
              sourceKind:job.sourceKind,
            });
          } catch(companionError) {
            var companionStatus = parseInt(companionError && companionError.statusCode, 10) || 0;
            if (!(companionError && companionError.code === 'ULTIMATE_UNAVAILABLE') && companionStatus !== 404) {
              logWarn('CustomSkin', 'optional skill companion skipped', {
                id:id, basePetId:job.basePetId || 0, error:companionError.message,
              });
            }
          }
        }
      } catch(e) {
        if (isCustomSkinResourceUnavailable(e)) {
          unavailable.push(customSkinDownloadUnavailable(id, type, cfg, e, job));
          completed++;
          sendCustomSkinDownloadProgress(sender, {
            state:'unavailable', id:id, type:type, completed:completed,
            total:total, directory:directory,
          });
          if (completed < total) await waitCustomSkinDownload(50);
          continue;
        }
        var failedItem = customSkinDownloadFailure(id, type, cfg, e);
        failedItem.basePetId = job.basePetId;
        failedItem.officialSkinId = job.officialSkinId;
        failedItem.officialName = job.officialName;
        failedItem.sourceKind = job.sourceKind;
        failedItem.queueRootId = job.queueRootId || job.id;
        failed.push(failedItem);
        if (e && (e.statusCode === 403 || e.statusCode === 429)) {
          for (var skippedIndex = jobIndex + 1; skippedIndex < jobs.length; skippedIndex++) {
            var skipped = jobs[skippedIndex];
            var skippedCfg = CUSTOM_SKIN_OFFICIAL_DOWNLOAD_TYPES[skipped.type];
            pending.push({
              id:skipped.id,
              type:skipped.type,
              label:skippedCfg.label,
              error:'因官方限流而尚未尝试',
              retryable:true,
              pending:true,
              url:skippedCfg.url(skipped.id),
              basePetId:skipped.basePetId,
              officialSkinId:skipped.officialSkinId,
              officialName:skipped.officialName,
              sourceKind:skipped.sourceKind,
              queueRootId:skipped.queueRootId || skipped.id,
            });
          }
          sendCustomSkinDownloadProgress(sender, {
            state:'rate-limited', id:id, type:type, completed:completed,
            total:total, error:e.message, directory:directory,
          });
          var limitedSuiteCommit = await settleCustomSkinDownloadSuiteDrafts(
            suiteTransactions,downloaded,failed,unavailable,requiredFightDownloadIds);
          var limitedResult = {
            ok:false,
            rateLimited:true,
            directory:directory,
            downloaded:downloaded,
            failed:failed,
            unavailable:unavailable,
            pending:pending,
            filtered:uClientFilteredIcons,
            completed:completed,
            total:total,
            suiteTransaction:limitedSuiteCommit,
            error:'赛尔号官方资源服务器已限流；任务已停止，请稍后再重试失败项',
          };
          if (shouldImportDownloaded && downloaded.length) {
            if (storageGeneration !== _customSkinStorageGeneration) {
              throw new Error('皮肤库已在下载期间重置，本次下载结果未导入');
            }
            sendCustomSkinDownloadProgress(sender, { state:'importing', completed:completed, total:total });
            await refreshCustomSkinReservedIds();
            var limitedImportBatch = customSkinPlayableAutoImportBatch(downloaded, requiredFightDownloadIds);
            limitedResult.incompleteUClientIds = limitedImportBatch.skippedIds;
            if (limitedImportBatch.records.length) {
              limitedResult.autoImportResult = await importDownloadedCustomSkinRecords(
                limitedImportBatch.records, sender, {
                  skipSupplement:true,
                  initialEnabled:shouldEnableImported,
                  reload:shouldEnableImported,
                }
              );
              if (!limitedResult.autoImportResult || limitedResult.autoImportResult.ok === false) {
                throw new Error('已下载套件导入失败：' +
                  String(limitedResult.autoImportResult && limitedResult.autoImportResult.error || 'unknown error'));
              }
            }
          }
          limitedResult.inventoryPublication = publishCommittedCustomSkinDownloadInventory(
            limitedSuiteCommit,limitedResult.autoImportResult);
          if (!limitedResult.inventoryPublication.ok) {
            throw new Error('下载库存 revision 写入失败：' + limitedResult.inventoryPublication.error);
          }
          limitedResult.suiteTransactionCleanupErrors =
            await finalizeSourceSuiteTransactions(suiteTransactions);
          if (shouldEnableImported || (limitedResult.autoImportResult && limitedResult.autoImportResult.anyEnabledUpdated)) {
            limitedResult.gameReload = await doReload();
          }
          finalResult = limitedResult;
          return limitedResult;
        }
      }
      completed++;
      sendCustomSkinDownloadProgress(sender, {
        state:'progress', id:id, type:type, completed:completed,
        total:total, directory:directory,
      });
      if (completed < total) await waitCustomSkinDownload(80);
    }
    var suiteCommit = await settleCustomSkinDownloadSuiteDrafts(
      suiteTransactions,downloaded,failed,unavailable,requiredFightDownloadIds);
    var result = {
      ok:true, directory:directory, downloaded:downloaded, failed:failed, unavailable:unavailable, pending:pending,
      filtered:uClientFilteredIcons, completed:completed, total:total, suiteTransaction:suiteCommit,
    };
    if (shouldImportDownloaded && downloaded.length) {
      if (storageGeneration !== _customSkinStorageGeneration) {
        throw new Error('皮肤库已在下载期间重置，本次下载结果未导入');
      }
      sendCustomSkinDownloadProgress(sender, { state:'importing', completed:completed, total:total });
      await refreshCustomSkinReservedIds();
      var importBatch = customSkinPlayableAutoImportBatch(downloaded, requiredFightDownloadIds);
      result.incompleteUClientIds = importBatch.skippedIds;
      if (importBatch.records.length) {
        result.autoImportResult = await importDownloadedCustomSkinRecords(
          importBatch.records, sender, {
            skipSupplement:true,
            initialEnabled:shouldEnableImported,
            reload:shouldEnableImported,
          }
        );
        if (!result.autoImportResult || result.autoImportResult.ok === false) {
          throw new Error('已下载套件导入失败：' +
            String(result.autoImportResult && result.autoImportResult.error || 'unknown error'));
        }
      }
      if (importBatch.skippedIds.length) {
        result.ok = false;
        result.error = '战斗模型未通过能力验证，未自动注册：' + importBatch.skippedIds.join(', ');
      }
    }
    result.inventoryPublication = publishCommittedCustomSkinDownloadInventory(
      suiteCommit,result.autoImportResult);
    if (!result.inventoryPublication.ok) {
      throw new Error('下载库存 revision 写入失败：' + result.inventoryPublication.error);
    }
    result.suiteTransactionCleanupErrors = await finalizeSourceSuiteTransactions(suiteTransactions);
    if (shouldEnableImported || (result.autoImportResult && result.autoImportResult.anyEnabledUpdated)) {
      result.gameReload = await doReload();
    }
    finalResult = result;
    return result;
  } catch(e) {
    finalError = e;
    var suiteRollbackErrors = await rollbackSourceSuiteTransactions(suiteTransactions);
    if (suiteRollbackErrors.length) e.message += '; download suite rollback: ' + suiteRollbackErrors.join('; ');
    throw e;
  } finally {
    _customSkinDownloadRunning = false;
    if (finalResult && !finalError) {
      finalResult.queueSettlement = settleCustomSkinDownloadQueue(request, finalResult, jobs);
      if (!finalResult.queueSettlement.ok) {
        finalResult.ok = false;
        finalResult.error = [finalResult.error,
          '下载已完成，但待下载列表保存失败：' + finalResult.queueSettlement.error]
          .filter(Boolean).join('\n');
      }
    }
    finishCustomSkinDownloadTask(finalResult, finalError, completed, total, directory);
    sendCustomSkinDownloadProgress(sender, {
      state:'finished',
      outcome:_customSkinDownloadTask && _customSkinDownloadTask.state || (finalError ? 'failed' : 'completed'),
      completed:completed, total:total, directory:directory,
      error:String(finalError && finalError.message || ''),
    });
    if (_customSkinDownloadTask) {
      _customSkinDownloadTask.running = false;
      _customSkinDownloadTask.state = finalError ? 'failed' : (finalResult && finalResult.rateLimited ? 'rate-limited' : 'completed');
      _customSkinDownloadTask.result = finalResult;
      _customSkinDownloadTask.error = String(finalError && finalError.message || '');
      _customSkinDownloadTask.finishedAt = Date.now();
      _customSkinDownloadTask.updatedAt = _customSkinDownloadTask.finishedAt;
    }
    _customSkinSuiteCommitDepth = Math.max(0, _customSkinSuiteCommitDepth - 1);
    notifyCustomSkinDownloadStateChanged();
    scheduleCustomSkinProjectionVerification();
  }
}

async function ensureCustomSkinStaticIcon(entry) {
  var sourceId = parseInt(entry && entry.sourceId, 10);
  var suiteRoute = sourceId > 0 ? officialBattleRouting.route(sourceId) : null;
  if (suiteRoute && suiteRoute.uClient) {
    return { ok:true, changed:false, skipped:true, skinId:entry.skinId, sourceId:sourceId,
      uClientIconAvailable:false, reason:'U-client suites do not supplement Flash icon.swf' };
  }
  var current = String(entry && entry.files && entry.files.icon || '').trim();
  if (current) {
    try {
      var currentBuffer = /^https?:\/\//i.test(current)
        ? await fetchCustomSkinBuffer(current, 8000, 0)
        : await fs.promises.readFile(resolveCustomSkinSourceForRuntime(current));
      var currentInfo = customSkinStaticIconInfo(currentBuffer);
      if (currentInfo.ok) {
        return { ok:true, changed:false, skinId:entry.skinId, source:current };
      }
    } catch(e) {}
  }

  if (!sourceId || sourceId <= 0) {
    return { ok:false, changed:false, skinId:entry && entry.skinId, error:'缺少源精灵序号' };
  }
  var officialUrl = 'https://seer.61.com/resource/pet/head/' + sourceId + '.swf';
  var buffer = await fetchCustomSkinBuffer(officialUrl, 8000, 0);
  var iconInfo = customSkinStaticIconInfo(buffer);
  if (!iconInfo.ok) {
    throw new Error('官方头像校验失败：' + iconInfo.error);
  }
  var targetDir = path.join(CUSTOM_SKINS_DIR, 'files', String(entry.skinId));
  await fs.promises.mkdir(targetDir, { recursive:true });
  var target = path.join(targetDir, 'icon.swf');
  await fs.promises.writeFile(target, buffer);
  entry.files.icon = normalizeCustomSkinSourceForStorage(target);
  return {
    ok:true,
    changed:true,
    skinId:entry.skinId,
    sourceId:sourceId,
    source:entry.files.icon,
    bytes:buffer.length,
  };
}

async function ensureCustomSkinStaticIcons(entries) {
  var list = Array.isArray(entries) ? entries : [];
  var results = [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    try {
      results.push(await ensureCustomSkinStaticIcon(entry));
    } catch(e) {
      results.push({
        ok:false,
        changed:false,
        skinId:entry && entry.skinId,
        sourceId:entry && entry.sourceId,
        error:e.message,
      });
    }
    await new Promise(function(resolve) { setImmediate(resolve); });
  }
  return results;
}

function customSkinFollowSwfInfo(buffer) {
  try {
    if (!buffer || buffer.length < 20 || buffer.length > 48 * 1024 * 1024) {
      return { ok:false, error:'follow SWF size is invalid' };
    }
    var info = customSkinReadRectSize(buffer);
    if (!info || !info.data || info.data.length < 20) {
      return { ok:false, error:'follow model is not a valid FWS/CWS file' };
    }
    if (info.data.indexOf(Buffer.from('pet\u0000', 'utf8')) < 0) {
      return { ok:false, error:'follow model does not export pet' };
    }
    var labels = ['down','leftdown','left','leftup','up','rightup','right','rightdown'];
    var missing = labels.filter(function(label) {
      return info.data.indexOf(Buffer.from(label + '\u0000', 'utf8')) < 0;
    });
    if (missing.length) {
      return { ok:false, error:'follow model is missing direction labels: ' + missing.join(',') };
    }
    return { ok:true, width:info.width, height:info.height };
  } catch(e) {
    return { ok:false, error:e.message };
  }
}

async function customSkinFollowSwfInfoAsync(buffer) {
  try {
    if (!buffer || buffer.length < 20 || buffer.length > 48 * 1024 * 1024) {
      return { ok:false, error:'follow SWF size is invalid' };
    }
    var info = await customSkinReadRectSizeAsync(buffer);
    if (!info || !info.data || info.data.length < 20) {
      return { ok:false, error:'follow model is not a valid FWS/CWS file' };
    }
    if (info.data.indexOf(Buffer.from('pet\u0000', 'utf8')) < 0) {
      return { ok:false, error:'follow model does not export pet' };
    }
    var labels = ['down','leftdown','left','leftup','up','rightup','right','rightdown'];
    var missing = labels.filter(function(label) {
      return info.data.indexOf(Buffer.from(label + '\u0000', 'utf8')) < 0;
    });
    if (missing.length) {
      return { ok:false, error:'follow model is missing direction labels: ' + missing.join(',') };
    }
    return { ok:true, width:info.width, height:info.height };
  } catch(e) {
    return { ok:false, error:e.message };
  }
}

async function ensureCustomSkinFollowModel(entry) {
  var sourceId = parseInt(entry && entry.sourceId, 10);
  var suiteRoute = sourceId > 0 ? officialBattleRouting.route(sourceId) : null;
  if (suiteRoute && suiteRoute.uClient && entry.uClientFollowAvailable !== true) {
    return { ok:false, changed:false, skipped:true, skinId:entry.skinId, sourceId:sourceId,
      uClientFollowAvailable:false,
      error:'U-client follow must come from the suite download transaction; Flash supplementation is disabled' };
  }
  var current = String(entry && entry.files && entry.files.normal || '').trim();
  if (current) {
    try {
      var currentBuffer = /^https?:\/\//i.test(current)
        ? await fetchCustomSkinBuffer(current, 20000, 0, 48 * 1024 * 1024)
        : await fs.promises.readFile(resolveCustomSkinSourceForRuntime(current));
      var currentInfo = await customSkinFollowSwfInfoAsync(currentBuffer);
      if (currentInfo.ok) {
        return { ok:true, changed:false, skinId:entry.skinId, source:current };
      }
    } catch(e) {}
  }

  if (!sourceId || sourceId <= 0) {
    return { ok:false, changed:false, skinId:entry && entry.skinId, error:'missing source pet id' };
  }
  if (suiteRoute && suiteRoute.uClient) {
    return { ok:false, changed:false, skipped:true, skinId:entry.skinId, sourceId:sourceId,
      uClientFollowAvailable:false,
      error:'U-client follow must come from the suite download transaction; Flash supplementation is disabled' };
  }
  var officialUrl = 'https://seer.61.com/resource/groupFightResource/pet/' + sourceId + '.swf';
  var buffer = await fetchCustomSkinBuffer(officialUrl, 45000, 0, 48 * 1024 * 1024);
  var followInfo = await customSkinFollowSwfInfoAsync(buffer);
  if (!followInfo.ok) {
    throw new Error('official follow model validation failed: ' + followInfo.error);
  }
  var targetDir = path.join(CUSTOM_SKINS_DIR, 'files', String(entry.skinId));
  await fs.promises.mkdir(targetDir, { recursive:true });
  var target = path.join(targetDir, 'normal.swf');
  await fs.promises.writeFile(target, buffer);
  entry.files.normal = normalizeCustomSkinSourceForStorage(target);
  return {
    ok:true,
    changed:true,
    skinId:entry.skinId,
    sourceId:sourceId,
    source:entry.files.normal,
    bytes:buffer.length,
  };
}

async function ensureCustomSkinFollowModels(entries) {
  var list = Array.isArray(entries) ? entries : [];
  var results = [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    try {
      results.push(await ensureCustomSkinFollowModel(entry));
    } catch(e) {
      results.push({
        ok:false,
        changed:false,
        skinId:entry && entry.skinId,
        sourceId:entry && entry.sourceId,
        error:e.message,
      });
    }
  }
  return results;
}

function customSkinFightTimelineScore(data) {
  if (!data || !data.length) return 0;
  var score = 0;
  var ascii = data.toString('latin1');
  var utf8 = data.toString('utf8');
  if (ascii.indexOf('attack\u0000') >= 0) score++;
  if (ascii.indexOf('hited\u0000') >= 0) score++;
  if (ascii.indexOf('sa\u0000') >= 0) score++;
  if (ascii.indexOf('cp\u0000') >= 0) score++;
  if (/待机|物理攻击|属性攻击|特殊攻击|被打|被暴击|必杀|合体攻击|胜利|失败/.test(utf8)) score += 3;
  return score;
}

function customSkinInspectLocalTypes(file) {
  var named = customSkinTypeFromName(file);
  try {
    var raw = fs.readFileSync(file);
    var info = customSkinReadRectSize(raw);
    if (!info) return [];
    if (named === 'normal' && customSkinFollowSwfInfo(raw).ok) return ['normal'];
    var utf8 = info.data.toString('utf8');
    if (customSkinFightTimelineScore(info.data) >= 2) return ['fight'];
    if (/物理攻击|属性攻击|特殊攻击|合体攻击|必杀/.test(utf8)) return ['fight'];
    if (named) return [named];
    if (info.data.indexOf(Buffer.from('item\0', 'ascii')) >= 0) return ['icon'];
    if (info.data.indexOf(Buffer.from('pet\0', 'ascii')) >= 0) return ['demo'];
    if (info.width === 550 && info.height === 400) return ['dictionary'];
  } catch(e) {}
  return [];
}

async function customSkinInspectLocalTypesAsync(file) {
  var named = customSkinTypeFromName(file);
  try {
    var raw = await fs.promises.readFile(file);
    var info = await customSkinReadRectSizeAsync(raw);
    if (!info) return [];
    if (named === 'normal' && (await customSkinFollowSwfInfoAsync(raw)).ok) return ['normal'];
    var utf8 = info.data.toString('utf8');
    if (customSkinFightTimelineScore(info.data) >= 2) return ['fight'];
    if (/物理攻击|属性攻击|特殊攻击|合体攻击|必杀/.test(utf8)) return ['fight'];
    if (named) return [named];
    if (info.data.indexOf(Buffer.from('item\0', 'ascii')) >= 0) return ['icon'];
    if (info.data.indexOf(Buffer.from('pet\0', 'ascii')) >= 0) return ['demo'];
    if (info.width === 550 && info.height === 400) return ['dictionary'];
  } catch(e) {}
  return [];
}

function customSkinGroupKey(source, sourceId, type) {
  if (sourceId) return 'source:' + sourceId;
  var value = String(source || '').replace(/\\/g, '/').split('?')[0];
  var parent = value.slice(0, value.lastIndexOf('/'));
  var base = value.slice(value.lastIndexOf('/') + 1).replace(/\.swf$/i, '');
  var aliases = /(normal|map|fight|battle|skill|ultimate|primary|dictionary|dict|icon|avatar|demo|display|show|地图|跟随|战斗|对战|技能特效|大招特效|首发|出场门|图鉴|头像|图标|展示|预览)/ig;
  var stem = base.replace(aliases, '').replace(/[\s._-]+/g, '');
  return 'auto:' + parent.toLowerCase() + ':' + (stem || 'folder');
}

function customSkinFriendlyName(source, skinId) {
  var value = String(source || '').replace(/\\/g, '/').split('?')[0];
  var parts = value.split('/').filter(Boolean).slice(-2).reverse();
  for (var i = 0; i < parts.length; i++) {
    var candidate = parts[i].replace(/\.swf$/i, '');
    try { candidate = decodeURIComponent(candidate); } catch(e) {}
    var cleaned = candidate
      .replace(new RegExp(String(skinId || ''), 'g'), '')
      .replace(/normal|map|fight|battle|skill|ultimate|primary|dictionary|dict|icon|avatar|demo|display|show|pet|swf/ig, '')
      .replace(/地图|跟随|战斗|对战|技能特效|大招特效|首发|出场门|图鉴|头像|图标|展示|预览|精灵模型|模型/g, '')
      .replace(/[\s._-]+/g, ' ')
      .trim();
    if (cleaned && !/^\d+$/.test(cleaned)) return cleaned.slice(0, 80);
  }
  return '自定义皮肤 ' + skinId;
}

async function resolveCustomSkinFriendlyName(source, sourceId, skinId) {
  var local = customSkinFriendlyName(source, sourceId || skinId);
  if (local.indexOf('自定义皮肤 ') !== 0) return local;
  var publicName = await fetchCustomSkinPublicName(sourceId);
  return (publicName || ('赛尔1精灵 ' + (sourceId || skinId))).slice(0, 80);
}

async function resolveCustomSkinLocalOfficialIdentity(sourceId) {
  var id = parseCustomSkinId(sourceId);
  if (!id) return {};
  try {
    var catalog = await loadSeer1OfficialPetCatalogFast();
    var items = catalog && Array.isArray(catalog.items) ? catalog.items : [];
    for (var index = 0; index < items.length; index++) {
      var item = items[index] || {};
      if (parseCustomSkinId(item.id) === id || parseCustomSkinId(item.realId) === id) {
        return {
          officialName:String(item.name || '').trim().slice(0, 80),
          basePetId:0,
          officialSkinId:0,
          sourceKind:'pet',
        };
      }
      var skins = Array.isArray(item.extraSkins) ? item.extraSkins : [];
      for (var skinIndex = 0; skinIndex < skins.length; skinIndex++) {
        var skin = skins[skinIndex] || {};
        var resourceId = parseCustomSkinId(skin.resourceId || skin.realId || skin.id);
        if (resourceId !== id) continue;
        return {
          officialName:String(skin.name || item.name || '').trim().slice(0, 80),
          basePetId:parseCustomSkinId(item.id),
          officialSkinId:parseCustomSkinId(skin.id || skin.skinId || skin.resourceId),
          sourceKind:'official-skin',
        };
      }
    }
  } catch(error) {
    logWarn('CustomSkin', 'local identity recovery skipped', { sourceId:id, error:error.message });
  }
  return {};
}

function sendCustomSkinImportProgress(sender, payload) {
  try {
    if (sender && !sender.isDestroyed()) sender.send('custom-skin-import-progress', payload);
  } catch(e) {}
}

async function collectCustomSkinFilesAsync(root, sender) {
  return await customSkinFolderPackage.collect(root, function(progress) {
    sendCustomSkinImportProgress(sender, progress);
  });
}

function expandCustomSkinLinkedModels(entry) {
  var changed = false;
  ['fight','demo'].forEach(function(type) {
    var source = String(entry.files[type] || '').trim();
    if (!source) return;
    var types = [];
    if (/^https?:\/\//i.test(source)) {
      types = [type];
    } else {
      var absolute = resolveCustomSkinSourceForRuntime(source);
      if (!fs.existsSync(absolute)) return;
      types = customSkinInspectLocalTypes(absolute);
    }
    if (types.indexOf('fight') >= 0) {
      if (!entry.files.fight) {
         entry.files.fight = source;
         changed = true;
      }
    }
  });
  return changed;
}

async function expandCustomSkinLinkedModelsAsync(entry) {
  var changed = false;
  for (var i = 0; i < 2; i++) {
    var type = i === 0 ? 'fight' : 'demo';
    var source = String(entry.files[type] || '').trim();
    if (!source) continue;
    var types = [];
    if (/^https?:\/\//i.test(source)) {
      types = [type];
    } else {
      var absolute = resolveCustomSkinSourceForRuntime(source);
      try { await fs.promises.access(absolute, fs.constants.R_OK); } catch(e) { continue; }
      types = await customSkinInspectLocalTypesAsync(absolute);
    }
    if (types.indexOf('fight') >= 0 && !entry.files.fight) {
      entry.files.fight = source;
      changed = true;
    }
  }
  return changed;
}

function rehomeCustomSkinManagedFiles(entry, oldId, newId) {
  if (!CUSTOM_SKINS_DIR || !oldId || !newId || oldId === newId) return false;
  var oldRoot = path.resolve(CUSTOM_SKINS_DIR, 'files', String(oldId));
  var changed = false;
  for (var typeIndex = 0; typeIndex < CUSTOM_SKIN_FILE_TYPES.length; typeIndex++) {
    var type = CUSTOM_SKIN_FILE_TYPES[typeIndex];
    var source = String(entry.files[type] || '').trim();
    if (!source || /^https?:\/\//i.test(source)) continue;
    var absolute = resolveCustomSkinSourceForRuntime(source);
    var relative = path.relative(oldRoot, absolute);
    if (relative === '..' || relative.indexOf('..' + path.sep) === 0 || path.isAbsolute(relative)) continue;
    if (!fs.existsSync(absolute)) continue;
    var targetDir = path.join(CUSTOM_SKINS_DIR, 'files', String(newId));
    fs.mkdirSync(targetDir, { recursive:true });
    var target = path.join(targetDir, type + '.swf');
    if (path.resolve(absolute).toLowerCase() !== path.resolve(target).toLowerCase()) {
      materializeCustomSkinManagedFileSync(absolute, target);
    }
    entry.files[type] = normalizeCustomSkinSourceForStorage(target);
    changed = true;
  }
  return changed;
}

async function prepareCustomSkinManagedRenumber(entries, mappings) {
  var managedRoot = path.resolve(CUSTOM_SKINS_DIR, 'files');
  var active = (mappings || []).filter(function(mapping) { return mapping.from !== mapping.to; });
  var movingSourceIds = new Set(active.map(function(mapping) { return mapping.from; }));
  var stageRoot = path.join(managedRoot, '.renumber-' + process.pid + '-' + Date.now() + '-' +
    crypto.randomBytes(4).toString('hex'));
  var moved = [];
  var createdTargetIds = new Set();
  async function rollback() {
    var errors = [];
    var summary = { deletedFiles:0, deletedDirectories:0, freedBytes:0, errors:[] };
    for (var targetId of createdTargetIds) {
      try { await deleteCustomSkinManagedTree(path.join(managedRoot, String(targetId)), managedRoot, summary); }
      catch(error) { errors.push('清理目标 ' + targetId + '：' + error.message); }
    }
    for (var index = moved.length - 1; index >= 0; index--) {
      try { await fs.promises.rename(moved[index].staged, moved[index].original); }
      catch(error) { errors.push('恢复原目录 ' + moved[index].id + '：' + error.message); }
    }
    try { await deleteCustomSkinManagedTree(stageRoot, managedRoot, summary); }
    catch(error) { if (!error || error.code !== 'ENOENT') errors.push('清理改号草稿：' + error.message); }
    if (errors.length) throw new Error(errors.join('; '));
  }
  try {
    for (var collisionIndex = 0; collisionIndex < active.length; collisionIndex++) {
      var collisionTarget = path.join(managedRoot, String(active[collisionIndex].to));
      if (fs.existsSync(collisionTarget) && !movingSourceIds.has(active[collisionIndex].to)) {
        throw new Error('目标托管目录已存在：' + active[collisionIndex].to + '。请先清理未使用文件或换一个序号');
      }
    }
    await fs.promises.mkdir(stageRoot, { recursive:true });
    for (var moveIndex = 0; moveIndex < active.length; moveIndex++) {
      var mapping = active[moveIndex];
      var originalRoot = path.join(managedRoot, String(mapping.from));
      if (!fs.existsSync(originalRoot)) continue;
      var stagedRoot = path.join(stageRoot, String(mapping.from));
      await fs.promises.rename(originalRoot, stagedRoot);
      moved.push({ id:mapping.from, original:originalRoot, staged:stagedRoot });
    }
    for (var mappingIndex = 0; mappingIndex < active.length; mappingIndex++) {
      var currentMapping = active[mappingIndex];
      var currentEntry = _customSkins.find(function(entry) {
        return String(entry && entry.id || '') === String(currentMapping.stableId || '');
      });
      var targetEntry = entries.find(function(entry) {
        return String(entry && entry.id || '') === String(currentMapping.stableId || '');
      });
      if (!currentEntry || !targetEntry) throw new Error('改号期间皮肤条目已变化');
      var oldRoot = path.join(managedRoot, String(currentMapping.from));
      var stagedOldRoot = path.join(stageRoot, String(currentMapping.from));
      var targetRoot = path.join(managedRoot, String(currentMapping.to));
      for (var typeIndex = 0; typeIndex < CUSTOM_SKIN_FILE_TYPES.length; typeIndex++) {
        var type = CUSTOM_SKIN_FILE_TYPES[typeIndex];
        var source = String(currentEntry.files && currentEntry.files[type] || '').trim();
        if (!source || /^https?:\/\//i.test(source)) continue;
        var absolute = resolveCustomSkinSourceForRuntime(source);
        var relative = path.relative(oldRoot, absolute);
        if (relative === '..' || relative.indexOf('..' + path.sep) === 0 || path.isAbsolute(relative)) continue;
        var stagedSource = path.join(stagedOldRoot, relative);
        if (!fs.existsSync(stagedSource)) continue;
        await fs.promises.mkdir(targetRoot, { recursive:true });
        createdTargetIds.add(currentMapping.to);
        var target = path.join(targetRoot, type + '.swf');
        materializeCustomSkinManagedFileSync(stagedSource, target);
        targetEntry.files[type] = normalizeCustomSkinSourceForStorage(target);
      }
    }
    return {
      rollback:rollback,
      finalize:async function() {
        var summary = { deletedFiles:0, deletedDirectories:0, freedBytes:0, errors:[] };
        await deleteCustomSkinManagedTree(stageRoot, managedRoot, summary);
        return summary;
      },
    };
  } catch(error) {
    try { await rollback(); }
    catch(rollbackError) { error.message += '；托管文件回滚失败：' + rollbackError.message; }
    throw error;
  }
}

async function deleteCustomSkinManagedIds(ids) {
  var summary = { deletedFiles:0, deletedDirectories:0, freedBytes:0, errors:[] };
  var managedRoot = path.resolve(CUSTOM_SKINS_DIR, 'files');
  var unique = new Set((Array.isArray(ids) ? ids : Array.from(ids || [])).map(parseCustomSkinId).filter(Boolean));
  for (var id of unique) {
    var target = path.resolve(managedRoot, String(id));
    try { await deleteCustomSkinManagedTree(target, managedRoot, summary); }
    catch(e) { summary.errors.push('托管目录 ' + id + '：' + e.message); }
  }
  return summary;
}

function customSkinPathInside(root, target) {
  var relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && relative !== '..' && relative.indexOf('..' + path.sep) !== 0 &&
    !path.isAbsolute(relative);
}

async function customSkinFilesMatch(left, right) {
  var leftStat = await fs.promises.stat(left);
  var rightStat = await fs.promises.stat(right);
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  if (leftStat.dev === rightStat.dev && leftStat.ino && leftStat.ino === rightStat.ino) return true;
  function hashFile(file) {
    return new Promise(function(resolve, reject) {
      var hash = crypto.createHash('sha256');
      var stream = fs.createReadStream(file, { highWaterMark:1024 * 1024 });
      stream.on('data', function(chunk) { hash.update(chunk); });
      stream.once('error', reject);
      stream.once('end', function() { resolve(hash.digest('hex')); });
    });
  }
  var hashes = await Promise.all([hashFile(left), hashFile(right)]);
  return hashes[0] === hashes[1];
}

async function cleanupCustomSkinRollbackMaterialization(files) {
  var managedRoot = path.resolve(CUSTOM_SKINS_DIR, 'files');
  var parents = new Set();
  for (var index = 0; index < files.length; index++) {
    var file = path.resolve(files[index]);
    if (!customSkinPathInside(managedRoot, file)) continue;
    try { await fs.promises.unlink(file); } catch(error) {
      if (!error || error.code !== 'ENOENT') logWarn('CustomSkin', 'rollback materialization cleanup skipped', {
        file:file, error:error && error.message,
      });
    }
    parents.add(path.dirname(file));
  }
  for (var parent of parents) {
    try { await fs.promises.rmdir(parent); } catch(_) {}
  }
}

async function prepareCustomSkinManagedRollback(rawSkins) {
  var desired = (Array.isArray(rawSkins) ? rawSkins : []).map(normalizeCustomSkinEntryForStorage);
  var currentByStableId = new Map();
  _customSkins.forEach(function(entry) {
    var stableId = String(entry && entry.id || '');
    if (stableId) currentByStableId.set(stableId, normalizeCustomSkinEntryForStorage(entry));
  });
  var managedRoot = path.resolve(CUSTOM_SKINS_DIR, 'files');
  var createdFiles = [];
  var cleanupIds = new Set();
  var mappings = [];
  try {
    for (var entryIndex = 0; entryIndex < desired.length; entryIndex++) {
      var desiredEntry = desired[entryIndex];
      var currentEntry = currentByStableId.get(String(desiredEntry.id || ''));
      var desiredId = parseCustomSkinId(desiredEntry.skinId);
      var currentId = parseCustomSkinId(currentEntry && currentEntry.skinId);
      if (!desiredId || !currentId || desiredId === currentId) continue;
      var desiredRoot = path.resolve(managedRoot, String(desiredId));
      var currentRoot = path.resolve(managedRoot, String(currentId));
      if (!customSkinPathInside(managedRoot, desiredRoot) || !customSkinPathInside(managedRoot, currentRoot)) {
        throw new Error('改号回滚托管目录越界');
      }
      var materialized = false;
      for (var typeIndex = 0; typeIndex < CUSTOM_SKIN_FILE_TYPES.length; typeIndex++) {
        var type = CUSTOM_SKIN_FILE_TYPES[typeIndex];
        var desiredSource = String(desiredEntry.files && desiredEntry.files[type] || '').trim();
        var currentSource = String(currentEntry.files && currentEntry.files[type] || '').trim();
        if (!desiredSource || !currentSource || /^https?:\/\//i.test(desiredSource) ||
            /^https?:\/\//i.test(currentSource)) continue;
        var desiredFile = resolveCustomSkinSourceForRuntime(desiredSource);
        var currentFile = resolveCustomSkinSourceForRuntime(currentSource);
        if (!customSkinPathInside(desiredRoot, desiredFile) ||
            !customSkinPathInside(currentRoot, currentFile)) continue;
        var currentStat = await fs.promises.stat(currentFile);
        if (!currentStat.isFile()) throw new Error('当前改号文件不存在：' + currentFile);
        if (!fs.existsSync(desiredFile)) {
          await fs.promises.mkdir(path.dirname(desiredFile), { recursive:true });
          materializeCustomSkinManagedFileSync(currentFile, desiredFile);
          createdFiles.push(desiredFile);
        }
        if (!(await customSkinFilesMatch(currentFile, desiredFile))) {
          throw new Error('改号回滚文件校验失败：' + type);
        }
        materialized = true;
      }
      if (materialized) {
        cleanupIds.add(currentId);
        mappings.push({ from:currentId, to:desiredId, stableId:String(desiredEntry.id || '') });
      }
    }
    return { skins:desired, createdFiles:createdFiles, cleanupIds:Array.from(cleanupIds), mappings:mappings };
  } catch(error) {
    await cleanupCustomSkinRollbackMaterialization(createdFiles);
    throw error;
  }
}

async function rollbackCustomSkinsFromBackup() {
  var backup = CUSTOM_SKINS_FILE + '.bak';
  if (!fs.existsSync(backup)) return { ok:false, error:'没有可撤销的上一版皮肤库' };
  if (_customSkinDownloadRunning || _customSkinSuiteCommitDepth > 0) {
    return { ok:false, busy:true, error:'仍有皮肤下载或资源提交任务，请等待完成后再撤销' };
  }
  var raw = JSON.parse(await fs.promises.readFile(backup, 'utf8'));
  var skins = Array.isArray(raw) ? raw : (raw && raw.skins);
  if (!Array.isArray(skins)) return { ok:false, error:'上一版皮肤库格式无效' };
  var desired = skins.map(normalizeCustomSkinEntryForStorage);
  var desiredByStableId = new Map(desired.map(function(entry) {
    return [String(entry && entry.id || ''), entry];
  }));
  var rollbackMappings = _customSkins.map(function(entry) {
    var target = desiredByStableId.get(String(entry && entry.id || ''));
    return target ? {
      from:parseCustomSkinId(entry.skinId), to:parseCustomSkinId(target.skinId),
      stableId:String(entry.id || ''),
    } : null;
  }).filter(function(mapping) { return mapping && mapping.from && mapping.to && mapping.from !== mapping.to; });
  var managedRollback = await prepareCustomSkinManagedRenumber(desired, rollbackMappings);
  var result = persistAndApplyCustomSkins(desired);
  if (!result.ok) {
    try { await managedRollback.rollback(); }
    catch(error) { result.error += '；托管文件回滚失败：' + error.message; }
    return result;
  }
  result.rollbackMappings = rollbackMappings;
  try { result.cleanup = await managedRollback.finalize(); }
  catch(error) { result.cleanup = { errors:[error.message] }; }
  if (rollbackMappings.length && !result.assignmentReset) {
    var rollbackAssignmentIds = Array.from(new Set([].concat.apply([], rollbackMappings.map(function(mapping) {
      return [mapping.from, mapping.to];
    }))));
    result.assignmentReset = trackCustomSkinAssignmentReset(
      rollbackAssignmentIds,
      clearCustomSkinAssignmentSharedObjects(rollbackAssignmentIds),
      false
    );
  }
  return result;
}

async function renumberCustomSkins(request) {
  request = request || {};
  var baseRevision = parseInt(request.baseRevision, 10);
  if (baseRevision > 0 && baseRevision !== _customSkinRevision) {
    return { ok:false, conflict:true, error:'皮肤库已更新，请刷新后再改号', revision:_customSkinRevision };
  }
  if (_customSkinDownloadRunning || _customSkinSuiteCommitDepth > 0) {
    return { ok:false, busy:true, error:'仍有皮肤下载或资源提交任务，请等待完成后再修改序号' };
  }
  await refreshCustomSkinReservedIds();
  if (baseRevision > 0 && baseRevision !== _customSkinRevision) {
    return { ok:false, conflict:true, error:'皮肤库已更新，请刷新后再改号', revision:_customSkinRevision };
  }
  if (_customSkinDownloadRunning || _customSkinSuiteCommitDepth > 0) {
    return { ok:false, busy:true, error:'仍有皮肤下载或资源提交任务，请等待完成后再修改序号' };
  }
  var officialIdentityIds = await customSkinOfficialIdentityIds();
  if (baseRevision > 0 && baseRevision !== _customSkinRevision) {
    return { ok:false, conflict:true, error:'皮肤库已更新，请刷新后再改号', revision:_customSkinRevision };
  }
  var mode = request.mode === 'chain' ? 'chain' : (request.mode === 'custom' ? 'custom' : 'sequential');
  var requestedIds = mode === 'chain' ? _customSkins.map(function(entry) {
    return parseCustomSkinId(entry && entry.skinId);
  }).filter(Boolean).sort(function(a, b) { return a - b; }) :
    (Array.isArray(request.skinIds) ? request.skinIds : []).map(parseCustomSkinId).filter(Boolean);
  var requestedSet = new Set(requestedIds);
  if (!requestedSet.size) return mode === 'chain'
    ? { ok:true, unchanged:true, mappings:[], skins:customSkinUiEntries(_customSkins),
      revision:_customSkinRevision, suggestedId:suggestedAutomaticCustomSkinId() }
    : { ok:false, error:'请先选择要修改序号的皮肤' };
  var selected = [];
  requestedIds.forEach(function(id) {
    var entry = _customSkins.find(function(item) { return parseCustomSkinId(item.skinId) === id; });
    if (entry && !selected.some(function(item) { return item.skinId === id; })) selected.push(entry);
  });
  if (selected.length !== requestedSet.size) return { ok:false, error:'部分所选皮肤已不存在，请刷新后重试' };

  var occupied = new Set(_customSkinReservedIds);
  _customSkinIssuedIds.forEach(function(id) { occupied.add(parseCustomSkinId(id)); });
  _customSkins.forEach(function(entry) {
    var id = parseCustomSkinId(entry.skinId);
    if (!requestedSet.has(id)) occupied.add(id);
  });
  var targets = [];
  var targetOfficialOverrides = [];
  if (mode === 'custom') {
    var supplied = Array.isArray(request.targetIds) ? request.targetIds : [];
    if (supplied.length !== selected.length) {
      return { ok:false, error:'自定义序号数量必须与所选皮肤数量一致' };
    }
    for (var suppliedIndex = 0; suppliedIndex < supplied.length; suppliedIndex++) {
      var targetId = parseCustomSkinId(supplied[suppliedIndex]);
      var oldId = parseCustomSkinId(selected[suppliedIndex].skinId);
      if (!targetId) {
        return { ok:false, error:'自定义序号必须是 ' + CUSTOM_SKIN_ID_MIN + '-' + CUSTOM_SKIN_ID_MAX + ' 的十进制正整数' };
      }
      var occupiedByOtherLocal = _customSkins.some(function(entry) {
        var entryId = parseCustomSkinId(entry && entry.skinId);
        return entryId === targetId && !requestedSet.has(entryId);
      });
      if (targetId !== oldId && occupiedByOtherLocal) {
        return { ok:false, error:'序号 ' + targetId + ' 已被当前皮肤库中的另一项占用' };
      }
      if (targets.indexOf(targetId) >= 0) return { ok:false, error:'目标序号 ' + targetId + ' 重复' };
      targets.push(targetId);
      targetOfficialOverrides.push(officialIdentityIds.has(targetId));
    }
  } else if (mode === 'chain') {
    var chainStart = parseCustomSkinId(request.startId);
    if (!chainStart) return { ok:false, error:'连续重排起始序号必须是 ' + CUSTOM_SKIN_ID_MIN + '-' + CUSTOM_SKIN_ID_MAX + ' 的十进制正整数' };
    if (chainStart + selected.length - 1 > CUSTOM_SKIN_ID_MAX) {
      return { ok:false, error:'连续重排将超过最大皮肤序号 ' + CUSTOM_SKIN_ID_MAX };
    }
    for (var chainIndex = 0; chainIndex < selected.length; chainIndex++) {
      var chainTarget = chainStart + chainIndex;
      targets.push(chainTarget);
      targetOfficialOverrides.push(officialIdentityIds.has(chainTarget));
    }
  } else {
    var cursor = parseCustomSkinId(request.startId);
    // Manual sequential renumbering may start at any valid game id.  The
    // 70091 floor belongs only to automatic downloads, not to user-defined
    // renumbering.
    if (!cursor || cursor < CUSTOM_SKIN_ID_MIN) cursor = CUSTOM_SKIN_ID_MIN;
    var localOccupied = new Set();
    _customSkins.forEach(function(entry) {
      var localId = parseCustomSkinId(entry && entry.skinId);
      if (localId && !requestedSet.has(localId)) localOccupied.add(localId);
    });
    for (var selectedIndex = 0; selectedIndex < selected.length; selectedIndex++) {
      while (localOccupied.has(cursor)) {
        cursor++;
        if (cursor > CUSTOM_SKIN_ID_MAX) {
          return { ok:false, error:'连续改号已超过最大皮肤序号 ' + CUSTOM_SKIN_ID_MAX };
        }
      }
      var nextId = cursor;
      targets.push(nextId);
      // A user-defined sequence may intentionally reuse an official game id;
      // mark that entry as an explicit local override instead of forcing it
      // back into the automatic 70091+ pool.
      targetOfficialOverrides.push(officialIdentityIds.has(nextId));
      localOccupied.add(nextId);
      cursor = nextId + 1;
    }
  }

  var next = _customSkins.map(normalizeCustomSkinEntryForStorage);
  var mappings = [];
  for (var index = 0; index < selected.length; index++) {
    var from = parseCustomSkinId(selected[index].skinId);
    var to = targets[index];
    var stableId = String(selected[index] && selected[index].id || '');
    var cloned = next.find(function(item) { return String(item && item.id || '') === stableId; });
    if (!cloned) continue;
    var officialIdOverride = targetOfficialOverrides[index] === true;
    var entryChanged = from !== to || cloned.autoId !== false ||
      cloned.officialIdOverride !== officialIdOverride;
    cloned.skinId = to;
    cloned.autoId = false;
    cloned.officialIdOverride = officialIdOverride;
    if (entryChanged) mappings.push({ from:from, to:to, stableId:stableId,
      officialIdOverride:cloned.officialIdOverride });
  }
  if (!mappings.length) return { ok:true, unchanged:true, mappings:[], skins:customSkinUiEntries(_customSkins),
    revision:_customSkinRevision, suggestedId:suggestedAutomaticCustomSkinId() };
  var managedRenumber;
  try { managedRenumber = await prepareCustomSkinManagedRenumber(next, mappings); }
  catch(error) { return { ok:false, error:'迁移托管文件失败：' + error.message }; }
  var result = persistAndApplyCustomSkins(next);
  if (!result.ok) {
    try { await managedRenumber.rollback(); }
    catch(error) { result.error += '；托管文件回滚失败：' + error.message; }
    return result;
  }
  result.mappings = mappings;
  try { result.cleanup = await managedRenumber.finalize(); }
  catch(error) { result.cleanup = { errors:[error.message] }; }
  if (!result.assignmentReset) {
    var renumberAssignmentIds = Array.from(new Set([].concat.apply([], mappings.map(function(mapping) {
      return [mapping.from, mapping.to];
    }))));
    result.assignmentReset = trackCustomSkinAssignmentReset(
      renumberAssignmentIds,
      clearCustomSkinAssignmentSharedObjects(renumberAssignmentIds),
      false
    );
  }
  result.suggestedId = suggestedAutomaticCustomSkinId();
  return result;
}

function migrateCustomSkinsToSafeIds(skins, options) {
  options = options || {};
  var inspectLinkedModels = options.inspectLinkedModels === true;
  var sourceList = Array.isArray(skins) ? skins : [];
  var previousBattleVariantManifest = sourceList.map(function(entry) {
    return String(entry && entry.battleVariantManifest || '').trim();
  });
  var normalized = sourceList.map(normalizeCustomSkinEntryForStorage);
  var keep = new Set();
  var keepFlags = normalized.map(function(entry) {
    var id = parseCustomSkinId(entry.skinId);
    // Official/native ids are valid local override targets. The only invalid
    // existing registration is a duplicate local id; do not migrate merely
    // because the official XML also contains the same number.
    var valid = !!id && !keep.has(id);
    if (valid) keep.add(id);
    return valid;
  });
  var used = new Set();
  keep.forEach(function(id) { used.add(id); });
  var automaticIdCursor = nextAutomaticCustomSkinIdStart(normalized);
  var mappings = [];
  var changed = normalized.some(function(entry, index) {
    return previousBattleVariantManifest[index] !== String(entry && entry.battleVariantManifest || '').trim();
  });
  normalized.forEach(function(entry, index) {
    var oldId = parseInt(entry.skinId, 10);
    if (!keepFlags[index]) {
      var nextId = reserveNextCustomSkinId(used, automaticIdCursor);
      automaticIdCursor = nextId + 1;
      if (!entry.sourceId) entry.sourceId = oldId;
      if (inspectLinkedModels) expandCustomSkinLinkedModels(entry);
      rehomeCustomSkinManagedFiles(entry, oldId, nextId);
      entry.skinId = nextId;
      entry.autoId = true;
      entry.officialIdOverride = false;
      mappings.push({ from:oldId, to:nextId });
      changed = true;
    } else {
      // Whether a local target replaces an existing native game id is derived
      // from the live XML reservation set.  Do not trust stale import metadata:
      // the dictionary must keep the native name/icon while only the model is
      // replaced, whereas genuinely unused ids expose the local identity.
      var nativeOverride = _customSkinReservedIds.has(parseCustomSkinId(entry.skinId));
      if (entry.officialIdOverride !== nativeOverride) {
        entry.officialIdOverride = nativeOverride;
        changed = true;
      }
      if (inspectLinkedModels && expandCustomSkinLinkedModels(entry)) changed = true;
    }
  });
  return { skins:normalized, changed:changed, mappings:mappings };
}

function applyRecoveredCustomSkinIdentity(entry, metadata) {
  metadata = metadata || {};
  if (metadata.officialName) entry.name = String(metadata.officialName).trim().slice(0, 80);
  if (metadata.basePetId !== undefined) entry.basePetId = parseCustomSkinId(metadata.basePetId);
  if (metadata.officialSkinId !== undefined) entry.officialSkinId = parseCustomSkinId(metadata.officialSkinId);
  if (metadata.sourceKind === 'official-skin' || metadata.sourceKind === 'pet') {
    entry.sourceKind = metadata.sourceKind;
  }
  if (metadata.previewAdapter === 'uclient' || metadata.previewAdapter === 'swf') {
    entry.previewAdapter = metadata.previewAdapter;
  }
  if (metadata.uClientPackageVersion) {
    entry.uClientPackageVersion = String(metadata.uClientPackageVersion).slice(0, 40);
  }
  if (metadata.uClientAssetPath) entry.uClientAssetPath = String(metadata.uClientAssetPath).slice(0, 240);
  if (Array.isArray(metadata.uClientActions)) {
    entry.uClientActions = normalizeUClientActions(metadata.uClientActions);
  }
  if (metadata.uClientDedicatedUltimate !== undefined) {
    entry.uClientDedicatedUltimate = metadata.uClientDedicatedUltimate === true;
  }
  if (metadata.uClientFollowAvailable !== undefined) {
    entry.uClientFollowAvailable = metadata.uClientFollowAvailable === true;
  }
  if (metadata.selectedBattleVariant === 'uclient-self-contained' ||
      metadata.selectedBattleVariant === 'legacy-swf') {
    entry.selectedBattleVariant = metadata.selectedBattleVariant;
  }
  if (metadata.selectionReason) {
    entry.battleVariantReason = String(metadata.selectionReason).slice(0, 160);
  }
  if (metadata.variantManifest) {
    entry.battleVariantManifest = String(metadata.variantManifest).slice(0, 320);
  }
  if (metadata.legacyFightPlayable !== undefined) {
    entry.legacyFightPlayable = metadata.legacyFightPlayable === true;
  }
}

async function importCustomSkinSources(sources, sender, options) {
  options = options || {};
  if (!Array.isArray(sources) || !sources.length) return { ok:false, error:'没有选择 SWF' };
  var configBindingsBySource = options.configBindingsBySource || {};
  var scanIdentityResolver = options.scanIdentityResolver || null;
  var records = [];
  var configTypeErrors = [];
  var usable = [];
  var usablePaths = new Set();
  for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    var sourceValue = String(sources[sourceIndex] || '').trim();
    var resolvedSource = sourceValue ? path.resolve(sourceValue) : '';
    var sourceKey = process.platform === 'win32' ? resolvedSource.toLowerCase() : resolvedSource;
    if (!resolvedSource || usablePaths.has(sourceKey)) continue;
    try {
      await fs.promises.access(resolvedSource, fs.constants.R_OK);
      usablePaths.add(sourceKey);
      usable.push(resolvedSource);
    } catch(e) {}
  }
  for (var usableIndex = 0; usableIndex < usable.length; usableIndex++) {
    var source = usable[usableIndex];
    var clean = String(source).trim();
    var sourceKey = process.platform === 'win32' ? path.resolve(clean).toLowerCase() : path.resolve(clean);
    var configBinding = configBindingsBySource[sourceKey] || null;
    sendCustomSkinImportProgress(sender, {
      state:'inspecting', completed:usableIndex, total:usable.length, file:clean,
    });
    var downloadedType = options.downloadedTypeBySource &&
      options.downloadedTypeBySource[path.resolve(clean).toLowerCase()];
    var inspectedTypes = CUSTOM_SKIN_FILE_TYPES.indexOf(downloadedType) >= 0
      ? [downloadedType] : await customSkinInspectLocalTypesAsync(clean);
    var recoveredIdentity = !configBinding && scanIdentityResolver
      ? await scanIdentityResolver.resolve(clean) : null;
    var pathSourceId = recoveredIdentity && recoveredIdentity.preferredSkinId
      ? 0 : customSkinIdFromName(clean);
    var sourceId = configBinding
      ? (parseCustomSkinId(configBinding.entry && configBinding.entry.sourceId) || pathSourceId)
      : (parseCustomSkinId(recoveredIdentity && recoveredIdentity.sourceId) || pathSourceId);
    var recoveredMetadata = recoveredIdentity && recoveredIdentity.metadata
      ? Object.assign({}, recoveredIdentity.metadata) : {};
    if (sourceId && recoveredIdentity) {
      recoveredMetadata = Object.assign(recoveredMetadata,
        await resolveCustomSkinLocalOfficialIdentity(sourceId));
    }
    var detectedTypes = inspectedTypes;
    if (configBinding) {
      detectedTypes = configBinding.types.filter(function(type) {
        return inspectedTypes.indexOf(type) >= 0 ||
          (type === 'demo' && inspectedTypes.indexOf('fight') >= 0);
      });
      var incompatibleTypes = configBinding.types.filter(function(type) {
        return detectedTypes.indexOf(type) < 0;
      });
      if (incompatibleTypes.length) {
        configTypeErrors.push(path.basename(clean) + ' 不能作为 ' + incompatibleTypes.join('/'));
      }
    }
    detectedTypes.forEach(function(type) {
      records.push({
        source:clean,
        sourceId:sourceId,
        skinId:0,
        type:type,
        key:configBinding ? configBinding.groupKey :
          (recoveredIdentity && recoveredIdentity.preferredSkinId
            ? 'managed:' + recoveredIdentity.preferredSkinId
            : customSkinGroupKey(clean, sourceId, type)),
        configEntry:configBinding ? configBinding.entry : null,
        preferredSkinId:parseCustomSkinId(recoveredIdentity && recoveredIdentity.preferredSkinId),
        identityMetadata:recoveredMetadata,
        identityEvidence:String(recoveredIdentity && recoveredIdentity.evidence || ''),
      });
    });
    if (usableIndex % 4 === 3) await new Promise(function(resolve) { setImmediate(resolve); });
  }
  if (configTypeErrors.length) {
    return { ok:false, error:'配置声明的资源类型与 SWF 实际结构不一致，未修改皮肤库：\n' +
      configTypeErrors.slice(0, 6).join('\n') };
  }
  if (!records.length) return { ok:false, error:'没有找到可导入的 SWF' };

  var groupIds = {};
  // Imported companions use the same local sequence as the metadata record.
  // Official XML ids and historical issuedIds do not occupy local ids.
  var reservedIds = new Set();
  _customSkins.forEach(function(entry) { reservedIds.add(parseInt(entry.skinId, 10)); });
  var automaticIdCursor = nextAutomaticCustomSkinIdStart(_customSkins);
  for (var recordMatchIndex = 0; recordMatchIndex < records.length; recordMatchIndex++) {
    var recordMatch = records[recordMatchIndex];
    if (recordMatch.sourceId || groupIds[recordMatch.key]) continue;
    for (var existingIndex = 0; existingIndex < _customSkins.length; existingIndex++) {
      var existingEntry = _customSkins[existingIndex];
      var existingSource = String(existingEntry && existingEntry.files && existingEntry.files[recordMatch.type] || '').trim();
      if (!existingSource || /^https?:\/\//i.test(existingSource)) continue;
      try {
        if (await customSkinFilesMatch(recordMatch.source, resolveCustomSkinSourceForRuntime(existingSource))) {
          groupIds[recordMatch.key] = parseInt(existingEntry.skinId, 10);
          break;
        }
      } catch(e) {}
    }
  }
  records.forEach(function(record) {
    if (groupIds[record.key]) return;
    var dlMeta = options.downloadMetadataBySource && options.downloadMetadataBySource[String(record.sourceId)];
    var existing = findExistingCustomSkin(_customSkins, {
      skinId:record.preferredSkinId || record.skinId,
      sourceId:record.sourceId,
      officialSkinId:(dlMeta && dlMeta.officialSkinId) || (record.identityMetadata && record.identityMetadata.officialSkinId),
      basePetId:(dlMeta && dlMeta.basePetId) || (record.identityMetadata && record.identityMetadata.basePetId),
    });
    if (existing && parseCustomSkinId(existing.skinId)) {
      groupIds[record.key] = parseInt(existing.skinId, 10);
    }
  });
  var claimedConfigIds = new Set(Object.keys(groupIds).map(function(key) {
    return parseCustomSkinId(groupIds[key]);
  }).filter(Boolean));
  records.forEach(function(record) {
    if (groupIds[record.key] || !record.configEntry) return;
    var preferredId = parseCustomSkinId(record.configEntry.skinId);
    if (!preferredId || claimedConfigIds.has(preferredId)) return;
    var occupiedByOther = _customSkins.some(function(entry) {
      return parseCustomSkinId(entry && entry.skinId) === preferredId;
    });
    if (occupiedByOther) return;
    groupIds[record.key] = preferredId;
    claimedConfigIds.add(preferredId);
    reservedIds.add(preferredId);
  });
  records.forEach(function(record) {
    if (groupIds[record.key] || record.configEntry) return;
    var preferredId = parseCustomSkinId(record.preferredSkinId);
    if (!preferredId) return;
    var occupiedByOther = _customSkins.some(function(entry) {
      return parseCustomSkinId(entry && entry.skinId) === preferredId;
    });
    if (occupiedByOther) return;
    groupIds[record.key] = preferredId;
    reservedIds.add(preferredId);
  });
  records.forEach(function(record) {
    if (!groupIds[record.key]) {
      groupIds[record.key] = reserveNextCustomSkinId(reservedIds, automaticIdCursor);
      automaticIdCursor = groupIds[record.key] + 1;
    }
    record.skinId = groupIds[record.key];
  });

  var uniqueRecords = [];
  var recordBySlot = {};
  for (var dedupeIndex = 0; dedupeIndex < records.length; dedupeIndex++) {
    var dedupeRecord = records[dedupeIndex];
    var slotKey = dedupeRecord.skinId + ':' + dedupeRecord.type;
    var previousRecord = recordBySlot[slotKey];
    if (!previousRecord) {
      recordBySlot[slotKey] = dedupeRecord;
      uniqueRecords.push(dedupeRecord);
      continue;
    }
    var sameFile = false;
    try { sameFile = await customSkinFilesMatch(previousRecord.source, dedupeRecord.source); }
    catch(_) {}
    if (!sameFile) {
      return { ok:false, error:'同一皮肤序号 ' + dedupeRecord.skinId + ' 的' +
        CUSTOM_SKIN_TYPE_LABELS[dedupeRecord.type] + '匹配到多个不同 SWF，请整理目录后重试' };
    }
  }
  records = uniqueRecords;

  var configMappingsByGroup = {};
  records.forEach(function(record) {
    if (!record.configEntry || configMappingsByGroup[record.key]) return;
    configMappingsByGroup[record.key] = {
      from:parseCustomSkinId(record.configEntry.skinId),
      to:record.skinId,
    };
  });

  var next = _customSkins.map(function(entry) { return normalizeCustomSkinEntryForStorage(entry); });
  var warnings = [];
  var imported = [];
  var touchedIds = new Set();
  var configuredGroups = new Set();
  var managedTransactions = options.managedTransactions instanceof Map
    ? options.managedTransactions : null;
  for (var recordIndex = 0; recordIndex < records.length; recordIndex++) {
    var record = records[recordIndex];
    var entryIndex = next.findIndex(function(item) { return item.skinId === record.skinId; });
    var entry = entryIndex >= 0 ? next[entryIndex] : null;
    var dlMeta = options.downloadMetadataBySource && options.downloadMetadataBySource[String(record.sourceId)];
    var existingInCurrent = findExistingCustomSkin(_customSkins, {
      skinId:record.skinId,
      sourceId:record.sourceId,
      officialSkinId:(dlMeta && dlMeta.officialSkinId) || (record.identityMetadata && record.identityMetadata.officialSkinId),
      basePetId:(dlMeta && dlMeta.basePetId) || (record.identityMetadata && record.identityMetadata.basePetId),
    });
    if (!entry) {
      if (record.configEntry) {
        entry = normalizeCustomSkinEntryForStorage(Object.assign({}, record.configEntry, {
          skinId:record.skinId,
          sourceId:parseCustomSkinId(record.configEntry.sourceId) || record.sourceId,
          autoId:parseCustomSkinId(record.configEntry.skinId) !== record.skinId,
          officialIdOverride:_customSkinReservedIds.has(parseCustomSkinId(record.skinId)),
          files:{},
        }));
      } else {
        var initialName = customSkinFriendlyName(record.source, record.sourceId || record.skinId);
        if (initialName.indexOf('自定义皮肤 ') === 0) {
          initialName = '赛尔1精灵 ' + (record.sourceId || record.skinId);
        }
        var initialEnabled;
        if (existingInCurrent && existingInCurrent.enabled !== false) {
          initialEnabled = true;
        } else if (options.initialEnabled !== undefined) {
          initialEnabled = options.initialEnabled === true;
        } else {
          initialEnabled = true;
        }
        entry = normalizeCustomSkinEntryForStorage({
          skinId:record.skinId,
          sourceId:record.sourceId,
          autoId:true,
          officialIdOverride:_customSkinDefinitionIds.has(parseCustomSkinId(record.skinId)),
          enabled:initialEnabled,
          name:(existingInCurrent && existingInCurrent.name) || initialName,
          files:existingInCurrent && existingInCurrent.files ? Object.assign({}, existingInCurrent.files) : {},
          battlePlacement:existingInCurrent ? existingInCurrent.battlePlacement : null,
          battleScale:existingInCurrent ? existingInCurrent.battleScale : null,
          ultimateAction:existingInCurrent ? existingInCurrent.ultimateAction : '',
          ultimateSkillId:existingInCurrent ? existingInCurrent.ultimateSkillId : 0,
          presentationMode:existingInCurrent ? existingInCurrent.presentationMode : 'full-idle',
        });
      }
      next.push(entry);
    } else if (record.configEntry && !configuredGroups.has(record.key)) {
      var configuredEntry = normalizeCustomSkinEntryForStorage(Object.assign({}, record.configEntry, {
        id:String(entry.id || record.configEntry.id || ''),
        skinId:record.skinId,
        sourceId:parseCustomSkinId(record.configEntry.sourceId) || record.sourceId,
        autoId:parseCustomSkinId(record.configEntry.skinId) !== record.skinId,
        officialIdOverride:_customSkinReservedIds.has(parseCustomSkinId(record.skinId)),
        files:Object.assign({}, entry.files || {}),
      }));
      next[entryIndex] = configuredEntry;
      entry = configuredEntry;
    }
    if (record.configEntry) configuredGroups.add(record.key);
    if (existingInCurrent && existingInCurrent.enabled !== false) {
      entry.enabled = true;
    } else if (options.initialEnabled === true) {
      entry.enabled = true;
    }
    if (existingInCurrent) {
      if (existingInCurrent.battlePlacement && !entry.battlePlacement) {
        entry.battlePlacement = Object.assign({}, existingInCurrent.battlePlacement);
      }
      if (typeof existingInCurrent.battleScale === 'number' && typeof entry.battleScale !== 'number') {
        entry.battleScale = existingInCurrent.battleScale;
      }
      if (existingInCurrent.ultimateAction && !entry.ultimateAction) {
        entry.ultimateAction = existingInCurrent.ultimateAction;
      }
      if (existingInCurrent.ultimateSkillId && !entry.ultimateSkillId) {
        entry.ultimateSkillId = existingInCurrent.ultimateSkillId;
      }
    }
    if (!record.configEntry && record.identityMetadata) {
      applyRecoveredCustomSkinIdentity(entry, record.identityMetadata);
    }
    var downloadedMeta = dlMeta;
    if (downloadedMeta) {
      entry.files.physical = '';
      entry.files.special = '';
      entry.files.property = '';
      if (downloadedMeta.officialName && (!existingInCurrent || !existingInCurrent.name)) {
        entry.name = String(downloadedMeta.officialName).trim().slice(0, 80);
      }
      entry.basePetId = parseCustomSkinId(downloadedMeta.basePetId);
      entry.officialSkinId = parseCustomSkinId(downloadedMeta.officialSkinId);
      entry.sourceKind = downloadedMeta.sourceKind === 'official-skin' ? 'official-skin' : 'pet';
      if (downloadedMeta.ultimateAction && (!existingInCurrent || !existingInCurrent.ultimateAction)) {
        entry.ultimateAction = String(downloadedMeta.ultimateAction).trim().slice(0, 40);
      }
      if (downloadedMeta.ultimateSkillId && (!existingInCurrent || !existingInCurrent.ultimateSkillId)) {
        entry.ultimateSkillId = parseCustomSkinId(downloadedMeta.ultimateSkillId);
      }
      if (downloadedMeta.previewAdapter === 'uclient' || downloadedMeta.previewAdapter === 'swf') {
        entry.previewAdapter = downloadedMeta.previewAdapter;
      }
      if (downloadedMeta.previewAdapter === 'swf') {
        entry.uClientPackageVersion = '';
        entry.uClientAssetPath = '';
        entry.uClientActions = [];
        entry.uClientDedicatedUltimate = false;
        entry.battleVariantManifest = '';
      }
      if (downloadedMeta.uClientPackageVersion) entry.uClientPackageVersion = String(downloadedMeta.uClientPackageVersion).slice(0, 40);
      if (downloadedMeta.uClientAssetPath) entry.uClientAssetPath = String(downloadedMeta.uClientAssetPath).slice(0, 240);
      if (Array.isArray(downloadedMeta.uClientActions)) entry.uClientActions = normalizeUClientActions(downloadedMeta.uClientActions);
      entry.uClientDedicatedUltimate = downloadedMeta.uClientDedicatedUltimate === true;
      if (downloadedMeta.selectedBattleVariant === 'uclient-self-contained' ||
          downloadedMeta.selectedBattleVariant === 'legacy-swf') {
        entry.selectedBattleVariant = downloadedMeta.selectedBattleVariant;
      }
      if (downloadedMeta.selectionReason) {
        entry.battleVariantReason = String(downloadedMeta.selectionReason).slice(0, 160);
      }
      if (downloadedMeta.variantManifest) {
        entry.battleVariantManifest = String(downloadedMeta.variantManifest).slice(0, 320);
      }
      entry.legacyFightPlayable = downloadedMeta.legacyFightPlayable === true;
      entry.legacyStaticPoseWrapper = downloadedMeta.staticPoseWrapper === true;
      if (Array.isArray(downloadedMeta.actionLabels)) {
        entry.battleActions = normalizeCustomSkinBattleActions(downloadedMeta.actionLabels);
      }
    }
    var storedSource = record.source;
    var managedRoot = path.join(CUSTOM_SKINS_DIR, 'files');
    var finalTargetDir = path.join(managedRoot, String(record.skinId));
    var targetDir = finalTargetDir;
    if (managedTransactions) {
      var managedTransaction = managedTransactions.get(record.skinId);
      if (!managedTransaction) {
        managedTransaction = await sourceSuiteTransaction.begin(managedRoot,record.skinId);
        managedTransactions.set(record.skinId,managedTransaction);
      }
      targetDir = managedTransaction.draftItemRoot;
    }
    await fs.promises.mkdir(targetDir, { recursive:true });
    var target = path.join(targetDir, record.type + '.swf');
    var finalTarget = path.join(finalTargetDir, record.type + '.swf');
    if (path.resolve(record.source).toLowerCase() !== path.resolve(finalTarget).toLowerCase()) {
      var alreadyMaterialized = false;
      if (!managedTransactions && fs.existsSync(finalTarget)) {
        try { alreadyMaterialized = await customSkinFilesMatch(record.source, finalTarget); } catch(e) {}
      }
      record.storageMaterialization = alreadyMaterialized
        ? 'existing' : await materializeCustomSkinManagedFile(record.source, target);
    }
    storedSource = normalizeCustomSkinSourceForStorage(finalTarget);
    if (entry.files[record.type] && entry.files[record.type] !== storedSource) {
      warnings.push('序号 ' + record.skinId + ' 的' + CUSTOM_SKIN_TYPE_LABELS[record.type] + '已更新');
    }
    entry.files[record.type] = storedSource;
    imported.push({
      skinId:record.skinId,
      sourceId:record.sourceId,
      type:record.type,
      typeLabel:CUSTOM_SKIN_TYPE_LABELS[record.type],
      source:storedSource,
      storageMaterialization:record.storageMaterialization || 'existing',
    });
    touchedIds.add(record.skinId);
    sendCustomSkinImportProgress(sender, {
      state:'copying', completed:recordIndex + 1, total:records.length, skinId:record.skinId,
    });
    if (recordIndex % 4 === 3) await new Promise(function(resolve) { setImmediate(resolve); });
  }
  var touchedEntries = next.filter(function(entry) { return touchedIds.has(entry.skinId); });
  if (!managedTransactions) {
    for (var touchedIndex = 0; touchedIndex < touchedEntries.length; touchedIndex++) {
      await expandCustomSkinLinkedModelsAsync(touchedEntries[touchedIndex]);
    }
  }
  applyCustomSkinNativeTemplates(touchedEntries);
  var iconResults = options.skipSupplement ? [] : await ensureCustomSkinStaticIcons(touchedEntries);
  var followResults = options.skipSupplement ? [] : await ensureCustomSkinFollowModels(touchedEntries);
  iconResults.forEach(function(item) {
    if (item.ok && item.changed) {
      warnings.push('序号 ' + item.skinId + ' 已安装官方单帧静态头像');
    } else if (!item.ok) {
      warnings.push('序号 ' + item.skinId + ' 未能补齐静态头像：' + item.error);
    }
  });
  followResults.forEach(function(item) {
    if (item.ok && item.changed) {
      warnings.push('序号 ' + item.skinId + ' 已安装官方跟随模型（实际视角以官方原文件为准）');
    } else if (!item.ok) {
      warnings.push('序号 ' + item.skinId + ' 未能补齐跟随模型：' + item.error);
    }
  });
  if (options.deferPersist === true) {
    sendCustomSkinImportProgress(sender, {
      state:'finished', imported:imported.length, skins:touchedEntries.length,
    });
    return {
      ok:true,
      unchanged:false,
      imported:imported,
      warnings:warnings,
      stagedSkins:next,
      revision:_customSkinRevision,
      configFile:options.configFile || '',
      configMappings:Object.keys(configMappingsByGroup).map(function(key) {
        return configMappingsByGroup[key];
      }),
    };
  }
  var result = persistAndApplyCustomSkins(next, {
    reload:options.reload !== false,
    notify:options.notify !== false,
  });
  if (!result.ok) return result;
  result.imported = imported;
  var sourceMappings = {};
  imported.forEach(function(item) {
    if (item.sourceId && item.sourceId !== item.skinId) sourceMappings[item.sourceId] = item.skinId;
  });
  Object.keys(sourceMappings).forEach(function(sourceId) {
    warnings.push('文件名中的 ' + sourceId + ' 仅用于编组；已避开游戏占用序号并分配 ' + sourceMappings[sourceId]);
  });
  result.warnings = (result.warnings || []).concat(warnings);
  if (options.configFile) {
    result.configFile = options.configFile;
    result.configMappings = Object.keys(configMappingsByGroup).map(function(key) {
      return configMappingsByGroup[key];
    });
  }
  sendCustomSkinImportProgress(sender, {
    state:'finished', imported:imported.length, skins:touchedEntries.length,
  });
  await resolveImportedCustomSkinNames(touchedEntries.map(function(entry) { return entry.skinId; }), {
    reload:options.reload !== false,
    notify:options.notify !== false,
  });
  return result;
}

async function resolveImportedCustomSkinNames(skinIds, options) {
  options = options || {};
  var ids = Array.isArray(skinIds) ? skinIds.slice() : [];
  var changed = false;
  for (var offset = 0; offset < ids.length; offset += 4) {
    var batch = ids.slice(offset, offset + 4);
    var results = await Promise.all(batch.map(async function(skinId) {
      var entry = _customSkins.find(function(item) { return item.skinId === skinId; });
      if (!entry || !entry.sourceId || !/^赛尔1精灵\s+\d+$/.test(String(entry.name || ''))) return null;
      var name = await fetchCustomSkinPublicName(entry.sourceId);
      return name ? { entry:entry, name:name } : null;
    }));
    results.forEach(function(item) {
      if (!item) return;
      item.entry.name = item.name;
      changed = true;
    });
    await new Promise(function(resolve) { setImmediate(resolve); });
  }
  if (changed) {
    applyCustomSkinNativeTemplates(_customSkins);
    persistAndApplyCustomSkins(_customSkins, {
      reload:options.reload !== false,
      notify:options.notify !== false,
    });
  }
}

app.whenReady().then(async function() {
  startupDiag('stage: app.whenReady fired');
  try {
    if (_pendingFatalDialog) {
      var _pf = _pendingFatalDialog;
      _pendingFatalDialog = null;
      try {
        dialog.showErrorBox(
          '启动早期捕获到异常',
          '启动早期捕获到异常，程序仍在尝试继续运行。\n\n' +
          '来源：' + _pf.source + '\n' +
          '错误：' + _pf.message + '\n\n' +
          '详细日志已写入：\n' + (_startupCrashLogPath || '(logging failed)')
        );
      } catch(_) {}
    }
  } catch(_) {}

  logInfo('App','=== Seer2 Launcher started ===',{ pid:process.pid, electron:process.versions.electron, chrome:process.versions.chrome });
  try { loadSelectedServer(); } catch(e) { startupDiag('loadSelectedServer FAILED', { message: e.message }); }
  startupDiag('stage: selectedServer loaded', { id: _selectedServerId });
  var _initSrv = getSelectedServer();
  if (_initSrv && _initSrv.rootUrl) {
    try { coreNet.setGameBackend(_initSrv.rootUrl); } catch(e) { startupDiag('setGameBackend FAILED', { message: e.message }); }
  }
  try { coreNet.setCacheDir(GAME_CACHE_DIR); } catch(e) { startupDiag('setCacheDir FAILED', { message: e.message }); }
  try {
    coreNet.setUClientPetPreviewResolver(function(sourceId) {
      var id = parseCustomSkinId(sourceId);
      if (!id) return '';
      var downloadedRoot = path.join(customSkinDownloadDirectory(), String(id), 'uclient-preview');
      var downloadedAtlas = ['uclient-atlas.png', 'uclient-atlas.webp'].map(function(name) {
        return path.join(downloadedRoot, name);
      }).find(function(file) { return fs.existsSync(file); });
      if (downloadedAtlas) return downloadedAtlas;
      var cachedRoot = path.join(uClientPetPreviewCacheDirectory(), String(id), 'uclient-preview');
      return ['uclient-atlas.png', 'uclient-atlas.webp'].map(function(name) {
        return path.join(cachedRoot, name);
      }).find(function(file) { return fs.existsSync(file); }) || '';
    });
  } catch(e) { startupDiag('setUClientPetPreviewResolver FAILED', { message:e.message }); }
  startupDiag('stage: cacheDir set', { dir: GAME_CACHE_DIR });
  try {
    await coreNet.startInterceptProxy();
    startupDiag('stage: interceptProxy started', { port: coreNet.getProxyPort() });
  } catch(e) {
    console.error('[LocalSrv] Failed:', e.message);
    startupDiag('stage: interceptProxy FAILED', { message: e.message });
  }

  (function registerHttpInterceptor() {
    var _proxyPort = coreNet.getProxyPort();
    protocol.interceptStreamProtocol('http', function(request, callback) {
      var replied = false;
      function reply(payload) {
        if (replied) return;
        replied = true;
        try { callback(payload); } catch(_) {}
      }
      var urlObj;
      try { urlObj = new URL(request.url); } catch(e) {
        reply({ statusCode: 400, data: bufferToStream('invalid url') });
        return;
      }

      if (urlObj.pathname === '/crossdomain.xml') {
        reply({
          statusCode: 200,
          headers: {
            'content-type':  'text/x-cross-domain-policy',
            'cache-control': 'no-cache',
            'access-control-allow-origin': '*',
          },
          data: bufferToStream(FLASH_POLICY_DATA),
        });
        return;
      }

      var reqHostname = urlObj.hostname;
      var reqPort     = parseInt(urlObj.port) || 80;

      if (reqHostname === '127.0.0.1') {
        var dH = Object.assign({}, request.headers || {});
        delete dH['proxy-connection'];
        var dReq = http.request({
          hostname: '127.0.0.1', port: reqPort,
          path: urlObj.pathname + (urlObj.search || ''),
          method: request.method || 'GET', headers: dH,
        }, function(dRes) {
          reply({ statusCode: dRes.statusCode || 200, headers: dRes.headers || {}, data: dRes });
          dRes.on('error',function(e) { reply({ statusCode: 502, data: bufferToStream('local-err: ' + e.message) }); });
        });
        dReq.on('error', function(e) { reply({ statusCode: 502, data: bufferToStream('local-conn: ' + e.message) }); });
        if (request.uploadData && request.uploadData[0]) dReq.write(request.uploadData[0].bytes);
        dReq.end();
        return;
      }

      var route = (reqHostname === LOCAL_HOSTNAME)
        ? { host: LOCAL_HOSTNAME, port: 80, path: urlObj.pathname + (urlObj.search || '') }
        : { host: reqHostname, port: reqPort, path: urlObj.pathname + (urlObj.search || '') };
      var targetHost = route.host;
      var targetPort = route.port || 80;
      var hostHdr    = targetHost + (targetPort !== 80 ? ':' + targetPort : '');
      var proxyPath  = 'http://' + hostHdr + route.path;
      var pH = Object.assign({}, request.headers || {});
      pH['host'] = hostHdr;
      delete pH['proxy-connection'];

      var pReq = http.request({
        hostname: '127.0.0.1', port: _proxyPort,
        path: proxyPath, method: request.method || 'GET', headers: pH,
      }, function(pRes) {
        reply({ statusCode: pRes.statusCode || 200, headers: pRes.headers || {}, data: pRes });
        pRes.on('error',function(e) { reply({ statusCode: 502, data: bufferToStream('proxy-res: ' + e.message) }); });
      });
      pReq.setTimeout(30000, function() {
        pReq.destroy();
        reply({ statusCode: 504, data: bufferToStream('timeout') });
      });
      pReq.on('error', function(e) { reply({ statusCode: 502, data: bufferToStream('proxy-conn: ' + e.message) }); });
      if (request.uploadData && request.uploadData[0]) pReq.write(request.uploadData[0].bytes);
      pReq.end();
    });
    console.log('[Protocol] http interceptor registered → game domain: http://' + LOCAL_HOSTNAME + '/');
  })();
  _CAPTURE_CFG_FILE = app.isPackaged
    ? require('path').join(require('path').dirname(process.execPath), 'capture-config.json')
    : require('path').join(__dirname, 'capture-config.json');
  try { _loadCaptureCfg(); } catch(e) { startupDiag('_loadCaptureCfg FAILED', { message: e.message }); }
  REPLACE_RULES_FILE = app.isPackaged
    ? require('path').join(require('path').dirname(process.execPath), 'replace-rules.json')
    : require('path').join(__dirname, 'replace-rules.json');
  SKIN_MODE_STATE_FILE = app.isPackaged
    ? require('path').join(require('path').dirname(process.execPath), 'skin-mode.json')
    : require('path').join(__dirname, 'skin-mode.json');
  SKIN_MODE_RULES_FILE = app.isPackaged
    ? require('path').join(require('path').dirname(process.execPath), 'skin-mode-rules.json')
    : require('path').join(__dirname, 'skin-mode-rules.json');
  CATALOG_INSTALL_RESET_FILE = app.isPackaged
    ? require('path').join(require('path').dirname(process.execPath), 'catalog-navigation-reset.pending')
    : null;
  SKIN_ASSIGNMENT_INSTALL_RESET_FILE = app.isPackaged
    ? require('path').join(require('path').dirname(process.execPath), 'skin-assignment-reset.pending')
    : null;
  LOCAL_SWF_DIR = app.isPackaged
    ? require('path').join(path.dirname(process.execPath), 'local-res')
    : require('path').join(__dirname, 'local-res');
  try { coreNet.setLocalSwfDir(LOCAL_SWF_DIR); } catch(e) { startupDiag('setLocalSwfDir FAILED', { message: e.message }); }
  try { loadReplaceRules(); } catch(e) { startupDiag('loadReplaceRules FAILED', { message: e.message }); }
  try { loadSkinModeState(); } catch(e) { startupDiag('loadSkinModeState FAILED', { message: e.message }); }
  try { consumeCatalogInstallResetMarker(); }
  catch(e) { startupDiag('consumeCatalogInstallResetMarker FAILED', { message:e.message }); }
  try { consumeSkinAssignmentInstallResetMarker(); }
  catch(e) { startupDiag('consumeSkinAssignmentInstallResetMarker FAILED', { message:e.message }); }

  var customSkinStorageRoot = app.isPackaged
    ? require('path').dirname(process.execPath)
    : __dirname;
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT) {
    var testSkinRoot = path.resolve(process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT);
    if (path.isAbsolute(testSkinRoot)) customSkinStorageRoot = testSkinRoot;
  }
  CUSTOM_SKINS_FILE = require('path').join(customSkinStorageRoot, 'custom-skins.json');
  CUSTOM_SKINS_DIR = require('path').join(require('path').dirname(CUSTOM_SKINS_FILE), 'custom-skins');
  CUSTOM_SKIN_DOWNLOAD_SETTINGS_FILE = require('path').join(
    require('path').dirname(CUSTOM_SKINS_FILE), 'custom-skin-download-settings.json'
  );
  CUSTOM_SKIN_NAME_CACHE_FILE = require('path').join(
    require('path').dirname(CUSTOM_SKINS_FILE), 'custom-skin-name-cache.json'
  );
  CUSTOM_SKIN_CATALOG_CACHE_FILE = require('path').join(
    require('path').dirname(CUSTOM_SKINS_FILE), 'custom-skin-official-catalog.json'
  );
  CUSTOM_SKIN_TEMPORARY_MODEL_NAME_EVIDENCE_FILE = require('path').join(
    require('path').dirname(CUSTOM_SKINS_FILE), 'custom-skin-temporary-model-names.json'
  );
  CUSTOM_SKIN_DEFAULT_DOWNLOAD_DIR = require('path').join(
    require('path').dirname(CUSTOM_SKINS_FILE), '赛尔号1精灵模型'
  );
  try { loadCustomSkinDownloadSettings(); }
  catch(e) { startupDiag('loadCustomSkinDownloadSettings FAILED', { message:e.message }); }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_DIR) {
    _customSkinDownloadDir = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_DIR);
  }
  try { loadCustomSkins(); } catch(e) { startupDiag('loadCustomSkins FAILED', { message:e.message }); }
  if (process.env.LAUNCHER_AUTOTEST === '1' &&
      process.env.LAUNCHER_AUTOTEST_SKIN_QUEUE_SETTLEMENT_RESULT_FILE) {
    var queueSettlementOutput = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_QUEUE_SETTLEMENT_RESULT_FILE);
    var queueSettlementReport = { ok:false, scenarios:[] };
    try {
      if (!process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT) {
        throw new Error('LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT is required');
      }
      var queueScenarios = [
        { name:'all-success', queue:[101,102], request:{ ids:[101,102] }, result:{ failed:[], pending:[] }, expected:[] },
        { name:'partial-failure', queue:[101,102], request:{ ids:[101,102] }, result:{ failed:[{ id:102, type:'fight', queueRootId:102 }], pending:[] }, expected:[102] },
        { name:'official-unavailable-terminal', queue:[101,102], request:{ ids:[101,102] }, result:{ unavailable:[{ id:102, type:'icon' }], failed:[], pending:[] }, expected:[] },
        { name:'rate-limited', queue:[101,102,103], request:{ ids:[101,102,103] }, result:{ failed:[{ id:102, type:'fight', queueRootId:102 }], pending:[{ id:103, type:'fight', queueRootId:103 }] }, expected:[102,103] },
        { name:'uclient-incomplete', queue:[101,102], request:{ ids:[101,102] }, result:{ incompleteUClientIds:[102], failed:[], pending:[] }, expected:[102] },
        { name:'retry-success', queue:[102], request:{ jobs:[{ id:1400102, type:'fight', queueRootId:102 }], queueRootIds:[102] }, result:{ failed:[], pending:[] }, expected:[] },
        { name:'expanded-skin-failure', queue:[101], request:{ ids:[101] }, jobs:[{ id:1400101, type:'fight', queueRootId:101, basePetId:101 }], result:{ failed:[{ id:1400101, type:'fight', queueRootId:101, basePetId:101 }], pending:[] }, expected:[101] },
        { name:'preview-does-not-consume', queue:[101], request:{ ids:[101], previewOnly:true }, result:{ failed:[], pending:[] }, expected:[101] },
      ];
      queueScenarios.forEach(function(scenario) {
        var plan = planCustomSkinDownloadQueueSettlement(
          scenario.queue, scenario.request, scenario.result, scenario.jobs || []);
        var passed = JSON.stringify(plan.after) === JSON.stringify(scenario.expected);
        queueSettlementReport.scenarios.push({
          name:scenario.name, ok:passed, after:plan.after, expected:scenario.expected,
          consumed:plan.consumed, retained:plan.retained,
        });
      });
      _customSkinDownloadQueueIds = [101,102];
      var persistedSettlement = settleCustomSkinDownloadQueue(
        { ids:[101,102] },
        { failed:[{ id:102, type:'fight', queueRootId:102 }], pending:[] },
        [{ id:101, type:'fight', queueRootId:101 }, { id:102, type:'fight', queueRootId:102 }]
      );
      var persistedSettings = JSON.parse(fs.readFileSync(CUSTOM_SKIN_DOWNLOAD_SETTINGS_FILE, 'utf8'));
      var staleWriteResult = setCustomSkinDownloadQueueRequest({
        ids:[101,102],
        baseQueueRevision:Math.max(0, _customSkinDownloadQueueRevision - 1),
      });
      queueSettlementReport.persistence = {
        result:persistedSettlement,
        queueIds:persistedSettings.queueIds,
        queueRevision:persistedSettings.queueRevision,
        staleWriteRejected:staleWriteResult && staleWriteResult.conflict === true &&
          JSON.stringify(_customSkinDownloadQueueIds) === JSON.stringify([102]),
        ok:persistedSettlement.ok === true &&
          JSON.stringify(persistedSettings.queueIds) === JSON.stringify([102]) &&
          staleWriteResult && staleWriteResult.conflict === true &&
          JSON.stringify(_customSkinDownloadQueueIds) === JSON.stringify([102]),
      };
      queueSettlementReport.ok = queueSettlementReport.scenarios.every(function(item) { return item.ok; }) &&
        queueSettlementReport.persistence.ok;
      _customSkinDownloadQueueIds = [];
      _customSkinDownloadQueueRevision++;
      saveCustomSkinDownloadSettings();
    } catch(e) {
      queueSettlementReport.error = e.stack || e.message;
    }
    await fs.promises.writeFile(queueSettlementOutput,
      JSON.stringify(queueSettlementReport, null, 2), 'utf8');
    if (!queueSettlementReport.ok) process.exitCode = 1;
    app.quit();
    return;
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' &&
      process.env.LAUNCHER_AUTOTEST_SKIN_CONFIG_IMPORT_FILE &&
      process.env.LAUNCHER_AUTOTEST_SKIN_CONFIG_IMPORT_RESULT_FILE) {
    var configImportOutput = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_CONFIG_IMPORT_RESULT_FILE);
    try {
      if (!process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT ||
          !process.env.LAUNCHER_AUTOTEST_USER_DATA_ROOT) {
        throw new Error('isolated user-data and custom-skin roots are required');
      }
      var configImportPackage = await customSkinConfigPackage.read(
        path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_CONFIG_IMPORT_FILE));
      await refreshCustomSkinReservedIds();
      var configImportResult = await importCustomSkinFolderPackage(
        configImportPackage, null, _customSkinRevision, { skipSupplement:true });
      await fs.promises.writeFile(configImportOutput, JSON.stringify({
        ok:configImportResult && configImportResult.ok === true,
        packageInfo:{ configFile:configImportPackage.configFile,
          configEntryCount:configImportPackage.configEntryCount,
          swfCount:configImportPackage.swfCount },
        result:configImportResult,
        snapshot:{ revision:_customSkinRevision, skins:customSkinUiEntries(_customSkins) },
      }, null, 2), 'utf8');
      if (!configImportResult || !configImportResult.ok) process.exitCode = 1;
    } catch(error) {
      await fs.promises.writeFile(configImportOutput,
        JSON.stringify({ ok:false, error:error.message, stack:error.stack || '' }, null, 2), 'utf8');
      process.exitCode = 1;
    }
    app.quit();
    return;
  }
  if (process.env.LAUNCHER_AUTOTEST_UCLIENT_FTR_FLASH_ASSETS) {
    var flashAssetOutput = null;
    try {
      if (process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_DIR) {
        _customSkinDownloadDir = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_DIR);
      }
      try { backfillRegisteredUClientPetMetadata(); } catch(_) {}
      try { applyCustomSkinsToCoreNet(); } catch(_) {}
      var requestedUClientIds = String(process.env.LAUNCHER_AUTOTEST_UCLIENT_FTR_FLASH_ASSETS || '')
        .split(',').map(parseCustomSkinId).filter(Boolean);
      if (!requestedUClientIds.length) {
        requestedUClientIds = (_customSkins || []).filter(function(item) { return item.previewAdapter === 'uclient'; })
          .map(function(item) { return parseCustomSkinId(item.sourceId); }).filter(Boolean);
      }
      var flashAssetResults = [];
      for (var uClientAssetIndex = 0; uClientAssetIndex < requestedUClientIds.length; uClientAssetIndex++) {
        var requestedUClientId = requestedUClientIds[uClientAssetIndex];
        var requestedUClientRoot = path.join(customSkinDownloadDirectory(), String(requestedUClientId), 'uclient-preview');
        var flashAssets = await ensureUClientPetFlashAssets(requestedUClientRoot,
          process.env.LAUNCHER_AUTOTEST_UCLIENT_FTR_FLASH_ASSETS_FORCE !== '0');
        var battleSwf = await buildUClientPetBattleSwf(requestedUClientRoot, requestedUClientId);
        flashAssetResults.push({ id:requestedUClientId, result:flashAssets, battleSwf:battleSwf });
      }
      flashAssetOutput = { ok:true, results:flashAssetResults };
      console.log('[AUTOTEST] uclient-flash-assets ' + JSON.stringify(flashAssetOutput));
    } catch(e) {
      flashAssetOutput = { ok:false, error:e.stack || e.message };
      console.log('[AUTOTEST] uclient-flash-assets-error ' + e.message);
      process.exitCode = 1;
    }
    if (process.env.LAUNCHER_AUTOTEST_UCLIENT_FTR_FLASH_ASSETS_RESULT_FILE) {
      try {
        await fs.promises.writeFile(
          path.resolve(process.env.LAUNCHER_AUTOTEST_UCLIENT_FTR_FLASH_ASSETS_RESULT_FILE),
          JSON.stringify(flashAssetOutput, null, 2), 'utf8'
        );
      } catch(e) {
        console.log('[AUTOTEST] uclient-flash-assets-result-error ' + e.message);
        process.exitCode = 1;
      }
    }
    app.quit();
    return;
  }
  if (process.env.LAUNCHER_AUTOTEST_CLEAR_SKINS === '1') {
    try {
      var autotestRemovedSkins = _customSkins.slice();
      var autotestClearResult = persistAndApplyCustomSkins([]);
      var autotestCleanup = await deleteCustomSkinLocalFiles(autotestRemovedSkins, []);
      var autotestAssignmentReset = trackCustomSkinAssignmentReset(
        [], clearCustomSkinAssignmentSharedObjects(), true);
      try { await fs.promises.unlink(CUSTOM_SKINS_FILE + '.bak'); }
      catch(e) { if (!e || e.code !== 'ENOENT') throw e; }
      console.log('[AUTOTEST] custom-skin-clear ' + JSON.stringify({
        ok:autotestClearResult && autotestClearResult.ok === true,
        cleanup:autotestCleanup,
        assignmentReset:autotestAssignmentReset,
      }));
    } catch(e) {
      console.log('[AUTOTEST] custom-skin-clear-error ' + e.message);
    }
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' &&
      process.env.LAUNCHER_AUTOTEST_CLEAR_BINDINGS_RESULT_FILE) {
    var clearBindingsOutput = path.resolve(process.env.LAUNCHER_AUTOTEST_CLEAR_BINDINGS_RESULT_FILE);
    var clearBindingsReport;
    try {
      if (!process.env.LAUNCHER_AUTOTEST_USER_DATA_ROOT ||
          !process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT) {
        throw new Error('isolated user-data and custom-skin roots are required');
      }
      var clearBindingsResult = trackCustomSkinAssignmentReset(
        [], clearCustomSkinAssignmentSharedObjects(), true);
      clearBindingsReport = {
        ok:clearBindingsResult.errors.length === 0,
        result:clearBindingsResult,
        snapshot:customSkinDownloadStatePayload(),
      };
    } catch(e) {
      clearBindingsReport = { ok:false, error:e.stack || e.message };
    }
    await fs.promises.writeFile(clearBindingsOutput,
      JSON.stringify(clearBindingsReport, null, 2), 'utf8');
    if (!clearBindingsReport.ok) process.exitCode = 1;
    app.quit();
    return;
  }
  if (process.env.LAUNCHER_AUTOTEST_PURGE_SKINS === '1') {
    try {
      if (!process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT ||
          !process.env.LAUNCHER_AUTOTEST_USER_DATA_ROOT) {
        throw new Error('isolated user-data and custom-skin roots are required');
      }
      var autotestPurgeResult = await purgeAllCustomSkins({
        confirmToken:'DELETE_ALL_SKIN_FILES',
        baseRevision:_customSkinRevision,
      });
      console.log('[AUTOTEST] custom-skin-purge ' + JSON.stringify(autotestPurgeResult));
      if (process.env.LAUNCHER_AUTOTEST_RESULT_FILE) {
        await fs.promises.writeFile(
          path.resolve(process.env.LAUNCHER_AUTOTEST_RESULT_FILE),
          JSON.stringify(autotestPurgeResult, null, 2),
          'utf8'
        );
      }
      if (!autotestPurgeResult.ok || customSkinDownloadedSourceIds().length) process.exitCode = 1;
    } catch(e) {
      console.log('[AUTOTEST] custom-skin-purge-error ' + e.message);
      process.exitCode = 1;
    }
    app.quit();
    return;
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_REMOVE_SKINS_RESULT_FILE) {
    try {
      if (!process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT ||
          !process.env.LAUNCHER_AUTOTEST_USER_DATA_ROOT) {
        throw new Error('isolated user-data and custom-skin roots are required');
      }
      var autotestRemoveIds = String(process.env.LAUNCHER_AUTOTEST_REMOVE_SKIN_IDS || '')
        .split(',').map(parseCustomSkinId).filter(Boolean);
      if (!autotestRemoveIds.length) {
        autotestRemoveIds = _customSkins.map(function(entry) { return parseCustomSkinId(entry.skinId); }).filter(Boolean);
      }
      var autotestRemoveResult = await removeCustomSkinsByRequest({
        skinIds:autotestRemoveIds,
        deleteFiles:process.env.LAUNCHER_AUTOTEST_REMOVE_SKIN_DELETE_FILES !== '0',
        baseRevision:_customSkinRevision,
      });
      await fs.promises.writeFile(
        path.resolve(process.env.LAUNCHER_AUTOTEST_REMOVE_SKINS_RESULT_FILE),
        JSON.stringify({
          ok:autotestRemoveResult && autotestRemoveResult.ok === true,
          result:autotestRemoveResult,
          snapshot:customSkinDownloadStatePayload(),
        }, null, 2),
        'utf8'
      );
      if (!autotestRemoveResult || !autotestRemoveResult.ok) process.exitCode = 1;
    } catch(e) {
      await fs.promises.writeFile(
        path.resolve(process.env.LAUNCHER_AUTOTEST_REMOVE_SKINS_RESULT_FILE),
        JSON.stringify({ ok:false, error:e.message }, null, 2),
        'utf8'
      );
      process.exitCode = 1;
    }
    app.quit();
    return;
  }
  if (!_customSkins.length && _customSkinIssuedIds.size) {
    try {
      var startupAssignmentReset = trackCustomSkinAssignmentReset(
        [], clearCustomSkinAssignmentSharedObjects(), true);
      startupDiag('empty custom skin library assignment reset', startupAssignmentReset);
    } catch(e) {
      startupDiag('empty custom skin library assignment reset FAILED', { message:e.message });
    }
  }
  try {
    loadLocalCustomSkinReservedIds();
    var localIssuedPruned = pruneNativeDefinitionIdsFromIssuedSet();
    var localSkinMigration = migrateCustomSkinsToSafeIds(_customSkins);
    var localAssignmentChangedIds = customSkinAssignmentStateChanged(_customSkins, localSkinMigration.skins);
    if (localSkinMigration.changed || localIssuedPruned) {
      _customSkins = localSkinMigration.skins;
      saveCustomSkins();
      startupDiag('custom skin ids migrated', { mappings:localSkinMigration.mappings });
    }
    if (localAssignmentChangedIds.length) {
      var localAssignmentReset = trackCustomSkinAssignmentReset(
        localAssignmentChangedIds,
        clearCustomSkinAssignmentSharedObjects(localAssignmentChangedIds),
        false
      );
      startupDiag('custom skin migration assignment reset', localAssignmentReset);
    }
  } catch(e) { startupDiag('migrateCustomSkinsToSafeIds FAILED', { message:e.message }); }
  try { applyCustomSkinsToCoreNet(); } catch(e) { startupDiag('applyCustomSkinsToCoreNet FAILED', { message:e.message }); }
  if (process.env.LAUNCHER_AUTOTEST === '1' &&
      process.env.LAUNCHER_AUTOTEST_SKIN_FOLDER_IMPORT_ROOT &&
      process.env.LAUNCHER_AUTOTEST_SKIN_FOLDER_IMPORT_RESULT_FILE) {
    var folderImportOutput = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_FOLDER_IMPORT_RESULT_FILE);
    try {
      if (!process.env.LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT ||
          !process.env.LAUNCHER_AUTOTEST_USER_DATA_ROOT) {
        throw new Error('isolated user-data and custom-skin roots are required');
      }
      var folderImportScan = await collectCustomSkinFilesAsync(
        path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_FOLDER_IMPORT_ROOT), null);
      var folderImportPackage = await customSkinFolderPackage.discover(folderImportScan);
      await refreshCustomSkinReservedIds();
      var folderImportResult = await importCustomSkinFolderPackage(
        folderImportPackage, null, _customSkinRevision, { skipSupplement:true });
      await fs.promises.writeFile(folderImportOutput, JSON.stringify({
        ok:folderImportResult && folderImportResult.ok === true,
        packageInfo:{ configFile:folderImportPackage.configFile,
          configEntryCount:folderImportPackage.configEntryCount,
          swfCount:folderImportPackage.swfCount },
        result:folderImportResult,
        snapshot:{ revision:_customSkinRevision, skins:customSkinUiEntries(_customSkins) },
      }, null, 2), 'utf8');
      if (!folderImportResult || !folderImportResult.ok) process.exitCode = 1;
    } catch(error) {
      await fs.promises.writeFile(folderImportOutput,
        JSON.stringify({ ok:false, error:error.message, stack:error.stack || '' }, null, 2), 'utf8');
      process.exitCode = 1;
    }
    app.quit();
    return;
  }
  // Verify persisted resources once after startup without blocking Electron's
  // main event loop. UI reads remain pure in-memory snapshots.
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_PROJECTION_WORKER_RESULT_FILE) {
    var projectionWorkerStartedAt = Date.now();
    scheduleCustomSkinProjectionVerification().then(function(published) {
      return fs.promises.writeFile(
        path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_PROJECTION_WORKER_RESULT_FILE),
        JSON.stringify({
          ok:published === true && _customSkinCommittedProjection.inventory.ids.length > 0,
          published:published === true,
          elapsedMs:Date.now() - projectionWorkerStartedAt,
          revision:_customSkinCommittedProjection.revision,
          inventoryCount:_customSkinCommittedProjection.inventory.ids.length,
          uiCount:_customSkinCommittedProjection.uiEntries.length,
        }, null, 2),
        'utf8'
      );
    }).catch(function(error) {
      return fs.promises.writeFile(
        path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_PROJECTION_WORKER_RESULT_FILE),
        JSON.stringify({ ok:false, error:error && error.stack || String(error) }, null, 2),
        'utf8'
      );
    }).finally(function() {
      if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') setTimeout(function() { app.quit(); }, 100);
    });
  } else if (process.env.LAUNCHER_AUTOTEST !== '1') {
    setTimeout(function() { scheduleCustomSkinProjectionVerification(); }, 350);
  }
  var autotestRenumberMode = String(process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_MODE || '').toLowerCase();
  if (process.env.LAUNCHER_AUTOTEST === '1' &&
      (process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_IDS || autotestRenumberMode === 'chain')) {
    setTimeout(function() {
      var testIds = process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_IDS
        ? String(process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_IDS).split(',') : [];
      var testMode = autotestRenumberMode === 'chain' ? 'chain' :
        (process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_TARGETS ? 'custom' : 'sequential');
      renumberCustomSkins({
        skinIds:testIds,
        mode:testMode,
        startId:process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_START || CUSTOM_SKIN_SAFE_ID_MIN,
        targetIds:testMode === 'custom'
          ? String(process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_TARGETS).split(',') : [],
        baseRevision:_customSkinRevision,
      }).then(async function(result) {
        var rollbackResult = null;
        if (result && result.ok === true && process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_ROLLBACK === '1') {
          rollbackResult = await rollbackCustomSkinsFromBackup();
        }
        console.log('[AUTOTEST] custom-skin-renumber ' + JSON.stringify(result));
        if (process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_RESULT_FILE) {
          return fs.promises.writeFile(
            path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_RESULT_FILE),
            JSON.stringify({ result:result, rollbackResult:rollbackResult,
              snapshot:customSkinDownloadStatePayload() }, null, 2),
            'utf8'
          );
        }
      }).catch(function(e) {
        console.log('[AUTOTEST] custom-skin-renumber-error ' + e.message);
        if (process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_RESULT_FILE) {
          return fs.promises.writeFile(
            path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_RESULT_FILE),
            JSON.stringify({ result:{ ok:false, error:e.message } }, null, 2),
            'utf8'
          );
        }
      }).finally(function() {
        if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') {
          setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
        }
      });
    }, 100);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' &&
      process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_IDS &&
      process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_DIR) {
    _seer1DownloadAutotestPending = true;
    startupDiag('autotest skin download begin', {
      ids:process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_IDS,
      resultFile:process.env.LAUNCHER_AUTOTEST_RESULT_FILE || '',
    });
    if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') {
      _seer1DownloadAutotestKeepalive = new BrowserWindow({ show:false, width:1, height:1 });
      _seer1DownloadAutotestKeepalive.loadURL('about:blank');
    }
    _customSkinDownloadDir = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_DIR);
    if (process.env.LAUNCHER_AUTOTEST_SKIN_AUTO_IMPORT === '0') _customSkinAutoImport = false;
    var testDownloadIds = String(process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_IDS).split(',');
    var testDownloadTypes = String(process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_TYPES || 'icon').split(',');
    downloadOfficialCustomSkinModels({
      ids:testDownloadIds,
      types:testDownloadTypes,
      includeSkins:process.env.LAUNCHER_AUTOTEST_SKIN_INCLUDE_OFFICIAL === '1',
      previewOnly:process.env.LAUNCHER_AUTOTEST_SKIN_PREVIEW_ONLY === '1',
      autoImport:process.env.LAUNCHER_AUTOTEST_SKIN_AUTO_IMPORT == null
        ? _customSkinAutoImport === true : process.env.LAUNCHER_AUTOTEST_SKIN_AUTO_IMPORT !== '0',
      forceRefresh:process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_FORCE_REFRESH === '1',
    }, null).then(function(result) {
      startupDiag('autotest skin download resolved', { ok:result && result.ok, completed:result && result.completed });
      console.log('[AUTOTEST] custom-skin-download ' + JSON.stringify(result));
      if (process.env.LAUNCHER_AUTOTEST_RESULT_FILE) {
        return fs.promises.writeFile(
          path.resolve(process.env.LAUNCHER_AUTOTEST_RESULT_FILE),
          JSON.stringify(result, null, 2),
          'utf8'
        );
      }
    }).catch(function(e) {
      startupDiag('autotest skin download rejected', { message:e.message, stack:e.stack || '' });
      console.log('[AUTOTEST] custom-skin-download-error ' + e.message);
      if (process.env.LAUNCHER_AUTOTEST_RESULT_FILE) {
        return fs.promises.writeFile(
          path.resolve(process.env.LAUNCHER_AUTOTEST_RESULT_FILE),
          JSON.stringify({ ok:false, error:e.message, stack:e.stack || '' }, null, 2),
          'utf8'
        );
      }
    }).finally(function() {
      startupDiag('autotest skin download finalized');
      _seer1DownloadAutotestPending = false;
      if (_seer1DownloadAutotestKeepalive && !_seer1DownloadAutotestKeepalive.isDestroyed()) {
        _seer1DownloadAutotestKeepalive.destroy();
      }
      _seer1DownloadAutotestKeepalive = null;
      if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') {
        setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
      }
    });
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_RESULT_FILE) {
    _seer1CatalogAutotestPending = true;
    querySeer1OfficialPetCatalog({
      query:String(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_QUERY || ''),
      category:String(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_CATEGORY || 'pets'),
      page:parseInt(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_PAGE, 10) || 1,
      pageSize:parseInt(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_PAGE_SIZE, 10) || 24,
      fast:process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_FAST !== '0',
    }).then(function(result) {
      return fs.promises.writeFile(
        path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_RESULT_FILE),
        JSON.stringify(result, null, 2),
        'utf8'
      );
    }).catch(function(e) {
      console.log('[AUTOTEST] custom-skin-catalog-error ' + e.message);
    }).finally(function() {
      _seer1CatalogAutotestPending = false;
      if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') setTimeout(function() { app.quit(); }, 150);
    });
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_REFRESH_RESULT_FILE) {
    _seer1CatalogAutotestPending = true;
    refreshSeer1OfficialPetCatalog().then(async function(result) {
      var verifyIds = String(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_VERIFY_IDS || '')
        .split(',').map(parseCustomSkinId).filter(Boolean);
      result.verifyQueries = [];
      for (var verifyIndex = 0; verifyIndex < verifyIds.length; verifyIndex++) {
        var verifyId = verifyIds[verifyIndex];
        var verifyCatalog = await loadSeer1OfficialPetCatalogFast();
        var verifyIsSkin = (verifyCatalog.items || []).some(function(item) {
          return (item.extraSkins || []).some(function(skin) {
            return parseCustomSkinId(skin && skin.resourceId) === verifyId;
          });
        });
        var queryResult = await querySeer1OfficialPetCatalog({
          query:String(verifyId), category:verifyIsSkin ? 'skins' : 'pets', page:1, pageSize:12,
        });
        result.verifyQueries.push({ id:verifyId, result:queryResult });
      }
      return fs.promises.writeFile(
        path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_REFRESH_RESULT_FILE),
        JSON.stringify(result, null, 2),
        'utf8'
      );
    }).catch(function(e) {
      console.log('[AUTOTEST] custom-skin-catalog-refresh-error ' + e.message);
      return fs.promises.writeFile(
        path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_REFRESH_RESULT_FILE),
        JSON.stringify({ ok:false, error:e.message, stack:e.stack || '' }, null, 2),
        'utf8'
      );
    }).finally(function() {
      _seer1CatalogAutotestPending = false;
      if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') {
        setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
      }
    });
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' &&
      process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_PAGINATION_RESULT_FILE) {
    _seer1CatalogAutotestPending = true;
    (async function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_PAGINATION_RESULT_FILE);
      var categories = ['pets', 'skins', 'downloaded'];
      var result = { ok:true, pageSize:60, categories:{} };
      try {
        for (var categoryIndex = 0; categoryIndex < categories.length; categoryIndex++) {
          var categoryName = categories[categoryIndex];
          var first = await querySeer1OfficialPetCatalog({
            category:categoryName, page:1, pageSize:60, fast:true,
          });
          var ids = [];
          for (var pageIndex = 1; pageIndex <= first.pageCount; pageIndex++) {
            var current = pageIndex === 1 ? first : await querySeer1OfficialPetCatalog({
              category:categoryName, page:pageIndex, pageSize:60, fast:true,
            });
            if (current.total !== first.total || current.pageCount !== first.pageCount) {
              throw new Error(categoryName + ' pagination snapshot changed while scanning');
            }
            (current.items || []).forEach(function(item) {
              var id = parseCustomSkinId(item && item.id);
              if (id) ids.push(id);
            });
          }
          var uniqueIds = Array.from(new Set(ids));
          result.categories[categoryName] = {
            total:first.total,
            pageCount:first.pageCount,
            collected:ids.length,
            unique:uniqueIds.length,
            duplicateCount:ids.length - uniqueIds.length,
            firstId:ids.length ? ids[0] : 0,
            lastId:ids.length ? ids[ids.length - 1] : 0,
          };
          if (ids.length !== first.total || uniqueIds.length !== ids.length) result.ok = false;
        }
        await fs.promises.writeFile(outputFile, JSON.stringify(result, null, 2), 'utf8');
      } catch(error) {
        result.ok = false;
        result.error = error && error.stack || String(error);
        await fs.promises.writeFile(outputFile, JSON.stringify(result, null, 2), 'utf8');
      } finally {
        _seer1CatalogAutotestPending = false;
        if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') {
          setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
        }
      }
    })();
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_UCLIENT_PREVIEW_RESULT_FILE) {
    (async function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_UCLIENT_PREVIEW_RESULT_FILE);
      var sourceId = parseCustomSkinId(process.env.LAUNCHER_AUTOTEST_UCLIENT_PREVIEW_ID) || 4931;
      try {
        var query = await querySeer1OfficialPetCatalog({
          query:String(sourceId), category:'pets', page:1, pageSize:12,
        });
        var prepared = await prepareUClientPetPreview(sourceId);
        var item = (query.items || []).find(function(entry) { return Number(entry.id) === sourceId; }) || null;
        await fs.promises.writeFile(outputFile, JSON.stringify({
          ok:prepared && prepared.ok === true,
          sourceId:sourceId,
          catalogItem:item && {
            id:item.id,
            name:item.name,
            uClientAvailable:item.uClientAvailable,
            uClientPackageVersion:item.uClientPackageVersion,
            fightPlayable:item.fightPlayable,
            previewOnly:item.previewOnly === true,
          },
          preview:prepared && prepared.ok ? {
            location:prepared.location,
            stale:prepared.stale,
            packageVersion:prepared.metadata && prepared.metadata.packageVersion,
            actions:prepared.metadata && prepared.metadata.actions,
            atlasUrl:prepared.atlasUrl,
            sequenceCount:prepared.animation && prepared.animation.sequences &&
              Object.keys(prepared.animation.sequences).length,
          } : { error:prepared && prepared.error },
        }, null, 2), 'utf8');
      } catch(error) {
        await fs.promises.writeFile(outputFile,
          JSON.stringify({ ok:false, sourceId:sourceId, error:error.message }, null, 2), 'utf8');
      }
    })();
  }
  setTimeout(function() {
    refreshCustomSkinReservedIds().then(function() {
      var onlineIssuedPruned = pruneNativeDefinitionIdsFromIssuedSet();
      var onlineSkinMigration = migrateCustomSkinsToSafeIds(_customSkins);
      _customSkins = onlineSkinMigration.skins;
      var templateChanged = applyCustomSkinNativeTemplates(_customSkins);
      if (onlineSkinMigration.changed || templateChanged || onlineIssuedPruned) saveCustomSkins();
      applyCustomSkinsToCoreNet();
      notifyCustomSkinsChanged();
      return resolveImportedCustomSkinNames(_customSkins.map(function(entry) { return entry.skinId; }));
    }).then(function() {
      notifyCustomSkinsChanged();
      startupDiag('custom skin catalog applied', {
        nativeTemplates:_customSkins.filter(function(s) { return !!s.nativeTemplateId; }).length,
      });
    }).catch(function(e) {
      startupDiag('refreshCustomSkinReservedIds FAILED', { message:e.message });
    });
  }, 1500);
  startupDiag('stage: custom skins applied', { count:_customSkins.length });

  if (_replaceRules.length === 0) {
    _replaceRules = [
      { url: 'http://43.138.190.6/seer2/module/app/GadSelectPetPanel.swf', file: '.\\复苏纹章by_神秘大佬.swf', label:'复苏纹章', enabled: true },
      { url: 'http://43.138.190.6/seer2/module/app/ItemBagPanel.swf', file: '.\\背包装扮穿戴修复.swf', label:'背包修复', enabled: true },
      { url: 'http://43.138.190.6/seer2/res/map/config/70.xml', file: 'http://seer2.61.com/res/map/config/70.xml', label:'官服传送室配置', enabled: false },
      { url: 'http://43.138.190.6/seer2/module/app/MapPanel.swf', file: 'http://seer2.61.com/module/app/MapPanel.swf', label:'官服地图', enabled: false },
      { url: 'http://43.138.190.6/seer2/res/ui/UI_Arena.swf', file: 'http://seer2.61.com/res/ui/UI_Arena.swf', label:'官服战斗 UI', enabled: false },
    ];
    saveReplaceRules();
  }

  try { applyReplaceRulesToCoreNet(); } catch(e) { startupDiag('applyReplaceRulesToCoreNet FAILED', { message: e.message }); }
  startupDiag('stage: replaceRules applied', { count: _replaceRules.length });
  console.log('[AutoStart] Checking version via Gitee…');
  startupDiag('stage: checkForUpdate begin');
  try {
    await checkForUpdate();
  } catch(e) {
    startupDiag('checkForUpdate threw unexpectedly (availability skip)', { message: e && e.message });
    logWarn('Version', 'check threw unexpectedly, skipped for availability', { error: e && e.message });
  }
  startupDiag('stage: checkForUpdate done');
  try {
    await initBloomRouting();
    startupDiag('stage: initBloomRouting done');
  } catch(e) {
    coreNet.clearBloomRoutes();
    logWarn('Bloom', 'Bloom routing init failed, falling back to legacy route', { error: e.message });
    startupDiag('stage: initBloomRouting failed (fallback ok)', { message: e.message });
  }
  var _postBloomSrv = getSelectedServer();
  if (_postBloomSrv && _postBloomSrv.rootUrl) {
    try { coreNet.setGameBackend(_postBloomSrv.rootUrl); } catch(e) {}
  }
  try { coreNet.loadFilesIntoMemory(__dirname); } catch(e) { startupDiag('loadFilesIntoMemory FAILED', { message: e.message }); }
  startupDiag('stage: loadFilesIntoMemory done');
  try { writeFlashMmsCfg(); } catch(e) { startupDiag('writeFlashMmsCfg FAILED', { message: e.message }); }
  startupDiag('stage: writeFlashMmsCfg done');
  var backgroundOnlyAutotest = process.env.LAUNCHER_AUTOTEST === '1' &&
    process.env.LAUNCHER_AUTOTEST_HEADLESS === '1' &&
    process.env.LAUNCHER_AUTOTEST_CONCURRENT_PREVIEW !== '1' &&
    (!!process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_RESULT_FILE ||
      !!process.env.LAUNCHER_AUTOTEST_SKIN_RENUMBER_RESULT_FILE ||
      !!process.env.LAUNCHER_AUTOTEST_SKIN_FOLDER_IMPORT_RESULT_FILE ||
      !!process.env.LAUNCHER_AUTOTEST_SKIN_CONFIG_IMPORT_RESULT_FILE ||
      !!process.env.LAUNCHER_AUTOTEST_SKIN_PROJECTION_WORKER_RESULT_FILE ||
      (!!process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_IDS && !!process.env.LAUNCHER_AUTOTEST_RESULT_FILE) ||
      !!process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_RESULT_FILE ||
      !!process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_REFRESH_RESULT_FILE ||
      !!process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_PAGINATION_RESULT_FILE ||
      !!process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_CATEGORY_RESULT_FILE ||
      !!process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_RENDER_RESULT_FILE);
  if (!backgroundOnlyAutotest) {
    console.log('[AutoStart] Launching game');
    startupDiag('stage: createGame begin');
    try {
      createGame();
    } catch(e) {
      startupDiag('FATAL: createGame threw', { message: e.message, stack: String(e.stack || '').split(/\r?\n/).slice(0, 15).join(' | ') });
    try { dialog.showErrorBox('启动失败', '创建游戏窗口时出错：\n' + e.message + '\n\n程序将退出。'); } catch(_) {}
    try { app.exit(1); } catch(_) { try { process.exit(1); } catch(__) {} }
      return;
    }
    startupDiag('stage: createGame returned');
  } else {
    startupDiag('stage: createGame skipped for isolated skin preview autotest');
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_TOOL_WINDOWS === '1') {
    setTimeout(function() {
      openCustomSkinToolWindow({ kind:'catalog' });
      openCustomSkinToolWindow({ kind:'preview', id:1, name:'布布种子' });
      openCustomSkinToolWindow({ kind:'download', ids:'1,2', category:'pets' });
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_LIFECYCLE_RESULT_FILE) {
    setTimeout(function() {
      openCustomSkinToolWindow({ kind:'catalog' });
      openCustomSkinToolWindow({ kind:'preview', id:1, name:'布布种子' });
      openCustomSkinToolWindow({ kind:'download', ids:'1', category:'pets', previewOnly:'1' });
      setTimeout(function() {
        if (gameWin && !gameWin.isDestroyed()) gameWin.close();
      }, 650);
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_RENDER_RESULT_FILE) {
    setTimeout(function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_RENDER_RESULT_FILE);
      openCustomSkinToolWindow({ kind:'catalog' });
      var catalogWin = skinToolWins.catalog;
      if (!catalogWin || catalogWin.isDestroyed()) return;
      if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') {
        catalogWin.setPosition(-32000, -32000, false);
        catalogWin.showInactive();
      }
      catalogWin.webContents.once('did-finish-load', function() {
        setTimeout(function() {
          var renderQuery = String(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_RENDER_QUERY || '');
          catalogWin.webContents.executeJavaScript(
            "(async function(){var q=" + JSON.stringify(renderQuery) + ";catalogState.category='pets';updateCatalogCategoryUi();var search=document.getElementById('catalogSearch');if(search)search.value=q;var cachedRefresh=await api.refreshSeer1OfficialPetCatalog({cached:true});await loadPetCatalog(true);await new Promise(function(resolve){setTimeout(resolve,300)});var pageButton=document.getElementById('catalogPageRefresh');var before=downloadedSourceIds.has(199999);var original=Array.from(downloadedSourceIds);applyDownloadState({downloadedIds:original.concat([199999]),queueIds:[]},false);var immediate=downloadedSourceIds.has(199999);applyDownloadState({downloadedIds:original,queueIds:[]},false);var card=document.querySelector('.catalog-card');var buttons=card?Array.from(card.querySelectorAll('.catalog-card-actions button')).map(function(button){return {label:button.textContent,disabled:button.disabled,title:button.title}}):[];var image=card&&card.querySelector('img[data-catalog-head]');return {ok:true,cachedRefresh:cachedRefresh,query:q,category:catalogState.category,total:catalogState.total,names:catalogState.items.map(function(x){return x.name}),availability:[],downloadable:catalogState.items.map(function(x){return x.downloadable}),publicDiscovery:catalogState.items.map(function(x){return x.publicDiscovery}),headUrls:catalogState.items.map(function(x){return x.publicHeadUrl||x.headUrl||''}),headDataUrls:catalogState.items.map(function(x){return String(x.publicHeadDataUrl||'').slice(0,30)}),renderedName:card&&card.querySelector('.catalog-name')&&card.querySelector('.catalog-name').textContent,renderedMeta:card&&card.querySelector('.catalog-meta')&&card.querySelector('.catalog-meta').textContent,buttons:buttons,imageHeadUrl:image&&String(image.dataset.headUrl||'').slice(0,30),imageReady:!!(image&&image.naturalWidth&&image.naturalHeight&&!image.hidden),imageSize:image?{width:image.naturalWidth,height:image.naturalHeight}:null,currentPageRefresh:{present:!!pageButton,label:pageButton&&pageButton.textContent,disabled:pageButton&&pageButton.disabled},downloadStateImmediate:{before:before,afterEvent:immediate,restored:!downloadedSourceIds.has(199999)}}})()"
          ).then(async function(result) {
            var shot = outputFile.replace(/\.json$/i, '.png');
            fs.writeFileSync(shot, (await catalogWin.capturePage()).toPNG());
            result.screenshot = shot;
            fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
            if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') setTimeout(function() { app.quit(); }, 100);
          }).catch(function(error) {
            fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:error.message }, null, 2), 'utf8');
            if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') setTimeout(function() { app.quit(); }, 100);
          });
        }, 500);
      });
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_RESULT_FILE) {
    setTimeout(function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_RESULT_FILE);
      var testLocalId = parseCustomSkinId(process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_LOCAL_ID) || 70091;
      var testSourceId = parseCustomSkinId(process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_SOURCE_ID) || 1;
      var keepActionFullscreen = process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_FULLSCREEN === '1';
      openCustomSkinToolWindow({ kind:'preview', id:testSourceId, localId:testLocalId, name:'动作回归样本',
        uClientAvailable:process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_UClient_AVAILABLE === '1' });
      var previewWin = skinToolWins.preview;
      if (!previewWin || previewWin.isDestroyed()) return;
      if (process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_FORCE_PLUGIN_RELOAD === '1') {
        setTimeout(function() { _killFlashForReload('CustomSkinReload'); }, 1500);
      }
      if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') {
        previewWin.setPosition(-32000, -32000, false);
        previewWin.showInactive();
      }
      var runSkinActionAutotest = function() {
        setTimeout(function() {
          var activePreviewWin = skinToolWins.preview;
          if (!activePreviewWin || activePreviewWin.isDestroyed() || activePreviewWin.webContents.isDestroyed()) {
            fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:'active preview window missing after plugin recovery' }, null, 2), 'utf8');
            if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') setTimeout(function() { app.quit(); }, 100);
            return;
          }
          activePreviewWin.webContents.executeJavaScript(
             "(async function(){var p=document.getElementById('catalogPreviewPlayer'),fv=p&&p.querySelector('param[name=flashvars]'),out={mode:catalogState.previewMode,action:catalogState.previewAction,status:document.getElementById('catalogPreviewStatus').textContent,previewOrigin:previewOrigin,plugins:Array.from(navigator.plugins||[]).map(function(x){return {name:x.name,description:x.description}}),embedType:p&&p.type,flashvars:fv&&fv.value,buttons:Array.from(document.querySelectorAll('[data-preview-action]')).map(function(b){return {action:b.dataset.previewAction,disabled:b.disabled}}),downloadedState:{ids:Array.from(downloadedSourceIds),uClientIds:Array.from(downloadedUClientSourceIds),previewIds:downloadedPreviewEntries().map(function(x){return Number(x.sourceId||x.id)||0})}};try{var r=await fetch(previewOrigin+'/launcher/pet-preview/fight/" + testLocalId + ".swf',{cache:'no-store'});out.modelStatus=r.status;out.modelBytes=(await r.arrayBuffer()).byteLength;var q=await fetch(previewOrigin+'/launcher/skin-preview.swf?v=18',{cache:'no-store'});out.playerStatus=q.status;out.playerBytes=(await q.arrayBuffer()).byteLength;out.actionInfo=await api.getCustomSkinPreviewActions(" + testLocalId + ");out.fullscreen=await api.setCustomSkinToolFullscreen(true);out.windowSize={width:innerWidth,height:innerHeight};p=document.getElementById('catalogPreviewPlayer');if(" + (keepActionFullscreen ? 'true' : 'false') + "){previewFullscreen=true;if(p&&typeof p.setWideView==='function')p.setWideView(true)}if(!" + (keepActionFullscreen ? 'true' : 'false') + ")await api.setCustomSkinToolFullscreen(false)}catch(e){out.error=e.message}return out})()"
          ).then(async function(result) {
            var idleShot = outputFile.replace(/\.json$/i, '-idle.png');
            fs.writeFileSync(idleShot, (await activePreviewWin.capturePage()).toPNG());
            result.idleScreenshot = idleShot;
            var requestedActions = String(process.env.LAUNCHER_AUTOTEST_SKIN_ACTIONS || '').split(',').map(function(value) { return value.trim().toLowerCase(); }).filter(Boolean);
            var actions = requestedActions.length ? requestedActions : ['physical','special','property','skill','ultimate','hurt','lowhp'];
            var actionReadyMs = Math.max(250, parseInt(process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_READY_MS || '250', 10) || 250);
            var actionFrameMs = Math.max(50, parseInt(process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_FRAME_MS || '85', 10) || 85);
            var captureActionFrames = process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_CAPTURE_FRAMES !== '0';
            var actionFrameCount = Math.max(1, Math.min(240,
              parseInt(process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_FRAME_COUNT || '4', 10) || 4));
            result.actionReloads = [];
            for (var i = 0; i < actions.length; i++) {
              var action = actions[i];
              var state = await activePreviewWin.webContents.executeJavaScript(
                "playCatalogAction('" + action + "');new Promise(function(resolve){setTimeout(function(){var p=document.getElementById('catalogPreviewPlayer'),fv=p&&p.querySelector('param[name=flashvars]'),hp=window.catalogUClientPlayer;resolve({action:catalogState.previewAction,status:document.getElementById('catalogPreviewStatus').textContent,flashvars:fv&&fv.value,camera:p&&typeof p.getCameraState==='function'?p.getCameraState():(hp&&typeof hp.getCameraState==='function'?hp.getCameraState():null),active:Array.from(document.querySelectorAll('[data-preview-action].active')).map(function(b){return b.dataset.previewAction})})}," + actionReadyMs + ")})"
              );
              var actionShot = outputFile.replace(/\.json$/i, '-' + action + '.png');
              fs.writeFileSync(actionShot, (await activePreviewWin.capturePage()).toPNG());
              state.screenshot = actionShot;
              if (process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_RESIZE === '1' && i === 0 && activePreviewWin && !activePreviewWin.isDestroyed()) {
                var beforeSize = activePreviewWin.getSize();
                state.resizeProbe = { beforeSize:beforeSize };
                state.resizeProbe.beforeCamera = await activePreviewWin.webContents.executeJavaScript(
                  "(function(){var p=document.getElementById('catalogPreviewPlayer'),hp=window.catalogUClientPlayer;return p&&typeof p.getCameraState==='function'?p.getCameraState():(hp&&typeof hp.getCameraState==='function'?hp.getCameraState():null)})()"
                );
                if (!activePreviewWin.isFullScreen()) activePreviewWin.setSize(beforeSize[0] + 480, beforeSize[1], false);
                await new Promise(function(resolve) { setTimeout(resolve, 650); });
                state.resizeProbe.afterSize = activePreviewWin.getSize();
                state.resizeProbe.afterCamera = await activePreviewWin.webContents.executeJavaScript(
                  "(function(){var p=document.getElementById('catalogPreviewPlayer'),hp=window.catalogUClientPlayer;return p&&typeof p.getCameraState==='function'?p.getCameraState():(hp&&typeof hp.getCameraState==='function'?hp.getCameraState():null)})()"
                );
                var resizedShot = outputFile.replace(/\.json$/i, '-' + action + '-resized.png');
                fs.writeFileSync(resizedShot, (await activePreviewWin.capturePage()).toPNG());
                state.resizeProbe.screenshot = resizedShot;
              }
              state.frames = [];
              for (var frameIndex = 0; captureActionFrames && frameIndex < actionFrameCount; frameIndex++) {
                await new Promise(function(resolve) { setTimeout(resolve, actionFrameMs); });
                var frameBuffer = (await activePreviewWin.capturePage()).toPNG();
                var frameShot = outputFile.replace(/\.json$/i, '-' + action + '-frame-' + frameIndex + '.png');
                fs.writeFileSync(frameShot, frameBuffer);
                var playbackState = await activePreviewWin.webContents.executeJavaScript(
                  "(function(){var p=document.getElementById('catalogPreviewPlayer'),hp=window.catalogUClientPlayer;return p&&typeof p.getPlaybackState==='function'?p.getPlaybackState():(hp&&typeof hp.getPlaybackState==='function'?hp.getPlaybackState():null)})()"
                );
                state.frames.push({ screenshot:frameShot, bytes:frameBuffer.length, playback:playbackState });
              }
              result.actionReloads.push(state);
            }
            fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
            if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') setTimeout(function() { app.quit(); }, 150);
          }).catch(function(error) {
            fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:error.message }, null, 2), 'utf8');
            if (process.env.LAUNCHER_AUTOTEST_HEADLESS === '1') setTimeout(function() { app.quit(); }, 150);
          });
        }, process.env.LAUNCHER_AUTOTEST_HEADLESS === '1'
          ? Math.max(1200, parseInt(process.env.LAUNCHER_AUTOTEST_SKIN_ACTION_INITIAL_WAIT_MS || '1200', 10) || 1200)
          : 6500);
      };
      if (!previewWin.webContents.isLoadingMainFrame()) runSkinActionAutotest();
      else previewWin.webContents.once('did-finish-load', runSkinActionAutotest);
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_THUMBNAIL_RESULT_FILE) {
    setTimeout(async function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_THUMBNAIL_RESULT_FILE);
      var testIds = String(process.env.LAUNCHER_AUTOTEST_SKIN_THUMBNAIL_IDS || '70098,70112')
        .split(',').map(parseCustomSkinId).filter(Boolean);
      var result = { ok:true, thumbnails:[], preview:null, catalogBounds:null };
      try {
        for (var ti = 0; ti < testIds.length; ti++) {
          var thumb = await queueCustomSkinThumbnail({ id:testIds[ti] });
          var image = nativeImage.createFromDataURL(thumb.dataUrl || '');
          result.thumbnails.push({
            id:testIds[ti], ok:!!thumb.ok, cached:!!thumb.cached,
            bytes:Buffer.from(String(thumb.dataUrl || '').split(',')[1] || '', 'base64').length,
            size:image.isEmpty() ? null : image.getSize(),
          });
        }
        var worker = await ensureSkinThumbnailWorker();
        result.worker = await worker.webContents.executeJavaScript(
          "({state:window.__skinThumbState,plugins:Array.from(navigator.plugins||[]).map(function(p){return p.name}),objectCount:document.querySelectorAll('object,embed').length})"
        );
        openCustomSkinToolWindow({ kind:'catalog' });
        var catalogWin = skinToolWins.catalog;
        if (catalogWin && !catalogWin.isDestroyed()) {
          await new Promise(function(resolve) { catalogWin.webContents.once('did-finish-load', resolve); });
          await new Promise(function(resolve) { setTimeout(resolve, 3500); });
          var before = catalogWin.getBounds();
          catalogWin.setBounds({ x:before.x, y:before.y - 60, width:before.width, height:before.height + 60 }, false);
          await new Promise(function(resolve) { setTimeout(resolve, 250); });
          result.catalogBounds = { before:before, after:catalogWin.getBounds(), minimum:catalogWin.getMinimumSize() };
          result.catalogDom = await catalogWin.webContents.executeJavaScript(
            "({objectCount:document.querySelectorAll('.catalog-avatar object,.catalog-avatar embed').length,imgCount:document.querySelectorAll('.catalog-avatar img').length})"
          );
        }
        var previewId = testIds[0] || 70098;
        openCustomSkinToolWindow({ kind:'preview', id:previewId, localId:previewId, name:'thumbnail-regression' });
        var previewWin = skinToolWins.preview;
        if (previewWin && !previewWin.isDestroyed()) {
          await new Promise(function(resolve) { previewWin.webContents.once('did-finish-load', resolve); });
          await new Promise(function(resolve) { setTimeout(resolve, 4500); });
          result.preview = await previewWin.webContents.executeJavaScript(
            "({plugins:Array.from(navigator.plugins||[]).map(function(p){return p.name}),status:(document.getElementById('catalogPreviewStatus')||{}).textContent||'',playerCount:document.querySelectorAll('#catalogPreviewHost object,#catalogPreviewHost embed').length})"
          );
          var shot = outputFile.replace(/\.json$/i, '.png');
          fs.writeFileSync(shot, (await previewWin.capturePage()).toPNG());
          result.preview.screenshot = shot;
        }
      } catch(error) {
        result.ok = false;
        result.error = error && error.stack || String(error);
      }
      fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
      setTimeout(function() { try { app.quit(); } catch(_) {} }, 200);
    }, 350);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_PREVIEW_DOWNLOAD_RESULT_FILE) {
    setTimeout(async function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_PREVIEW_DOWNLOAD_RESULT_FILE);
      try {
        var result = await downloadOfficialCustomSkinModels({
          ids:[2], types:['normal','fight','icon'], includeSkins:false, previewOnly:true,
        });
        var imported = _customSkins.find(function(item) { return parseCustomSkinId(item.sourceId) === 2; });
        var snapshot = coreNet.getCustomSkinSnapshotInfo();
        var port = coreNet.getProxyPort();
        var routeStatus = await new Promise(function(resolve) {
          http.get('http://127.0.0.1:' + port + '/launcher/pet-preview/fight/' + (imported && imported.skinId || 0) + '.swf', function(res) {
            res.resume(); resolve(res.statusCode);
          }).on('error', function() { resolve(0); });
        });
        fs.writeFileSync(outputFile, JSON.stringify({
          ok:!!(result && result.ok), downloaded:(result && result.downloaded || []).length,
          imported:imported ? { skinId:imported.skinId, sourceId:imported.sourceId, enabled:imported.enabled } : null,
          snapshot:snapshot, previewRouteStatus:routeStatus,
          requiresReload:!!(result && result.autoImportResult && result.autoImportResult.requiresReload),
          reloadTimerScheduled:!!_customSkinReloadTimer,
        }, null, 2), 'utf8');
      } catch(error) {
        fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:error.message }, null, 2), 'utf8');
      }
    }, 500);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_PREVIEW_RESULT_FILE) {
    setTimeout(function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_PREVIEW_RESULT_FILE);
      openCustomSkinToolWindow({ kind:'catalog' });
      var catalogWin = skinToolWins.catalog;
      if (!catalogWin || catalogWin.isDestroyed()) return;
      catalogWin.webContents.once('did-finish-load', function() {
        catalogWin.webContents.executeJavaScript(
          "localStorage.setItem('seer1-skin-catalog-state-v3',JSON.stringify({category:'pets',pages:{pets:17,skins:4},query:'5770'}));true"
        ).then(function() {
          if (skinToolWins.catalog === catalogWin) skinToolWins.catalog = null;
          catalogWin.close();
          setTimeout(function() {
            openCustomSkinToolWindow({ kind:'catalog' });
            var restoredWin = skinToolWins.catalog;
            if (!restoredWin || restoredWin.isDestroyed()) return;
            restoredWin.webContents.once('did-finish-load', function() {
              setTimeout(function() {
                Promise.all([
                  restoredWin.webContents.executeJavaScript("({category:catalogState.category,page:catalogState.page,pages:catalogState.pages,query:document.getElementById('catalogSearch').value,title:document.title})"),
                  (async function() {
                    openCustomSkinToolWindow({ kind:'preview', id:1, localId:70091, name:'布布种子' });
                    var previewWin = skinToolWins.preview;
                    if (!previewWin || previewWin.isDestroyed()) return { error:'preview window missing' };
                    await new Promise(function(resolve) { previewWin.webContents.once('did-finish-load', resolve); });
                    await new Promise(function(resolve) { setTimeout(resolve, 150); });
                    var localPreview = await previewWin.webContents.executeJavaScript("({id:catalogState.previewId,localId:catalogState.previewLocalId,mode:catalogState.previewMode,embed:document.getElementById('catalogPreviewPlayer')&&document.getElementById('catalogPreviewPlayer').getAttribute('flashvars')})");
                    previewWin.webContents.send('custom-skin-tool-request', { kind:'preview', id:5789, name:'米特拉王虫' });
                    previewWin.webContents.send('custom-skin-tool-request', { kind:'preview', id:5790, name:'黑月荒兽' });
                    await new Promise(function(resolve) { setTimeout(resolve, 650); });
                    var rapidPreview = await previewWin.webContents.executeJavaScript("({id:catalogState.previewId,name:catalogState.previewName,mode:catalogState.previewMode,title:document.getElementById('catalogPreviewTitle').textContent,callback:catalogState.previewCallback,embed:document.getElementById('catalogPreviewPlayer')&&document.getElementById('catalogPreviewPlayer').getAttribute('flashvars'),downloadedCount:document.getElementById('downloadedPreviewCount').textContent})");
                    return { localPreview:localPreview, rapidPreview:rapidPreview };
                  })(),
                ]).then(function(values) {
                  return fs.promises.writeFile(outputFile, JSON.stringify({ ok:true, persistence:values[0], preview:values[1] }, null, 2), 'utf8');
                }).catch(function(error) {
                  return fs.promises.writeFile(outputFile, JSON.stringify({ ok:false, error:error.message }, null, 2), 'utf8');
                });
              }, 650);
            });
          }, 120);
        });
      });
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_LIBRARY_RESULT_FILE) {
    setTimeout(function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_LIBRARY_RESULT_FILE);
      var fakeCache = path.join(app.getPath('userData'), 'Pepper Data', 'Shockwave Flash',
        'WritableRoot', '#SharedObjects', 'skin-library-autotest', 'skinDefine.sol');
      try {
        fs.mkdirSync(path.dirname(fakeCache), { recursive:true });
        fs.writeFileSync(fakeCache, 'skin-cache-probe', 'utf8');
      } catch(_) {}
      toggleOverlay('skin');
      var skinWin = overlayWins.skin;
      if (!skinWin || skinWin.isDestroyed()) {
        fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:'skin overlay missing' }, null, 2), 'utf8');
        return;
      }
      skinWin.webContents.once('did-finish-load', function() {
        setTimeout(function() {
          var script = [
            '(async function(){',
            'function delay(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}',
            'var card=document.querySelector(".card"),sw=card&&card.querySelector(".switch");',
            'if(!card||!sw)throw new Error("skin card missing");',
            'var key=card.getAttribute("onclick").match(/choose\\(event,\\\'([^\\\']+)/)[1];',
            'var skinId=Number((skins.find(function(s){return keyOf(s)===key})||{}).skinId),original=sw.classList.contains("on"),revisionBefore=revision;',
            'card.click();var selectedCard=document.querySelector(".card");var afterSelect={count:selectedKeys.size,selected:selectedCard.classList.contains("selected"),aria:selectedCard.getAttribute("aria-selected")};',
            'card=document.querySelector(".card");card.click();var afterDeselect={count:selectedKeys.size,selected:document.querySelector(".card").classList.contains("selected")};',
            'sw=document.querySelector(".card .switch");sw.click();await delay(20);document.querySelector(".card .switch").click();await delay(20);document.querySelector(".card .switch").click();',
            'await delay(1700);',
            'var saved=await api.getCustomSkins(),entry=(saved.skins||[]).find(function(s){return Number(s.skinId)===skinId});',
            'var rapid={expected:!original,saved:entry&&entry.enabled!==false,pending:toggleDesiredStates.size,saving:toggleSaving,revision:revision};',
            'document.querySelector(".card .switch").click();await delay(1400);',
            'var restored=await api.getCustomSkins(),restoredEntry=(restored.skins||[]).find(function(s){return Number(s.skinId)===skinId});',
            'var statusNode=document.getElementById("status");return {key:key,skinId:skinId,original:original,revisionBefore:revisionBefore,afterSelect:afterSelect,afterDeselect:afterDeselect,rapid:rapid,restored:restoredEntry&&restoredEntry.enabled!==false,finalPending:toggleDesiredStates.size,finalSaving:toggleSaving,status:statusNode&&statusNode.textContent||""};',
            '})()'
          ].join('');
          skinWin.webContents.executeJavaScript(script).then(async function(result) {
            result.unrelatedCachePreserved = fs.existsSync(fakeCache);
            result.ok = result.afterSelect.count === 1 && result.afterSelect.selected &&
              result.afterDeselect.count === 0 && result.rapid.saved === result.rapid.expected &&
              result.rapid.pending === 0 && result.rapid.saving === false &&
              result.restored === result.original && result.finalPending === 0 &&
              result.finalSaving === false && result.unrelatedCachePreserved;
            var shot = outputFile.replace(/\.json$/i, '.png');
            fs.writeFileSync(shot, (await skinWin.capturePage()).toPNG());
            result.screenshot = shot;
            fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
          }).catch(function(error) {
            fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:error.stack || error.message }, null, 2), 'utf8');
          });
        }, 650);
      });
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' &&
      process.env.LAUNCHER_AUTOTEST_SKIN_WINDOW_FOCUS_RESULT_FILE) {
    setTimeout(async function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_WINDOW_FOCUS_RESULT_FILE);
      var result = { ok:false, steps:[] };
      function snapshot(label) {
        var skinWin = overlayWins.skin;
        var visibleTools = Object.keys(skinToolWins).filter(function(kind) {
          return !!visibleSkinToolWindow(kind);
        });
        result.steps.push({
          label:label,
          activeSkinToolKind:activeSkinToolKind,
          skinVisible:!!(skinWin && !skinWin.isDestroyed() && skinWin.isVisible()),
          visibleTools:visibleTools,
          generation:skinSurfaceGeneration,
        });
      }
      function showTool(kind) {
        var win = skinToolWins[kind];
        if (!win || win.isDestroyed()) throw new Error(kind + ' window missing');
        applySkinToolTopPolicy(kind, win);
        win.show();
        win.focus();
        win.moveTop();
        return win;
      }
      try {
        toggleOverlay('skin');
        await new Promise(function(resolve) { setTimeout(resolve, 550); });
        snapshot('library-opened');
        openCustomSkinToolWindow({ kind:'catalog' });
        var catalog = showTool('catalog');
        await new Promise(function(resolve) { setTimeout(resolve, 1750); });
        snapshot('catalog-after-ready-fallback');
        var unpinnedPassed = !!(overlayWins.skin && !overlayWins.skin.isDestroyed() && overlayWins.skin.isVisible()) &&
          activeSkinToolKind === 'catalog' && catalog.isVisible();

        openCustomSkinToolWindow({ kind:'download', queueView:'1' });
        var download = showTool('download');
        await new Promise(function(resolve) { setTimeout(resolve, 180); });
        snapshot('download-active');
        var downloadPassed = activeSkinToolKind === 'download' && download.isVisible() && !catalog.isVisible();

        openCustomSkinToolWindow({ kind:'preview', id:1, localId:1, name:'focus-test' });
        var preview = showTool('preview');
        await new Promise(function(resolve) { setTimeout(resolve, 180); });
        snapshot('preview-active');
        var previewPassed = activeSkinToolKind === 'preview' && preview.isVisible() && !download.isVisible();

        openCustomSkinToolWindow({ kind:'catalog' });
        catalog = showTool('catalog');
        _bringOverlaysToTop();
        await new Promise(function(resolve) { setTimeout(resolve, 300); });
        snapshot('catalog-restored');
        var restoredPassed = activeSkinToolKind === 'catalog' && catalog.isVisible() &&
          (!skinToolWins.preview || skinToolWins.preview.isDestroyed()) && !download.isVisible();

        result.unpinnedPassed = unpinnedPassed;
        result.downloadPassed = downloadPassed;
        result.previewPassed = previewPassed;
        result.restoredPassed = restoredPassed;
        result.ok = unpinnedPassed && downloadPassed && previewPassed && restoredPassed;
        var shot = outputFile.replace(/\.json$/i, '.png');
        fs.writeFileSync(shot, (await catalog.capturePage()).toPNG());
        result.screenshot = shot;
      } catch(error) {
        result.error = error.stack || error.message;
      }
      fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
      if (!result.ok) process.exitCode = 1;
      setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
    }, 350);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_LAYOUT_RESULT_FILE) {
    setTimeout(function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_LAYOUT_RESULT_FILE);
      toggleOverlay('skin');
      var skinWin = overlayWins.skin;
      if (!skinWin || skinWin.isDestroyed()) {
        fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:'skin overlay missing' }, null, 2), 'utf8');
        return;
      }
      skinWin.setSize(960, 640);
      skinWin.webContents.once('did-finish-load', function() {
        setTimeout(async function() {
          try {
            var metrics = await skinWin.webContents.executeJavaScript([
              '(function(){',
              'function box(selector){var node=document.querySelector(selector);return node?{client:node.clientWidth,scroll:node.scrollWidth,height:node.clientHeight}:null}',
              'function selectedState(){var node=document.querySelector(".card");return {count:selectedKeys.size,selected:!!(node&&node.classList.contains("selected")),active:!!(node&&node.classList.contains("active"))}}',
              'var list=document.querySelector(".list"),content=document.querySelector(".library-content"),previewCalls=[],oldApi=api,card=document.querySelector(".card"),initial=selectedState(),visibleCount=visible().length;',
              'if(card)card.click();var afterSelect=selectedState();card=document.querySelector(".card");if(card)card.click();var afterDeselect=selectedState();var checkbox=document.querySelector(".card input");if(checkbox)checkbox.click();var afterCheckboxSelect=selectedState();checkbox=document.querySelector(".card input");if(checkbox)checkbox.click();var afterCheckboxDeselect=selectedState();var all=el("checkAll");if(all)all.click();var afterSelectAll=selectedKeys.size;all=el("checkAll");if(all)all.click();var afterClearAll=selectedKeys.size;',
              'card=document.querySelector(".card");',
              'api={openCustomSkinToolWindow:function(request){previewCalls.push(request)}};if(card)card.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));var previewRequest=previewCalls[0]||null;previewCalls=[];if(card){card.querySelector("input").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));card.querySelector(".switch").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))}api=oldApi;',
              'var maintenance=el("maintenanceModal"),maintenanceLabels=Array.from(maintenance.querySelectorAll("button strong")).map(function(node){return node.textContent.trim()});showModal("maintenanceModal");hideModal("maintenanceModal");',
              'var resourceChips=Array.from(document.querySelectorAll(".card:first-of-type .resource-chip")).map(function(node){return node.textContent.trim()});var remoteNodes=document.querySelectorAll("#remoteModal,#remoteUrls,[onclick*=\\"remoteModal\\"],[onclick*=\\"importUrls\\"]").length;var filterKeys=Array.from(document.querySelectorAll("[data-filter]")).map(function(node){return node.dataset.filter}).join();',
              'return {quick:box(".quickbar"),filters:box(".filterbar"),batch:box(".batchbar"),content:box(".library-content"),list:{client:list.clientHeight,scroll:list.scrollHeight},cards:document.querySelectorAll(".card").length,visibleCount:visibleCount,initial:initial,selection:el("selectionText").textContent,hasSidebar:!!document.querySelector(".sidebar"),afterSelect:afterSelect,afterDeselect:afterDeselect,afterCheckboxSelect:afterCheckboxSelect,afterCheckboxDeselect:afterCheckboxDeselect,afterSelectAll:afterSelectAll,afterClearAll:afterClearAll,previewRequest:previewRequest,blockedControlPreviewRequests:previewCalls.length,maintenanceSections:maintenance.querySelectorAll(".maintenance-section").length,maintenanceLabels:maintenanceLabels,registrationCleanupIsPrecise:String(clearRegistrations).indexOf("clearCustomSkinBindings")<0,resourceChips:resourceChips,legacyResourceDots:document.querySelectorAll(".resource-dots,.dot").length,remoteNodes:remoteNodes,remoteApi:typeof api.importCustomSkinUrls,filterKeys:filterKeys};',
              '})()'
            ].join(''));
            metrics.ok = metrics.quick && metrics.filters && metrics.batch && metrics.content &&
              metrics.quick.scroll <= metrics.quick.client + 1 &&
              metrics.filters.scroll <= metrics.filters.client + 1 &&
              metrics.batch.scroll <= metrics.batch.client + 1 &&
              !metrics.hasSidebar && metrics.cards > 0 && metrics.cards <= 40 && metrics.previewRequest &&
              metrics.initial.count === 0 && !metrics.initial.selected && !metrics.initial.active &&
              metrics.afterSelect.count === 1 && metrics.afterSelect.selected &&
              metrics.afterDeselect.count === 0 && !metrics.afterDeselect.selected && !metrics.afterDeselect.active &&
              metrics.afterCheckboxSelect.count === 1 && metrics.afterCheckboxSelect.selected &&
              metrics.afterCheckboxDeselect.count === 0 && !metrics.afterCheckboxDeselect.selected && !metrics.afterCheckboxDeselect.active &&
              metrics.afterSelectAll === metrics.visibleCount && metrics.afterClearAll === 0 &&
              metrics.maintenanceSections === 1 && metrics.registrationCleanupIsPrecise &&
              metrics.maintenanceLabels.join('|') ===
                '清除全部皮肤绑定缓存|移除全部注册（保留文件）|清空所有并彻底删除文件' &&
              metrics.resourceChips.length === 3 && metrics.resourceChips[0] === '战斗' &&
              metrics.resourceChips[1] === '跟随' && metrics.resourceChips[2].indexOf('展示') === 0 &&
              metrics.legacyResourceDots === 0 && metrics.remoteNodes === 0 && metrics.remoteApi === 'undefined' &&
              metrics.filterKeys === 'all,downloaded,enabled,ultimate' &&
              metrics.previewRequest.kind === 'preview' && Number(metrics.previewRequest.localId) > 0 &&
              metrics.blockedControlPreviewRequests === 0;
            await new Promise(function(resolve) { setTimeout(resolve, 180); });
            var shot = outputFile.replace(/\.json$/i, '.png');
            fs.writeFileSync(shot, (await skinWin.capturePage()).toPNG());
            metrics.screenshot = shot;
            fs.writeFileSync(outputFile, JSON.stringify(metrics, null, 2), 'utf8');
          } catch(error) {
            fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:error.stack || error.message }, null, 2), 'utf8');
          }
          setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
        }, 650);
      });
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_CACHE_PRESERVE_RESULT_FILE) {
    setTimeout(async function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_CACHE_PRESERVE_RESULT_FILE);
      var probeFile = path.join(GAME_CACHE_DIR, 'unrelated-cache-probe.bin');
      var expected = Buffer.from('unrelated-game-cache-must-survive-skin-reload', 'utf8');
      try {
        fs.mkdirSync(GAME_CACHE_DIR, { recursive:true });
        if (!fs.existsSync(probeFile)) fs.writeFileSync(probeFile, expected);
        await doCustomSkinReload();
        setTimeout(function() {
          try {
            var indexed = coreNet.getCacheList().some(function(entry) {
              return entry && (entry.diskName === 'unrelated-cache-probe.bin' || entry.name === 'unrelated-cache-probe.bin');
            });
            var exists = fs.existsSync(probeFile);
            var unchanged = exists && fs.readFileSync(probeFile).equals(expected);
            var result = { ok:exists && unchanged && indexed, exists:exists, unchanged:unchanged, indexed:indexed, cacheDir:GAME_CACHE_DIR };
            fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
          } catch(error) {
            fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:error.stack || error.message }, null, 2), 'utf8');
          }
          setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
        }, 850);
      } catch(error) {
        fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:error.stack || error.message }, null, 2), 'utf8');
        setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
      }
    }, 500);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_STATE_RESULT_FILE) {
    setTimeout(function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_STATE_RESULT_FILE);
      _customSkinDownloadQueueIds = [];
      saveCustomSkinDownloadSettings();
      openCustomSkinToolWindow({ kind:'catalog' });
      var catalogWin = skinToolWins.catalog;
      if (!catalogWin || catalogWin.isDestroyed()) {
        fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:'catalog window missing' }, null, 2), 'utf8');
        return;
      }
      catalogWin.webContents.once('did-finish-load', function() {
        setTimeout(function() {
          var script = [
            '(async function(){',
            'function delay(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}',
            'catalogState.loadGeneration++;catalogState.items=[{id:4871,name:"测试精灵 A",extraSkins:[],availabilityStatus:"battle-verified",fightAvailable:true,normalAvailable:true},{id:4872,name:"测试精灵 B",extraSkins:[],availabilityStatus:"battle-verified",fightAvailable:true,normalAvailable:true}];',
            'applyDownloadState({queueIds:[],downloadedIds:[]},true);renderPetCatalog();',
            'var initial={queueDisabled:el("catalogCompleteQueue").disabled,downloadDisabled:el("catalogCompleteDownload").disabled};',
            'await putCatalogId(4871);',
            'var added={queue:downloadQueueIds(),cardButtons:Array.from(document.querySelectorAll(".catalog-card-actions button:nth-child(2)")).map(function(b){return b.textContent}),queueDisabled:el("catalogCompleteQueue").disabled,downloadDisabled:el("catalogCompleteDownload").disabled};',
            'el("downloadIds").value="";syncDownloadQueueFromTextarea();await delay(300);var cleared=await api.getCustomSkinDownloadSettings();',
            'var downloadedSampleId=Number((cleared.downloadedIds||[])[0]||0);clearTimeout(catalogState.downloadedRefreshTimer);catalogState.items=[{id:downloadedSampleId,name:"已下载真实样本",extraSkins:[],availabilityStatus:"battle-verified",fightAvailable:true,normalAvailable:true,uClientAvailable:true}];applyDownloadState(cleared,true);clearTimeout(catalogState.downloadedRefreshTimer);renderPetCatalog();',
            'var downloaded={cardButtons:Array.from(document.querySelectorAll(".catalog-card-actions button:nth-child(3)")).map(function(b){return b.textContent}),cardDisabled:Array.from(document.querySelectorAll(".catalog-card-actions button:nth-child(3)")).map(function(b){return b.disabled}),pageDownload:el("catalogPageDownload").textContent,queueDisabled:el("catalogCompleteQueue").disabled,downloadDisabled:el("catalogCompleteDownload").disabled};',
            'var oldSkins=skins,oldFilter=filter;filter="downloaded";var downloadedVisible=visible().length;skins=oldSkins;filter=oldFilter;',
            'return {initial:initial,added:added,cleared:cleared,downloaded:downloaded,downloadedVisible:downloadedVisible};',
            '})()'
          ].join('');
          catalogWin.webContents.executeJavaScript(script).then(async function(result) {
            result.ok = result.initial.queueDisabled && result.initial.downloadDisabled &&
              result.added.queue.length === 1 && result.added.queue[0] === 4871 &&
              result.added.cardButtons[0] === '取消加入' && !result.added.queueDisabled && !result.added.downloadDisabled &&
              result.cleared && result.cleared.ok && result.cleared.queueIds.length === 0 &&
              result.downloaded.cardButtons[0] === '重新下载' &&
              result.downloaded.cardDisabled[0] === false &&
              result.downloaded.queueDisabled && result.downloaded.downloadDisabled && result.downloadedVisible === 1;
            var shot = outputFile.replace(/\.json$/i, '.png');
            fs.writeFileSync(shot, (await catalogWin.capturePage()).toPNG());
            result.screenshot = shot;
            fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
          }).catch(function(error) {
            fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:error.stack || error.message }, null, 2), 'utf8');
          }).finally(function() {
            setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
          });
        }, 650);
      });
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_UI_RESULT_FILE) {
    setTimeout(function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_UI_RESULT_FILE);
      openCustomSkinToolWindow({ kind:'download', queueView:'1' });
      var firstWin = skinToolWins.download;
      if (!firstWin || firstWin.isDestroyed()) {
        fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:'download window missing' }, null, 2), 'utf8');
        return;
      }
      firstWin.webContents.once('did-finish-load', function() {
        setTimeout(async function() {
          var result = {};
          try {
            firstWin.webContents.send('custom-skin-download-progress', {
              state:'transfer', id:4871, type:'fight', label:'战斗模型', completed:0, total:3,
              receivedBytes:524288, totalBytes:1048576, speedBytesPerSecond:262144,
            });
            await new Promise(function(resolve) { setTimeout(resolve, 80); });
            result.transferText = await firstWin.webContents.executeJavaScript('el("downloadProgress").textContent');
            await firstWin.webContents.executeJavaScript([
              '(async function(){',
              'api=Object.assign({},api,{downloadOfficialCustomSkinModels:async function(){return {ok:true,downloaded:[{id:4871,type:"fight"}],failed:[],unavailable:[],pending:[],completed:1,total:1}}});',
              'await runDownload({ids:[4871],types:["fight"],autoClose:true});',
              'return true;',
              '})()'
            ].join(''));
            await new Promise(function(resolve) { setTimeout(resolve, 700); });
            var firstContentsId = firstWin.webContents.id;
            result.successHidden = !!skinToolWins.download && !skinToolWins.download.isDestroyed() && !skinToolWins.download.isVisible();

            openCustomSkinToolWindow({ kind:'download', queueView:'1' });
            var errorWin = skinToolWins.download;
            result.reusedWebContents = !!errorWin && !errorWin.isDestroyed() && errorWin.webContents.id === firstContentsId;
            if (errorWin.webContents.isLoadingMainFrame()) {
              await new Promise(function(resolve) { errorWin.webContents.once('did-finish-load', resolve); });
            }
            await new Promise(function(resolve) { setTimeout(resolve, 120); });
            await errorWin.webContents.executeJavaScript([
              '(async function(){',
              'api=Object.assign({},api,{downloadOfficialCustomSkinModels:async function(){return {ok:false,error:"模拟下载失败",downloaded:[],failed:[{id:4872,type:"fight",error:"模拟下载失败",retryable:true}],unavailable:[],pending:[],completed:0,total:1}}});',
              'await runDownload({ids:[4872],types:["fight"],autoClose:true});',
              'return {progress:el("downloadProgress").textContent,errors:el("downloadErrors").textContent};',
              '})()'
            ].join(''));
            await new Promise(function(resolve) { setTimeout(resolve, 700); });
            result.errorStayed = !!skinToolWins.download && !skinToolWins.download.isDestroyed();
            result.errorText = result.errorStayed
              ? await skinToolWins.download.webContents.executeJavaScript('({progress:el("downloadProgress").textContent,errors:el("downloadErrors").textContent})')
              : {};
            result.ok = /512(?:\.0)? KB/.test(result.transferText) && /256(?:\.0)? KB\/s/.test(result.transferText) &&
              result.successHidden && result.reusedWebContents && result.errorStayed && /模拟下载失败/.test(result.errorText.progress || '');
            if (result.errorStayed) {
              var shot = outputFile.replace(/\.json$/i, '.png');
              fs.writeFileSync(shot, (await skinToolWins.download.capturePage()).toPNG());
              result.screenshot = shot;
            }
          } catch(error) {
            result.ok = false;
            result.error = error && error.stack || String(error);
          }
          fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
          setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
        }, 350);
      });
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_CONTINUITY_RESULT_FILE) {
    setTimeout(function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_CONTINUITY_RESULT_FILE);
      openCustomSkinToolWindow({ kind:'download', queueView:'1' });
      var firstWin = skinToolWins.download;
      if (!firstWin || firstWin.isDestroyed()) {
        fs.writeFileSync(outputFile, JSON.stringify({ ok:false, error:'download window missing' }, null, 2), 'utf8');
        return;
      }
      firstWin.webContents.once('did-finish-load', function() {
        setTimeout(async function() {
          var result = {};
          try {
            _customSkinDownloadRunning = true;
            beginCustomSkinDownloadTask({ ids:[4871, 4872], types:['fight'] }, 2, 'D:\\autotest-downloads');
            sendCustomSkinDownloadProgress(firstWin.webContents, {
              state:'transfer', id:4871, type:'fight', label:'战斗模型', completed:0, total:2,
              directory:'D:\\autotest-downloads', receivedBytes:262144, totalBytes:1048576,
              speedBytesPerSecond:131072,
            });
            var taskId = _customSkinDownloadTask.id;
            firstWin.destroy();
            await new Promise(function(resolve) { setTimeout(resolve, 120); });
            openCustomSkinToolWindow({ kind:'download', queueView:'1' });
            var restoredWin = skinToolWins.download;
            await new Promise(function(resolve) { restoredWin.webContents.once('did-finish-load', resolve); });
            await new Promise(function(resolve) { setTimeout(resolve, 350); });
            result.runningView = await restoredWin.webContents.executeJavaScript('({text:el("downloadProgress").textContent,busy:busy})');
            result.sameTask = !!(_customSkinDownloadTask && _customSkinDownloadTask.id === taskId && _customSkinDownloadTask.running);
            var completedResult = {
              ok:true, directory:'D:\\autotest-downloads',
              downloaded:[{ id:4871, type:'fight' }, { id:4872, type:'fight' }],
              failed:[], unavailable:[], pending:[], completed:2, total:2,
            };
            _customSkinDownloadRunning = false;
            finishCustomSkinDownloadTask(completedResult, null, 2, 2, 'D:\\autotest-downloads');
            sendCustomSkinDownloadProgress(restoredWin.webContents, {
              state:'finished', outcome:'completed', completed:2, total:2, directory:'D:\\autotest-downloads', error:'',
            });
            await new Promise(function(resolve) { setTimeout(resolve, 350); });
            result.completedView = await restoredWin.webContents.executeJavaScript('({text:el("downloadProgress").textContent,busy:busy})');
            result.ok = result.sameTask && result.runningView.busy && /4871/.test(result.runningView.text) &&
              !result.completedView.busy && /成功 2/.test(result.completedView.text);
          } catch(error) {
            result.ok = false;
            result.error = error && error.stack || String(error);
          }
          fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
          setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
        }, 300);
      });
    }, 250);
  }
  if (process.env.LAUNCHER_AUTOTEST === '1' && process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_CATEGORY_RESULT_FILE) {
    setTimeout(async function() {
      var outputFile = path.resolve(process.env.LAUNCHER_AUTOTEST_SKIN_CATALOG_CATEGORY_RESULT_FILE);
      var missingHeadUrl = String(process.env.LAUNCHER_AUTOTEST_CATALOG_HEAD_MISSING_URL || 'http://127.0.0.1:9/catalog-head-missing.png');
      var result = { ok:false };
      try {
        result.petQuery = await querySeer1OfficialPetCatalog({ category:'pets', query:'1', page:1, pageSize:12 });
        result.tigerQuery = await querySeer1OfficialPetCatalog({ category:'skins', query:'1400310', page:1, pageSize:12 });
        openCustomSkinToolWindow({ kind:'catalog' });
        var catalogWin = skinToolWins.catalog;
        if (!catalogWin || catalogWin.isDestroyed()) throw new Error('catalog window missing');
        if (catalogWin.webContents.isLoading()) await new Promise(function(resolve) {
          catalogWin.webContents.once('did-finish-load', resolve);
        });
        result.thumbnailFlow = await catalogWin.webContents.executeJavaScript([
          '(async function(){',
          'ensureCatalogCategoryTabs();await loadPetCatalog(false,true);',
          'for(var i=0;i<100&&!document.querySelector(".catalog-avatar img[data-thumb-ready=\\"1\\"]");i++)await new Promise(function(resolve){setTimeout(resolve,50)});',
          'var officialReady=document.querySelectorAll(".catalog-avatar img[data-thumb-ready=\\"1\\"]").length;',
          'var image=document.querySelector(".catalog-avatar img[data-catalog-head]");',
          'if(!image)return {officialReady:officialReady,fallbackReady:false,error:"catalog image missing"};',
          'clearCatalogHeadTimer(image);delete image.dataset.lazyLoaded;delete image.dataset.baseTried;delete image.dataset.fallbackTried;delete image.dataset.thumbReady;delete image.dataset.fallbackReady;',
          'image.dataset.headUrl='+JSON.stringify(missingHeadUrl)+';image.dataset.baseId=image.dataset.id;image.removeAttribute("src");var fallbackStarted=performance.now();loadCatalogHead(image);',
          'for(var j=0;j<100&&image.dataset.fallbackReady!=="1";j++)await new Promise(function(resolve){setTimeout(resolve,50)});',
          'var fallbackDetectedMs=Math.round(performance.now()-fallbackStarted);',
          'if(image.dataset.fallbackReady==="1"&&typeof image.decode==="function")try{await image.decode()}catch(_){}',
          'await new Promise(function(resolve){requestAnimationFrame(function(){requestAnimationFrame(resolve)})});',
          'return {officialReady:officialReady,fallbackReady:image.dataset.fallbackReady==="1",fallbackSrc:String(image.getAttribute("src")||""),fallbackVisible:!image.hidden,fallbackReason:String(image.dataset.fallbackReason||""),fallbackDetectedMs:fallbackDetectedMs,fallbackVisualMs:Math.round(performance.now()-fallbackStarted)};',
          '})()'
        ].join(''));
        result.renderer = await catalogWin.webContents.executeJavaScript([
          '(function(){',
          'var card=document.querySelector(".catalog-card");',
          'return {tabs:Array.from(document.querySelectorAll(".catalog-tabs button")).map(function(b){return b.textContent.trim()}),flags:document.querySelectorAll(".catalog-flag").length,queueDisabled:!!(card&&card.querySelector("[data-catalog-queue]").disabled),downloadDisabled:!!(card&&card.querySelector("[data-catalog-download]").disabled),thumbnailReady:document.querySelectorAll(".catalog-avatar img[data-thumb-ready=\\"1\\"]").length,thumbnailIpcReferenced:String(catalogHeadError).indexOf("getCustomSkinThumbnail")>=0};',
          '})()'
        ].join(''));
        result.ok = result.petQuery.ok && result.petQuery.total >= 1 &&
          result.tigerQuery.ok && result.tigerQuery.total === 1 &&
          result.tigerQuery.items[0].id === 1400310 && result.tigerQuery.items[0].historicalFlashOnly === true &&
          result.renderer.tabs.length === 3 && result.renderer.flags === 0 &&
          !result.renderer.queueDisabled && !result.renderer.downloadDisabled &&
          result.thumbnailFlow.officialReady >= 1 && result.thumbnailFlow.fallbackReady && result.thumbnailFlow.fallbackVisible &&
          (result.thumbnailFlow.fallbackReason === 'load-error' || result.thumbnailFlow.fallbackReason === 'timeout') &&
          result.thumbnailFlow.fallbackDetectedMs < 1000 &&
          /catalog-avatar-fallback\.png(?:[?#].*)?$/i.test(result.thumbnailFlow.fallbackSrc) &&
          result.renderer.thumbnailReady >= 1 && !result.renderer.thumbnailIpcReferenced;
        var shot = outputFile.replace(/\.json$/i, '.png');
        fs.writeFileSync(shot, (await catalogWin.capturePage()).toPNG());
        result.screenshot = shot;
      } catch(error) {
        result.error = error && error.stack || String(error);
      }
      fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
      setTimeout(function() { try { app.quit(); } catch(_) {} }, 150);
    }, 250);
  }
  _autoStartPending = false;
}).catch(function(fatalErr) {
  try {
    startupDiag('FATAL: whenReady chain rejected', {
      message: (fatalErr && fatalErr.message) ? fatalErr.message : String(fatalErr),
      stack: (fatalErr && fatalErr.stack) ? String(fatalErr.stack).split(/\r?\n/).slice(0, 20).join(' | ') : '',
    });
  } catch(_) {}
  try {
    dialog.showErrorBox(
      '启动失败',
      '启动过程中发生异常，程序将退出。\n\n' +
      '错误：' + ((fatalErr && fatalErr.message) ? fatalErr.message : String(fatalErr)) + '\n\n' +
      '详细日志已写入：\n' + (_startupCrashLogPath || '(logging failed)')
    );
  } catch(_) {}
  try { app.exit(1); } catch(_) { try { process.exit(1); } catch(__) {} }
});
app.on('before-quit', function() { _cleanupForAppExit('BeforeQuit'); /* 文件锁已废弃，无需解锁 */ });
try {
  app.on('child-process-gone', function(_e, details) {
    startupDiag('child-process-gone', { type: details && details.type, reason: details && details.reason, exitCode: details && details.exitCode });
  });
} catch(_) {}
try {
  app.on('render-process-gone', function(_e, _webContents, details) {
    startupDiag('render-process-gone', { reason: details && details.reason, exitCode: details && details.exitCode });
  });
} catch(_) {}
app.on('window-all-closed', function() {
  startupDiag('window-all-closed', {
    autoStartPending:_autoStartPending,
    catalogPending:_seer1CatalogAutotestPending,
    downloadPending:_seer1DownloadAutotestPending,
    keepalive:!!(_seer1DownloadAutotestKeepalive && !_seer1DownloadAutotestKeepalive.isDestroyed()),
  });
  if (_autoStartPending) return;
  if (_seer1CatalogAutotestPending || _seer1DownloadAutotestPending) return;
  if (gameWin && !gameWin.isDestroyed()) return;
  app.quit();
});




ipcMain.on('skin-ui-ready', function(event) {
  var senderId = event.sender.id;
  skinUiReadyWebContents.add(senderId);
  var skinWin = overlayWins.skin;
  if (skinWin && !skinWin.isDestroyed() && skinWin.webContents.id === senderId &&
      !skinWin.isVisible() && skinOverlayVisibility.shouldShow() &&
      !visibleSkinToolWindow(activeSkinToolKind)) {
    if (skinWin.__skinReadyFallbackTimer) {
      clearTimeout(skinWin.__skinReadyFallbackTimer);
      skinWin.__skinReadyFallbackTimer = null;
    }
    skinWin.show();
    try { skinWin.focus(); } catch(_) {}
    try { skinWin.moveTop(); } catch(_) {}
  }
  Object.keys(skinToolWins).forEach(function(kind) {
    var win = skinToolWins[kind];
    if (!win || win.isDestroyed() || win.webContents.id !== senderId ||
        activeSkinToolKind !== kind || process.env.LAUNCHER_AUTOTEST === '1') return;
    if (win.__skinReadyFallbackTimer) {
      clearTimeout(win.__skinReadyFallbackTimer);
      win.__skinReadyFallbackTimer = null;
    }
    applySkinToolTopPolicy(kind, win);
    win.show();
    win.focus();
    win.moveTop();
  });
});

ipcMain.on('hide-self', function(event) {
  Object.keys(overlayWins).forEach(function(name) {
    var w = overlayWins[name];
    if (!w || w.isDestroyed()) return;
    if (w.webContents.id === event.sender.id) {
      if (name === 'scanner' || name === 'skin') {
        if (name === 'skin') skinOverlayVisibility.requestClose();
        if (name === 'skin') {
          if (!_overlayClosing[name]) {
            _overlayClosing[name] = true;
            saveOneOverlayBounds(name, w);
            disposeSkinThumbnailWorker();
            w.close();
          }
        } else if (w.isVisible()) {
          w.hide();
        }
      } else {
        if (!_overlayClosing[name]) {
          _overlayClosing[name] = true;
          saveOneOverlayBounds(name, w);
          w.close();
        }
      }
    }
  });
  Object.keys(skinToolWins).forEach(function(kind) {
    var w = skinToolWins[kind];
    if (w && !w.isDestroyed() && w.webContents.id === event.sender.id) {
      saveSkinToolBounds(kind, w);
      if (kind !== 'preview' || (kind === 'download' && _customSkinDownloadRunning)) {
        w.hide();
        if (activeSkinToolKind === kind) activeSkinToolKind = '';
        return;
      }
      skinToolWins[kind] = null;
      skinToolPinState[kind] = false;
      if (activeSkinToolKind === kind) activeSkinToolKind = '';
      w.close();
    }
  });
});
ipcMain.on('minimize-self', function(event) {
  Object.keys(overlayWins).forEach(function(name) {
    var w = overlayWins[name];
    if (!w || w.isDestroyed()) return;
    if (w.webContents.id === event.sender.id) {
      if (!w.isMinimized()) w.minimize();
    }
  });
  Object.keys(skinToolWins).forEach(function(kind) {
    var w = skinToolWins[kind];
    if (w && !w.isDestroyed() && w.webContents.id === event.sender.id && !w.isMinimized()) w.minimize();
  });
});
ipcMain.on('launch-game',         () => createGame());
ipcMain.on('overlay-reload',      () => { doReload().catch(function(e) { logWarn('Reload', 'reload request failed: ' + String(e && e.message || e)); }); });
ipcMain.on('overlay-clear-cache-reload', () => { doClearCacheAndReload().catch(function(e) { logWarn('ClearReload', 'clear-cache reload request failed: ' + String(e && e.message || e)); }); });
ipcMain.on('restart-launcher',    () => {
  // app.relaunch() schedules one replacement process; app.exit() is used
  // instead of app.quit() so a quality-panel save cannot trigger two starts.
  try { app.relaunch(); app.exit(0); }
  catch(e) { logWarn('Restart', 'launcher relaunch failed: ' + String(e && e.message || e)); try { app.quit(); } catch(_) {} }
});
ipcMain.on('game-window-click',   function() {
  closeAllImageWins(false);
  closeUnpinnedOverlays();
});
ipcMain.on('overlay-set-pinned',  function(event, pinned) {
  var NEEDS_KEYBOARD = new Set(['scanner','replace','proxy','skin']);
  Object.keys(overlayWins).forEach(function(name) {
    var w = overlayWins[name];
    if (!w || w.isDestroyed() || w.webContents.id !== event.sender.id) return;
    overlayPinState[name] = !!pinned;
    if (pinned) {
      w.setAlwaysOnTop(true, _alwaysOnTop ? 'screen-saver' : 'pop-up-menu');
      if (!NEEDS_KEYBOARD.has(name)) {
        w.setFocusable(false);
      }
    } else {
      w.setFocusable(true);
      if (_alwaysOnTop) {
        w.setAlwaysOnTop(true, 'pop-up-menu');
      } else {
        w.setAlwaysOnTop(false);
      }
    }
    if (name === 'skin' && activeSkinToolKind) {
      applySkinToolTopPolicy(activeSkinToolKind, skinToolWins[activeSkinToolKind]);
    }
  });
  Object.keys(skinToolWins).forEach(function(kind) {
    var w = skinToolWins[kind];
    if (!w || w.isDestroyed() || w.webContents.id !== event.sender.id) return;
    skinToolPinState[kind] = !!pinned;
    w.setFocusable(true);
    applySkinToolTopPolicy(kind, w);
  });
});
ipcMain.on('close-app',           () => app.quit());
ipcMain.on('clipboard-write',     (_, text) => clipboard.writeText(String(text)));
ipcMain.on('image-win-pinned',    function(event, pinned) {
  Object.keys(_imageWins).forEach(function(k) {
    var w = _imageWins[k];
    if (!w || w.isDestroyed() || w.webContents.id !== event.sender.id) return;
    _imageWinPins[k] = !!pinned;
    try { w.setFocusable(true); } catch(_) {}
    if (pinned) {
      w.setAlwaysOnTop(true, _alwaysOnTop ? 'screen-saver' : 'pop-up-menu');
    } else {
      if (_alwaysOnTop) {
        w.setAlwaysOnTop(true, 'pop-up-menu');
      } else {
        w.setAlwaysOnTop(false);
      }
    }
  });
});
ipcMain.on('open-external',       (_, url) => shell.openExternal(url));

ipcMain.handle('clipboard-write', (_, text) => { clipboard.writeText(String(text)); return true; });

ipcMain.handle('open-cache-folder', function(_, dirPath) {
  try {
    require('electron').shell.showItemInFolder(dirPath || coreNet.getCacheDir());
  } catch(e) { /* 静默失败 */ }
});

ipcMain.handle('open-cache-file', function(_, filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      require('electron').shell.showItemInFolder(filePath);
    } else {
      require('electron').shell.showItemInFolder(coreNet.getCacheDir());
    }
  } catch(e) {}
});

ipcMain.handle('get-cache-list', function() {
  try {
    var items = coreNet.getCacheList();
    var dir   = coreNet.getCacheDir();
    items = items.map(function(item) {
      return Object.assign({}, item, { url: rewriteUrlForCurrentServer(item.url) });
    });
    var hits  = items.reduce(function(s, i) { return s + (i.hitCount || 0); }, 0);
    return { ok: true, items: items, dir: dir, sessionHits: hits };
  } catch(e) { return { ok: false, error: e.message, items: [], dir: '' }; }
});

ipcMain.handle('delete-cache-items', function(_, hashes) {
  try {
    if (!Array.isArray(hashes) || !hashes.length) return { ok: false, error: 'no hashes' };
    return coreNet.deleteCacheItems(hashes);
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('clear-all-cache', function() {
  try { return coreNet.clearAllCache(); }
  catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('clear-cache-reload', async function() {
  return await doClearCacheAndReload();
});
ipcMain.handle('clear-cache-only', async function() {
  if (!gameWin||gameWin.isDestroyed()) return {ok:false,error:'游戏未运行'};
  try { await gameWin.webContents.session.clearCache(); await gameWin.webContents.session.clearStorageData({ storages:['localstorage','sessionstorage','indexdb','caches'] }); return {ok:true}; }
  catch(e) { return {ok:false,error:e.message}; }
});
var _lastNewScanHitCap = false;
var _lastNewScanValue  = null;
var _lastNewScanType   = null;

ipcMain.handle('mem-scan-new', async function(_, data) {
  if (!gameRenderPid) return { ok:false, error:'游戏未运行，请先启动游戏' };

  refreshPpapiPid();
  if (!cachedPpapiPid) {
    await refreshPpapiPidViaDll();
  }
  if (!cachedPpapiPid) {
    logWarn('Scan', 'New scan REJECTED: PPAPI not detected', { gameRenderPid: gameRenderPid });
    return { ok:false, error:'未识别 Flash PPAPI 进程，无法可靠扫描。请等待游戏完全加载、刷新游戏或重启启动器。', ppapiVerified: false };
  }

  var value    = data.value;
  var scanType = data.scanType || 'int32';
  var maxResult = '50000';
  logInfo('Scan', 'New scan', { value: value, type: scanType, browserPid: process.pid, maxResult: maxResult });
  var extra = ['-Value', String(value), '-Mode', 'new', '-MaxResult', maxResult, '-ScanType', scanType];
  if (cachedPpapiPid) extra = extra.concat(['-CachedPpapiPid', String(cachedPpapiPid)]);
  var r = await runScanner(scanArgs(extra));
  if (r && r.ok) {
    r.hitCap = (Number(r.count) >= Number(maxResult));
    r.ppapiVerified = !!cachedPpapiPid;
    r.zeroValue = (Number(value) === 0);
    _lastNewScanHitCap = !!r.hitCap;
    _lastNewScanValue  = value;
    _lastNewScanType   = scanType;
    var sampleTags = (r.addresses || []).slice(0, 5);
    logInfo('Scan', 'New scan diag', {
      backend: 'see Scanner.call done log line above',
      ppapiPid: cachedPpapiPid,
      scanType: scanType,
      inputValue: value,
      resultCount: Number(r.count) || 0,
      hitCap: r.hitCap,
      maxResult: Number(maxResult),
      firstTags: sampleTags,
    });
  }
  if (r.ok) {
    var newPpapiPid = null;
    if (r.ppapi && r.ppapi.length > 0) {
      newPpapiPid = r.ppapi[0];
    } else if (r.pids && r.pids.length > 0) {
      for (var i = 0; i < r.pids.length; i++) {
        var scannedPid = r.pids[i].pid;
        if (scannedPid && scannedPid !== gameRenderPid && r.pids[i].found > 0) {
          newPpapiPid = scannedPid;
          break;
        }
      }
    }
    if (newPpapiPid) {
      if (newPpapiPid !== cachedPpapiPid) {
        logInfo('Scan', 'cachedPpapiPid updated (PID changed or first scan)', { old: cachedPpapiPid, new: newPpapiPid });
        cachedPpapiPid = newPpapiPid;
        if (_flashWarmupDone) {
          setFlashPriority(cachedPpapiPid, 'Normal');
        } else {
          logInfo('Scan', 'Flash PID updated during warmup — keeping AboveNormal', { pid: cachedPpapiPid });
        }
      } else {
        logInfo('Scan', 'Cached ppapi PID confirmed (same PID)', { pid: cachedPpapiPid });
      }
    }
  }
  if (r.ok && r.addresses) {
    var cntD = 0, cntF = 0, cntI = 0;
    r.addresses.forEach(function(a) {
      if (a.indexOf(':D:') !== -1) cntD++;
      else if (a.indexOf(':F:') !== -1) cntF++;
      else cntI++;
    });
    logInfo('Scan', 'New scan result', { ok: r.ok, count: r.count, Double: cntD, Float: cntF, Int32: cntI, pids: r.pids });
  } else {
    logInfo('Scan', 'New scan result', { ok: r.ok, count: r.count, pids: r.pids });
  }
  return r;
});
ipcMain.handle('mem-scan-next', async function(_, data) {
  if (!gameRenderPid) return { ok:false, error:'游戏未运行' };

  refreshPpapiPid();
  if (!cachedPpapiPid) {
    await refreshPpapiPidViaDll();
  }
  if (!cachedPpapiPid) {
    logWarn('Scan', 'Next scan REJECTED: PPAPI not detected');
    return { ok:false, error:'未识别 Flash PPAPI 进程，无法可靠扫描。请重新打开扫描器后再试。', ppapiVerified: false };
  }

  var addresses = data.addresses || [];
  var inD = 0, inF = 0, inI = 0;
  addresses.forEach(function(a) {
    if (a.indexOf(':D:') !== -1) inD++;
    else if (a.indexOf(':F:') !== -1) inF++;
    else inI++;
  });
  var firstInTags = addresses.slice(0, 5);
  var pidCount = {};
  for (var aii = 0; aii < addresses.length; aii++) {
    var pp = addresses[aii].split(':');
    var pidStr = pp[pp.length - 1];
    if (pidStr) pidCount[pidStr] = (pidCount[pidStr] || 0) + 1;
  }
  var dominantPid = null, dominantCount = 0;
  Object.keys(pidCount).forEach(function(k) {
    if (pidCount[k] > dominantCount) { dominantPid = k; dominantCount = pidCount[k]; }
  });
  var dominantPidAlive = false;
  if (dominantPid) {
    try { process.kill(parseInt(dominantPid, 10), 0); dominantPidAlive = true; }
    catch(_) { dominantPidAlive = false; }
  }
  logInfo('Scan', 'Next scan diag entry', {
    ppapiPid: cachedPpapiPid,
    inputValue: data.value,
    incomingCandidates: addresses.length,
    typeDist: { Double: inD, Float: inF, Int32: inI },
    dominantPid: dominantPid,
    dominantPidShare: dominantPid ? (dominantCount + '/' + addresses.length) : null,
    dominantPidAlive: dominantPidAlive,
    firstTags: firstInTags,
  });
  if (dominantPid && !dominantPidAlive) {
    logWarn('Scan', 'Next scan rejected: dominant tag PID is dead', {
      dominantPid: dominantPid, cachedPpapiPid: cachedPpapiPid });
    return { ok:false, error:'上次扫描的 Flash PPAPI 进程已退出 (PID=' + dominantPid + ')，请重新点击「新建扫描」从头开始。' };
  }
  console.log('[Scan] Next scan input: total=' + addresses.length + ' Double=' + inD + ' Float=' + inF + ' Int32=' + inI + ' filterValue=' + data.value);
  var tmpFile = path.join(os.tmpdir(), 'seer2scan_' + process.pid + '_' + Date.now() + '.tmp');
  try {
    fs.writeFileSync(tmpFile, addresses.join('\n'), 'utf8');
  } catch(e) {
    return { ok:false, error:'Failed to write temp file: ' + e.message };
  }
  var r;
  try {
    r = await runScanner(scanArgs(['-Value', String(data.value), '-Mode', 'next', '-PrevFile', tmpFile]));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch(e) {}
  }
  if (r.ok && r.addresses) {
    var outD = 0, outF = 0, outI = 0;
    r.addresses.forEach(function(a) {
      if (a.indexOf(':D:') !== -1) outD++;
      else if (a.indexOf(':F:') !== -1) outF++;
      else outI++;
    });
    var firstOutTags = r.addresses.slice(0, 5);
    logInfo('Scan', 'Next scan result', { ok: r.ok, count: r.count, Double: outD, Float: outF, Int32: outI, firstTags: firstOutTags });
    if (Number(r.count) === 0 && _lastNewScanHitCap) {
      r.hitCapAndZeroNext = true;
      r.error = '上次新建扫描候选已达 50000 上限，真实地址可能被丢弃。请用更具体的初始数值重新「新建扫描」。';
      logWarn('Scan', 'Next scan returned 0 AND last new-scan hit 50000 cap → likely truncated', {
        lastValue: _lastNewScanValue, lastType: _lastNewScanType, currentValue: data.value });
    }
  } else {
    logInfo('Scan', 'Next scan result', { ok: r.ok, count: r.count });
  }
  return r;
});
ipcMain.handle('mem-read',  async (_, addr) => { if (!gameRenderPid) return {ok:false,error:'游戏未运行'}; return await runScanner(scanArgs(['-Mode','read','-Addr',addr])); });
ipcMain.handle('mem-write', async function(_, data) {
  if (!gameRenderPid) return { ok:false, error:'游戏未运行' };
  var parts=data.addr.split(':'), pidPart=parts[parts.length-1];
  var safePids=cachedPpapiPid?[String(cachedPpapiPid)]:[String(gameRenderPid)];
  if (safePids.indexOf(pidPart)===-1) { logWarn('Write','Blocked unsafe write',{addr:data.addr,pid:pidPart}); return {ok:false,error:'拦截：地址不属于游戏进程 (PID='+pidPart+')'}; }
  lastWriteAddr=data.addr; lastWriteValue=data.value; lastWriteTime=new Date().toISOString();
  var r = await runScanner(scanArgs(['-Mode','write','-Addr',data.addr,'-WriteVal',String(data.value)]));
  if (!r.ok) logError('Write','Single write FAILED',{addr:data.addr,value:data.value});
  return r;
});
ipcMain.handle('mem-batch-write', async function(_, items) {
  if (!gameRenderPid) return { ok:false, error:'游戏未运行' };
  if (!items || items.length === 0) return { ok:true, written:0, failed:0, skipped:0 };

  var safePids = cachedPpapiPid ? [String(cachedPpapiPid)] : [String(gameRenderPid)];

  var safeItems    = [];
  var skippedItems = [];
  items.forEach(function(it) {
    var parts   = it.addr.split(':');
    var pidPart = parts[parts.length - 1];  // 最后一段始终是 PID
    if (safePids.indexOf(pidPart) !== -1) {
      safeItems.push(it);
    } else {
      skippedItems.push(it.addr);
    }
  });

  if (skippedItems.length > 0) {
    logWarn('Write', 'Skipped unsafe addresses (non-renderer PIDs)', {
      skippedCount: skippedItems.length,
      examples: skippedItems.slice(0, 5),
      safePids: safePids
    });
  }

  if (safeItems.length === 0) {
    return { ok:false, error:'所有地址均不属于游戏进程，已全部拦截以防崩溃', written:0, failed:0, skipped:skippedItems.length };
  }

  var tmpFile = path.join(os.tmpdir(), 'seer2batchwrite_' + process.pid + '_' + Date.now() + '.tmp');
  try {
    var lines = safeItems.map(function(it) { return it.addr + '\t' + String(it.value); });
    fs.writeFileSync(tmpFile, lines.join('\n'), 'utf8');
  } catch(e) {
    return { ok:false, error:'Failed to write batch temp file: ' + e.message };
  }
  logInfo('Write', 'Batch write start', {
    total: items.length, safe: safeItems.length, skipped: skippedItems.length,
    value: safeItems[0] && safeItems[0].value,
    addrs: safeItems.slice(0, 5).map(function(i){ return i.addr; })
  });
  if (safeItems.length > 0) {
    lastWriteAddr  = safeItems.map(function(i){ return i.addr; }).join(',').slice(0, 200);
    lastWriteValue = safeItems[0].value;
    lastWriteTime  = new Date().toISOString();
  }
  var r;
  try {
    r = await runScanner(['-BrowserPid', String(process.pid), '-GamePids', gameRenderPid ? String(gameRenderPid) : '', '-Mode', 'batchwrite', '-BatchFile', tmpFile]);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch(e) {}
  }
  if (r.ok) logInfo('Write', 'Batch write done', { written: r.written, failed: r.failed, skipped: skippedItems.length });
  else      logError('Write', 'Batch write FAILED', { error: r.error });
  r.skipped = skippedItems.length;
  return r;
});
ipcMain.handle('mem-list-procs', async function() {
  return await runScanner(['-BrowserPid',String(process.pid),'-GamePids',gameRenderPid?String(gameRenderPid):'','-Mode','listprocs']);
});

ipcMain.handle('mem-refresh-ppapi', async function() {
  refreshPpapiPid();
  if (!cachedPpapiPid) {
    await refreshPpapiPidViaDll();
  }
  return {
    ok: !!cachedPpapiPid,
    ppapiPid:      cachedPpapiPid,
    gameRenderPid: gameRenderPid,
    browserPid:    process.pid,
    ppapiVerified: !!cachedPpapiPid,
  };
});
ipcMain.handle('open-flash-path', function() {
  try {
    var flashPath = (flashStatus && flashStatus.path) || findFlashPlugin();
    if (!flashPath || !fs.existsSync(flashPath)) {
      return { ok:false, error:'未找到当前架构可用的 Flash DLL' };
    }
    shell.showItemInFolder(flashPath);
    return { ok:true, path:flashPath };
  } catch(e) {
    return { ok:false, error:e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('get-status', function() {
  var safePids = cachedPpapiPid ? [cachedPpapiPid] : (gameRenderPid ? [gameRenderPid] : []);
  return {
    flashEnabled:flashStatus.enabled, flashVersion:flashStatus.version, flashPath:flashStatus.path,
    proxy:proxyCfg.enabled?(proxyCfg.host+':'+proxyCfg.port):'直连 (无代理)',
    proxyEnabled:proxyCfg.enabled, proxyCfg,
    gameRenderPid, gameMainPid, browserPid:process.pid, ppapiPid:cachedPpapiPid,
    safePids, electronVersion:process.versions.electron, chromeVersion:process.versions.chrome,
    flashDetected:!!cachedPpapiPid, flashWarmupDone:_flashWarmupDone,
  };
});
ipcMain.handle('get-proxy-config', () => ({ ok:true, config:proxyCfg }));
ipcMain.handle('set-proxy-config', async function(_, cfg) {
  if (typeof cfg.enabled!=='undefined') proxyCfg.enabled=!!cfg.enabled;
  if (cfg.type!==undefined)     proxyCfg.type=cfg.type;
  if (cfg.host!==undefined)     proxyCfg.host=String(cfg.host).trim();
  if (cfg.port!==undefined)     proxyCfg.port=parseInt(cfg.port,10)||10808;
  if (cfg.username!==undefined) proxyCfg.username=String(cfg.username);
  if (cfg.password!==undefined) proxyCfg.password=String(cfg.password);
  saveProxyCfg();
  if (gameWin&&!gameWin.isDestroyed()) {
    var up=proxyCfg.enabled?buildProxyRules().replace(/^.*:\/\//,'PROXY '):'DIRECT';
    var pac=coreNet.buildPacScript(up);
    await gameWin.webContents.session.setProxy({ pacScript:'data:application/x-ns-proxy-autoconfig;base64,'+Buffer.from(pac).toString('base64'), proxyBypassRules:'<local>;127.0.0.1' });
  }
  broadcastAll('proxy-changed',{ mode:proxyCfg.enabled?'custom':'direct', config:proxyCfg });
  logInfo('Proxy','Config updated',{ enabled:proxyCfg.enabled, type:proxyCfg.type, host:proxyCfg.host, port:proxyCfg.port });
  return { ok:true };
});


ipcMain.handle('get-quality-config', function() {
  return {
    ok:true,
    quality:_qualityConfig.quality,
    frameZoom:_qualityConfig.frameZoom === true,
  };
});

ipcMain.handle('set-quality-config', function(_, config) {
  config = config || {};
  var quality = String(config.quality || '').toLowerCase();
  if (launcherRenderPolicy.VALID_QUALITIES.indexOf(quality) < 0) {
    return { ok:false, error:'无效的 Flash 画质档位（可选 low、medium、high、best）' };
  }
  _qualityConfig = launcherRenderPolicy.normalizeConfig({
    quality:quality,
    frameZoom:config.frameZoom,
  });
  var saved = saveQualityConfig();
  if (!saved.ok) return saved;
  try { coreNet.setRenderQuality(_qualityConfig); }
  catch(e) { return { ok:false, error:'应用渲染配置失败：' + e.message }; }
  // 帧放大开关即时生效：立即重算缩放，在 DOM 缩放路径与物理重采样路径间切换。
  try { _applyPageZoom(); } catch(e) {}
  return {
    ok:true,
    quality:_qualityConfig.quality,
    frameZoom:_qualityConfig.frameZoom,
  };
});

ipcMain.handle('get-current-server', function() {
  var srv = getSelectedServer();
  return { id: srv.id, rootUrl: srv.rootUrl, label: srv.label };
});

ipcMain.handle('get-replace-rules', function() {
  return { ok: true, rules: getReplaceRulesForCurrentServer() };
});

ipcMain.handle('get-skin-mode', function() {
  return Object.assign({ ok:true }, skinModePayload());
});

ipcMain.handle('get-catalog-install-reset', function() {
  var reset = _catalogInstallResetPending === true;
  _catalogInstallResetPending = false;
  return { ok:true, reset:reset };
});

ipcMain.handle('set-skin-mode', async function(_, enabled) {
  try { return await setSkinModeEnabled(enabled === true); }
  catch(e) { return { ok:false, error:e.message, enabled:_skinModeEnabled === true }; }
});

ipcMain.handle('set-replace-rules', function(_, rules) {
  if (!Array.isArray(rules)) return { ok: false };
  _replaceRules = rules.map(normalizeReplaceRuleForStorage);
  saveReplaceRules();
  _customSkinCatalogRefreshedAt = 0;
  loadLocalCustomSkinReservedIds();
  applyReplaceRulesToCoreNet();
  notifyReplaceRulesChanged();
  return { ok: true };
});

ipcMain.handle('browse-replace-file', async function() {
  var r = await dialog.showOpenDialog({ title: '选择本地替换文件', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return null;
  return normalizeReplaceFileForStorage(r.filePaths[0]);
});

ipcMain.handle('normalize-replace-file-path', function(_, file) {
  return { ok: true, file: normalizeReplaceFileForStorage(file) };
});

ipcMain.handle('import-replace-rules', async function() {
  var r = await dialog.showOpenDialog({
    title: '导入替换规则', properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  try {
    var raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    var rules;
    if (Array.isArray(raw)) {
      rules = raw.map(normalizeReplaceRuleForStorage);
    } else if (raw && Array.isArray(raw.rules)) {
      rules = raw.rules.slice().sort(function(a, b) {
        return (a.index != null ? a.index : 9999) - (b.index != null ? b.index : 9999);
      }).map(function(r) {
        return normalizeReplaceRuleForStorage({ url: r.url || '', file: r.file || '', label:r.label || '', enabled: r.enabled !== false });
      });
    } else {
      return { ok: false, error: '格式不正确' };
    }
    _replaceRules = rules.map(normalizeReplaceRuleForStorage);
    saveReplaceRules();
    applyReplaceRulesToCoreNet();
    return { ok: true, rules: getReplaceRulesForCurrentServer() };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('export-replace-rules', async function() {
  var r = await dialog.showSaveDialog({
    title: '导出替换规则', defaultPath: 'replace-rules.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    var exportData = {
      version: 2,
      rules: getReplaceRulesForCurrentServer().map(function(rule, i) {
        return { index: i, url: rule.url || '', file: rule.file || '', label:rule.label || '', enabled: rule.enabled !== false };
      }),
    };
    fs.writeFileSync(r.filePath, JSON.stringify(exportData, null, 2), 'utf8');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('get-custom-skins', async function(_event, request) {
  var lightweight = request && request.lightweight === true;
  if (!lightweight && _customSkinActionMetadataScanRevision !== _customSkinRevision) {
    try { await ensureCustomSkinActionMetadata(); } catch(_) {}
  }
  var suggestedId = suggestedAutomaticCustomSkinId();
  var inventory = customSkinDownloadedInventory();
  // Pure in-memory snapshot read. Opening/focusing a window must never start a
  // full disk/hash pass; verification is scheduled only by startup or mutation.
  return {
    ok:true,
    skinModeEnabled:_skinModeEnabled === true,
    skins:lightweight ? JSON.parse(JSON.stringify(_customSkins)) : customSkinUiEntries(_customSkins),
    revision:_customSkinRevision,
    configFile:CUSTOM_SKINS_FILE || '',
    managedDir:CUSTOM_SKINS_DIR || '',
    reservedCount:_customSkinReservedIds.size,
    autoIdRange:CUSTOM_SKIN_ID_MIN + '-' + CUSTOM_SKIN_ID_MAX,
    suggestedId:suggestedId,
    maxSkinId:CUSTOM_SKIN_ID_MAX,
    downloadDir:customSkinDownloadDirectory(),
    downloadedIds:inventory.ids,
    downloadedUClientIds:inventory.uClientIds,
    inventory:customSkinInventoryEntriesForUi(inventory),
    queueIds:_customSkinDownloadQueueIds.slice(),
    running:_customSkinDownloadRunning,
    task:cloneCustomSkinDownloadTask(),
  };
});

ipcMain.handle('set-custom-skins', async function(_, request) {
  var skins = Array.isArray(request) ? request : (request && request.skins);
  var baseRevision = Array.isArray(request) ? null : parseInt(request && request.baseRevision, 10);
  if (baseRevision > 0 && baseRevision !== _customSkinRevision) {
    return {
      ok:false,
      conflict:true,
      error:'皮肤库已在其他任务中更新，请刷新后重试',
      revision:_customSkinRevision,
      skins:customSkinUiEntries(_customSkins),
    };
  }
  var requestedIds = new Set((Array.isArray(skins) ? skins : []).map(function(entry) {
    return parseCustomSkinId(entry && entry.skinId);
  }).filter(Boolean));
  var idsUnchanged = requestedIds.size === _customSkins.length && _customSkins.every(function(entry) {
    return requestedIds.has(parseCustomSkinId(entry.skinId));
  });
  if (!idsUnchanged) {
    try { await refreshCustomSkinReservedIds(); }
    catch(e) { return { ok:false, error:'无法核对游戏 XML 占用序号：' + e.message }; }
  }
  var checked = validateCustomSkins(skins);
  if (!checked.ok) return checked;
  checked.skins.forEach(function(entry) { entry.autoId = false; });
  applyCustomSkinNativeTemplates(checked.skins);
  return persistAndApplyCustomSkins(checked.skins);
});

ipcMain.handle('renumber-custom-skins', async function(_, request) {
  try { return await renumberCustomSkins(request); }
  catch(e) { return { ok:false, error:e.message }; }
});

ipcMain.handle('clear-custom-skins', function(_, request) {
  var baseRevision = parseInt(request && request.baseRevision, 10);
  if (baseRevision > 0 && baseRevision !== _customSkinRevision) {
    return { ok:false, conflict:true, error:'皮肤库已更新，请刷新后再清空', revision:_customSkinRevision };
  }
  return persistAndApplyCustomSkins([]);
});

function customSkinCleanupPathInside(root, target) {
  var relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && relative !== '..' && relative.indexOf('..' + path.sep) !== 0 && !path.isAbsolute(relative);
}

async function deleteCustomSkinManagedTree(target, root, summary) {
  if (!customSkinCleanupPathInside(root, target)) throw new Error('拒绝删除托管目录之外的路径');
  var stat;
  try { stat = await fs.promises.lstat(target); }
  catch(e) { if (e && e.code === 'ENOENT') return; throw e; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    var children = await fs.promises.readdir(target);
    for (var i = 0; i < children.length; i++) {
      await deleteCustomSkinManagedTree(path.join(target, children[i]), root, summary);
    }
    await fs.promises.rmdir(target);
    summary.deletedDirectories++;
    return;
  }
  summary.freedBytes += Number(stat.size) || 0;
  await fs.promises.unlink(target);
  summary.deletedFiles++;
}

async function deleteCustomSkinLocalFiles(removedEntries, remainingEntries) {
  var summary = { deletedFiles:0, deletedDirectories:0, freedBytes:0, errors:[] };
  var managedRoot = path.resolve(CUSTOM_SKINS_DIR, 'files');
  var managedIds = new Set();
  (removedEntries || []).forEach(function(entry) {
    var id = parseCustomSkinId(entry && entry.skinId);
    if (id) managedIds.add(id);
  });
  for (var managedId of managedIds) {
    var managedTarget = path.resolve(managedRoot, String(managedId));
    try { await deleteCustomSkinManagedTree(managedTarget, managedRoot, summary); }
    catch(e) { summary.errors.push('托管目录 ' + managedId + '：' + e.message); }
  }

  var remainingSources = new Set((remainingEntries || []).map(function(entry) {
    return parseCustomSkinId(entry && entry.sourceId);
  }).filter(Boolean));
  var downloadSources = new Set();
  (removedEntries || []).forEach(function(entry) {
    var id = parseCustomSkinId(entry && entry.sourceId);
    if (id && !remainingSources.has(id)) downloadSources.add(id);
  });
  var downloadRoot = path.resolve(customSkinDownloadDirectory());
  var allowedNames = new Set(['normal.swf','fight.swf','physical.swf','special.swf','property.swf','skill.swf','icon.swf',
    'uclient-pet.bundle','uclient-fight-build.json','uclient-follow.bundle','uclient-follow-build.json','uclient-follow-metadata.json',
    'uclient-video.bundle','uclient-video-build.json','battle-variants.json']);
  var allowedDirectories = new Set(['uclient-preview','uclient-follow-preview','variants']);
  for (var sourceId of downloadSources) {
    var sourceDir = path.resolve(downloadRoot, String(sourceId));
    if (!customSkinCleanupPathInside(downloadRoot, sourceDir)) continue;
    try {
      var names = await fs.promises.readdir(sourceDir);
      for (var nameIndex = 0; nameIndex < names.length; nameIndex++) {
        var fileName = names[nameIndex];
        var lowerName = String(fileName).toLowerCase();
        var allowedOwnedFile = allowedNames.has(lowerName) ||
          (/\.part$/i.test(lowerName) && allowedNames.has(lowerName.replace(/\.part$/i, '')));
        if (!allowedOwnedFile && !allowedDirectories.has(lowerName) &&
            !/^(normal|fight|physical|special|property|skill|icon)\.swf\.part$/i.test(lowerName) &&
            !/^uclient-follow-dependency-\d+\.bundle(?:\.part)?$/i.test(lowerName)) continue;
        var filePath = path.resolve(sourceDir, fileName);
        if (!customSkinCleanupPathInside(sourceDir, filePath)) continue;
        var fileStat = await fs.promises.lstat(filePath);
        if (fileStat.isDirectory()) {
          if (!allowedDirectories.has(lowerName) || fileStat.isSymbolicLink()) continue;
          await deleteCustomSkinManagedTree(filePath, sourceDir, summary);
          continue;
        }
        summary.freedBytes += Number(fileStat.size) || 0;
        await fs.promises.unlink(filePath);
        summary.deletedFiles++;
      }
      var leftovers = await fs.promises.readdir(sourceDir);
      if (!leftovers.length) {
        await fs.promises.rmdir(sourceDir);
        summary.deletedDirectories++;
      }
    } catch(e) {
      if (!e || e.code !== 'ENOENT') summary.errors.push('下载目录 ' + sourceId + '：' + e.message);
    }
  }
  return summary;
}

async function cleanupCustomSkinOptionalFiles() {
  var summary = { deletedFiles:0, deletedDirectories:0, freedBytes:0, errors:[] };
  var activeIds = new Set(_customSkins.map(function(entry) {
    return parseCustomSkinId(entry && entry.skinId);
  }).filter(Boolean));
  var managedRoot = path.resolve(CUSTOM_SKINS_DIR, 'files');
  try {
    var names = await fs.promises.readdir(managedRoot);
    for (var index = 0; index < names.length; index++) {
      if (!/^\d+$/.test(names[index])) continue;
      var id = parseCustomSkinId(names[index]);
      if (!id || activeIds.has(id)) continue;
      try { await deleteCustomSkinManagedTree(path.resolve(managedRoot, names[index]), managedRoot, summary); }
      catch(e) { summary.errors.push('未使用托管目录 ' + names[index] + '：' + e.message); }
    }
  } catch(e) {
    if (!e || e.code !== 'ENOENT') summary.errors.push('托管目录：' + e.message);
  }
  try {
    var partSummary = await cleanupCustomSkinDownloadParts(customSkinDownloadDirectory());
    summary.deletedFiles += Number(partSummary && partSummary.deletedFiles) || 0;
    summary.freedBytes += Number(partSummary && partSummary.freedBytes) || 0;
    if (partSummary && Array.isArray(partSummary.errors)) summary.errors = summary.errors.concat(partSummary.errors);
  } catch(e) {
    summary.errors.push('下载残片：' + e.message);
  }
  return summary;
}

function addCustomSkinCleanupSummary(target, source) {
  source = source || {};
  target.deletedFiles += Number(source.deletedFiles) || 0;
  target.deletedDirectories += Number(source.deletedDirectories) || 0;
  target.freedBytes += Number(source.freedBytes) || 0;
  if (Array.isArray(source.errors)) target.errors = target.errors.concat(source.errors);
}

async function deleteCustomSkinExactFiles(files, summary) {
  var seen = new Set();
  for (var source of files) {
    if (!source || /^https?:\/\//i.test(source)) continue;
    var absolute;
    try { absolute = path.resolve(resolveCustomSkinSourceForRuntime(source)); }
    catch(e) { summary.errors.push(String(source) + '：' + e.message); continue; }
    var key = absolute.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (path.extname(absolute).toLowerCase() !== '.swf') {
      summary.errors.push('已跳过非 SWF 外部文件：' + absolute);
      continue;
    }
    try {
      var stat = await fs.promises.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        summary.errors.push('已跳过非普通文件：' + absolute);
        continue;
      }
      await fs.promises.unlink(absolute);
      summary.deletedFiles++;
      summary.freedBytes += Number(stat.size) || 0;
      summary.deletedExternalFiles++;
    } catch(e) {
      if (!e || e.code !== 'ENOENT') summary.errors.push('外部源文件 ' + absolute + '：' + e.message);
    }
  }
}

async function deleteAllCustomSkinDownloadFiles(summary) {
  var root = path.resolve(customSkinDownloadDirectory());
  var allowed = /^(normal|fight|physical|special|property|skill|icon)\.swf(?:\.part)?$/i;
  var ownedFiles = new Set(['uclient-pet.bundle','uclient-fight-build.json','uclient-follow.bundle','uclient-follow-build.json',
    'uclient-follow-metadata.json','uclient-video.bundle','uclient-video-build.json','battle-variants.json']);
  var ownedDirectories = new Set(['uclient-preview','uclient-follow-preview','variants']);
  var directories;
  try { directories = await fs.promises.readdir(root, { withFileTypes:true }); }
  catch(e) { if (e && e.code === 'ENOENT') return; summary.errors.push('下载目录：' + e.message); return; }
  for (var index = 0; index < directories.length; index++) {
    var directory = directories[index];
    if (!directory.isDirectory() || !/^\d+$/.test(directory.name)) continue;
    var sourceDir = path.resolve(root, directory.name);
    if (!customSkinCleanupPathInside(root, sourceDir)) continue;
    try {
      var names = await fs.promises.readdir(sourceDir);
      for (var nameIndex = 0; nameIndex < names.length; nameIndex++) {
        var childName = names[nameIndex];
        var childLowerName = String(childName).toLowerCase();
        var ownedFileName = ownedFiles.has(childLowerName) ||
          (/\.part$/i.test(childLowerName) && ownedFiles.has(childLowerName.replace(/\.part$/i, '')));
        if (!allowed.test(childName) && !ownedFileName &&
            !ownedDirectories.has(String(childName).toLowerCase()) &&
            !/^uclient-follow-dependency-\d+\.bundle(?:\.part)?$/i.test(childName)) continue;
        var target = path.resolve(sourceDir, childName);
        if (!customSkinCleanupPathInside(sourceDir, target)) continue;
        var stat = await fs.promises.lstat(target);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (!ownedDirectories.has(String(childName).toLowerCase())) continue;
          await deleteCustomSkinManagedTree(target, sourceDir, summary);
        } else if (stat.isFile()) {
          await fs.promises.unlink(target);
          summary.deletedFiles++;
          summary.freedBytes += Number(stat.size) || 0;
        }
      }
      if (!(await fs.promises.readdir(sourceDir)).length) {
        await fs.promises.rmdir(sourceDir);
        summary.deletedDirectories++;
      }
    } catch(e) {
      if (!e || e.code !== 'ENOENT') summary.errors.push('下载目录 ' + directory.name + '：' + e.message);
    }
  }
}

async function deleteCustomSkinOwnedStorage(summary) {
  var storageRoot = path.resolve(path.dirname(CUSTOM_SKINS_FILE));
  var ownedRoot = path.resolve(CUSTOM_SKINS_DIR);
  if (path.dirname(ownedRoot).toLowerCase() !== storageRoot.toLowerCase() ||
      path.basename(ownedRoot).toLowerCase() !== 'custom-skins') {
    summary.errors.push('拒绝清理非标准托管目录：' + ownedRoot);
    return;
  }
  var rootStat;
  try { rootStat = await fs.promises.lstat(ownedRoot); }
  catch(e) { if (e && e.code === 'ENOENT') return; summary.errors.push('托管根目录：' + e.message); return; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    summary.errors.push('拒绝清理非普通托管目录：' + ownedRoot);
    return;
  }
  try {
    var children = await fs.promises.readdir(ownedRoot);
    for (var index = 0; index < children.length; index++) {
      await deleteCustomSkinManagedTree(path.resolve(ownedRoot, children[index]), ownedRoot, summary);
    }
    await fs.promises.rmdir(ownedRoot);
    summary.deletedDirectories++;
  } catch(e) {
    if (!e || e.code !== 'ENOENT') summary.errors.push('托管根目录：' + e.message);
  }
}

async function deleteCustomSkinPreviewCache(summary) {
  var cacheParent = path.resolve(app.getPath('userData'), 'cache');
  var cacheRoot = path.resolve(uClientPetPreviewCacheDirectory());
  if (path.dirname(cacheRoot).toLowerCase() !== cacheParent.toLowerCase() ||
      path.basename(cacheRoot).toLowerCase() !== 'uclient-pet-preview') {
    summary.errors.push('拒绝清理非标准 UClient 预览缓存：' + cacheRoot);
    return;
  }
  try {
    var children = await fs.promises.readdir(cacheRoot);
    for (var index = 0; index < children.length; index++) {
      await deleteCustomSkinManagedTree(path.resolve(cacheRoot, children[index]), cacheRoot, summary);
    }
    await fs.promises.rmdir(cacheRoot);
    summary.deletedDirectories++;
  } catch(e) {
    if (!e || e.code !== 'ENOENT') summary.errors.push('UClient 预览缓存：' + e.message);
  }
}

async function purgeAllCustomSkins(request) {
  request = request || {};
  var deleteExternalFiles = request.confirmToken === 'DELETE_ALL_SKIN_FILES';
  if (!deleteExternalFiles && request.confirmToken !== 'CLEAR_MANAGED_SKINS') {
    return { ok:false, error:'缺少彻底删除确认口令' };
  }
  var baseRevision = parseInt(request.baseRevision, 10);
  if (baseRevision > 0 && baseRevision !== _customSkinRevision) {
    return { ok:false, conflict:true, error:'皮肤库已更新，请刷新后重试', revision:_customSkinRevision };
  }
  if (_customSkinDownloadRunning || _uClientPetPreviewPrepareJobs.size) {
    return { ok:false, busy:true, error:'仍有皮肤下载或预览资源准备任务，请等待任务完成后再彻底清空' };
  }
  _customSkinStorageGeneration++;
  logInfo('CustomSkin', 'Full purge requested', {
    revision:_customSkinRevision,
    skinCount:_customSkins.length,
  });
  var removed = _customSkins.map(normalizeCustomSkinEntryForStorage);
  var exactFiles = [];
  removed.forEach(function(entry) {
    CUSTOM_SKIN_FILE_TYPES.forEach(function(type) {
      var source = String(entry.files && entry.files[type] || '').trim();
      if (source && !/^https?:\/\//i.test(source)) exactFiles.push(source);
    });
  });

  var nextRevision = _customSkinRevision + 1;
  var emptyIssued = new Set();
  var emptyProjection = {
    revision:nextRevision,
    generation:_customSkinStorageGeneration,
    uiEntries:[],
    inventory:emptyCustomSkinDownloadedInventory(),
  };
  var saved = saveCustomSkins([], nextRevision, emptyIssued, emptyProjection);
  if (!saved.ok) return saved;
  applyCustomSkinsToCoreNet([], nextRevision, emptyIssued);
  _customSkins = [];
  _customSkinRevision = nextRevision;
  _customSkinIssuedIds = emptyIssued;
  _customSkinCommittedProjection = emptyProjection;
  invalidateCustomSkinSnapshotProjection();
  _customSkinAssignmentResetPending = false;
  _customSkinAssignmentResetAllPending = false;
  _customSkinAssignmentResetPendingIds.clear();

  var summary = { deletedFiles:0, deletedDirectories:0, deletedExternalFiles:0, freedBytes:0, errors:[] };
  addCustomSkinCleanupSummary(summary, await deleteCustomSkinLocalFiles(removed, []));
  addCustomSkinCleanupSummary(summary, await cleanupCustomSkinOptionalFiles());
  await deleteAllCustomSkinDownloadFiles(summary);
  if (deleteExternalFiles) await deleteCustomSkinExactFiles(exactFiles, summary);
  await deleteCustomSkinOwnedStorage(summary);
  await deleteCustomSkinPreviewCache(summary);
  skinThumbnailLatestGeneration.clear();
  if (skinThumbnailWin && !skinThumbnailWin.isDestroyed()) {
    try { skinThumbnailWin.destroy(); } catch(_) {}
  }
  skinThumbnailWin = null;
  skinThumbnailReady = null;
  var thumbnailFiles = invalidateSkinThumbnailCache();
  summary.deletedFiles += thumbnailFiles;

  var metadataFiles = [
    CUSTOM_SKINS_FILE + '.bak',
    CUSTOM_SKIN_NAME_CACHE_FILE,
    CUSTOM_SKIN_DOWNLOAD_SETTINGS_FILE,
    CUSTOM_SKIN_TEMPORARY_MODEL_NAME_EVIDENCE_FILE,
  ];
  for (var metadataIndex = 0; metadataIndex < metadataFiles.length; metadataIndex++) {
    var metadata = metadataFiles[metadataIndex];
    try {
      var metadataStat = await fs.promises.lstat(metadata);
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) continue;
      await fs.promises.unlink(metadata);
      summary.deletedFiles++;
      summary.freedBytes += Number(metadataStat.size) || 0;
    } catch(e) {
      if (!e || e.code !== 'ENOENT') summary.errors.push('皮肤元数据 ' + metadata + '：' + e.message);
    }
  }
  _customSkinNameCache = {};
  _customSkinDownloadDir = path.resolve(CUSTOM_SKIN_DEFAULT_DOWNLOAD_DIR);
  _customSkinPreferUClient = false;
  _customSkinDownloadQueueIds = [];
  _customSkinDownloadQueueRevision++;
  _customSkinDownloadTask = null;
  // A full purge promises to clear every account skin selection, not only
  // launcher-issued ids.  Queue the same full deletion after Flash exits so an
  // in-memory SharedObject cannot restore an official id such as 5.
  var assignmentReset = trackCustomSkinAssignmentReset(
    [], clearCustomSkinAssignmentSharedObjects(), true);
  var purgeErrors = summary.errors.concat(assignmentReset.errors || []);
  notifyCustomSkinStateChanged();
  scheduleCustomSkinReload();
  logInfo('CustomSkin', 'Full purge completed', {
    revision:_customSkinRevision,
    deletedFiles:summary.deletedFiles,
    deletedDirectories:summary.deletedDirectories,
    deletedExternalFiles:summary.deletedExternalFiles,
    freedBytes:summary.freedBytes,
    bindingCaches:assignmentReset.deleted,
    errors:summary.errors.length + assignmentReset.errors.length,
  });
  return {
    ok:true,
    partial:purgeErrors.length > 0,
    revision:_customSkinRevision,
    skins:[],
    cleanup:summary,
    assignmentReset:assignmentReset,
    error:purgeErrors.length ? purgeErrors.join('\n') : '',
  };
}

ipcMain.handle('clear-custom-skin-bindings', function() {
  var result = trackCustomSkinAssignmentReset(
    [], clearCustomSkinAssignmentSharedObjects(), true);
  if (result.deleted || result.updated || result.pendingAfterFlashExit) scheduleCustomSkinReload();
  return { ok:!result.errors.length, result:result, error:result.errors.join('\n') };
});

ipcMain.handle('cleanup-custom-skin-optional-files', async function() {
  try { return { ok:true, cleanup:await cleanupCustomSkinOptionalFiles() }; }
  catch(e) { return { ok:false, error:e.message }; }
});

ipcMain.handle('purge-all-custom-skins', async function(_, request) {
  try { return await purgeAllCustomSkins(request); }
  catch(e) { return { ok:false, error:e.message }; }
});

async function removeCustomSkinsByRequest(request) {
  request = request || {};
  var baseRevision = parseInt(request.baseRevision, 10);
  if (baseRevision > 0 && baseRevision !== _customSkinRevision) {
    return {
      ok:false,
      conflict:true,
      error:'皮肤库已在其他任务中更新，请刷新后重试',
      revision:_customSkinRevision,
      skins:customSkinUiEntries(_customSkins),
    };
  }
  var ids = new Set((Array.isArray(request.skinIds) ? request.skinIds : []).map(parseCustomSkinId).filter(Boolean));
  if (!ids.size) return { ok:false, error:'没有选中可移除的皮肤' };
  var removed = _customSkins.filter(function(entry) { return ids.has(parseCustomSkinId(entry.skinId)); });
  var remaining = _customSkins.filter(function(entry) { return !ids.has(parseCustomSkinId(entry.skinId)); });
  if (!removed.length) return { ok:false, error:'所选皮肤已不在当前注册表中' };
  // Always clear assignments for every removed runtime id, including ids that
  // also exist in the official game.  Otherwise an old selected value such as 5
  // survives removal and is reinterpreted as the official model with id 5.
  var removedAssignmentIds = removed.map(function(entry) {
    return parseCustomSkinId(entry && entry.skinId);
  }).filter(Boolean);
  var deletingFiles = request.deleteFiles === true;
  var result = persistAndApplyCustomSkins(remaining, deletingFiles
    ? { notify:false, reload:false }
    : {});
  if (!result.ok) return result;

  // persistAndApplyCustomSkins performs a best-effort precise SOL rewrite, but
  // that happens while PPAPI Flash may still hold the same SharedObject in
  // memory.  A successful write is not enough: Flash can flush its stale copy
  // back while exiting.  Always queue every removed custom assignment id for
  // the existing post-Flash-exit pass, while retaining the established rule
  // that official-ID overrides keep their official account binding.
  var firstAssignmentReset = result.assignmentReset;
  var immediateAssignmentReset = removedAssignmentIds.length
    ? clearCustomSkinAssignmentSharedObjects(removedAssignmentIds)
    : {
        deleted:0, updated:0, untouched:0, removedBindings:0,
        skippedUnsupported:0, precise:true, errors:[], warnings:[],
      };
  if (firstAssignmentReset) {
    ['deleted','updated','removedBindings'].forEach(function(key) {
      immediateAssignmentReset[key] = Number(immediateAssignmentReset[key] || 0) +
        Number(firstAssignmentReset[key] || 0);
    });
    immediateAssignmentReset.errors = Array.from(new Set(
      (firstAssignmentReset.errors || []).concat(immediateAssignmentReset.errors || [])
    ));
    immediateAssignmentReset.warnings = Array.from(new Set(
      (firstAssignmentReset.warnings || []).concat(immediateAssignmentReset.warnings || [])
    ));
  }
  immediateAssignmentReset.changedSkinIds = removedAssignmentIds.slice();
  immediateAssignmentReset = trackCustomSkinAssignmentReset(
    removedAssignmentIds, immediateAssignmentReset, false);
  result.assignmentReset = immediateAssignmentReset;
  if (immediateAssignmentReset.errors.length) {
    result.partial = true;
    result.warnings = (result.warnings || []).concat(immediateAssignmentReset.errors.map(function(error) {
      return '皮肤绑定缓存首次清理失败，将在 Flash 退出后重试：' + error;
    }));
  }

  if (!deletingFiles) return result;
  result.cleanup = await deleteCustomSkinLocalFiles(removed, remaining);
  // Keep the catalog/downloaded view in sync immediately.  It normally reads
  // the committed projection (rather than rescanning disk), so deleting the
  // files alone is not sufficient to remove stale entries such as a duplicate
  // re-download that was just purged.
  result.inventoryReset = deletingFiles
    ? evictCustomSkinDownloadedInventory(removed, remaining)
    : { ok:true, changed:false, preserved:true };
  if (!result.inventoryReset.ok) {
    result.cleanup.errors.push('下载库存清理失败：' + result.inventoryReset.error);
  }
  // evictCustomSkinDownloadedInventory performs a second manifest save after
  // file deletion.  Keep that backup: it now contains the same post-removal
  // registration state and remains safe for startup recovery.
  notifyCustomSkinStateChanged();
  scheduleCustomSkinReload();
  result.requiresReload = true;
  return result;
}

ipcMain.handle('remove-custom-skins', async function(_, request) {
  return removeCustomSkinsByRequest(request);
});

ipcMain.handle('rollback-custom-skins', async function() {
  try {
    return await rollbackCustomSkinsFromBackup();
  } catch(e) {
    return { ok:false, error:'撤销失败：' + e.message };
  }
});

ipcMain.handle('import-custom-skin-files', async function(event, multiple) {
  try {
    var properties = ['openFile'];
    if (multiple) properties.push('multiSelections');
    var r = await dialog.showOpenDialog({
      title:multiple ? '批量导入皮肤 SWF' : '导入单个皮肤 SWF',
      properties:properties,
      filters:[{ name:'Flash 模型', extensions:['swf'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok:false, canceled:true };
    await refreshCustomSkinReservedIds();
    return await importCustomSkinSources(r.filePaths, event.sender);
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('import-custom-skin-folder', async function(event) {
  try {
    var importBaseRevision = _customSkinRevision;
    var r = await dialog.showOpenDialog({
      title:'扫描皮肤文件夹（仅识别 SWF）',
      properties:['openDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { ok:false, canceled:true };
    var scan = await collectCustomSkinFilesAsync(r.filePaths[0], event.sender);
    var packageInfo = await customSkinFolderPackage.discover(scan);
    if (!packageInfo.sources.length) return { ok:false, error:'所选文件夹中没有可导入的 SWF' };
    if (_customSkinRevision !== importBaseRevision) {
      return { ok:false, conflict:true, error:'皮肤库已在选择或扫描文件夹期间更新，请重新扫描',
        revision:_customSkinRevision };
    }
    await refreshCustomSkinReservedIds();
    if (_customSkinRevision !== importBaseRevision) {
      return { ok:false, conflict:true, error:'皮肤库已在扫描期间更新，请重新扫描',
        revision:_customSkinRevision };
    }
    return await importCustomSkinFolderPackage(packageInfo, event.sender, importBaseRevision);
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('import-custom-skin-config', async function(event) {
  try {
    var importBaseRevision = _customSkinRevision;
    var r = await dialog.showOpenDialog({
      title:'导入自定义皮肤配置',
      properties:['openFile'],
      filters:[{ name:'皮肤配置', extensions:['json'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok:false, canceled:true };
    var packageInfo = await customSkinConfigPackage.read(r.filePaths[0]);
    var confirmation = await dialog.showMessageBox({
      type:'question',
      title:'导入皮肤配置',
      message:'将按配置恢复 ' + packageInfo.configEntryCount + ' 项皮肤的名称、编号、启用状态和资源路径。',
      detail:'导入前已验证所有本地 SWF 路径；若皮肤库在确认期间发生变化，本次操作会停止，不覆盖新状态。',
      buttons:['导入配置','取消'],
      defaultId:0,
      cancelId:1,
      noLink:true,
    });
    if (!confirmation || confirmation.response !== 0) return { ok:false, canceled:true };
    if (_customSkinRevision !== importBaseRevision) {
      return { ok:false, conflict:true, error:'皮肤库已在选择配置期间更新，请重新导入',
        revision:_customSkinRevision };
    }
    await refreshCustomSkinReservedIds();
    if (_customSkinRevision !== importBaseRevision) {
      return { ok:false, conflict:true, error:'皮肤库已在导入期间更新，请重新导入',
        revision:_customSkinRevision };
    }
    return await importCustomSkinFolderPackage(packageInfo, event.sender, importBaseRevision, {
      skipSupplement:true,
    });
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('open-custom-skin-folder', async function() {
  try {
    fs.mkdirSync(CUSTOM_SKINS_DIR, { recursive:true });
    var error = await shell.openPath(CUSTOM_SKINS_DIR);
    return error ? { ok:false, error:error } : { ok:true };
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('get-custom-skin-download-settings', function() {
  var state = customSkinDownloadStatePayload();
  return Object.assign({}, state, {
    ok:true,
    directory:customSkinDownloadDirectory(),
    defaultDirectory:path.resolve(CUSTOM_SKIN_DEFAULT_DOWNLOAD_DIR),
    running:_customSkinDownloadRunning,
    autoImport:_customSkinAutoImport !== false,
    includeOfficialSkins:_customSkinIncludeOfficialSkins !== false,
    preferUClient:_customSkinPreferUClient === true,
    inputMode:_customSkinDownloadInputMode === 'range' ? 'range' : 'list',
    types:_customSkinDownloadTypes.slice(),
    maxBatch:200,
  });
});

function setCustomSkinDownloadQueueRequest(values) {
  var request = Array.isArray(values) ? { ids:values } : (values && typeof values === 'object' ? values : { ids:[] });
  var baseQueueRevision = Math.max(0, parseInt(request.baseQueueRevision, 10) || 0);
  if (baseQueueRevision !== _customSkinDownloadQueueRevision) {
    return Object.assign({
      ok:false,
      conflict:true,
      error:'待下载列表已在其他窗口更新，请按最新列表继续操作',
    }, customSkinDownloadStatePayload());
  }
  var nextQueueIds = parseCustomSkinDownloadIds(Array.isArray(request.ids) ? request.ids : []).slice(0, 200);
  if (JSON.stringify(nextQueueIds) === JSON.stringify(_customSkinDownloadQueueIds)) {
    return Object.assign({ ok:true, unchanged:true }, customSkinDownloadStatePayload());
  }
  var previousQueueIds = _customSkinDownloadQueueIds.slice();
  var previousQueueRevision = _customSkinDownloadQueueRevision;
  _customSkinDownloadQueueIds = nextQueueIds;
  _customSkinDownloadQueueRevision++;
  var saved = saveCustomSkinDownloadSettings();
  if (!saved.ok) {
    _customSkinDownloadQueueIds = previousQueueIds;
    _customSkinDownloadQueueRevision = previousQueueRevision;
    return Object.assign({}, saved, customSkinDownloadStatePayload());
  }
  var state = notifyCustomSkinDownloadStateChanged();
  return Object.assign({ ok:true }, state);
}

ipcMain.handle('set-custom-skin-download-queue', function(_, values) {
  return setCustomSkinDownloadQueueRequest(values);
});

ipcMain.handle('set-custom-skin-auto-import', function(_, enabled) {
  _customSkinAutoImport = enabled !== false;
  var saved = saveCustomSkinDownloadSettings();
  if (saved.ok) notifyCustomSkinDownloadStateChanged();
  return saved.ok ? { ok:true, autoImport:_customSkinAutoImport } : saved;
});

ipcMain.handle('set-custom-skin-download-preferences', function(_, preferences) {
  preferences = preferences || {};
  if (typeof preferences.includeOfficialSkins === 'boolean') {
    _customSkinIncludeOfficialSkins = preferences.includeOfficialSkins;
  }
  if (typeof preferences.preferUClient === 'boolean') {
    _customSkinPreferUClient = preferences.preferUClient;
  }
  if (preferences.inputMode === 'list' || preferences.inputMode === 'range') {
    _customSkinDownloadInputMode = preferences.inputMode;
  }
  if (Array.isArray(preferences.types)) {
    var allowedTypes = new Set(['normal','fight','icon']);
    var nextTypes = preferences.types.map(function(value) { return String(value || '').toLowerCase(); })
      .filter(function(value, index, values) { return allowedTypes.has(value) && values.indexOf(value) === index; });
    if (nextTypes.length) _customSkinDownloadTypes = nextTypes;
  }
  var saved = saveCustomSkinDownloadSettings();
  if (saved.ok) notifyCustomSkinDownloadStateChanged();
  return saved.ok ? {
    ok:true,
    includeOfficialSkins:_customSkinIncludeOfficialSkins,
    preferUClient:_customSkinPreferUClient,
    inputMode:_customSkinDownloadInputMode,
    types:_customSkinDownloadTypes.slice(),
  } : saved;
});

ipcMain.handle('query-seer1-official-pet-catalog', async function(_, request) {
  try {
    return await querySeer1OfficialPetCatalog(request || {});
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('get-custom-skin-thumbnail', async function(_, request) {
  try {
    return await queueCustomSkinThumbnail(request || {});
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('get-custom-skin-preview-actions', async function(_, skinId) {
  return await getCustomSkinPreviewActions(skinId);
});

ipcMain.handle('open-custom-skin-tool-window', function(_, request) {
  try { return openCustomSkinToolWindow(request || {}); }
  catch(e) { return { ok:false, error:e.message }; }
});

ipcMain.handle('set-custom-skin-tool-fullscreen', function(event, enabled) {
  try {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok:false, error:'预览窗口已关闭' };
    win.setFullScreen(!!enabled);
    return { ok:true, fullscreen:win.isFullScreen() };
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('refresh-seer1-official-pet-catalog', async function(event, request) {
  try {
    if (request && request.cached === true) {
      if (!CUSTOM_SKIN_CATALOG_CACHE_FILE || !fs.existsSync(CUSTOM_SKIN_CATALOG_CACHE_FILE)) {
        return { ok:false, error:'本地官方资料缓存不存在，请执行刷新官方资料' };
      }
      _seer1OfficialPetCatalogCache = null;
      var cached = await loadSeer1OfficialPetCatalogFast();
      return { ok:true, fromCache:true, updatedAt:String(cached.updatedAt || ''),
        uClientPetCount:countSeer1NativeUClientCatalogItems(cached),
        uClientPackageVersion:String(cached.uClientBattlePackageVersion || '') };
    }
    return await refreshSeer1OfficialPetCatalog(function(progress) {
      try {
        if (event && event.sender && !event.sender.isDestroyed()) {
          event.sender.send('seer1-official-pet-catalog-refresh-progress', progress || {});
        }
      } catch(_) {}
    });
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('mark-seer1-official-playback-verified', async function(_, request) {
  try {
    return await markSeer1OfficialPlaybackVerified(request || {});
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('choose-custom-skin-download-folder', async function() {
  try {
    var r = await dialog.showOpenDialog({
      title:'选择赛尔号1模型下载目录',
      defaultPath:customSkinDownloadDirectory(),
      properties:['openDirectory','createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { ok:false, canceled:true };
    _customSkinDownloadDir = path.resolve(r.filePaths[0]);
    var saved = saveCustomSkinDownloadSettings();
    if (!saved.ok) return saved;
    notifyCustomSkinDownloadStateChanged();
    return { ok:true, directory:_customSkinDownloadDir };
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('reset-custom-skin-download-folder', function() {
  _customSkinDownloadDir = path.resolve(CUSTOM_SKIN_DEFAULT_DOWNLOAD_DIR);
  var saved = saveCustomSkinDownloadSettings();
  if (saved.ok) notifyCustomSkinDownloadStateChanged();
  return saved.ok
    ? { ok:true, directory:_customSkinDownloadDir }
    : saved;
});

ipcMain.handle('open-custom-skin-download-folder', async function() {
  try {
    var directory = customSkinDownloadDirectory();
    await fs.promises.mkdir(directory, { recursive:true });
    var error = await shell.openPath(directory);
    return error ? { ok:false, error:error } : { ok:true, directory:directory };
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('download-official-custom-skin-models', async function(event, request) {
  try {
    return await downloadOfficialCustomSkinModels(request, event.sender);
  } catch(e) {
    return { ok:false, error:e.message };
  }
});

ipcMain.handle('get-uclient-pet-preview', async function(_, sourceId) {
  return await getUClientPetPreview(sourceId);
});

ipcMain.handle('prepare-uclient-pet-preview', async function(event, sourceId) {
  var id = parseCustomSkinId(sourceId);
  return await prepareUClientPetPreview(id, function(progress) {
    try {
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('uclient-pet-preview-progress', Object.assign({ sourceId:id }, progress || {}));
      }
    } catch(_) {}
  });
});

ipcMain.handle('export-custom-skins', async function() {
  try {
    var r = await dialog.showSaveDialog({
      title:'导出自定义皮肤配置',
      defaultPath:'custom-skins.json',
      filters:[{ name:'皮肤配置', extensions:['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok:false, canceled:true };
    var payload = await customSkinConfigPackage.buildExportPayload(
      _customSkins, _customSkinRevision, r.filePath, resolveCustomSkinSourceForRuntime);
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok:true, filePath:r.filePath };
  } catch(e) {
    return { ok:false, error:e.message };
  }
});


function _findTargetPids() {
  var ppPid = cachedPpapiPid || 0;
  var rnPid = gameRenderPid || 0;
  if (!rnPid && gameWin && !gameWin.isDestroyed()) {
    try { rnPid = gameWin.webContents.getOSProcessId() || 0; } catch(e) {}
  }
  if (!ppPid) {
    try {
      var metrics = app.getAppMetrics();
      for (var i = 0; i < metrics.length; i++) {
        var mt = (metrics[i].type || '').toLowerCase();
        if (mt.indexOf('ppapi') >= 0 || mt.indexOf('plugin') >= 0 || mt.indexOf('pepper') >= 0) {
          ppPid = metrics[i].pid || 0;
          if (ppPid) break;
        }
      }
    } catch(e) {}
  }
  return { ppPid: ppPid, rnPid: rnPid };
}


var _CAPTURE_CFG_FILE = null; // app.whenReady() 后赋值

function _loadCaptureCfg() {
  try {
    if (fs.existsSync(_CAPTURE_CFG_FILE)) {
      var d = JSON.parse(fs.readFileSync(_CAPTURE_CFG_FILE, 'utf8'));
      if (d && d.mode) coreNet.setCaptureMode(d.mode);
    }
  } catch(e) {}
}
function _saveCaptureCfg() {
  try { fs.writeFileSync(_CAPTURE_CFG_FILE, JSON.stringify({ mode: coreNet.getCaptureMode() }, null, 2), 'utf8'); } catch(e) {}
}

var _sessionCacheTab = 'all'; // 内存状态，进程退出自动清零
ipcMain.handle('get-cache-tab', function() {
  if (_sessionCacheTab === 'capture' && coreNet.getCaptureMode() === 'off') {
    return { tab: 'all' };
  }
  return { tab: _sessionCacheTab };
});
ipcMain.handle('set-cache-tab', function(_, tab) {
  _sessionCacheTab = String(tab || 'all');
  return { ok: true };
});

ipcMain.handle('get-capture-config', function() {
  return { mode: coreNet.getCaptureMode() };
});
ipcMain.handle('set-capture-mode', function(_, mode) {
  coreNet.setCaptureMode(mode);
  _saveCaptureCfg();
  return { ok: true, mode: coreNet.getCaptureMode() };
});
ipcMain.handle('get-captured-items', function() {
  var items = coreNet.getCapturedItems();
  items = items.map(function(item) {
    return Object.assign({}, item, { url: rewriteUrlForCurrentServer(item.url) });
  });
  return { ok: true, items: items };
});
ipcMain.handle('clear-captured-items', function() {
  coreNet.clearCapturedItems();
  broadcastAll('capture-cleared', null);
  return { ok: true };
});
ipcMain.handle('set-game-speed', async function(_, speedFactor) {
  speedFactor = Math.max(0.1, Math.min(3.0, Number(speedFactor) || 1.0));
  _currentGameSpeed = speedFactor;

  if (!gameWin || gameWin.isDestroyed())
    return { ok: false, error: '游戏未运行' };

  var _myEpoch = _speedReloadSeq;

  var fps = Math.round(24 * speedFactor);

  var ppPid = cachedPpapiPid || 0;

  if (ppPid) {
    try { process.kill(ppPid, 0); } catch(e) {
      logWarn('Speed', 'cachedPpapiPid ' + ppPid + ' 已死亡，清除并重新扫描');
      cachedPpapiPid = null;
      ppPid = 0;
    }
  }

  if (!ppPid) {
    try {
      var metrics = app.getAppMetrics();
      for (var i = 0; i < metrics.length; i++) {
        var mt = (metrics[i].type || '').toLowerCase();
        if (mt.indexOf('ppapi') >= 0 || mt.indexOf('plugin') >= 0) {
          ppPid = metrics[i].pid || 0;
          if (ppPid) break;
        }
      }
    } catch(e) {}
  }

  if (!ppPid)
    return { ok: false, error: 'Flash PPAPI 进程未就绪，请等游戏完全加载后再使用变速' };

  if (_speedHookState && _speedHookState.pid === ppPid) {
    try { process.kill(ppPid, 0); } catch(e) {
      logInfo('Speed', 'PID ' + ppPid + ' died between scan and pipe connect — treating as reload');
      _speedHookState = null;
      return { ok: true, fps: 24, method: 'normal' };
    }
    var ru = await _ceSetSpeed(ppPid, speedFactor);
    if (ru.ok) {
      logInfo('Speed', 'CE速度更新成功', { pid: ppPid, speed: speedFactor });
      return { ok: true, fps: fps, method: 'CEHook', pid: ppPid };
    }
    if (_speedReloadSeq !== _myEpoch || ru.error.indexOf('ENOENT') >= 0) {
      logInfo('Speed', '管道失败但检测到 Reload，静默重置', { error: ru.error });
      _speedHookState = null;
      return { ok: true, fps: 24, method: 'normal' };
    }
    logWarn('Speed', 'Named Pipe 通信失败，清除旧状态重新注入', { error: ru.error });
    _speedHookState = null;
  }

  if (Math.abs(speedFactor - 1.0) < 0.005) {
    return { ok: true, fps: 24, method: 'normal' };
  }

  var dllPath = _ceDllPath();
  if (!require('fs').existsSync(dllPath)) {
    var _dllName = process.arch === 'x64' ? 'speedhook_ce_x64.dll' : 'speedhook_ce_ia32.dll';
    return { ok: false, error: _dllName + ' 文件缺失，请重新部署启动器' };
  }

  logInfo('Speed', '开始注入 CE SpeedHook DLL', { pid: ppPid, dll: dllPath, speed: speedFactor });
  var ri = await _ceInject(ppPid, dllPath);

  if (_speedReloadSeq !== _myEpoch) {
    logInfo('Speed', 'Reload detected during injection (epoch changed), aborting silently', { pid: ppPid });
    return { ok: true, fps: 24, method: 'normal' };
  }
  try { process.kill(ppPid, 0); } catch(e) {
    logInfo('Speed', 'PID ' + ppPid + ' died during injection, aborting silently');
    return { ok: true, fps: 24, method: 'normal' };
  }

  if (!ri.ok) {
    logError('Speed', 'DLL 注入失败', { error: ri.error });
    return { ok: false, fps: fps, error: 'DLL注入失败: ' + (ri.error || '未知原因') };
  }

  logInfo('Speed', 'CE DLL 注入成功，等待管道服务器初始化', { pid: ppPid });
  _speedHookState = { pid: ppPid };
  if (!cachedPpapiPid) cachedPpapiPid = ppPid;

  await new Promise(function(r) { setTimeout(r, 600); });

  if (_speedReloadSeq !== _myEpoch) {
    logInfo('Speed', 'Reload detected during pipe wait (epoch changed), clearing state silently', { pid: ppPid });
    _speedHookState = null;
    return { ok: true, fps: 24, method: 'normal' };
  }

  var rs = await _ceSetSpeed(ppPid, speedFactor);
  if (!rs.ok) {
    var isReloadRelated = (_speedReloadSeq !== _myEpoch) || (rs.error.indexOf('ENOENT') >= 0);
    if (isReloadRelated) {
      logInfo('Speed', '注入后管道失败，判定为 Reload 竞态，静默重置', { error: rs.error });
      _speedHookState = null;
      return { ok: true, fps: 24, method: 'normal' };
    }
    logError('Speed', '注入后管道通信失败', { error: rs.error });
    _speedHookState = null;
    return { ok: false, error: '注入成功但速度设置失败: ' + rs.error };
  }

  logInfo('Speed', 'CE SpeedHook 完整激活', { pid: ppPid, speed: speedFactor, fps: fps });
  return { ok: true, fps: fps, method: 'CEHook', pid: ppPid };
});

ipcMain.handle('get-game-speed', function() {
  var pids = (gameWin && !gameWin.isDestroyed()) ? _findTargetPids() : { ppPid:0, rnPid:0 };
  return {
    ok:true, running:!!(gameWin&&!gameWin.isDestroyed()),
    speed:_currentGameSpeed, hooked:!!_speedHookState,
    ppPid:pids.ppPid, rnPid:pids.rnPid
  };
});
