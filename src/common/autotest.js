'use strict';
/**
 * Autotest harness for the launcher.
 *
 * Activated by env var LAUNCHER_AUTOTEST=1. When NOT set, this module is a
 * complete no-op (zero runtime effect, no side effects, no hook registration).
 * When set, it:
 *   - Logs every major Electron lifecycle event with the stable prefix
 *     "[AUTOTEST] " so external stress harnesses can grep without relying
 *     on any UI or ready-to-show signal.
 *   - Stubs dialog.showErrorBox so a fatal-dialog path never blocks the
 *     process in an unattended run.
 *   - Sets LAUNCHER_AUTOTEST_BYPASS_FLASH=1 by default so the launcher does
 *     not hard-exit when Flash DLL is absent in a dev workspace. The main.js
 *     setupFlash() function honors this env var (see main.js).
 *   - After LAUNCHER_AUTOTEST_EXIT_AFTER_MS (default 3000ms) from whenReady,
 *     calls app.quit(). If quit is vetoed or stalls, force-exits after a
 *     safety timeout via app.exit(code).
 *   - Tracks failure conditions (uncaughtException / unhandledRejection /
 *     did-fail-load on main frame / render-process-gone / showErrorBox
 *     invocation) and sets exit code 1 on any failure, 0 otherwise.
 *
 * This file is test infrastructure. It does not modify any business logic.
 */

const enabled = process.env.LAUNCHER_AUTOTEST === '1';
const exitAfterMs = Math.max(500, parseInt(process.env.LAUNCHER_AUTOTEST_EXIT_AFTER_MS || '3000', 10) || 3000);

module.exports = { enabled: enabled, exitAfterMs: exitAfterMs };

if (!enabled) {
  return; // top-level return is legal in CommonJS modules
}

// Default-on: bypass Flash DLL requirement when autotesting a dev workspace.
// Semantics of LAUNCHER_AUTOTEST_BYPASS_FLASH:
//   '1'            -> explicit bypass (setupFlash short-circuits)
//   '0' (or empty) -> explicit NO bypass (real Flash path exercised)
//   undefined      -> default to '1' (dev workspace has no flash/ dir)
if (process.env.LAUNCHER_AUTOTEST_BYPASS_FLASH === undefined) {
  process.env.LAUNCHER_AUTOTEST_BYPASS_FLASH = '1';
}

const electron = require('electron');
const app = electron.app;
const dialog = electron.dialog;

let failure = false;
const failureReasons = [];
let exitTimer = null;
let quitKicked = false;

function safeJson(v) {
  try {
    if (v && (v instanceof Error || v.stack)) {
      return JSON.stringify({
        message: String(v.message || ''),
        stack: String(v.stack || '').split(/\r?\n/).slice(0, 10).join(' | '),
      });
    }
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

function log(tag, data) {
  const line = '[AUTOTEST] ' + tag + (data === undefined ? '' : ' ' + safeJson(data));
  try { process.stdout.write(line + '\n'); } catch (_) {}
}

function markFailure(reason, data) {
  failure = true;
  failureReasons.push(reason);
  log('FAILURE ' + reason, data);
}

function kickQuit(reason) {
  if (quitKicked) return;
  quitKicked = true;
  log('kickQuit', { reason: reason });
  try { app.quit(); } catch (_) {}
  // Safety net: if quit is vetoed or stalls, force exit after 4s.
  setTimeout(function () {
    log('forceExit', { failure: failure, reasons: failureReasons });
    try { app.exit(failure ? 1 : 0); } catch (_) { process.exit(failure ? 1 : 0); }
  }, 4000);
}

// --- Stub dialog.showErrorBox so modal dialogs never block in autotest. ---
try {
  const origShowErrorBox = dialog.showErrorBox;
  dialog.showErrorBox = function (title, content) {
    markFailure('showErrorBox', {
      title: String(title || ''),
      contentHead: String(content || '').slice(0, 400),
    });
  };
  // Keep reference alive to avoid "unused" flags.
  void origShowErrorBox;
} catch (_) {}

// --- Process-level exception capture (registers BEFORE main.js handlers). ---
process.on('uncaughtException', function (err) {
  markFailure('uncaughtException', err);
});
process.on('unhandledRejection', function (reason) {
  markFailure('unhandledRejection', { reason: String(reason && reason.stack || reason) });
});

log('init', { pid: process.pid, exitAfterMs: exitAfterMs, bypassFlash: process.env.LAUNCHER_AUTOTEST_BYPASS_FLASH === '1' });

// Heartbeat: every 200ms, write a stdout line with a monotonically
// increasing counter and elapsed ms. If the process is terminated by a
// native crash (no JS exception, no render-process-gone), the last
// heartbeat number tells us how far into the lifetime the process got.
// Also acts as a stdout flush pressure valve so prior log lines land on
// disk before a sudden exit.
var _heartbeatStart = Date.now();
var _heartbeatCount = 0;
var _heartbeatTimer = setInterval(function () {
  _heartbeatCount++;
  var ms = Date.now() - _heartbeatStart;
  try {
    process.stdout.write('[AUTOTEST] hb ' + _heartbeatCount + ' +' + ms + 'ms\n');
  } catch (_) {}
}, 200);
_heartbeatTimer.unref();

// Force stdout flush on any planned exit so trailing log lines survive.
process.on('exit', function (code) {
  try {
    process.stdout.write('[AUTOTEST] processExit code=' + code + ' hb=' + _heartbeatCount + '\n');
  } catch (_) {}
});

function trimUrl(u) { return String(u || '').slice(0, 300); }

app.whenReady().then(function () {
  log('whenReady');
  exitTimer = setTimeout(function () { kickQuit('timer'); }, exitAfterMs);
}).catch(function (err) {
  markFailure('whenReady-rejected', err);
  kickQuit('whenReady-rejected');
});

app.on('browser-window-created', function (_e, win) {
  if (!win) return;
  log('browser-window-created', { id: win.id });
  try {
    const wc = win.webContents;
    wc.on('did-finish-load', function () {
      try { log('did-finish-load', { id: win.id, url: trimUrl(wc.getURL()) }); } catch (_) {}
    });
    wc.on('did-fail-load', function (_e2, code, desc, url, isMainFrame) {
      const data = { code: code, desc: String(desc || ''), url: trimUrl(url), isMain: !!isMainFrame };
      if (isMainFrame) markFailure('did-fail-load', data); else log('did-fail-load-subframe', data);
    });
    wc.on('render-process-gone', function (_e3, details) {
      markFailure('render-process-gone', details);
    });
    wc.on('unresponsive', function () { log('webcontents-unresponsive', { id: win.id }); });
  } catch (_) {}
});

app.on('before-quit', function () { log('before-quit'); });
app.on('will-quit', function () {
  log('will-quit', { failure: failure, reasons: failureReasons });
  if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
});
app.on('window-all-closed', function () { log('window-all-closed'); });
app.on('quit', function (_e, code) {
  log('quit', { systemCode: code, failure: failure, reasons: failureReasons });
});
