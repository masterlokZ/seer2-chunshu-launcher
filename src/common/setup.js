'use strict';
const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 10808;
const FLASH_DIR  = path.join(__dirname, 'flash');

function log(m)  { process.stdout.write('[INFO]  ' + m + '\n'); }
function ok(m)   { process.stdout.write('[OK]    ' + m + '\n'); }
function warn(m) { process.stdout.write('[WARN]  ' + m + '\n'); }
function err(m)  { process.stdout.write('[ERROR] ' + m + '\n'); }
function sep()   { process.stdout.write('-'.repeat(52) + '\n'); }

function isValidDll(p) {
  return fs.existsSync(p) && fs.statSync(p).size > 100 * 1024;
}

// Find any valid pepflash dll already in our flash/ dir
function findLocalFlash() {
  if (!fs.existsSync(FLASH_DIR)) return null;
  const dlls = fs.readdirSync(FLASH_DIR)
    .filter(f => f.toLowerCase().includes('pepflash') && f.endsWith('.dll'));
  for (const f of dlls) {
    const full = path.join(FLASH_DIR, f);
    if (isValidDll(full)) return full;
  }
  return null;
}

function findSystemFlash() {
  const dirs = [
    path.join('C:', 'Windows', 'System32', 'Macromed', 'Flash'),
    path.join('C:', 'Windows', 'SysWOW64', 'Macromed', 'Flash'),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const dlls = fs.readdirSync(d)
      .filter(f => f.toLowerCase().startsWith('pepflashplayer64') && f.endsWith('.dll'));
    for (const f of dlls) {
      const full = path.join(d, f);
      if (isValidDll(full)) return full;
    }
  }
  return null;
}

function findChromeFlash() {
  const bases = [
    path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application'),
    path.join('C:', 'Program Files (x86)', 'Google', 'Chrome', 'Application'),
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application'),
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const versions = fs.readdirSync(base).filter(d => /^\d+\./.test(d)).reverse();
    for (const v of versions) {
      for (const name of ['pepflashplayer64.dll', 'pepflashplayer.dll']) {
        const p = path.join(base, v, name);
        if (isValidDll(p)) return p;
      }
    }
  }
  return null;
}

function downloadViaCurl(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log('Downloading: ' + url);
  const r = spawnSync('curl.exe', [
    '--proxy', 'socks5://' + PROXY_HOST + ':' + PROXY_PORT,
    '--location', '--fail', '--retry', '3', '--retry-delay', '2',
    '--connect-timeout', '30', '--max-time', '300',
    '--output', dest, url,
  ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 360000 });
  if (r.status !== 0) {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
    throw new Error('curl exit code ' + r.status);
  }
}

async function ensureFlash() {
  sep();
  log('Checking Pepper Flash plugin...');

  // Already have a valid dll in flash/
  const local = findLocalFlash();
  if (local) {
    ok('Flash DLL ready: ' + local);
    return true;
  }

  // Copy from system — KEEP THE ORIGINAL FILENAME so version can be parsed
  const sys = findSystemFlash() || findChromeFlash();
  if (sys) {
    ok('Found system Flash: ' + sys);
    fs.mkdirSync(FLASH_DIR, { recursive: true });
    const destName = path.basename(sys); // e.g. pepflashplayer64_34_0_0_330.dll
    const destPath = path.join(FLASH_DIR, destName);
    fs.copyFileSync(sys, destPath);
    ok('Copied as: ' + destPath);
    return true;
  }

  // Download installer from Adobe CDN via proxy
  log('Flash not found locally, downloading from Adobe CDN...');
  const tmpDir  = path.join(os.tmpdir(), 'seer2flash');
  const exePath = path.join(tmpDir, 'flashinstaller.exe');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    downloadViaCurl(
      'https://fpdownload.macromedia.com/pub/flashplayer/updaters/32/flashplayer_32_ppapi.exe',
      exePath
    );
  } catch (e) {
    err('Download failed: ' + e.message);
    return false;
  }

  if (!fs.existsSync(exePath) || fs.statSync(exePath).size < 1000) {
    err('Downloaded installer is invalid');
    return false;
  }

  ok('Running silent install (UAC may appear)...');
  spawnSync(exePath, ['/install'], { stdio: 'inherit', timeout: 120000 });
  try { fs.unlinkSync(exePath); } catch (_) {}
  try { fs.rmdirSync(tmpDir); }   catch (_) {}

  const installed = findSystemFlash();
  if (!installed) { err('DLL not found after install.'); return false; }

  fs.mkdirSync(FLASH_DIR, { recursive: true });
  const destPath = path.join(FLASH_DIR, path.basename(installed));
  fs.copyFileSync(installed, destPath);
  ok('Flash installed: ' + destPath);
  return true;
}

function removeReadOnly(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          removeReadOnly(full);
        } else {
          const mode = fs.statSync(full).mode;
          // Add write permission for owner/group/others
          fs.chmodSync(full, mode | 0o222);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

function npmInstall() {
  sep();
  log('Removing read-only attributes...');
  removeReadOnly(__dirname);
  ok('Read-only attributes cleared.');

  // ── 清理已知的错误格式代理环境变量 ─────────────────────────────────
  // 错误现象：getaddrinfo ENOTFOUND http=127.0.0.1
  // 根因：系统/用户环境变量中存在格式错误的代理变量（如 http=127.0.0.1），
  //        global-agent 模块会扫描所有 env，将其当做主机名尝试 DNS 解析而失败。
  // 修复：在传入 env 之前，明确将这些可能被污染的变量清零（空字符串覆盖）。
  const cleanEnv = Object.assign({}, process.env, {
    // 覆盖格式错误的裸变量名（无 _proxy 后缀）
    http:  undefined,
    https: undefined,
    ftp:   undefined,
    // 统一设置格式正确的代理变量
    HTTP_PROXY:  'http://' + PROXY_HOST + ':' + PROXY_PORT,
    HTTPS_PROXY: 'http://' + PROXY_HOST + ':' + PROXY_PORT,
    http_proxy:  'http://' + PROXY_HOST + ':' + PROXY_PORT,
    https_proxy: 'http://' + PROXY_HOST + ':' + PROXY_PORT,
    NO_PROXY:    'localhost,127.0.0.1',
    no_proxy:    'localhost,127.0.0.1',
    ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    // 阻止 global-agent 从 env 自动读取代理（使用 npm 显式 --proxy 参数代替）
    GLOBAL_AGENT_HTTP_PROXY:  undefined,
    GLOBAL_AGENT_HTTPS_PROXY: undefined,
  });
  // undefined 值在 Object.assign 后仍存在键，需要二次删除
  const forbiddenKeys = ['http', 'https', 'ftp', 'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY'];
  forbiddenKeys.forEach(function(k) { delete cleanEnv[k]; });

  const npmCmd =
    'npm install' +
    ' --registry=https://registry.npmmirror.com' +
    ' --proxy=http://' + PROXY_HOST + ':' + PROXY_PORT +
    ' --https-proxy=http://' + PROXY_HOST + ':' + PROXY_PORT;

  const spawnOpts = { cwd: __dirname, stdio: 'inherit', timeout: 300000, env: cleanEnv };

  // ── 第一次尝试 ──────────────────────────────────────────────────────
  log('Running npm install (attempt 1)...');
  try {
    execSync(npmCmd, spawnOpts);
    ok('npm install completed.');
    return true;
  } catch (e) {
    warn('npm install attempt 1 failed. Removing package-lock.json and retrying...');
    try { fs.unlinkSync(path.join(__dirname, 'package-lock.json')); } catch (_) {}
  }

  // ── 第二次尝试（删除 package-lock.json 后）──────────────────────────
  log('Running npm install (attempt 2)...');
  try {
    execSync(npmCmd, spawnOpts);
    ok('npm install completed.');
    return true;
  } catch (e) {
    warn('npm install attempt 2 failed. Trying without proxy...');
  }

  // ── 第三次尝试（不使用代理，直连镜像源）──────────────────────────────
  log('Running npm install (attempt 3, no proxy)...');
  const noProxyEnv = Object.assign({}, cleanEnv, {
    HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
  });
  try {
    execSync(
      'npm install --registry=https://registry.npmmirror.com',
      Object.assign({}, spawnOpts, { env: noProxyEnv })
    );
    ok('npm install completed (no proxy).');
    return true;
  } catch (e) {
    err('All npm install attempts failed: ' + e.message);
    err('[HINT] 1) 检查网络/代理  2) 手动删除 node_modules  3) 重新运行 setup.bat');
    return false;
  }
}

async function main() {
  process.stdout.write('\n');
  sep();
  process.stdout.write(' Seer2 Launcher - Setup\n');
  process.stdout.write(' Electron 11.x (Chromium 87, Flash supported)\n');
  process.stdout.write(' Proxy: ' + PROXY_HOST + ':' + PROXY_PORT + '\n');
  sep();

  const npmOk   = npmInstall();
  if (!npmOk) { err('Setup failed.'); process.exit(1); }

  const flashOk = await ensureFlash();

  sep();
  process.stdout.write(' Summary\n');
  sep();
  process.stdout.write(' npm deps : OK\n');
  process.stdout.write(' Flash DLL: ' + (flashOk ? 'OK' : 'MISSING') + '\n');
  sep();
  process.stdout.write('\n[DONE] Starting launcher...\n\n');
}

main().catch(e => { err(e.message); process.exit(1); });
