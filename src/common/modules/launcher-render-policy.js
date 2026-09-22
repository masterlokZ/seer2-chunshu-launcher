'use strict';

const DEFAULT_CONFIG = Object.freeze({
  quality:'high',
  // 帧放大：开启时（true）每帧矢量重绘极清，关闭时（false）平滑拉伸防卡顿；
  // 两种模式下画面均根据窗口大小等比放大并完整铺满窗口。
  frameZoom:false,
  uClientRenderMode:'cpu',
});

// Native Flash stage quality values.  Keep this list deliberately small and
// explicit so malformed/legacy config files cannot inject arbitrary markup.
// `best` is the highest native Flash quality (more expensive rasterization).
const VALID_QUALITIES = Object.freeze(['low','medium','high','best']);
const VALID_UClient_RENDER_MODES = Object.freeze(['cpu']);

function normalizeConfig(value) {
  value = value || {};
  var requestedQuality = String(value.quality || '').toLowerCase();
  var quality = VALID_QUALITIES.indexOf(requestedQuality) >= 0
    ? requestedQuality : DEFAULT_CONFIG.quality;
  // 帧放大是显式持久化的登陆器偏好。缺省回退到默认值。
  // 支持用户配置为 true（每帧矢量重绘极清）或 false（平滑拉伸防卡顿模式）。
  // 旧 quality-config.json 里废弃的 GPU 加速开关字段被彻底忽略：
  // 不再解析、不再映射，也不得影响任何行为。
  var frameZoom = value.frameZoom !== undefined
    ? value.frameZoom !== false
    : DEFAULT_CONFIG.frameZoom;
  return {
    quality:quality,
    frameZoom:frameZoom,
    uClientRenderMode:'cpu',
  };
}

function readConfig(fs, file) {
  try {
    if (fs.existsSync(file)) return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch(_) {}
  return normalizeConfig(DEFAULT_CONFIG);
}

function writeConfig(fs, file, value) {
  var config = normalizeConfig(value);
  try {
    fs.writeFileSync(file, JSON.stringify({
      version:3,
      quality:config.quality,
      frameZoom:config.frameZoom,
      uClientRenderMode:config.uClientRenderMode,
      updatedAt:new Date().toISOString(),
    }, null, 2), 'utf8');
    return { ok:true, config:config };
  } catch(error) {
    return { ok:false, error:error.message };
  }
}

function initializeEarly(options) {
  var config = readConfig(options.fs, options.configFile);
  // Normalize an existing v1/v2 low/medium file before any renderer observes
  // it.  Frame zoom remains independent and is intentionally preserved.
  try {
    if (options.fs.existsSync(options.configFile)) {
      writeConfig(options.fs, options.configFile, config);
    }
  } catch(_) {}
  // 32 位环境的底层稳定基线：无条件禁用 Chromium GPU 合成。
  // （硬件加速不再是可配置项，帧放大在应用层完成。）
  try { options.app.disableHardwareAcceleration(); } catch(_) {}
  return {
    config:config,
  };
}

function appendChromiumSwitches(app, arch) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-site-isolation-trials');
  var disabledFeatures = [
    'IsolateOrigins','site-per-process','SitePerProcess',
    'TranslateUI','AutofillServerCommunication','Translate',
    'MediaRouter','DialMediaRouteProvider','OptimizationHints',
    'CertificateTransparencyComponentUpdater',
    'BackForwardCache','AudioServiceOutOfProcess',
    'SpareRendererForSitePerProcess','Prerender2',
    'PrefetchPrivacyChanges','NetworkServiceSandbox',
  ];
  if (arch !== 'x64') disabledFeatures.push('D3D11');
  app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
  app.commandLine.appendSwitch('ignore-certificate-errors');
  app.commandLine.appendSwitch('ignore-ssl-errors');
  app.commandLine.appendSwitch('allow-insecure-localhost');
  app.commandLine.appendSwitch('proxy-bypass-list', '<local>;localhost;127.0.0.1');
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --optimize-for-size');
  app.commandLine.appendSwitch('disable-extensions');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-default-apps');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('disable-translate');
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-client-side-phishing-detection');
  app.commandLine.appendSwitch('disable-hang-monitor');
  app.commandLine.appendSwitch('disable-prompt-on-repost');
  app.commandLine.appendSwitch('no-first-run');
  app.commandLine.appendSwitch('no-pings');
  app.commandLine.appendSwitch('disk-cache-size', '1');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
  app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('renderer-process-limit', '1');
  app.commandLine.appendSwitch('process-per-site');
  if (arch !== 'x64') {
    app.commandLine.appendSwitch('use-angle', 'd3d9');
    app.commandLine.appendSwitch('in-process-gpu');
  }
  return disabledFeatures.slice();
}

module.exports = {
  DEFAULT_CONFIG:DEFAULT_CONFIG,
  VALID_QUALITIES:VALID_QUALITIES,
  VALID_UClient_RENDER_MODES:VALID_UClient_RENDER_MODES,
  normalizeConfig:normalizeConfig,
  readConfig:readConfig,
  writeConfig:writeConfig,
  initializeEarly:initializeEarly,
  appendChromiumSwitches:appendChromiumSwitches,
};
