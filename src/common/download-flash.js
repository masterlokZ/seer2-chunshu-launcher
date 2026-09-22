#!/usr/bin/env node
/**
 * download-flash.js — CI/CD Auto-Fetch for PPAPI Flash DLL (x64 build)
 *
 * 策略（按优先级）：
 *   1. flash/ 目录已有 .dll → 直接跳过（幂等）
 *   2. Windows 系统 Macromed 目录有 32位 PPAPI DLL → 直接复制（零网络依赖）
 *   3. 从 DOWNLOAD_URLS 列表按序下载（需要开发者自行填入有效 URL）
 *
 * 为什么优先"本地复制"：
 *   开发者本机能运行游戏，说明机器上已安装 32位 Flash。
 *   直接从系统目录复制比任何网络下载都可靠，且无版权/托管问题。
 *
 * 如需网络下载，请将真实可用的直链填入 DOWNLOAD_URLS 数组。
 */
'use strict';

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { URL } = require('url');
const { execSync } = require('child_process');

// ── 配置区 ────────────────────────────────────────────────────────────────
// 网络下载备用 URL（留空数组表示只使用本地复制，不尝试网络）
// 若有可用直链，按顺序填入，脚本会逐一尝试直到成功。
const DOWNLOAD_URLS = [
  // 'https://your-cdn.example.com/pepflashplayer32_34_0_0_330.dll',
];

const FLASH_DIR  = path.join(__dirname, 'flash');
const TIMEOUT_MS = 60000;

// ── Step 1: 确保 flash/ 目录存在 ─────────────────────────────────────────
if (!fs.existsSync(FLASH_DIR)) {
  console.log('[Flash] Creating flash/ directory...');
  try { fs.mkdirSync(FLASH_DIR, { recursive: true }); }
  catch(e) { console.error('[Flash] FATAL: Cannot create flash/ dir:', e.message); process.exit(1); }
}

// ── 架构目标检测（必须在 Step 2 幂等性检查之前定义）─────────────────────
// ⚠️ 此脚本由系统 Node.js（x64）执行，process.arch 永远是 'x64'，
//    不能用它判断目标 Electron 架构。从 build.bat 设置的环境变量读取。
var _targetArch = process.env.ELECTRON_ARCH
               || process.env.npm_config_arch
               || process.env.npm_config_target_arch
               || 'x64';  // 缺省回退 x64
var _archIs64 = (_targetArch !== 'ia32');

// ── Step 2: 幂等性检查（架构感知）────────────────────────────────────────
// 双架构构建时 flash/ 可能已有对方架构的 DLL，不能用"有任何 DLL"来跳过。
// 必须检查"当前目标架构的 DLL 是否已存在"。
// x64 → 含 '64' 的 pepflashplayer DLL；ia32 → 含 '32' 的 pepflashplayer DLL
// 通用文件名（不含 32/64）也视为满足，兜底跳过。
try {
  var _allDlls = fs.readdirSync(FLASH_DIR).filter(function(f) {
    return f.toLowerCase().startsWith('pepflashplayer') && f.toLowerCase().endsWith('.dll');
  });
  var _wantTag = _archIs64 ? '64' : '32';
  var _matchDll = _allDlls.filter(function(f) {
    var l = f.toLowerCase();
    return l.includes(_wantTag) || (!l.includes('32') && !l.includes('64'));
  });
  if (_matchDll.length > 0) {
    console.log('[Flash] Arch-matched DLL already exists, skipping:', _matchDll[0]);
    process.exit(0);
  }
} catch(e) { /* 继续尝试 */ }

// ── Step 3: 从 Windows 系统目录本地复制（最可靠方案）─────────────────────
// 开发者机器上若已安装 Flash Player，PPAPI DLL 必然在以下两个目录之一：
//   - System32\Macromed\Flash\  → 64位 OS 上的 64位 DLL（不适用）
//   - SysWOW64\Macromed\Flash\  → 64位 OS 上的 32位 DLL ✓
//   - System32\Macromed\Flash\  → 32位 OS 上的 32位 DLL ✓
var SYS_FLASH_DIRS = _archIs64
  ? [
      path.join('C:', 'Windows', 'System32',  'Macromed', 'Flash'),  // 64位 DLL（x64 优先）
      path.join('C:', 'Windows', 'SysWOW64',  'Macromed', 'Flash'),  // 32位 DLL（回退）
    ]
  : [
      path.join('C:', 'Windows', 'SysWOW64',  'Macromed', 'Flash'),  // 32位 DLL（ia32 优先）
      path.join('C:', 'Windows', 'System32',  'Macromed', 'Flash'),  // 回退
    ];

console.log('[Flash] No DLL in flash/ — checking Windows system Macromed directories...');
var copiedFromSystem = false;

for (var si = 0; si < SYS_FLASH_DIRS.length; si++) {
  var sysDir = SYS_FLASH_DIRS[si];
  if (!fs.existsSync(sysDir)) {
    console.log('[Flash]   Not found:', sysDir);
    continue;
  }
  try {
    var sysFiles = fs.readdirSync(sysDir);
    // 在系统目录中找 32位 PPAPI DLL（文件名含 pepflashplayer32 或 pepflashplayer）
    var flashDlls = sysFiles.filter(function(f) {
      var lower = f.toLowerCase();
      // 优先选 32位版本（明确含 32 字样的），避免误选 64位
      return lower.startsWith('pepflashplayer') && lower.endsWith('.dll');
    });
    // 排序：优先选与当前架构匹配的 DLL（x64 优先 '64'，ia32 优先 '32'）
    var _want = _archIs64 ? '64' : '32';
    flashDlls.sort(function(a, b) {
      var aMatch = a.toLowerCase().includes(_want);
      var bMatch = b.toLowerCase().includes(_want);
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
      return 0;
    });

    for (var fi = 0; fi < flashDlls.length; fi++) {
      var srcPath  = path.join(sysDir, flashDlls[fi]);
      var destName = flashDlls[fi]; // 保留原始文件名
      var destPath = path.join(FLASH_DIR, destName);
      try {
        var stat = fs.statSync(srcPath);
        if (!stat.isFile() || stat.size < 100 * 1024) continue; // 跳过小文件
        console.log('[Flash]   Found system DLL:', srcPath);
        console.log('[Flash]   Copying to flash/', destName + '...');
        fs.copyFileSync(srcPath, destPath);
        var sizeMb = (stat.size / 1024 / 1024).toFixed(2);
        console.log('[Flash] SUCCESS! Copied ' + sizeMb + ' MB → ' + destPath);
        copiedFromSystem = true;
        break;
      } catch(copyErr) {
        console.warn('[Flash]   Copy failed:', copyErr.message);
      }
    }
  } catch(readErr) {
    console.warn('[Flash]   Cannot read', sysDir, ':', readErr.message);
  }
  if (copiedFromSystem) break;
}

if (copiedFromSystem) {
  process.exit(0);
}

console.log('[Flash] No system Flash DLL found. Trying network download...');

// ── Step 4: 代理检测 ─────────────────────────────────────────────────────
function detectSystemProxy() {
  var envProxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
                 process.env.HTTP_PROXY  || process.env.http_proxy;
  if (envProxy) { console.log('[Proxy] Using env proxy:', envProxy); return envProxy; }
  if (process.platform === 'win32') {
    try {
      var regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      var enableOut = execSync('reg query "' + regKey + '" /v ProxyEnable 2>nul', { encoding:'utf8', windowsHide:true });
      var enableMatch = enableOut.match(/ProxyEnable\s+REG_DWORD\s+(0x\w+)/i);
      if (!enableMatch || parseInt(enableMatch[1], 16) !== 1) { console.log('[Proxy] System proxy disabled.'); return null; }
      var serverOut = execSync('reg query "' + regKey + '" /v ProxyServer 2>nul', { encoding:'utf8', windowsHide:true });
      var serverMatch = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
      if (!serverMatch || !serverMatch[1].trim()) return null;
      var proxy = serverMatch[1].trim();
      var normalized = proxy.startsWith('http') ? proxy : 'http://' + proxy;
      console.log('[Proxy] Detected Windows system proxy:', normalized);
      return normalized;
    } catch(e) {}
  }
  console.log('[Proxy] No proxy detected.');
  return null;
}

// ── Step 5: 网络下载（DOWNLOAD_URLS 为空则跳过）─────────────────────────
if (!DOWNLOAD_URLS.length) {
  console.error('[Flash] FATAL: No system Flash DLL found and DOWNLOAD_URLS is empty.');
  console.error('[Flash] Solutions:');
  console.error('[Flash]   A) Install Flash Player on the build machine, then re-run this script.');
  console.error('[Flash]   B) Manually copy pepflashplayer32_*.dll into the flash/ folder.');
  console.error('[Flash]   C) Add a valid direct-download URL to DOWNLOAD_URLS in download-flash.js.');
  process.exit(1);
}

function buildProxyAgent(proxyStr, targetUrl) {
  if (!proxyStr) return null;
  try {
    var pu = new URL(proxyStr);
    var tu = new URL(targetUrl);
    return { proxyHost:pu.hostname, proxyPort:parseInt(pu.port||'80',10), targetHost:tu.hostname, targetPort:parseInt(tu.port||(tu.protocol==='https:'?'443':'80'),10) };
  } catch(e) { console.warn('[Proxy] Parse error:', e.message); return null; }
}

function downloadUrl(dlUrl, destPath, proxyInfo, redirectCount) {
  redirectCount = redirectCount || 0;
  return new Promise(function(resolve, reject) {
    if (redirectCount > 8) return reject(new Error('Too many redirects'));
    var parsed   = new URL(dlUrl);
    var isHttps  = parsed.protocol === 'https:';
    var protocol = isHttps ? https : http;
    var tmpPath  = destPath + '.tmp';

    var makeReq = function(opts) {
      var req = protocol.request(opts, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return downloadUrl(res.headers.location, destPath, proxyInfo, redirectCount+1).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        var total = parseInt(res.headers['content-length']||'0',10), received=0, lastPct=-1;
        var out = fs.createWriteStream(tmpPath);
        out.on('error', function(e){ try{fs.unlinkSync(tmpPath);}catch(_){} reject(e); });
        res.on('data', function(c){ received+=c.length; if(total>0){var p=Math.floor(received/total*100);if(p>=lastPct+10){lastPct=p;console.log('[Flash]   '+(received/1024/1024).toFixed(1)+'/'+(total/1024/1024).toFixed(1)+' MB ('+p+'%)');}} });
        res.on('error', function(e){ try{fs.unlinkSync(tmpPath);}catch(_){} reject(e); });
        res.on('end', function(){ out.end(function(){ try{ var s=fs.statSync(tmpPath); if(s.size<100*1024){fs.unlinkSync(tmpPath);return reject(new Error('File too small: '+s.size+'B'));} fs.renameSync(tmpPath,destPath); console.log('[Flash]   Done! '+(s.size/1024/1024).toFixed(2)+' MB'); resolve(); }catch(e){reject(e);} }); });
        res.pipe(out);
      });
      req.setTimeout(TIMEOUT_MS, function(){ req.destroy(new Error('Timeout')); });
      req.on('error', function(e){ try{if(fs.existsSync(tmpPath))fs.unlinkSync(tmpPath);}catch(_){} reject(e); });
      req.end();
    };

    if (proxyInfo && isHttps) {
      var tr = http.request({ host:proxyInfo.proxyHost, port:proxyInfo.proxyPort, method:'CONNECT', path:proxyInfo.targetHost+':'+proxyInfo.targetPort, headers:{Host:proxyInfo.targetHost+':'+proxyInfo.targetPort} });
      tr.setTimeout(TIMEOUT_MS, function(){ tr.destroy(new Error('Proxy CONNECT timeout')); });
      tr.on('connect', function(pr, socket){ if(pr.statusCode!==200){socket.destroy();return reject(new Error('Proxy CONNECT: HTTP '+pr.statusCode));} makeReq({host:proxyInfo.targetHost,port:proxyInfo.targetPort,path:parsed.pathname+(parsed.search||''),method:'GET',agent:new https.Agent({socket:socket}),headers:{Host:proxyInfo.targetHost,'User-Agent':'seer2-launcher-build/1.0'}}); });
      tr.on('error', function(e){ reject(e); });
      tr.end();
    } else {
      var opts={hostname:parsed.hostname,port:parseInt(parsed.port||(isHttps?'443':'80'),10),path:parsed.pathname+(parsed.search||''),method:'GET',headers:{'User-Agent':'seer2-launcher-build/1.0'}};
      if (proxyInfo && !isHttps){ opts.hostname=proxyInfo.proxyHost; opts.port=proxyInfo.proxyPort; opts.path=dlUrl; }
      makeReq(opts);
    }
  });
}

async function main() {
  var proxyStr = detectSystemProxy();
  for (var i = 0; i < DOWNLOAD_URLS.length; i++) {
    var tryUrl = DOWNLOAD_URLS[i];
    var outFile = path.join(FLASH_DIR, path.basename(tryUrl).split('?')[0] || 'pepflashplayer32_34_0_0_330.dll');
    console.log('\n[Flash] Trying URL ' + (i+1) + '/' + DOWNLOAD_URLS.length + ':', tryUrl);
    try {
      await downloadUrl(tryUrl, outFile, buildProxyAgent(proxyStr, tryUrl), 0);
      console.log('[Flash] SUCCESS! Downloaded to:', outFile);
      process.exit(0);
    } catch(e) {
      console.warn('[Flash] URL ' + (i+1) + ' failed:', e.message);
      if (i < DOWNLOAD_URLS.length-1) console.log('[Flash] Trying next URL...');
    }
  }
  console.error('\n[Flash] FATAL: All download attempts failed.');
  console.error('[Flash] Please add a valid URL to DOWNLOAD_URLS in download-flash.js, or manually place the DLL in flash/');
  process.exit(1);
}

main().catch(function(e){ console.error('[Flash] Unhandled:', e); process.exit(1); });
