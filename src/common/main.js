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
const os     = require('os');
const http   = require('http');
const https  = require('https');
const dns    = require('dns');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const net    = require('net');
const launcherRenderPolicy = require('./modules/launcher-render-policy');

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
  coreNet.setUserReplaceRules(getReplaceRulesForCurrentServer());
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

async function doClearCacheAndReload() {
  if (_gameReloadInFlight) {
    logInfo('ClearReload', 'clear-cache reload request coalesced while another reload is running');
    return { ok:false, busy:true };
  }
  _gameReloadInFlight = ++_gameReloadSerial;
  try {
  clearCapturedIfCaptureEnabled('clear-cache-reload');
  _prepareReload('ClearReload');

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

var overlayWins = { scanner:null, proxy:null, cache:null, speed:null, replace:null, quality:null };
// Reloads can be requested by the menu and cache actions at the same time.
// Keep one navigation in flight so a second request cannot tear down the first
// document and leave a white/empty game surface behind.
var _gameReloadInFlight = null;
var _gameReloadSerial = 0;
var overlayCfg = {
  scanner: { file:'scanner-overlay.html', defW:960, defH:520, minH:380, minW:480, title:'内存扫描器' },
  proxy:   { file:'proxy-overlay.html', defW:520, defH:580, minH:520, minW:480, title:'代理设置' },
  cache:   { file:'cache-overlay.html', defW:820, defH:560, minH:400, minW:480, title:'缓存管理' },
  speed:   { file:'speed-overlay.html', defW:420, defH:300, minH:260, minW:280, title:'游戏变速' },
  replace: { file:'replace-overlay.html', defW:760, defH:500, minH:360, minW:560, title:'请求替换' },
  quality: { file:'quality-overlay.html', defW:480, defH:295, minH:275, minW:440, title:'画质' },
};

var _lastGBForOverlays = null;
function onGameWindowMoved() {
  if (!gameWin || gameWin.isDestroyed()) { _lastGBForOverlays = null; return; }
  _lastGBForOverlays = gameContentRef();
}
var _overlayClosing = {}, overlayPinState = {}, _gameMinimized = false;
var _minimizedByGameMin = {};

function closeUnpinnedOverlays() {
  Object.keys(overlayWins).forEach(function(name) {
    var w = overlayWins[name];
    if (!w || w.isDestroyed() || overlayPinState[name]) return;
    if (name === 'scanner') {
      if (w.isVisible()) w.hide();
      return;
    }
    if (!_overlayClosing[name]) {
      _overlayClosing[name] = true;
      saveOneOverlayBounds(name, w);
      w.close();
    }
  });
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
      try { logWarn('Overlay', 'detected dead webContents, disposing before reopen', { name:name }); } catch(_) {}
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
  } else if (win && !win.isDestroyed()) {
    _overlayClosing[name] = true;
    saveOneOverlayBounds(name, win);
    win.close();
    return;
  }
  if (!gameWin || gameWin.isDestroyed()) return;
  if (gameWin.isMinimized()) gameWin.restore();
  Object.keys(overlayWins).forEach(function(other) {
    if (other === name) return;
    var otherWin = overlayWins[other];
    if (!otherWin || otherWin.isDestroyed() || _overlayClosing[other] || overlayPinState[other]) return;
    if (other === 'scanner') {
      if (otherWin.isVisible()) otherWin.hide();
      return;
    }
    _overlayClosing[other] = true;
    saveOneOverlayBounds(other, otherWin);
    otherWin.close();
  });

  var b = resolveOverlayBounds(name, cfg.defW, cfg.defH);
  _lastGBForOverlays = gameContentRef();
  var winOpts = {
    x:b.x, y:b.y, width:b.width, height:b.height,
    minWidth:Math.min(b.width, cfg.minW || 480), minHeight:cfg.minH || 300,
    title:cfg.title, backgroundColor:'#0a0e1a',
    frame:false, thickFrame:true, movable:true, resizable:true,
    icon:path.join(__dirname,'icon.ico'),
    alwaysOnTop:_alwaysOnTop === true,
    webPreferences:{ nodeIntegration:false, contextIsolation:true, sandbox:false, preload:path.join(__dirname,'preload.js'), plugins:false, backgroundThrottling:false, spellcheck:false, enableWebSQL:false, v8CacheOptions:'bypassHeatCheck' },
    show:false, skipTaskbar:false,
  };
  if (gameWin && !gameWin.isDestroyed()) winOpts.parent = gameWin;
  var newWin = new BrowserWindow(winOpts);
  newWin.loadFile(cfg.file);

  var selfDestroying = false;
  function disposeForCrash(reason) {
    if (selfDestroying) return;
    selfDestroying = true;
    try { logError('Overlay', 'crash/unresponsive — disposing', { name:name, reason:reason }); } catch(_) {}
    try { newWin.webContents.removeAllListeners(); } catch(_) {}
    try { newWin.removeAllListeners('moved'); } catch(_) {}
    try { newWin.removeAllListeners('resized'); } catch(_) {}
    try { if (!newWin.isDestroyed()) newWin.destroy(); } catch(_) {}
    overlayWins[name] = null;
    overlayPinState[name] = false;
    _overlayClosing[name] = false;
  }
  newWin.webContents.on('render-process-gone', function(_event, details) {
    disposeForCrash('render-process-gone:' + (details && details.reason));
  });
  newWin.webContents.on('did-fail-load', function(_event, errorCode, errorDescription, _validatedURL, isMainFrame) {
    if (isMainFrame === false || Number(errorCode) === -3) return;
    disposeForCrash('did-fail-load:' + String(errorCode) + ':' + String(errorDescription || ''));
  });
  try { newWin.webContents.on('crashed', function() { disposeForCrash('crashed'); }); } catch(_) {}
  newWin.on('unresponsive', function() { disposeForCrash('unresponsive'); });
  newWin.once('ready-to-show', function() {
    var current = overlayWins[name];
    if (!current || current.isDestroyed()) return;
    if (gameWin && !gameWin.isDestroyed()) {
      try { current.setParentWindow(gameWin); } catch(_) {}
    }
    if (_alwaysOnTop || overlayPinState[name]) {
      try { current.setAlwaysOnTop(true, _alwaysOnTop ? 'screen-saver' : 'pop-up-menu'); } catch(_) {}
    }
    current.show();
    try { current.focus(); } catch(_) {}
    try { current.moveTop(); } catch(_) {}
    current.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(function(){});
    console.log('[Overlay] shown:', name);
  });
  var throttledMove = _makeThrottle(function() {
    var current = overlayWins[name];
    if (current && !current.isDestroyed()) saveOneOverlayBounds(name, current, _lastGBForOverlays);
  }, 16);
  var throttledResize = _makeThrottle(function() {
    var current = overlayWins[name];
    if (current && !current.isDestroyed()) saveOneOverlayBounds(name, current, _lastGBForOverlays);
  }, 16);
  newWin.on('moved', throttledMove);
  newWin.on('resized', throttledResize);
  newWin.on('closed', function() {
    try { newWin.webContents.removeAllListeners(); } catch(_) {}
    try { newWin.removeAllListeners(); } catch(_) {}
    overlayWins[name] = null;
    overlayPinState[name] = false;
    _overlayClosing[name] = false;
    console.log('[Overlay] closed:', name);
  });
  overlayWins[name] = newWin;
}

function toggleScanner()   { toggleOverlay('scanner');  }
function toggleProxy()     { toggleOverlay('proxy');    }
function toggleCache()     { toggleOverlay('cache');    }
function toggleSpeed()     { toggleOverlay('speed');    }
function toggleReplace()   { toggleOverlay('replace');  }
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
          try { coreNet.setGameBackend(srv.rootUrl); } catch(e) {}
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
    Object.keys(overlayWins).forEach(function(name) {
      var w = overlayWins[name];
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
    closeAllImageWins(true);
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
      } else {
        var w = overlayWins[name]; if (!w || w.isDestroyed()) return;
        if (w.isMinimized()) w.restore(); else w.show();
      }
    });
    _minimizedByGameMin = {};
    _bringOverlaysToTop();
  });
}

var GAME_CACHE_DIR = (function() {
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
  LOCAL_SWF_DIR = app.isPackaged
    ? require('path').join(path.dirname(process.execPath), 'local-res')
    : require('path').join(__dirname, 'local-res');
  try { coreNet.setLocalSwfDir(LOCAL_SWF_DIR); } catch(e) { startupDiag('setLocalSwfDir FAILED', { message: e.message }); }
  try { loadReplaceRules(); } catch(e) { startupDiag('loadReplaceRules FAILED', { message: e.message }); }
  if (_replaceRules.length === 0) {
    _replaceRules = [
      { url: 'http://43.138.190.6/seer2/module/app/GadSelectPetPanel.swf', file: '.\\复苏纹章by_神秘大佬.swf', label:'复苏纹章', enabled: true },
      { url: 'http://43.138.190.6/seer2/module/app/ItemBagPanel.swf', file: '.\\背包装扮穿戴修复.swf', label:'背包修复', enabled: true },
      { url: 'http://43.138.190.6/seer2/dll/Seer2CoreDLL.swf', file: '.\\CoreDLL.swf', label:'对战版', enabled: false },
      { url: 'http://43.138.190.6/seer2/res/ui/FramePlayer.swf', file: '.\\FramePlayer.swf', label: '改服ui特修', enabled: false },
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
  console.log('[AutoStart] Launching game');
  startupDiag('stage: createGame begin');
  try {
    createGame();
  } catch(e) {
    startupDiag('FATAL: createGame threw', {
      message:e.message,
      stack:String(e.stack || '').split(/\r?\n/).slice(0, 15).join(' | '),
    });
    try { dialog.showErrorBox('启动失败', '创建游戏窗口时出错：\n' + e.message + '\n\n程序将退出。'); } catch(_) {}
    try { app.exit(1); } catch(_) { try { process.exit(1); } catch(__) {} }
    return;
  }
  startupDiag('stage: createGame returned');
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
  startupDiag('window-all-closed', { autoStartPending:_autoStartPending });
  if (_autoStartPending) return;
  if (gameWin && !gameWin.isDestroyed()) return;
  app.quit();
});




ipcMain.on('hide-self', function(event) {
  Object.keys(overlayWins).forEach(function(name) {
    var w = overlayWins[name];
    if (!w || w.isDestroyed()) return;
    if (w.webContents.id === event.sender.id) {
      if (name === 'scanner') {
        if (w.isVisible()) w.hide();
      } else {
        if (!_overlayClosing[name]) {
          _overlayClosing[name] = true;
          saveOneOverlayBounds(name, w);
          w.close();
        }
      }
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
  var NEEDS_KEYBOARD = new Set(['scanner','replace','proxy']);
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
  });
});
ipcMain.on('close-app',           () => app.quit());
ipcMain.on('clipboard-write',     (_, text) => clipboard.writeText(String(text)));
ipcMain.on('image-win-pinned',    function(event, pinned) {
  Object.keys(_imageWins).forEach(function(k) {
    var w = _imageWins[k];
    if (!w || w.isDestroyed() || w.webContents.id !== event.sender.id) return;
    _imageWinPins[k] = !!pinned;
    if (pinned) {
      w.setAlwaysOnTop(true, _alwaysOnTop ? 'screen-saver' : 'pop-up-menu');
      try { w.setFocusable(false); } catch(_) {}
    } else {
      try { w.setFocusable(true); } catch(_) {}
      if (_alwaysOnTop) {
        w.setAlwaysOnTop(true, 'pop-up-menu');
      } else {
        w.setAlwaysOnTop(false);
      }
    }
    if (gameWin && !gameWin.isDestroyed()) {
      try { gameWin.focus(); } catch(_) {}
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

ipcMain.handle('set-replace-rules', function(_, rules) {
  if (!Array.isArray(rules)) return { ok: false };
  _replaceRules = rules.map(normalizeReplaceRuleForStorage);
  saveReplaceRules();
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
