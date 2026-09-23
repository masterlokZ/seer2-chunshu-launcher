'use strict';
/**
 * preload.js — Seer2 Launcher 渲染进程预加载脚本
 *
 * IPC 监听器防泄漏：
 *   _safeOn(channel, fn) 在绑定新监听器前先调用 removeAllListeners(channel)，
 *   确保同一频道的旧监听器不会无限堆叠（overlay 反复 show/hide 时尤为重要）。
 *
 * Log 面板已完全移除：
 *   getLog, getLogFiles, readLogFile, openLogFolder, getStartupLog,
 *   getLogRetention, setLogRetention, getLogMaxSize, setLogMaxSize
 *   —— 以上 API 已全部删除，对应 IPC 频道已在 main.js 中一并注销。
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── _safeOn：防监听器泄漏包装 ────────────────────────────────────────────
// 每次注册前先清空该频道所有监听器，确保只有一个有效回调，彻底断绝堆叠根因。
function _safeOn(channel, fn) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, fn);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ── 游戏控制 ─────────────────────────────────────────────────────────
  launchGame:      () => ipcRenderer.send('launch-game'),
  closeApp:        () => ipcRenderer.send('close-app'),
  openExternal:    (url) => ipcRenderer.send('open-external', url),

  // ── 状态查询 ─────────────────────────────────────────────────────────
  getStatus:     () => ipcRenderer.invoke('get-status'),
  getStatusData: () => ipcRenderer.invoke('get-status'),
  openFlashPath: () => ipcRenderer.invoke('open-flash-path'),

  // ── 缓存/刷新 ────────────────────────────────────────────────────────
  clearCacheAndReload: () => ipcRenderer.invoke('clear-cache-reload'),
  clearCacheOnly:      () => ipcRenderer.invoke('clear-cache-only'),
  reloadGame:          () => ipcRenderer.send('overlay-reload'),
  restartLauncher:     () => ipcRenderer.send('restart-launcher'),

  // ── 内存扫描 ─────────────────────────────────────────────────────────
  memScanNew:    (value, scanType)  => ipcRenderer.invoke('mem-scan-new',  { value, scanType: scanType || 'int32' }),
  memScanNext:   (value, addresses) => ipcRenderer.invoke('mem-scan-next', { value, addresses }),
  memRead:       (addr)             => ipcRenderer.invoke('mem-read',  addr),
  memWrite:      (addr, value)      => ipcRenderer.invoke('mem-write', { addr, value }),
  memBatchWrite: (items)            => ipcRenderer.invoke('mem-batch-write', items),
  memListProcs:  ()                 => ipcRenderer.invoke('mem-list-procs'),
  memRefreshPpapi: ()               => ipcRenderer.invoke('mem-refresh-ppapi'),
  getScanPage:   (page)             => ipcRenderer.invoke('get-scan-page', page),



  // ── 代理 ─────────────────────────────────────────────────────────────
  getProxyConfig: ()    => ipcRenderer.invoke('get-proxy-config'),
  setProxyConfig: (cfg) => ipcRenderer.invoke('set-proxy-config', cfg),

  // ── Flash 原生画质 ───────────────────────────────────────────────────
  getQualityConfig: () => ipcRenderer.invoke('get-quality-config'),
  setQualityConfig: (config) => ipcRenderer.invoke('set-quality-config', config || {}),

  // ── 工具 ─────────────────────────────────────────────────────────────
  clipboardWrite:   (text)   => ipcRenderer.invoke('clipboard-write', text),
  setOverlayPinned: (pinned) => ipcRenderer.send('overlay-set-pinned', !!pinned),
  // Smart Cache
  getCacheList:      ()         => ipcRenderer.invoke('get-cache-list'),
  deleteCacheItems:  (hashes)   => ipcRenderer.invoke('delete-cache-items', hashes),
  clearAllCache:     ()         => ipcRenderer.invoke('clear-all-cache'),
  openCacheFolder:   (dir)      => ipcRenderer.invoke('open-cache-folder', dir),
  openCacheFile:     (filePath) => ipcRenderer.invoke('open-cache-file', filePath),
  // 覆盖窗口主动请求关闭/隐藏自身，由 main.js 'hide-self' handler 统一处理
  hideSelf:     () => ipcRenderer.send('hide-self'),
  // 覆盖窗口主动请求最小化自身（独立任务栏条目），由 main.js 'minimize-self' handler 处理
  minimizeSelf: () => ipcRenderer.send('minimize-self'),

  // ── 请求替换 ──────────────────────────────────────────────────────────
  getCurrentServer:    ()      => ipcRenderer.invoke('get-current-server'),
  onSelectedServerChanged: (cb) => _safeOn('selected-server-changed', (_, d) => cb(d)),
  getReplaceRules:     ()      => ipcRenderer.invoke('get-replace-rules'),
  setReplaceRules:     (rules) => ipcRenderer.invoke('set-replace-rules', rules),
  browseReplaceFile:   ()      => ipcRenderer.invoke('browse-replace-file'),
  normalizeReplaceFilePath:(p) => ipcRenderer.invoke('normalize-replace-file-path', p),
  importReplaceRules:  ()      => ipcRenderer.invoke('import-replace-rules'),
  exportReplaceRules:  ()      => ipcRenderer.invoke('export-replace-rules'),
  onReplaceRulesChanged: (cb)  => _safeOn('replace-rules-changed', (_, d) => cb(d)),

  // ── 缓存窗口标签持久化（会话级，登录器关闭即重置）──────────────────────
  getCacheTab: ()      => ipcRenderer.invoke('get-cache-tab'),
  setCacheTab: (tab)   => ipcRenderer.invoke('set-cache-tab', tab),

  // ── 实时捕获 ─────────────────────────────────────────────────────────
  getCaptureConfig:    ()       => ipcRenderer.invoke('get-capture-config'),
  setCaptureMode:      (mode)   => ipcRenderer.invoke('set-capture-mode', mode),
  getCapturedItems:    ()       => ipcRenderer.invoke('get-captured-items'),
  clearCapturedItems:  ()       => ipcRenderer.invoke('clear-captured-items'),
  onCaptureCleared:    (cb)     => _safeOn('capture-cleared',   ()     => cb()),

  // ── 变速 ─────────────────────────────────────────────────────────────
  setGameSpeed: (factor) => ipcRenderer.invoke('set-game-speed', factor),
  getGameSpeed: ()       => ipcRenderer.invoke('get-game-speed'),
  onSpeedReset: (cb)     => _safeOn('speed-reset', (_, d) => cb(d)),

  // ── 事件订阅（全部使用 _safeOn 防堆叠）──────────────────────────────
  onGameLaunched:  (cb) => _safeOn('game-launched',  (_, d) => cb(d)),
  onGameReloading: (cb) => _safeOn('game-reloading', (_, d) => cb(d)),
  onGameClosed:    (cb) => _safeOn('game-closed',    ()     => cb()),
  onGameLoadError: (cb) => _safeOn('game-load-error',(_, d) => cb(d)),
  onProxyChanged:  (cb) => _safeOn('proxy-changed',  (_, d) => cb(d)),

});
