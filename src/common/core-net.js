'use strict';
/**
 * core-net.js  —  Seer2 Launcher 网络层模块（明文，不混淆）
 *
 * 职责：
 *   1. 本地 HTTP 拦截代理（Flash 无法直接被 webRequest 捕获，必须用真实 HTTP 代理）
 *   2. 游戏文件内存缓存（加载进 RAM 后断开磁盘依赖）
 *   3. PAC 脚本构建
 *
 * 依赖：electron（仅在 Electron 主进程中 require）、Node.js 内置模块
 * 在 main.js 中通过以下方式引入：
 *   const coreNet = require('./core-net');
 */

const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const https  = require('https');
const net    = require('net');
const urlMod = require('url');
const zlib   = require('zlib');
const crypto = require('crypto'); // URL MD5 hashing for cache keys
const { createGameHtmlRenderPolicy } = require('./modules/game-html-render-policy');

// ── 热更新资源基准目录 ────────────────────────────────────────────────────
// Bug 2 修复：path.dirname(__filename) 在生产环境中指向 app.asar 内部虚拟路径，
// 读到的是安装包原始版本，不是热更新后的新版。
// 解决方案：main.js 在启动时调用 setBaseDir(unpackedResDir()) 注入真实磁盘路径；
// 磁盘回退逻辑改用 _baseDir，确保始终读取 app.asar.unpacked/ 下的最新文件。
let _baseDir = path.dirname(__filename); // 开发环境默认值；生产环境由 main.js 覆盖

function setBaseDir(dir) {
  _baseDir = dir;
  console.log('[CoreNet] baseDir set to:', dir);
}

// ── 拦截目标 ──────────────────────────────────────────────────────────────
const INTERCEPT_HOST  = '43.138.190.6';
// ── 虚拟域名常量（与 main.js LOCAL_HOSTNAME 保持一致）──────────────────────────
// PAC 路径（Flash WinINet → session.setProxy → core-net）下，Flash 把
// seer2.chunshu 发来的请求直接送到 core-net，此处将其重写为真实目标主机，
// 确保 INTERCEPT_PATHS 查找、直连等所有后续逻辑均正常工作。
//   seer2.chunshu/Client.swf → 改服 /seer2/Client.swf（保留动态配置 loader）
//   seer2.chunshu/其余路径  → 改服 43.138.190.6
const LOCAL_HOSTNAME  = 'seer2.chunshu';
const OFFICIAL_HOST   = 'seer2.61.com';
let _gameRootHost     = INTERCEPT_HOST;
let _gameRootPort     = 80;
let _gameRootBasePath = '/seer2';
let _bloomContains    = null;
const INTERCEPT_PATHS = {};

function _md5Hex(data) {
  return crypto.createHash('md5').update(String(data || '')).digest('hex');
}

function _buildBloomMatcher(data) {
  var split = String(data || '').replace(/\r/g, '').trim().split('\n');
  if (split.length < 3) throw new Error('invalid bloom data');
  var funcNum = parseInt(split[1], 10);
  if (!funcNum || funcNum <= 0) throw new Error('invalid bloom func count');
  var buffer = Buffer.from(split[2], 'base64');
  if (!buffer.length) throw new Error('empty bloom buffer');
  var bloom = [];
  for (var i = 0; i < buffer.length; i++) {
    var num = buffer[i];
    for (var j = 0; j < 8; j++) bloom.push(((num >> j) & 1) === 1);
  }
  return function(dataPath) {
    var hash = _md5Hex(dataPath);
    var hash1 = BigInt(parseInt(hash.slice(0, 8), 16) ^ parseInt(hash.slice(8, 16), 16));
    var hash2 = BigInt(parseInt(hash.slice(16, 24), 16) ^ parseInt(hash.slice(24, 32), 16));
    var combinedHash = hash1;
    for (var k = 0; k < funcNum; k++) {
      combinedHash &= BigInt(0xffffffff);
      if (!bloom[Number(combinedHash % BigInt(bloom.length))]) return false;
      combinedHash += hash2;
    }
    return true;
  };
}

function _normalizeBloomPath(reqPath) {
  if (!reqPath) return '/';
  if (reqPath === '/seer2') return '/';
  if (reqPath.indexOf('/seer2/') === 0) return reqPath.slice(6) || '/';
  return reqPath;
}

function _toGameServerPath(reqPath) {
  if (!reqPath) return _gameRootBasePath + '/';
  if (reqPath === '/seer2' || reqPath === '/seer2/') return _gameRootBasePath + '/';
  if (reqPath.indexOf(_gameRootBasePath + '/') === 0) return reqPath;
  if (reqPath[0] !== '/') reqPath = '/' + reqPath;
  return _gameRootBasePath + reqPath;
}

function _toOfficialPath(reqPath) {
  var normalized = _normalizeBloomPath(reqPath);
  return normalized || '/';
}

function resolveVirtualHostRoute(reqPath, search) {
  var q = search || '';
  if (reqPath === '/seer2/' || reqPath === '/seer2' || reqPath === '/seer2/index.html' || reqPath === '/seer2/index.php' || reqPath === '/seer2/play-local.html') {
    return { host: LOCAL_HOSTNAME, port: 80, path: reqPath + q, sourceType: 'local', localHtml: true };
  }
  if (reqPath === '/Client.swf') {
    return { host: _gameRootHost, port: _gameRootPort, path: _toGameServerPath(reqPath) + q, sourceType: 'game' };
  }
  if (
    reqPath === '/seer2' ||
    reqPath === '/seer2/' ||
    reqPath.indexOf('/seer2/static/') === 0 ||
    reqPath === '/seer2/config/dyn-client-config.xml'
  ) {
    var gamePathFixed = _toGameServerPath(reqPath);
    return { host: _gameRootHost, port: _gameRootPort, path: gamePathFixed + q, sourceType: 'game' };
  }
  var normalized = _normalizeBloomPath(reqPath);
  var useGame = (_bloomContains === null) ? true : !!_bloomContains(normalized);
  if (useGame) {
    var gamePath = _toGameServerPath(reqPath);
    return { host: _gameRootHost, port: _gameRootPort, path: gamePath + q, sourceType: 'game' };
  }
  var officialPath = _toOfficialPath(reqPath);
  return { host: OFFICIAL_HOST, port: 80, path: officialPath + q, sourceType: 'official' };
}

function setBloomRoutes(rootUrl, bloomText) {
  var parsed = urlMod.parse(rootUrl);
  if (!parsed.hostname) throw new Error('invalid bloom root url');
  _gameRootHost = parsed.hostname;
  _gameRootPort = parseInt(parsed.port, 10) || 80;
  _gameRootBasePath = (parsed.pathname || '/seer2').replace(/\/+$/, '') || '/seer2';
  _bloomContains = _buildBloomMatcher(bloomText);
  console.log('[Bloom] routes loaded:', _gameRootHost + ':' + _gameRootPort + _gameRootBasePath);
}

// ── 动态游戏后端热切换 ────────────────────────────────────────────────────
// 由 main.js 菜单"选择网址"调用，仅更新代理层目标后端，
// 不重启 app、不强杀 Flash、不 loadURL，后续请求自动路由到新线路。
function setGameBackend(rootUrl) {
  try {
    var parsed = urlMod.parse(rootUrl);
    if (!parsed.hostname) throw new Error('invalid rootUrl');
    _gameRootHost     = parsed.hostname;
    _gameRootPort     = parseInt(parsed.port, 10) || 80;
    _gameRootBasePath = (parsed.pathname || '/seer2').replace(/\/+$/, '') || '/seer2';
    console.log('[Bloom] backend switched:', _gameRootHost + ':' + _gameRootPort + _gameRootBasePath);
  } catch(e) {
    console.warn('[Bloom] setGameBackend failed:', e.message);
  }
}

function clearBloomRoutes() {
  _gameRootHost = INTERCEPT_HOST;
  _gameRootPort = 80;
  _gameRootBasePath = '/seer2';
  _bloomContains = null;
  console.log('[Bloom] routes cleared');
}

// ── 用户自定义请求替换规则 ────────────────────────────────────────────────
// 规则优先级：用户替换 > 内置 INTERCEPT_PATHS > 缓存 > 直连
// 结构：[{ url: 'http://host/path', file: 'C:\\local\\file', enabled: true }]
// 两个受保护 URL 在 setUserReplaceRules 时直接过滤，不进入替换缓存
const PROTECTED_URLS = new Set([
  '43.138.190.6/seer2/config/dyn-client-config.xml',
]);
let _userReplaceRules    = [];
let _userReplaceCache    = new Map();      // normalizedUrl -> { kind:'file'|'network', file|url }
let _userPassthroughKeys = new Set();      // normalizedUrl → 留空规则（跳过内置拦截）
let _localSwfDir         = null;           // swf-local 目录绝对路径，./前缀的解析基准


/**
 * 设置 swf-local 目录路径（由 main.js 在 app.whenReady 后调用）
 * 所有以 './' 开头的替换路径都相对于此目录解析
 */
function setLocalSwfDir(dir) {
  _localSwfDir = dir || null;
  console.log('[Replace] localSwfDir =', _localSwfDir);
}

/**
 * 将替换规则中的 ./xxx 路径解析为绝对路径
 * ./文件名  → <_localSwfDir>/文件名
 * ./子目录/文件名 → <_localSwfDir>/子目录/文件名
 * 绝对路径或 http 地址保持不变
 */
function _resolveReplaceFile(file) {
  if (!file) return file;
  if (/^https?:\/\//i.test(file)) return file; // 网络URL直接返回
  if (file.startsWith('./') || file.startsWith('.\\')) {
    if (!_localSwfDir) return file;
    const relative = file.slice(2).replace(/[\/\\]+/g, require('path').sep); // 去掉 ./ 并统一路径分隔符
    const primary = require('path').join(_localSwfDir, relative);
    if (fs.existsSync(primary)) return primary;
    if (relative === 'CoreDLL.swf') {
      const fallback = require('path').join(_localSwfDir, 'skin-mode', 'CoreDLL.swf');
      if (fs.existsSync(fallback)) return fallback;
    } else if (relative === 'skin-mode' + require('path').sep + 'CoreDLL.swf') {
      const fallback = require('path').join(_localSwfDir, 'CoreDLL.swf');
      if (fs.existsSync(fallback)) return fallback;
    } else if (relative === 'FramePlayer.swf') {
      const fallback = require('path').join(_localSwfDir, 'skin-mode', 'FramePlayer.swf');
      if (fs.existsSync(fallback)) return fallback;
    } else if (relative === 'skin-mode' + require('path').sep + 'FramePlayer.swf') {
      const fallback = require('path').join(_localSwfDir, 'FramePlayer.swf');
      if (fs.existsSync(fallback)) return fallback;
    }
    return primary;
  }
  return file; // 绝对路径直接返回
}

function _normalizeUrl(url) {
  return (url || '').replace(/^https?:\/\//i, '').toLowerCase().replace(/\/$/, '').trim();
}

function _guessMime(filePath) {
  var ext = (filePath || '').split('.').pop().toLowerCase();
  var map = {
    swf:'application/x-shockwave-flash', xml:'text/xml', html:'text/html',
    js:'application/javascript', css:'text/css', json:'application/json',
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
    mp3:'audio/mpeg', ogg:'audio/ogg', txt:'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

function setUserReplaceRules(rules) {
  _userReplaceRules = Array.isArray(rules) ? rules : [];
  _userReplaceCache.clear();
  _userPassthroughKeys.clear();
  _userReplaceRules.forEach(function(rule) {
    if (!rule.enabled || !rule.url) return;
    // 规范化 URL：先通过 _normalizeCacheUrl 统一所有已知线路到默认线路，
    // 再通过 _normalizeUrl 去协议/小写，确保跨线路匹配一致。
    var key = _normalizeUrl(_normalizeCacheUrl(rule.url));
    // 受保护的 URL 直接跳过，永远不进入替换缓存
    if (PROTECTED_URLS.has(key)) return;
    var isPassthrough = (!rule.file || rule.file === rule.url);
    if (isPassthrough) {
      if (!_userPassthroughKeys.has(key) && !_userReplaceCache.has(key))
        _userPassthroughKeys.add(key);
      return;
    }
    if (_userReplaceCache.has(key) || _userPassthroughKeys.has(key)) return;
    // 解析 ./相对路径 → 绝对路径
    var resolvedFile = _resolveReplaceFile(rule.file);
    if (/^https?:\/\//i.test(resolvedFile)) {
      _userReplaceCache.set(key, { kind: 'network', url: resolvedFile, sourceFile: rule.file || '' });
      return;
    }
    _userReplaceCache.set(key, { kind: 'file', file: resolvedFile, sourceFile: rule.file || '' });
    if (!fs.existsSync(resolvedFile)) {
      console.warn('[Replace] Local file not found yet:', rule.url, '->', resolvedFile);
    }
  });
  console.log('[Replace] Rules updated:', _userReplaceRules.length, 'rules,',
    _userReplaceCache.size, 'targets,', _userPassthroughKeys.size, 'passthrough');
}
function getUserReplaceRules() { return _userReplaceRules; }

// ── 内存文件缓存 ─────────────────────────────────────────────────────────
// 所有需要拦截的游戏文件在启动时读入此 Map，代理直接从内存返回，
// 磁盘文件被修改或删除均不影响运行中的游戏。
// 这些文件不在 asarUnpack 列表中，直接打进 app.asar 内部只读档案，
// 通过 fs + asar 集成层透明读取；用户删除 app.asar.unpacked/ 中的副本
// （由 build 脚本后置复制的可见备份）不影响程序运行。
const _fileCache = new Map();

/**
 * 将所有拦截文件及图片资源加载进内存
 * @param {string} baseDir  launcher 根目录（__dirname）
 */
function loadFilesIntoMemory(baseDir) {
  const targets = Object.values(INTERCEPT_PATHS).map(e => e.file)
    .concat(['qq-group.jpg', 'bilibili.jpg', 'contact-qq.jpg']);

  targets.forEach(function(f) {
    const p = path.join(baseDir, f);
    try {
      _fileCache.set(f, fs.readFileSync(p));
      console.log('[Cache] loaded into memory:', f, '(' + _fileCache.get(f).length + 'b)');
    } catch(e) {
      console.log('[Cache] could not load:', f, e.message);
    }
  });
}

// ── 本地游戏首页（内置 HTML，绕过网络请求）─────────────────────────────────
// main.js 在启动时读取 local-game-index.html 并调用 setLocalGameIndex() 注入。
// 代理收到游戏首页 HTML 请求时，直接返回此本地副本（经 _applyHtmlTransform 处理），
// 彻底消除首次加载的网络延迟，同时去掉原始页面的底部导航栏/音乐按钮等干扰元素。
let _localGameIndexBuf = null;
const _gameHtmlRenderPolicy = createGameHtmlRenderPolicy();
function setLocalGameIndex(buf) {
  _localGameIndexBuf = (buf && buf.length > 0) ? buf : null;
}

function setRenderQuality(config) {
  return _gameHtmlRenderPolicy.setConfig(config);
}

/**
 * 对游戏 HTML 字节流执行统一变换（wmode/quality/hasPriority 注入 + 背景 CSS）。
 * 同时适用于本地内置 HTML 和从服务器获取的 HTML。
 * @param {Buffer} buf    原始 HTML 字节
 * @returns {Buffer}      处理后的 HTML 字节
 */
function _applyHtmlTransform(buf) {
  return _gameHtmlRenderPolicy.transform(buf);
}

let _proxyServer = null;
let _proxyPort   = 0;


// ── Smart Cache Engine ────────────────────────────────────────────────────
// cacheDir is set by main.js via setCacheDir() before the proxy starts.
// Until then cache is disabled (pass-through).
let _cacheDir  = null;      // absolute path to GameCache directory
let _cacheIndex = null;     // Map<hash, {hash,name,url,ext,size,cachedAt,hitCount}>
let _cacheIndexDirty = false;
let _cacheIndexTimer = null;
const CACHEABLE_EXTS = new Set(['swf','png','jpg','jpeg','mp3','ogg']);
const _rangeFillInFlight = new Set();
const _replaceTargetCacheInFlight = new Set();



// ── 模块级 MIME 类型映射表 ──────────────────────────────────────────────────
// 集中定义，供 Cache HIT / MISS 路径统一引用，避免各处独立 inline 对象。
// 对未知扩展名的回退：使用 image/png 而非 application/octet-stream——
// 因为缓存的文件均来自 CACHEABLE_EXTS 白名单，背景图（png/jpg）是最常见的
// "未识别"场景。Flash 收到 octet-stream 时会拒绝将其用作 BitmapData，
// 而 image/png 作为回退能让 Flash 尝试解码，大幅减少白屏概率。
const MIME_MAP = {
  swf:  'application/x-shockwave-flash',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  mp3:  'audio/mpeg',
  ogg:  'audio/ogg',
  xml:  'text/xml',
  json: 'application/json',
  js:   'application/javascript',
  css:  'text/css',
  html: 'text/html',
  txt:  'text/plain',
};
const MIME_FALLBACK = 'image/png'; // 比 octet-stream 对 Flash BitmapData 更友好

// ── 缓存 URL 规范化 ──────────────────────────────────────────────────────
// 不同线路（43.138.190.6、o1.733702.xyz、seer2.chunshu）指向同一资源，
// 缓存 key 必须统一，否则切换线路后同一文件会被重复缓存为独立条目。
// 规范化策略：将所有已知游戏线路 URL 统一映射到默认线路（43.138.190.6/seer2）。
function _normalizeCacheUrl(url) {
  if (!url) return url;
  var pathOnly = url.split('?')[0];
  // 当前动态后端（可能是任何已知线路）
  var currentRoot = 'http://' + _gameRootHost +
    (_gameRootPort !== 80 ? ':' + _gameRootPort : '') + _gameRootBasePath;
  var knownRoots = [
    'http://o1.733702.xyz/seer2',
    'http://seer2.chunshu/seer2',
    currentRoot,
  ];
  var canonicalRoot = 'http://43.138.190.6/seer2';
  for (var i = 0; i < knownRoots.length; i++) {
    if (knownRoots[i] === canonicalRoot) continue; // 跳过自身
    if (pathOnly.indexOf(knownRoots[i]) === 0) {
      return canonicalRoot + pathOnly.slice(knownRoots[i].length);
    }
  }
  // 也处理虚拟 host 无 /seer2 前缀的情况
  if (pathOnly.indexOf('http://seer2.chunshu/') === 0 && pathOnly.indexOf('http://seer2.chunshu/seer2') !== 0) {
    return canonicalRoot + pathOnly.slice('http://seer2.chunshu'.length);
  }
  return pathOnly;
}

// ── URL 哈希策略 ──────────────────────────────────────────────────────────
// 对于可缓存的静态二进制资源（swf/png/jpg/mp3/ogg），文件内容完全由 URL 路径决定，
// 所有 query 参数（?_=、?t=、?rand=、?j3yi414w=、?v= 等）均为防缓存噪声，
// 哈希时直接取 '?' 之前的路径部分，彻底消除任意随机参数名带来的重复缓存问题。
//
// 例如游戏服务器使用随机字符串作为 query key（如 ?j3yi414w=0.508）：
//   NOISE_RE 无法匹配未知参数名 → 三次加载生成三个不同 hash → 三份重复缓存
//   path-only hash → 三次加载统一映射到同一 hash → 完美命中
//
// 对比方案（保留 ?v= 等语义参数）：不适用于 Flash 游戏——
// 该游戏的 ?v=xxx 与 ?j3yi414w=xxx 性质相同，均为随机时间戳，非 CDN 版本控制。
function _urlHash(url) {
  // 先规范化 URL（统一线路），再取 '?' 前的纯路径
  var normalized = _normalizeCacheUrl(url);
  return crypto.createHash('md5').update(normalized).digest('hex');
}

function _loadIndex() {
  if (_cacheIndex) return;
  _cacheIndex = new Map();
  if (!_cacheDir) return;
  var idxPath = path.join(_cacheDir, 'index.json');
  try {
    if (fs.existsSync(idxPath)) {
      var arr = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      arr.forEach(function(e) { if (e && e.hash) _cacheIndex.set(e.hash, e); });
    }
  } catch(e) { console.warn('[Cache] index load error:', e.message); }
}

function _saveIndex() {
  if (!_cacheDir || !_cacheIndex) return;
  _cacheIndexDirty = false;
  var arr = Array.from(_cacheIndex.values());
  var idxPath = path.join(_cacheDir, 'index.json');
  fs.writeFile(idxPath, JSON.stringify(arr), 'utf8', function(err) {
    if (err) console.warn('[Cache] index save error:', err.message);
  });
}

function _scheduleIndexSave() {
  _cacheIndexDirty = true;
  if (_cacheIndexTimer) return;
  _cacheIndexTimer = setTimeout(function() {
    _cacheIndexTimer = null;
    if (_cacheIndexDirty) _saveIndex();
  }, 2000);
}

// 根据 URL 计算缓存文件的相对路径（镜像 URL 目录结构）
//
// 规则（以游戏主服务器 43.138.190.6/seer2/ 为基准）：
//   http://43.138.190.6/seer2/module/app/GadSelectPetPanel.swf
//     → module/app/GadSelectPetPanel.swf     (strip host+/seer2/)
//   http://43.138.190.6/seer2/static/5bg.png
//     → static/5bg.png
//   http://43.138.190.6/seer2/Seer2CoreDLL.swf
//     → Seer2CoreDLL.swf                     (直接在 GameCache 根)
//
// 其他域名（用户替换规则使用网络地址时）：
//   http://xxx.com/2/1.swf  → xxx.com/2/1.swf
//   http://cdn.example.com/1.swf → cdn.example.com/1.swf
//
// 返回值：相对路径（不含 cacheDir 前缀），如 "module/app/GadSelectPetPanel.swf"
// 根据 URL 确定缓存来源分类（供 UI 分类展示）
//   'game'     → 改服主服务器（所有已知游戏线路）
//   'official' → 官服 seer2.61.com
//   'other'    → 其他域名
function _urlSourceType(url) {
  var m = (url || '').match(/^https?:\/\/([^/:]+)/i);
  if (!m) return 'other';
  var host = m[1].toLowerCase();
  if (host === '43.138.190.6') return 'game';
  if (host === 'o1.733702.xyz') return 'game';
  if (host === LOCAL_HOSTNAME) return 'game';   // seer2.chunshu
  if (host === _gameRootHost.toLowerCase()) return 'game'; // 当前动态后端
  if (host === 'seer2.61.com') return 'official';
  return 'other';
}

// 根据完整 URL（含协议）计算缓存相对路径，镜像目录结构：
//
//   http://43.138.190.6/seer2/module/app/Foo.swf → module/app/Foo.swf  (游戏主服，去 seer2/ 前缀)
//   http://o1.733702.xyz/seer2/res/login/bg.swf  → res/login/bg.swf    (已知线路，规范化后同上)
//   http://seer2.61.com/res/map/config/70.xml    → http_seer2.61.com/res/map/config/70.xml
//   https://s2.999962.xyz/Seer2CoreDLL.swf       → https_s2.999962.xyz/Seer2CoreDLL.swf
//   http://cdn.example.com:8080/a.swf            → http_cdn.example.com_8080/a.swf
//
// 协议前缀规则：协议_主机名[_端口]（下划线分隔，严格区分 http/https 和端口）
function _urlToRelPath(fullUrl) {
  try {
    // 先规范化：将所有已知游戏线路 URL 统一到默认线路
    var normalizedUrl = _normalizeCacheUrl(fullUrl);
    var urlNoQuery = (normalizedUrl || '').split('?')[0];
    var m = urlNoQuery.match(/^(https?):\/\/([^/]+)(\/.*)?$/i);
    if (!m) return null;
    var scheme      = m[1].toLowerCase();          // 'http' | 'https'
    var hostWithPort = m[2].toLowerCase();          // 'host' | 'host:port'
    var urlPath     = (m[3] || '/').replace(/^\/+/, '');

    // 游戏主服务器：去掉 seer2/ 前缀，存在根目录
    if (hostWithPort === '43.138.190.6' || hostWithPort.startsWith('43.138.190.6:')) {
      urlPath = urlPath.replace(/^seer2\//, '');
      return urlPath || null;
    }

    // 其他域名：scheme_host[_port]/path
    var parts    = hostWithPort.split(':');
    var hostname = parts[0];
    var port     = parts[1];
    var folder   = port ? (scheme + '_' + hostname + '_' + port)
                        : (scheme + '_' + hostname);
    return folder + '/' + urlPath;
  } catch(e) { return null; }
}


// 确保相对路径的父目录在 cacheDir 下存在
function _ensureDirForPath(cacheDir, relPath) {
  var parts = relPath.replace(/\\/g, '/').split('/');
  if (parts.length <= 1) return; // 根目录，无需创建子目录
  var dirParts = parts.slice(0, -1);
  var dir = cacheDir;
  for (var i = 0; i < dirParts.length; i++) {
    dir = path.join(dir, dirParts[i]);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir); } catch(e) {}
    }
  }
}

// 根据 URL 计算磁盘绝对路径，确保父目录存在，返回 { relPath, absPath }
function _resolveUrlCachePath(cacheDir, fullUrl, hash, ext) {
  var relPath = _urlToRelPath(fullUrl);
  if (!relPath) relPath = hash + '.' + ext;  // fallback
  _ensureDirForPath(cacheDir, relPath);
  return { relPath: relPath, absPath: path.join(cacheDir, relPath) };
}

// 删除文件后，递归向上清理空目录（直到 cacheDir 本身停止）
function _pruneEmptyDirs(dir, stopAt) {
  try {
    while (dir && dir !== stopAt && dir.startsWith(stopAt)) {
      var entries = fs.readdirSync(dir);
      if (entries.length > 0) break;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  } catch(e) {} // 静默失败，不阻断主流程
}

function setCacheDir(dir) {
  _cacheDir = dir;
  _cacheIndex = null; // reset so next access reloads
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
  catch(e) { console.warn('[Cache] mkdir failed:', e.message); _cacheDir = null; }
}

// 确保缓存目录存在：用户可能在运行中途手动删除 GameCache 文件夹。
// 每次写盘前调用，目录不存在则自动重建并重置索引，无需重启启动器。
function _ensureCacheDir() {
  if (!_cacheDir) return false;
  if (fs.existsSync(_cacheDir)) return true;
  try {
    fs.mkdirSync(_cacheDir, { recursive: true });
    _cacheIndex = null; // 目录重建后旧文件已丢失，强制重载空索引
    console.log('[Cache] Directory recreated after deletion:', _cacheDir);
    return true;
  } catch(e) {
    console.warn('[Cache] Failed to recreate cache dir:', e.message);
    return false;
  }
}

// Returns cache item {hash,filePath,...} if file exists on disk, else null
function _getCacheHit(urlStr) {
  if (!_cacheDir) return null;
  _loadIndex();
  var hash = _urlHash(urlStr);
  var cacheIdxEntry = _cacheIndex.get(hash);
  if (!cacheIdxEntry) return null;
  var filePath = path.join(_cacheDir, cacheIdxEntry.diskName || (cacheIdxEntry.hash + '.' + cacheIdxEntry.ext));
  if (!fs.existsSync(filePath)) { _cacheIndex.delete(hash); _scheduleIndexSave(); return null; }
  return { entry: cacheIdxEntry, filePath: filePath };
}

function _cleanupTempFile(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch(_) {}
}

function _finalizeCacheEntry(hash, relPath, url, ext, tmpPath, finalPath, size) {
  try {
    if (!size || size < 64) {
      _cleanupTempFile(tmpPath);
      return false;
    }
    fs.renameSync(tmpPath, finalPath);
    _loadIndex();
    // 存储规范化后的 URL（默认线路），确保 UI 重写逻辑能正确匹配
    var canonicalUrl = _normalizeCacheUrl(url);
    _cacheIndex.set(hash, {
      hash: hash,
      name: relPath.split('/').pop(),
      relPath: relPath,
      url: canonicalUrl,
      ext: ext,
      diskName: relPath,
      size: size,
      cachedAt: Date.now(),
      hitCount: 0,
    });
    _scheduleIndexSave();
    _evictCapturedUrl(url);
    return true;
  } catch(e) {
    console.warn('[Cache] finalize error:', e.message);
    _cleanupTempFile(tmpPath);
    return false;
  }
}

function _queueReplaceTargetCache(urlStr) {
  var fullUrl = String(urlStr || '').split('?')[0];
  if (!fullUrl || !_cacheDir) return;
  if (!/^https?:\/\//i.test(fullUrl)) return;
  if (_getCacheHit(fullUrl)) return;
  if (_replaceTargetCacheInFlight.has(fullUrl)) return;
  _replaceTargetCacheInFlight.add(fullUrl);
  try {
    var electronNet = require('electron').net;
    var req = electronNet.request({ url: fullUrl, method: 'GET', redirect: 'follow' });
    req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36');
    req.setHeader('Cache-Control', 'no-cache');
    req.setHeader('Accept-Encoding', 'identity');
    var chunks = [];
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      try { req.abort(); } catch(_) {}
      _replaceTargetCacheInFlight.delete(fullUrl);
    }, 20000);
    req.on('response', function(rsp) {
      var statusCode = rsp.statusCode || 0;
      rsp.on('data', function(chunk) { if (chunk && chunk.length) chunks.push(chunk); });
      rsp.on('end', function() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        _replaceTargetCacheInFlight.delete(fullUrl);
        if (statusCode !== 200) return;
        var body = Buffer.concat(chunks);
        if (!body || body.length < 64) return;
        if (!_ensureCacheDir()) return;
        var ext = (fullUrl.split('?')[0].split('.').pop() || 'bin').toLowerCase();
        var hash = _urlHash(fullUrl);
        var cachePaths = _resolveUrlCachePath(_cacheDir, fullUrl, hash, ext);
        var tmpPath = path.join(_cacheDir, hash + '.tmp');
        fs.writeFile(tmpPath, body, function(err) {
          if (err) { _cleanupTempFile(tmpPath); return; }
          _finalizeCacheEntry(hash, cachePaths.relPath, fullUrl, ext, tmpPath, cachePaths.absPath, body.length);
        });
      });
      rsp.on('error', function() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        _replaceTargetCacheInFlight.delete(fullUrl);
      });
    });
    req.on('error', function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _replaceTargetCacheInFlight.delete(fullUrl);
    });
    req.end();
  } catch(_) {
    _replaceTargetCacheInFlight.delete(fullUrl);
  }
}

function _queueRangeMissFill(urlStr) {
  var fullUrl = String(urlStr || '').split('?')[0];
  if (!fullUrl || !_cacheDir) return;
  if (_getCacheHit(fullUrl)) return;
  if (_rangeFillInFlight.has(fullUrl)) return;
  _rangeFillInFlight.add(fullUrl);
  try {
    var parsed = urlMod.parse(fullUrl);
    if (!parsed.hostname) throw new Error('invalid-url');
    var req = http.request({
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10) || 80,
      path: parsed.path || '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36',
        'Cache-Control': 'no-cache',
        'Accept-Encoding': 'identity',
      },
      agent: _getOutboundAgent(),
    }, function(rsp) {
      if ((rsp.statusCode || 0) !== 200) {
        _rangeFillInFlight.delete(fullUrl);
        return;
      }
      var ext = (fullUrl.split('.').pop() || 'bin').toLowerCase();
      var hash = _urlHash(fullUrl);
      var cachePaths = _resolveUrlCachePath(_cacheDir, fullUrl, hash, ext);
      var tmpPath = path.join(_cacheDir, hash + '.tmp');
      var enc = (rsp.headers['content-encoding'] || '').toLowerCase();
      var compressed = (enc === 'gzip' || enc === 'br' || enc === 'deflate');
      var writer = null;
      var decoder = null;
      var size = 0;
      var failed = false;
      try {
        if (!_ensureCacheDir()) throw new Error('cache-dir');
        writer = fs.createWriteStream(tmpPath);
        writer.on('error', function() { failed = true; _cleanupTempFile(tmpPath); });
        if (compressed) {
          decoder = enc === 'gzip' ? zlib.createGunzip() : enc === 'br' ? zlib.createBrotliDecompress() : zlib.createInflate();
          decoder.on('data', function(chunk) { size += chunk.length; });
          decoder.on('error', function() { failed = true; _cleanupTempFile(tmpPath); });
          decoder.pipe(writer);
        }
      } catch(_) {
        failed = true;
      }
      rsp.on('data', function(chunk) {
        if (failed || !writer || !chunk || !chunk.length) return;
        if (compressed) {
          try { decoder.write(chunk); } catch(_) { failed = true; _cleanupTempFile(tmpPath); }
        } else {
          size += chunk.length;
          try { writer.write(chunk); } catch(_) { failed = true; _cleanupTempFile(tmpPath); }
        }
      });
      rsp.on('end', function() {
        function done() { _rangeFillInFlight.delete(fullUrl); }
        if (failed || !writer) { done(); return; }
        if (compressed) {
          writer.once('finish', function() {
            if (!failed) _finalizeCacheEntry(hash, cachePaths.relPath, fullUrl, ext, tmpPath, cachePaths.absPath, size);
            done();
          });
          try { decoder.end(); } catch(_) { _cleanupTempFile(tmpPath); done(); }
        } else {
          writer.end(function() {
            if (!failed) _finalizeCacheEntry(hash, cachePaths.relPath, fullUrl, ext, tmpPath, cachePaths.absPath, size);
            done();
          });
        }
      });
      rsp.on('error', function() {
        failed = true;
        _cleanupTempFile(tmpPath);
        _rangeFillInFlight.delete(fullUrl);
      });
    });
    req.on('error', function() { _rangeFillInFlight.delete(fullUrl); });
    req.end();
  } catch(_) {
    _rangeFillInFlight.delete(fullUrl);
  }
}

function _scheduleCacheRescue(urlStr) {
  var fullUrl = String(urlStr || '').split('?')[0];
  if (!fullUrl || !_cacheDir) return;
  var normalized = _normalizeCapturePath(fullUrl).toLowerCase();
  if (normalized !== '/dll/assets.swf') return;
  setTimeout(function() {
    if (_getCacheHit(fullUrl)) return;
    _queueRangeMissFill(fullUrl);
  }, 3500);
}

// Public API for main.js IPC handlers
function getCacheList() {
  if (!_cacheDir) return [];
  _loadIndex();
  return Array.from(_cacheIndex.values()).map(function(e) {
    return Object.assign({}, e, {
      filePath:   path.join(_cacheDir, e.diskName || (e.hash + '.' + e.ext)),
      sourceType: _urlSourceType(e.url),   // 'game' | 'official' | 'other'
    });
  });
}
function getCacheDir() { return _cacheDir || ''; }
function deleteCacheItems(hashes) {
  if (!_cacheDir) return { ok: false, error: 'no cache dir' };
  _loadIndex();
  var deleted = 0;
  hashes.forEach(function(hash) {
    var delEntry = _cacheIndex.get(hash);
    if (!delEntry) return;
    var fp = path.join(_cacheDir, delEntry.diskName || (hash + '.' + delEntry.ext));
    try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); _pruneEmptyDirs(path.dirname(fp), _cacheDir); } } catch(e) {}
    _cacheIndex.delete(hash);
    deleted++;
  });
  _saveIndex();
  return { ok: true, deleted: deleted };
}

function clearAllCache() {
  if (!_cacheDir) return { ok: false, error: 'no cache dir' };
  _loadIndex();
  var deleted = 0;
  _cacheIndex.forEach(function(entry, hash) {
    var fp = path.join(_cacheDir, entry.diskName || (hash + '.' + entry.ext));
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch(e) {}
    deleted++;
  });
  _cacheIndex.clear();
  _saveIndex();
  // 清理 GameCache 下所有空子目录
  try { _pruneAllEmptyDirs(_cacheDir); } catch(e) {}
  return { ok: true, deleted: deleted };
}

// 递归清理目录树中所有空子目录
function _pruneAllEmptyDirs(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return;
  function pruneDir(dir) {
    try {
      var entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.forEach(function(e) { if (e.isDirectory()) pruneDir(path.join(dir, e.name)); });
      var remaining = fs.readdirSync(dir);
      if (remaining.length === 0 && dir !== rootDir) fs.rmdirSync(dir);
    } catch(e) {}
  }
  pruneDir(rootDir);
}

// No-op stubs (kept for API compatibility during transition)
function pushRequestLog() {}
function drainRequestLog() { return []; }

// keepAlive agent：Flash 每次会话发出 20-40+ 个 HTTP 请求，
// 复用 TCP 连接避免每次握手的 CPU 开销。
const _fwdAgentDirect = new http.Agent({
  keepAlive:      true,
  keepAliveMsecs: 10000,
  maxSockets:     16,
  maxFreeSockets: 8,
});

// ── SOCKS5/HTTP 代理 Agent（对 core-net 出站请求生效）─────────────────────
// 当用户在代理面板启用 SOCKS5/HTTP 代理时，所有 core-net 发出的 http.request
// 都通过此 agent 走代理隧道，确保德国线路等远程资源能正确加载。
let _proxyAgent = null;
let _proxyConfig = null;

function setProxyConfig(config) {
  _proxyConfig = config;
  _proxyAgent = null;
  if (config && config.enabled && config.host && config.port) {
    try {
      var SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
      var proxyUrl;
      if (config.username) {
        proxyUrl = 'socks5://' + encodeURIComponent(config.username) + ':' + encodeURIComponent(config.password || '') + '@' + config.host + ':' + config.port;
      } else {
        proxyUrl = 'socks5://' + config.host + ':' + config.port;
      }
      _proxyAgent = new SocksProxyAgent(proxyUrl, {
        keepAlive: true,
        keepAliveMsecs: 10000,
        maxSockets: 16,
        maxFreeSockets: 8,
        timeout: 30000,
      });
      console.log('[Proxy] SOCKS5 agent created for core-net:', config.host + ':' + config.port);
    } catch(e) {
      console.warn('[Proxy] Failed to create SOCKS5 agent:', e.message);
      _proxyAgent = null;
    }
  } else {
    console.log('[Proxy] core-net proxy disabled (direct)');
  }
}

// 获取当前应使用的出站 agent：代理启用时用 _proxyAgent，否则用直连 keepAlive agent
function _getOutboundAgent() {
  return _proxyAgent || _fwdAgentDirect;
}
// HTTPS keepAlive agent：用于网络替换规则中 https:// 目标 URL 的出站请求。
// 必须使用 https.Agent，http.Agent 传给 https.request() 会抛
// "Protocol 'https:' not supported. Expected 'http:'" 错误（Node.js 内部类型检查）。
const _fwdHttpsAgent = new (require('https').Agent)({
  keepAlive:           true,
  keepAliveMsecs:      10000,
  maxSockets:          8,
  maxFreeSockets:      4,
  rejectUnauthorized:  false,  // 允许自签名证书（替换目标可能是私有 CDN）
});

function getProxyPort()  { return _proxyPort; }

// ── 本地 HTTP 拦截代理 ────────────────────────────────────────────────────
/**
 * 启动本地 HTTP 代理服务，绑定到 127.0.0.1 随机端口。
 * Flash PPAPI 进程发出的 HTTP 请求绕过 Chromium webRequest，
 * 只有通过真实 HTTP 代理才能拦截。
 *
 * 路由规则（按优先级）：
 *   /img/*              → 从内存缓存返回图片资源
 *   INTERCEPT_PATHS     → 从内存缓存返回拦截的游戏文件
 *   HTML 页面请求       → 透传并 rewrite（wmode=direct, quality=medium, hasPriority=true）
 *   其余请求            → 直接转发至原服务器
 *
 * @returns {Promise<number>} 实际绑定的端口号
 */
function startInterceptProxy() {
  return new Promise(function(resolve, reject) {
    const srv = http.createServer(function(req, res) {
      const urlObj  = urlMod.parse(req.url);
      const reqPath = urlObj.pathname || '/';
      // ── 虚拟域名重写（PAC 路径）───────────────────────────────────────────
      // Flash WinINet 经 PAC 将 seer2.chunshu 请求路由到 core-net；
      // 在此处将 _rawHost 重写为真实目标主机，所有后续逻辑无感知。
      const _rawHost = (urlObj.hostname || req.headers.host || '').replace(/:\d+$/, '');
      const _virtualRoute = (_rawHost === LOCAL_HOSTNAME)
        ? resolveVirtualHostRoute(reqPath, urlObj.search || '')
        : null;
      const host = (_virtualRoute && !_virtualRoute.localHtml) ? _virtualRoute.host : _rawHost;
      const reqPathForHost = (_virtualRoute && !_virtualRoute.localHtml) ? (_virtualRoute.path.split('?')[0] || '/') : reqPath;
      const routeHostForOps = (_virtualRoute && !_virtualRoute.localHtml) ? _virtualRoute.host : host;
      const routePathForOps = (_virtualRoute && !_virtualRoute.localHtml) ? (_virtualRoute.path.split('?')[0] || '/') : reqPath;

      if (_virtualRoute && _virtualRoute.localHtml && _localGameIndexBuf) {
        try {
          var localOut2 = _applyHtmlTransform(_localGameIndexBuf);
          pushRequestLog({ method: req.method, url: reqPath, status: 200, type: 'LOCAL-HTML', size: localOut2.length });
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': localOut2.length,
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(localOut2);
          return;
        } catch(e) {}
      }

      // ── /img/ 路由：从内存缓存返回图片 ──────────────────────────────
      if (host === '127.0.0.1' && reqPath.startsWith('/img/')) {
        const imgName = reqPath.replace('/img/', '').split('?')[0];
        const ALLOWED = { 'qq-group.jpg':'image/jpeg','sponsor.jpg':'image/jpeg','bilibili.jpg':'image/jpeg','contact-qq.jpg':'image/jpeg' };
        const mime = ALLOWED[imgName];
        if (mime && _fileCache.has(imgName)) {
          const buf = _fileCache.get(imgName);
          res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
          res.end(buf);
        } else {
          res.writeHead(404); res.end('not found');
        }
        return;
      }

      // 所有用户规则共用同一套跨线路规范化键。
      var _replFullUrl = 'http://' + (routeHostForOps || '') + routePathForOps;
      var _replKey = _normalizeUrl(_normalizeCacheUrl(_replFullUrl));

      // 跨线路修复：先用 _normalizeCacheUrl 将请求 URL 统一到默认线路，
      // 再 _normalizeUrl 去协议/小写，与 setUserReplaceRules 中的 key 一致。
      if (_userReplaceCache.has(_replKey)) {
        var _replEntry = _userReplaceCache.get(_replKey);
        var _matchRule = _userReplaceRules.find(function(r) {
          return r.enabled && _normalizeUrl(_normalizeCacheUrl(r.url)) === _replKey;
        });
        if (_replEntry && _replEntry.kind === 'file') {
          var _localReplaceFile = _replEntry.file || ((_matchRule || {}).file || '');
          try {
            var _replStat = fs.statSync(_localReplaceFile);
            var _replBuf  = fs.readFileSync(_localReplaceFile);
            var _replMime = _guessMime(_localReplaceFile);
            res.writeHead(200, {
              'Content-Type': _replMime,
              'Content-Length': _replBuf.length,
              'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
              'Pragma': 'no-cache',
              'Expires': '0',
              'Last-Modified': _replStat.mtime.toUTCString(),
              'Access-Control-Allow-Origin': '*',
              'Connection': 'close',
            });
            res.end(_replBuf);
            console.log('[Replace] Fresh local file:', routePathForOps, '->', _localReplaceFile,
              'size=' + _replBuf.length, 'mtime=' + _replStat.mtime.toISOString());
            pushRequestLog({ method: req.method, url: routePathForOps, status: 200, type: 'REPLACE-FILE', size: _replBuf.length });
          } catch(e) {
            console.warn('[Replace] Local file read failed:', routePathForOps, '->', _localReplaceFile, e.code || e.message);
            res.writeHead(404, {
              'Content-Type': 'text/plain',
              'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
              'Pragma': 'no-cache',
              'Expires': '0',
              'Access-Control-Allow-Origin': '*',
              'Connection': 'close',
            });
            res.end('Replace local file not found');
          }
          return;
        }
        var _netTargetUrl = (_replEntry && _replEntry.url) || ((_matchRule || {}).file || '');
        if (_netTargetUrl && /^https?:\/\//i.test(_netTargetUrl)) {
          var _netTargetHost = '';
          try { _netTargetHost = (urlMod.parse(_netTargetUrl).hostname || '').toLowerCase(); } catch(_) {}
          var _useRedirectReplace = (
            _netTargetHost === OFFICIAL_HOST ||
            _netTargetHost === INTERCEPT_HOST ||
            _netTargetHost === LOCAL_HOSTNAME
          );
          if (_useRedirectReplace) {
          // 分流版使用 seer2.chunshu 虚拟域名作为 Flash 的入口。
          // 如果仍把官服 SWF/XML 的字节伪装成原始改服 URL 返回，部分官方 SWF
          // 会基于 loaderInfo.url / 相对路径推导出错误上下文，严重时直接打崩 Flash。
          // 网络替换改为真实 302 跳转：让 Flash 按目标 URL 加载，后续请求也自然落到目标域。
          res.writeHead(302, {
            'Location': _netTargetUrl,
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            'Connection': 'close',
          });
          res.end();
          pushRequestLog({ method: req.method, url: routePathForOps, status: 302, type: 'REPLACE-REDIRECT', size: 0 });
          return;
          }
          // ── 优先从磁盘缓存命中 ────────────────────────────────────────
          // 网络替换的缓存 key 基于目标 URL（而非原始拦截 URL），
          // 允许缓存任意类型文件（xml/json/swf 等），不受 CACHEABLE_EXTS 限制。
          var _netHash   = _urlHash(_netTargetUrl);
          var _netCacheHit = _cacheDir ? _getCacheHit(_netTargetUrl) : null;
          if (_netCacheHit) {
            var _nce = _netCacheHit.entry;
            _nce.hitCount = (_nce.hitCount || 0) + 1;
            _scheduleIndexSave();
            var _ncMime = MIME_MAP[_nce.ext] || _guessMime('f.' + _nce.ext);
            res.writeHead(200, {
              'Content-Type': _ncMime, 'Content-Length': _nce.size,
              'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public,max-age=86400',
              'X-Cache': 'HIT', 'Connection': 'close',
            });
            fs.createReadStream(_netCacheHit.filePath).on('error', function(){ try{res.end();}catch(_){} }).pipe(res);
            return;
          }
          // ── 网络请求并缓存响应（使用 electron.net，支持 HTTP/2 + TLS1.3 + 代理继承）──
          // 原先用 Node.js https.request()：Electron 11 Node.js 12.x 在与 Cloudflare Pages
          // 的 HTTP/2 + TLS 1.3 握手时存在 ALPN 协商问题，导致 ECONNRESET / 挂起超时。
          // electron.net 使用 Chromium 网络栈：
          //   ✓ 天然支持 HTTP/2 / QUIC
          //   ✓ 继承 session 代理配置（proxyCfg 设置的 SOCKS5/HTTP 代理自动生效）
          //   ✓ TLS 1.2/1.3 完整支持，无 ALPN 问题
          //   ✓ 自带 Cloudflare 能识别的 Chrome User-Agent
          (function() {
            var _electronNet = require('electron').net;
            var _nReq = _electronNet.request({
              url: _netTargetUrl,
              method: 'GET',
              redirect: 'follow',
            });
            _nReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36');
            _nReq.setHeader('Cache-Control', 'no-cache');
            var _nc = [], _settled = false;
            var _nTimeout = setTimeout(function() {
              if (_settled) return; _settled = true;
              try { _nReq.abort(); } catch(_) {}
              console.warn('[Replace] Net replace timeout 20s:', _netTargetUrl);
              try { res.writeHead(504, {'Content-Type':'text/plain'}); res.end('Replace timeout'); } catch(_) {}
            }, 20000);
            _nReq.on('response', function(_nRes) {
              var _chunks = [];
              _nRes.on('data', function(chunk) { _chunks.push(chunk); });
              _nRes.on('end', function() {
                if (_settled) return; _settled = true;
                clearTimeout(_nTimeout);
                var _nb = Buffer.concat(_chunks);
                var _nm = _guessMime(_netTargetUrl);
                try {
                  res.writeHead(_nRes.statusCode || 200, {
                    'Content-Type': _nm, 'Content-Length': _nb.length,
                    'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Connection': 'close',
                  });
                  res.end(_nb);
                } catch(_) {}
                // 异步缓存到磁盘
                if (_cacheDir && (_nRes.statusCode === 200 || !_nRes.statusCode) && _nb.length >= 16) {
                  var _nExt2 = (_netTargetUrl.split('?')[0].split('.').pop() || 'bin').toLowerCase();
                  var _nCachePaths = _resolveUrlCachePath(_cacheDir, _netTargetUrl, _netHash, _nExt2);
                  var _nTmp = path.join(_cacheDir, _netHash + '.tmp');
                  if (_ensureCacheDir()) {
                    fs.writeFile(_nTmp, _nb, function(we) {
                      if (we) return;
                      try {
                        fs.renameSync(_nTmp, _nCachePaths.absPath);
                        _loadIndex();
                        _cacheIndex.set(_netHash, {
                          hash: _netHash, name: _nCachePaths.relPath.split('/').pop(),
                          relPath: _nCachePaths.relPath, url: _netTargetUrl,
                          ext: _nExt2, diskName: _nCachePaths.relPath,
                          size: _nb.length, cachedAt: Date.now(), hitCount: 0,
                        });
                        _saveIndex();
                      } catch(e) { try { fs.unlinkSync(_nTmp); } catch(_) {} }
                    });
                  }
                }
              });
              _nRes.on('error', function(e) {
                if (_settled) return; _settled = true;
                clearTimeout(_nTimeout);
                console.warn('[Replace] Net replace response error:', _netTargetUrl, e.message);
                try { res.writeHead(502, {'Content-Type':'text/plain'}); res.end('Net replace error: ' + e.message); } catch(_) {}
              });
            });
            _nReq.on('error', function(e) {
              if (_settled) return; _settled = true;
              clearTimeout(_nTimeout);
              console.warn('[Replace] Net replace failed:', _netTargetUrl, e.message);
              try { res.writeHead(502, {'Content-Type':'text/plain'}); res.end('Net replace fetch failed: ' + e.message); } catch(_) {}
            });
            _nReq.end();
          })();
          return;
        }
      }

      // 留空规则（passthrough）：跳过内置拦截，直接转发网络原始资源
      var _isPassthrough = _userPassthroughKeys.has(_replKey);

      // ── crossdomain.xml: 任意来源均返回宽松 Flash 跨域策略 ──────────────
      // 兜底：protocol.interceptBufferProtocol 已在 main.js 拦截大多数情况，
      // 但 cache-miss 直连路径下请求仍经本地代理，
      // 此处统一拦截确保 Flash 跨域检查始终通过。
      if (reqPath === '/crossdomain.xml' || reqPath.endsWith('/crossdomain.xml')) {
        const _policyXml = '<?xml version="1.0"?><!DOCTYPE cross-domain-policy SYSTEM ' +
          '"http://www.macromedia.com/xml/dtds/cross-domain-policy.dtd">' +
          '<cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>';
        const _policyBuf = Buffer.from(_policyXml);
        pushRequestLog({ method: req.method, url: reqPath, status: 200, type: 'CROSSDOMAIN', size: _policyBuf.length });
        res.writeHead(200, {
          'Content-Type': 'text/x-cross-domain-policy',
          'Content-Length': _policyBuf.length,
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
          'Connection': 'close',
        });
        res.end(_policyBuf);
        return;
      }

      // ── 拦截的游戏文件：从内存缓存直接返回 ──────────────────────────

      const interceptEntry = (!_isPassthrough && host === _gameRootHost) ? INTERCEPT_PATHS[reqPathForHost] : null;
      if (interceptEntry) {
        if (_fileCache.has(interceptEntry.file)) {
          const buf = _fileCache.get(interceptEntry.file);
          // 不再对每个拦截请求调用 console.log（Flash 高峰期数百次/秒，会产生严重 GC 压力）。
          // 改用轻量缓冲区，由主进程 500ms 批次刷新。
          pushRequestLog({ method: req.method, url: reqPath, status: 200, type: 'INTERCEPT', size: buf.length });
          res.writeHead(200, { 'Content-Type': interceptEntry.mime, 'Content-Length': buf.length, 'Cache-Control': 'no-cache', 'Connection': 'close' });
          res.end(buf);
        } else {
          // 内存缓存尚未加载（启动竞态）→ 从磁盘读取并缓存
          // baseDir = __dirname = asar 虚拟路径；fs 通过 asar 集成层读取 asar 内嵌资源
          const baseDir = _baseDir;
          fs.readFile(path.join(baseDir, interceptEntry.file), function(err, data) {
            if (err) { res.writeHead(500); res.end('read error'); return; }
            _fileCache.set(interceptEntry.file, data);
            console.log('[Proxy] INTERCEPT (disk fallback)', reqPath, '→', interceptEntry.file);
            res.writeHead(200, { 'Content-Type': interceptEntry.mime, 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'Connection': 'close' });
            res.end(data);
          });
        }
        return;
      }

      // ── HTML 页面请求：透传并 rewrite ────────────────────────────────
      // wmode=direct    → Flash 直接渲染到窗口表面，跳过合成器路径
      // quality=medium  → 每帧光栅化开销减半（2D 游戏视觉一致）
      // hasPriority=true → 后台时 Flash 不被 Chromium 降频
      const isHtmlReq = (host === INTERCEPT_HOST) && (req.method === 'GET') &&
        (reqPath === '/seer2/' || reqPath === '/seer2/index.html' ||
         reqPath === '/seer2/index.php' ||
         (!reqPath.match(/\.(?:swf|xml|jpg|jpeg|png|gif|css|js|mp3|wav|ogg|flv|f4v|zip|amf)$/i) &&
          (req.headers['accept'] || '').indexOf('text/html') !== -1));

      if (isHtmlReq) {
        // ── 本地内置首页（零网络延迟，绕过服务器 HTML 请求）──────────────────
        if (_localGameIndexBuf) {
          try {
            var localOut = _applyHtmlTransform(_localGameIndexBuf);
            pushRequestLog({ method: req.method, url: reqPath, status: 200, type: 'LOCAL-HTML', size: localOut.length });
            res.writeHead(200, {
              'Content-Type':   'text/html; charset=utf-8',
              'Content-Length': localOut.length,
              'Cache-Control':  'no-store',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(localOut);
          } catch(e) {
            // 本地 HTML 处理失败时降级：继续走下方服务器请求路径
            console.warn('[LocalHTML] transform failed, falling back to server:', e.message);
          }
          return;
        }
        // ── 从服务器获取 HTML（本地 HTML 不可用时的兜底）────────────────────
        const hH = Object.assign({}, req.headers);
        delete hH['proxy-connection'];
        hH['host']            = INTERCEPT_HOST;
        hH['accept-encoding'] = 'identity';
        const hOpts = { hostname: INTERCEPT_HOST, port: 80, path: reqPath + (urlObj.search || ''), method: 'GET', headers: hH, agent: _getOutboundAgent() };
        const hReq  = http.request(hOpts, function(hRes) {
          const ct = hRes.headers['content-type'] || '';
          if (ct.indexOf('text/html') === -1) {
            res.writeHead(hRes.statusCode, hRes.headers);
            hRes.pipe(res); return;
          }
          const chunks = [];
          let totalSize = 0;
          const MAX_REWRITE_SIZE = 2 * 1024 * 1024;
          hRes.on('data', c => { chunks.push(c); totalSize += c.length; });
          hRes.on('end', function() {
            const raw = Buffer.concat(chunks);
            if (totalSize > MAX_REWRITE_SIZE) {
              const passHdrs = Object.assign({}, hRes.headers);
              res.writeHead(hRes.statusCode, passHdrs);
              res.end(raw);
              return;
            }
            function applyRewrite(buf) {
              try {
                const outBuf  = _applyHtmlTransform(buf);
                const outHdrs = Object.assign({}, hRes.headers);
                delete outHdrs['content-encoding'];
                delete outHdrs['transfer-encoding'];
                outHdrs['content-length'] = outBuf.length;
                outHdrs['cache-control']  = 'no-store';
                pushRequestLog({ method: req.method, url: reqPath, status: hRes.statusCode, type: 'HTML-REWRITE', size: outBuf.length });
                res.writeHead(hRes.statusCode, outHdrs);
                res.end(outBuf);
              } catch(e) {
                const passHdrs = Object.assign({}, hRes.headers);
                res.writeHead(hRes.statusCode, passHdrs);
                res.end(raw);
              }
            }
            const enc = (hRes.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip')    zlib.gunzip(raw, (err, d) => applyRewrite(err ? raw : d));
            else if (enc === 'br') zlib.brotliDecompress(raw, (err, d) => applyRewrite(err ? raw : d));
            else if (enc === 'deflate') zlib.inflate(raw, (err, d) => applyRewrite(err ? raw : d));
            else applyRewrite(raw);
          });
        });
        hReq.setTimeout(15000, () => { hReq.destroy(); try { res.writeHead(504); res.end('html timeout'); } catch(_) {} });
        hReq.on('error', e => { try { res.writeHead(502); res.end('html fwd err: ' + e.message); } catch(_) {} });
        req.pipe(hReq);
        return;
      }

      // ── 其余请求：直连转发 ────────────────────────────
      // Smart Cache 检查：仅对 GET 请求的可缓存静态资源（swf/png/jpg/mp3 等）启用
      if (_cacheDir && req.method === 'GET') {
        var reqExt = (reqPath.split('.').pop() || '').toLowerCase().split('?')[0];
        if (CACHEABLE_EXTS.has(reqExt)) {
          var fullUrl = 'http://' + (host || INTERCEPT_HOST) + reqPath.split('?')[0]; // 路径部分，与存储时一致
          var cacheHit = _getCacheHit(fullUrl);
          if (cacheHit) {
            // ── Cache HIT: 从磁盘流式返回 ──────────────────────────────
            // 必须显式注入以下响应头，否则 Flash Player 安全沙箱会静默拒绝：
            // 1. Access-Control-Allow-Origin: * — Flash 跨域策略严格要求此头，
            //    本地代理返回的响应不带此头时，Flash 的 BitmapData.draw()、
            //    Loader.load() 等 API 会抛 SecurityError，导致贴图/SWF 白屏。
            // 2. Content-Type: 从 entry.ext 字段查表（该字段在写入时已剥除查询参数），
            //    不从原始 URL 重新解析，避免 ?v=123 等参数干扰扩展名识别。
            //    回退值使用 image/png 而非 application/octet-stream：
            //    Flash 收到 octet-stream 时拒绝将其用作 BitmapData 背景图，
            //    而 image/png 回退能让 Flash 尝试解码，大幅减少白屏概率。
            // 3. Content-Length: 必须与实际文件大小一致，否则流可能被截断。
            var cacheEntry = cacheHit.entry;
            cacheEntry.hitCount = (cacheEntry.hitCount || 0) + 1;
            _scheduleIndexSave();
            // entry.ext 在存储时已通过 .split('?')[0] 剥除查询参数，直接查表即可
            var hitMime = MIME_MAP[cacheEntry.ext] || MIME_FALLBACK;
            res.writeHead(200, {
              'Content-Type':                   hitMime,
              'Content-Length':                  cacheEntry.size,
              'Access-Control-Allow-Origin':     '*',
              'Access-Control-Allow-Methods':    'GET, OPTIONS',
              'Access-Control-Allow-Headers':    'Content-Type, Range',
              'Access-Control-Expose-Headers':   'Content-Length, Content-Range',
              'Cache-Control':                   'public,max-age=86400',
              'X-Cache':                         'HIT',
              'Connection':                      'close',
            });
            var rs = fs.createReadStream(cacheHit.filePath);
            rs.on('error', function() { try { res.end(); } catch(_) {} });
            rs.pipe(res);
            pushRequestLog({ method: req.method, url: reqPath, status: 200, type: 'CACHE-HIT', size: cacheEntry.size });
            return;
          }
          if (req.headers && req.headers.range) _queueRangeMissFill(fullUrl);
        }
      }
      // 捕获未缓存的请求 URL（代理转发意味着未命中缓存）
      var _capUrl = 'http://' + (host || INTERCEPT_HOST) + reqPath.split('?')[0];
      _maybeCaptureRequest(_capUrl);
      _scheduleCacheRescue(_capUrl);
      {
        const tHost = host || INTERCEPT_HOST;
        const tPort = parseInt(urlObj.port) || 80;
        const fwdPath = _virtualRoute
          ? _virtualRoute.path
          : (req.url.replace(/^https?:\/\/[^/]+/, '') || '/');
        function _makeDirectHeaders(targetHost, targetPort) {
          const dH = Object.assign({}, req.headers);
          delete dH['proxy-connection'];
          dH['host'] = targetHost + (targetPort !== 80 ? ':' + targetPort : '');
          return dH;
        }
        // 直连路径：向目标服务器发出请求
        function _directForward(targetHost, targetPort, targetPath, cacheUrl, bodyBuf) {
          const dOpts = {
            hostname: targetHost,
            port: targetPort,
            path: targetPath,
            method: req.method,
            headers: _makeDirectHeaders(targetHost, targetPort),
            agent: _getOutboundAgent()
          };
          const dReq  = http.request(dOpts, function(dRes) {
          // Cache MISS 转发：将服务器原始响应头传给 Flash，
          // 同时注入 CORS 头（确保首次加载 Flash 也不被沙箱拦截）
          var fwdHeaders = Object.assign({}, dRes.headers);
          fwdHeaders['access-control-allow-origin']   = '*';
          fwdHeaders['access-control-allow-methods']  = 'GET, OPTIONS';
          fwdHeaders['access-control-allow-headers']  = 'Content-Type, Range';
          fwdHeaders['access-control-expose-headers'] = 'Content-Length, Content-Range';
          if (dRes.statusCode !== 200) _evictCapturedUrl(_capUrl);
          // ── Cache MISS 转发策略 ────────────────────────────────────────────
          // 原则：先保证 Flash 流畅加载，再异步写盘。
          //
          // 关键认知：Flash 是 HTTP 客户端，它自己处理 content-encoding:gzip 解压。
          // 因此 MISS 时把原始响应（含 gzip 头）直接流式转发给 Flash 完全正确，
          // Flash 能实时解压并渲染，不需要等待整个文件下载完成。
          //
          // 写盘策略：在流式转发的同时，把原始 chunks 收集到侧缓冲区；
          // 'end' 事件后再解压，把裸字节（PNG/SWF 原始二进制）写入 GameCache。
          // 这样 cache HIT 时能直接以正确 MIME 返回裸字节，无需解压，也不白屏。
          //
          // 非缓存路径（pipe）：直接 pipe 即可，不需要任何侧缓冲。

          var respEncoding = (dRes.headers['content-encoding'] || '').toLowerCase();
          var isCompressed = (respEncoding === 'gzip' || respEncoding === 'br' || respEncoding === 'deflate');

          // ── Cache MISS tee-stream ─────────────────────────────────────
          var doCache = _cacheDir && req.method === 'GET' && dRes.statusCode === 200;
          if (doCache) {
            var missExt = (targetPath.split('.').pop() || '').toLowerCase().split('?')[0];
            doCache = CACHEABLE_EXTS.has(missExt);
          }

          if (doCache) {
            var missUrl   = cacheUrl;
            var missHash  = _urlHash(cacheUrl);
            var missExt2  = (targetPath.split('.').pop() || '').toLowerCase().split('?')[0];
            var missUrlFull = cacheUrl;
            var mCachePaths = _resolveUrlCachePath(_cacheDir, missUrlFull, missHash, missExt2);
            var tmpPath   = path.join(_cacheDir, missHash + '.tmp');
            var finalPath = mCachePaths.absPath;
            var cacheWriter = null;
            var cacheDecode = null;
            var cacheBytes = 0;
            var cacheWriteFailed = false;
            if (_ensureCacheDir()) {
              try {
                cacheWriter = fs.createWriteStream(tmpPath);
                cacheWriter.on('error', function() { cacheWriteFailed = true; _cleanupTempFile(tmpPath); });
                if (isCompressed) {
                  cacheDecode = respEncoding === 'gzip' ? zlib.createGunzip() :
                                respEncoding === 'br'   ? zlib.createBrotliDecompress() :
                                                          zlib.createInflate();
                  cacheDecode.on('data', function(chunk) { cacheBytes += chunk.length; });
                  cacheDecode.on('error', function() { cacheWriteFailed = true; _cleanupTempFile(tmpPath); });
                  cacheDecode.pipe(cacheWriter);
                }
              } catch(e) {
                cacheWriter = null;
                cacheWriteFailed = true;
                console.warn('[Cache] stream init error:', e.message);
              }
            } else {
              cacheWriteFailed = true;
            }

            // 把原始响应头（含 gzip/chunked）直接转发给 Flash，Flash 自己解压
            res.writeHead(dRes.statusCode, dRes.headers);

            // 侧缓冲：收集 chunks 用于写盘，同时实时流给 Flash
            var sideChunks = [];
            dRes.on('data', function(chunk) {
              res.write(chunk);
              if (cacheWriteFailed || !cacheWriter || !chunk || !chunk.length) return;
              if (isCompressed) {
                try { cacheDecode.write(chunk); } catch(_) { cacheWriteFailed = true; _cleanupTempFile(tmpPath); }
              } else {
                cacheBytes += chunk.length;
                try { cacheWriter.write(chunk); } catch(_) { cacheWriteFailed = true; _cleanupTempFile(tmpPath); }
              }
              return;
              res.write(chunk);          // 立即流给 Flash，不等待
              sideChunks.push(chunk);   // 侧收集，写盘用
            });
            dRes.on('end', function() {
              res.end();
              if (cacheWriter && !cacheWriteFailed) {
                if (isCompressed) {
                  cacheWriter.once('finish', function() {
                    if (!cacheWriteFailed) _finalizeCacheEntry(missHash, mCachePaths.relPath, missUrl, missExt2, tmpPath, finalPath, cacheBytes);
                  });
                  try { cacheDecode.end(); } catch(_) { _cleanupTempFile(tmpPath); }
                } else {
                  cacheWriter.end(function() {
                    if (!cacheWriteFailed) _finalizeCacheEntry(missHash, mCachePaths.relPath, missUrl, missExt2, tmpPath, finalPath, cacheBytes);
                  });
                }
              }
              return;
              res.end();  // Flash 收到完整响应

              // 异步后台写盘（不阻塞任何响应）
              var rawBuf = Buffer.concat(sideChunks);
              sideChunks = null; // 释放引用，让 GC 回收

              function saveToDisk(decodedBuf) {
                if (decodedBuf.length < 64) return; // 过滤空文件/错误页
                if (!_ensureCacheDir()) return; // 目录不存在且无法重建则跳过写盘
                fs.writeFile(tmpPath, decodedBuf, function(writeErr) {
                  if (writeErr) { console.warn('[Cache] write error:', writeErr.message); return; }
                  try {
                    fs.renameSync(tmpPath, finalPath);
                    _loadIndex();
                    var mRelPath = mCachePaths.relPath;
                    var mFname   = mRelPath.split('/').pop();
                    _cacheIndex.set(missHash, {
                      hash: missHash, name: mFname, relPath: mRelPath, url: missUrl,
                      ext: missExt2, diskName: mRelPath,
                      size: decodedBuf.length,
                      cachedAt: Date.now(), hitCount: 0
                    });
                    _scheduleIndexSave();
                    // 文件已成功写入缓存 → 立即从实时捕获列表中移除该 URL
                    _evictCapturedUrl(missUrl);
                  } catch(e) {
                    console.warn('[Cache] rename error:', e.message);
                    try { fs.unlinkSync(tmpPath); } catch(_) {}
                  }
                });
              }

              if (isCompressed && rawBuf.length > 0) {
                // 服务器返回了 gzip/br/deflate — 解压后存裸字节
                var decomp = respEncoding === 'gzip'    ? zlib.gunzip :
                             respEncoding === 'br'      ? zlib.brotliDecompress :
                                                          zlib.inflate;
                decomp(rawBuf, function(err, decoded) {
                  saveToDisk(err ? rawBuf : decoded);
                });
              } else {
                // 服务器已返回裸字节，直接存盘
                saveToDisk(rawBuf);
              }
            });
            dRes.on('error', function() {
              _evictCapturedUrl(_capUrl);
              try { res.end(); } catch(_) {}
              try { fs.unlinkSync(tmpPath); } catch(_) {}
            });
          } else {
            // 非缓存路径：直接 pipe，零延迟
            res.writeHead(dRes.statusCode, dRes.headers);
            dRes.pipe(res);
          }
          });
          dReq.setTimeout(15000, () => {
            _evictCapturedUrl(_capUrl);
            dReq.destroy();
            try { res.writeHead(504); res.end('gateway timeout'); } catch(_) {}
          });
          dReq.on('error', e => {
            _evictCapturedUrl(_capUrl);
            try { res.writeHead(502); res.end('forward error: ' + e.message); } catch(_) {}
          });
          if (bodyBuf && bodyBuf.length) dReq.write(bodyBuf);
          dReq.end();
        }
        var _directBody = [];
        req.on('data', function(chunk) { if (chunk && chunk.length) _directBody.push(chunk); });
        req.on('end', function() {
          var bodyBuf = _directBody.length ? Buffer.concat(_directBody) : null;
          _directForward(tHost, tPort, fwdPath, 'http://' + tHost + (fwdPath.split('?')[0] || '/'), bodyBuf);
        });
      }
    });

    // ── HTTPS CONNECT 隧道 ─────────────────────────────────────────────
    srv.on('connect', function(req, clientSocket, head) {
      const parts = (req.url || '').split(':');
      const tHost = parts[0];
      const tPort = parseInt(parts[1]) || 443;
      const sSock = net.connect(tPort, tHost, function() {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        sSock.write(head); sSock.pipe(clientSocket); clientSocket.pipe(sSock);
      });
      sSock.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => { try { sSock.destroy(); } catch(_){} });
    });

    srv.listen(0, '127.0.0.1', function() {
      _proxyPort = srv.address().port;
      _proxyServer = srv;
      srv.keepAliveTimeout = 5000;
      srv.headersTimeout   = 10000;
      console.log('[Proxy] intercept proxy on 127.0.0.1:' + _proxyPort);
      resolve(_proxyPort);
    });
    srv.on('error', reject);
  });
}

// ── PAC 脚本构建 ───────────────────────────────────────────────────────────
/**
 * 构建 PAC 脚本：将 INTERCEPT_HOST 的流量引导至本地拦截代理，其余按 upstream 处理。
 * @param {string} [upstream]  上游代理字符串，例如 'PROXY 127.0.0.1:8888' 或 'DIRECT'
 */
function buildPacScript(upstream) {
  const up = upstream || 'DIRECT';
  // 将所有 HTTP 流量路由至本地缓存代理，使游戏访问任何域名的资源都能被拦截和缓存。
  // HTTPS 流量走 upstream（CONNECT 隧道透传，缓存在应用层处理）。
  // 注意：setProxy 仅作用于 gameWin 的 session，不影响主进程或其它窗口。
  return [
    'function FindProxyForURL(url, host) {',
    '  if (url.substring(0,6) === "https:") return "' + up + '";',
    '  return "PROXY 127.0.0.1:' + _proxyPort + '";',
    '}',
  ].join('\n');
}


// ── 实时捕获功能（调试期：记录所有请求，含缓存命中）──────────────────────
// 捕获模式：'off'（关闭）| 'all'（全部）| 'game'（改服）| 'official'（官服）| 'other'（其它）
// 调试时需要看到“已缓存但仍被请求”的资源，因此这里不再剔除缓存命中项。
// 捕获结果存内存，不写磁盘，刷新/重开登录器自动清空。
let _captureMode  = 'off';
let _captureItems = [];           // [{ url, host, sourceType, time, normPath }]
let _captureUrlSet = new Set();   // O(1) duplicate checks under high request volume
const MAX_CAPTURE = 2000;         // 内存上限，防止无限积累

function setCaptureMode(mode) {
  _captureMode = (mode === 'all' || mode === 'game' || mode === 'official' || mode === 'other')
    ? mode : 'off';
}
function getCaptureMode() { return _captureMode; }
function clearCapturedItems() {
  _captureItems = [];
  _captureUrlSet.clear();
}
function getCapturedItems() {
  return _captureItems.slice();
}

// 规范化 URL 路径，用于改服/官服跨域名路径比较：
// 改服 43.138.190.6 的路径带 /seer2/ 前缀，官服无此前缀，直接比较会不相等。
// 本函数统一去掉 /seer2/ 前缀，使两者路径可以对比。
// 例：http://43.138.190.6/seer2/res/login/createRole.swf → /res/login/createRole.swf
//     http://seer2.61.com/res/login/createRole.swf       → /res/login/createRole.swf
function _normalizeCapturePath(url) {
  try {
    var u = new URL(url);
    var p = u.pathname || '';
    if (
      u.hostname === INTERCEPT_HOST ||
      u.hostname === OFFICIAL_HOST ||
      u.hostname === LOCAL_HOSTNAME
    ) {
      p = p.replace(/^\/seer2(?=\/|$)/, '') || '/';
    }
    return p || '/';
  } catch(e) { return ''; }
}

// 写盘成功后从捕获列表中主动移除该 URL（立即生效，不依赖下次轮询）
// 同时移除"兄弟 URL"：改服/官服 URL 路径相同但域名不同，
// 当其中一个被缓存时另一个也应从捕获列表中清除。
function _evictCapturedUrl(url) {
  if (!url || _captureItems.length === 0) return;
  var normPath = _normalizeCapturePath(url);
  var next = [];
  for (var i = 0; i < _captureItems.length; i++) {
    var item = _captureItems[i];
    var itemNormPath = item.normPath || _normalizeCapturePath(item.url);
    var shouldRemove = item.url === url || (normPath && itemNormPath === normPath);
    if (shouldRemove) {
      _captureUrlSet.delete(item.url);
    } else {
      next.push(item);
    }
  }
  _captureItems = next;
}

/**
 * 在代理请求路径中调用：记录一个请求（调试期含缓存命中）。
 * reqUrl: 完整请求 URL（如 http://seer2.61.com/res/xxx.swf）
 */
function _maybeCaptureRequest(reqUrl) {
  if (_captureMode === 'off') return;
  // 去重：同一 URL 不重复记录。先走 Set，避免高频请求时反复线性扫描列表。
  if (_captureUrlSet.has(reqUrl)) return;
  var st = _urlSourceType(reqUrl);
  if (_captureMode !== 'all' && _captureMode !== st) return;
  // 超出上限时移除末尾（最旧的）条目，保持新的在前
  if (_captureItems.length >= MAX_CAPTURE) {
    var old = _captureItems.pop();
    if (old && old.url) _captureUrlSet.delete(old.url);
  }
  // 新条目插入头部，最新的排在最前面
  _captureUrlSet.add(reqUrl);
  _captureItems.unshift({
    url: reqUrl,
    sourceType: st,
    time: Date.now(),
    normPath: _normalizeCapturePath(reqUrl)
  });
}

module.exports = {
  INTERCEPT_HOST,
  OFFICIAL_HOST,
  setLocalGameIndex,
  setRenderQuality,
  INTERCEPT_PATHS,
  resolveVirtualHostRoute,
  setBloomRoutes,
  clearBloomRoutes,
  setGameBackend,
  setUserReplaceRules,
  getUserReplaceRules,
  setLocalSwfDir,
  loadFilesIntoMemory,
  setBaseDir,
  startInterceptProxy,
  buildPacScript,
  getProxyPort,
  // SOCKS5/HTTP 代理 Agent 管理（供 main.js 在代理配置变更时调用）
  setProxyConfig,
  // No-op stubs（保留 API 兼容性）
  pushRequestLog,
  drainRequestLog,
  // Smart Cache API（供 main.js 调用）
  setCacheDir,
  getCacheDir,
  getCacheList,
  deleteCacheItems,
  clearAllCache,
  // 实时捕获 API
  setCaptureMode,
  getCaptureMode,
  clearCapturedItems,
  getCapturedItems,
};
