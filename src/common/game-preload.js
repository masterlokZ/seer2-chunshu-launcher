// Game window preload — runs synchronously before the page HTML is parsed.
// Primary defense: core-net.js injects <style> CSS directly into the HTML response,
// guaranteeing body content is hidden before the first render frame.
// This preload only handles: mousedown forwarding + emergency fallback overlay.
'use strict';
const { ipcRenderer } = require('electron');

// ── mousedown 转发（点击游戏区域关闭未固定 overlay 窗口）────────────────────
document.addEventListener('mousedown', function() {
  ipcRenderer.send('game-window-click');
}, true);

// ── 紧急兜底遮罩（防范 coreNet 注入失败的极端场景）─────────────────────────
// 注：正常情况下 coreNet 的 HTML 内嵌 CSS 已完整覆盖白屏问题，此处代码
// 几乎不会实际生效（HTML CSS 已在第一帧前生效）。
// 仅作为双重保险：若 HTML 注入失败（如 Fiddler 模式直连、缓存命中等），
// preload 覆盖层保证用户永远不会看到白底或底部导航栏。
;(function() {
  try {
    // 立即注入黑色遮罩到 <html>（position:fixed 不依赖 body 存在）
    var ol = document.createElement('div');
    ol.id = '__sl_overlay';
    ol.style.cssText =
      'position:fixed;left:0;top:0;width:100vw;height:100vh;' +
      'background:#000;' +
      'z-index:2147483647;pointer-events:none;' +
      'transition:opacity .35s ease;';
    document.documentElement.appendChild(ol);

    // Flash embed 挂载后自动淡出遮罩
    function _watch(root) {
      var obs = new MutationObserver(function() {
        var em = document.querySelector('embed[type*="flash"],embed[src*=".swf"]');
        if (em) {
          obs.disconnect();
          setTimeout(function() {
            ol.style.opacity = '0';
            setTimeout(function() {
              try { if (ol.parentNode) ol.parentNode.removeChild(ol); } catch(_) {}
            }, 380);
          }, 200);
        }
      });
      obs.observe(root, { childList: true, subtree: true });
    }

    if (document.body) {
      _watch(document.body);
    } else {
      var bw = new MutationObserver(function() {
        if (document.body) { bw.disconnect(); _watch(document.body); }
      });
      bw.observe(document.documentElement, { childList: true });
    }

    // 10 秒兜底：Flash 加载失败时不永久黑屏
    setTimeout(function() {
      try { var e = document.getElementById('__sl_overlay'); if (e && e.parentNode) e.parentNode.removeChild(e); } catch(_) {}
    }, 10000);
  } catch(_) {}
})();

// ── 前端实时自适应与丝滑缩放引擎 ──────────────────────────────────────────
// 配合主进程的双模式缩放机制（帧放大矢量重绘模式 / 平滑拉伸防卡顿模式）：
// 1. 监听 window resize，以 requestAnimationFrame 高频实时驱动；
// 2. 容器与画面在窗口拉伸/最大化/还原过程中始终等比自适应居中，杜绝四周黑边滞后；
// 3. 配合 CSS transition 与 will-change 优化，提供丝滑平顺的缩放过渡。
;(function() {
  var DESIGN_W = 1200;
  var DESIGN_H = 660;
  var _rafId = null;

  function _findTarget() {
    return document.querySelector(
      'embed#Client, embed[name="Client"], object#Client, ' +
      'embed[type*="flash"], embed[src*=".swf"], object[type*="flash"]'
    );
  }

  function _ensureLayout(target) {
    var center = document.getElementById('__flash_center');
    if (center) {
      center.style.position = 'relative';
      center.style.width = '100%';
      center.style.height = '100%';
      center.style.display = 'flex';
      center.style.alignItems = 'center';
      center.style.justifyContent = 'center';
      center.style.overflow = 'hidden';
      center.style.zIndex = '0';
    }
    var menuBars = document.querySelectorAll('#toolbar, #nav, #menu, .toolbar, .menu, .nav, header');
    for (var mi = 0; mi < menuBars.length; mi++) {
      menuBars[mi].style.position = 'relative';
      menuBars[mi].style.zIndex = '9999';
    }

    var wrap = document.getElementById('flashContentWrap');
    if (wrap && wrap !== document.body) {
      wrap.style.width = DESIGN_W + 'px';
      wrap.style.height = DESIGN_H + 'px';
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.justifyContent = 'center';
      wrap.style.overflow = 'visible';
    }

    var box = document.getElementById('flashbox');
    if (box) {
      box.style.width = DESIGN_W + 'px';
      box.style.height = DESIGN_H + 'px';
      box.style.display = 'flex';
      box.style.alignItems = 'center';
      box.style.justifyContent = 'center';
      box.style.overflow = 'visible';
    }

    var content = document.getElementById('flashContent');
    if (content) {
      content.style.width = DESIGN_W + 'px';
      content.style.height = DESIGN_H + 'px';
      content.style.display = 'flex';
      content.style.alignItems = 'center';
      content.style.justifyContent = 'center';
      content.style.overflow = 'visible';
    }

    if (target) {
      target.style.width = DESIGN_W + 'px';
      target.style.height = DESIGN_H + 'px';
      target.style.display = 'block';
      target.style.transformOrigin = 'center center';
      target.style.willChange = 'transform';
      target.style.backfaceVisibility = 'hidden';
      if (!target.style.transition) {
        target.style.transition = 'transform 0.08s cubic-bezier(0.25, 0.1, 0.25, 1)';
      }
    }
  }

  function _onResizeTick() {
    _rafId = null;
    var target = _findTarget();
    if (!target) return;

    _ensureLayout(target);

    var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    if (!vw || !vh) return;

    var factor = Math.min(vw / DESIGN_W, vh / DESIGN_H);
    factor = Math.max(0.5, Math.min(factor, 3.0));

    // frameZoom 模式（物理矢量重绘）与 DOM 缩放模式的协同自适应：
    // 在 frameZoom 模式下，主进程会设置 webContents.setZoomFactor(factor)，此时 vw/vh 缩放后
    // 计算出的 factor 约为 1.0 (例如 1200/1200=1.0)，transform 为 none；
    // 当窗口正在拉伸变动而主进程 setZoomFactor 尚未到达的短暂间隙，前端通过实时 scale(factor)
    // 立即撑满视口，消除四周大黑边，主进程更新完成后自然无缝交接为矢量重绘。
    if (window.__sl_frame_zoom_mode === false) {
      target.style.transform = 'scale(' + factor + ')';
    } else {
      if (Math.abs(factor - 1.0) < 0.01) {
        target.style.transform = 'none';
      } else {
        target.style.transform = 'scale(' + factor + ')';
      }
    }
  }

  function _scheduleResizeTick() {
    if (!_rafId) {
      _rafId = requestAnimationFrame(_onResizeTick);
    }
  }

  window.addEventListener('resize', _scheduleResizeTick, { passive: true });
  window.addEventListener('orientationchange', _scheduleResizeTick, { passive: true });
  document.addEventListener('DOMContentLoaded', _scheduleResizeTick, { once: true });
})();
