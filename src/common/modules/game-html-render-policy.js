'use strict';

function setTagAttribute(tag, name, value) {
  var attr = new RegExp('(\\s' + name + '\\s*=\\s*)(?:"[^"]*"|\'[^\']*\'|[^\\s>]+)', 'i');
  if (attr.test(tag)) return tag.replace(attr, '$1"' + value + '"');
  return tag.replace(/(\/?\s*>\s*)$/, ' ' + name + '="' + value + '"$1');
}

function readTagAttribute(tag, name) {
  var attr = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  var match = tag.match(attr);
  return match ? String(match[1] || match[2] || match[3] || '') : '';
}

function ensureObjectParam(html, name, value) {
  var tagRe = /<\s*(\/?)\s*(object|param)\b[^>]*>/gi;
  var stack = [];
  var objects = [];
  var changes = [];
  var match;
  while ((match = tagRe.exec(html)) !== null) {
    var closing = !!match[1];
    var kind = String(match[2] || '').toLowerCase();
    if (kind === 'object') {
      if (closing) {
        if (stack.length) stack.pop();
      } else {
        var record = { openEnd:tagRe.lastIndex, hasParam:false };
        objects.push(record);
        stack.push(record);
      }
    } else if (!closing && stack.length && readTagAttribute(match[0], 'name').toLowerCase() === name) {
      stack[stack.length - 1].hasParam = true;
      changes.push({ start:match.index, end:tagRe.lastIndex, text:setTagAttribute(match[0], 'value', value) });
    }
  }
  objects.forEach(function(record) {
    if (!record.hasParam) {
      changes.push({
        start:record.openEnd,
        end:record.openEnd,
        text:'<param name="' + name + '" value="' + value + '"/>',
      });
    }
  });
  changes.sort(function(a, b) { return b.start - a.start; }).forEach(function(change) {
    html = html.slice(0, change.start) + change.text + html.slice(change.end);
  });
  return html;
}

function replaceSwfObjectParam(html, name, value) {
  var escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var pattern = new RegExp(
    '(\\.addParam\\s*\\(\\s*([\'\"])' + escapedName + '\\2\\s*,\\s*)([\'\"])[^\'\"]*\\3',
    'gi'
  );
  return html.replace(pattern, function(_match, prefix, _nameQuote, valueQuote) {
    return prefix + valueQuote + value + valueQuote;
  });
}

function normalizeConfig(current, update) {
  update = update || {};
  var requestedQuality = String(
    update.quality !== undefined ? update.quality : (current && current.quality)
  ).toLowerCase();
  var allowedQualities = ['low','medium','high','best'];
  var requestedFrameZoom = update.frameZoom !== undefined
    ? update.frameZoom
    : (current ? current.frameZoom : undefined);
  var next = {
    quality:allowedQualities.indexOf(requestedQuality) >= 0 ? requestedQuality : 'high',
    // 帧放大：开启时（true）每帧矢量重绘极清，关闭时（false）平滑拉伸防卡顿；
    // 两种模式下画面均随窗口等比铺满，画质 100% 保持用户配置，严禁被开关篡改。
    frameZoom:requestedFrameZoom === undefined ? true : requestedFrameZoom !== false,
  };
  return next;
}

function createGameHtmlRenderPolicy(initialConfig) {
  var config = normalizeConfig(null, initialConfig || {});

  function setConfig(update) {
    config = normalizeConfig(config, update);
    return Object.assign({}, config);
  }

  function transform(buf) {
    var body = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    var headInjection = '<style id="__sl_bg">' +
      'html,body{width:100%!important;height:100%!important;margin:0!important;padding:0!important;overflow:hidden!important;background:#000!important;}' +
      '#__flash_center{position:relative!important;width:100%!important;height:100%!important;display:flex!important;align-items:center!important;justify-content:center!important;overflow:hidden!important;z-index:0!important;}' +
      '#toolbar,#nav,#menu,.toolbar,.menu,.nav,header{position:relative!important;z-index:9999!important;}' +
      '#flashContentWrap,#flashbox,#flashContent{display:flex!important;align-items:center!important;justify-content:center!important;overflow:visible!important;}' +
      'embed#Client,embed[type*="flash"],object[type*="flash"]{transform-origin:center center!important;will-change:transform;-webkit-backface-visibility:hidden;backface-visibility:hidden;transition:transform 0.08s cubic-bezier(0.25,0.1,0.25,1);}' +
      '</style>';
    var head = body.match(/<head[^>]*>/i);
    body = head ? body.replace(head[0], head[0] + headInjection) : headInjection + body;

    // wmode 统一为 window；配合主进程缩放与重绘工作。
    var wmode = 'window';
    // effectiveQuality：画质 100% 保持用户配置（low/medium/high/best），
    // 无论 frameZoom 开关是 true 还是 false，严禁篡改为 low。
    var effectiveQuality = config.quality || 'high';
    body = body.replace(/<embed\b[^>]*>/gi, function(tag) {
      return setTagAttribute(tag, 'wmode', wmode);
    });
    body = ensureObjectParam(body, 'wmode', wmode);
    body = body.replace(/<embed\b[^>]*>/gi, function(tag) {
      return setTagAttribute(tag, 'quality', effectiveQuality);
    });
    body = ensureObjectParam(body, 'quality', effectiveQuality);
    // The live game page uses SWFObject rather than static <embed>/<object>
    // markup.  Rewrite its dynamic parameters too; otherwise the generated
    // Flash element keeps the page's hard-coded values (historically `low`
    // and `window`) even after the launcher setting changes.
    body = replaceSwfObjectParam(body, 'wmode', wmode);
    body = replaceSwfObjectParam(body, 'quality', effectiveQuality);
    if (body.indexOf('hasPriority') === -1) {
      body = body.replace(/(<embed\s[^>]*type\s*=\s*["\']?application\/x-shockwave-flash["\']?[^>]*?)(\/?\s*>)/gi,
        function(_match, open, close) { return open + ' hasPriority="true"' + close; });
      body = body.replace(/(<object\s[^>]*(?:classid|type)[^>]*>)/gi,
        function(match) { return match + '<param name="hasPriority" value="true"/>'; });
    }
    return Buffer.from(body, 'utf8');
  }

  return { setConfig:setConfig, getConfig:function() { return Object.assign({}, config); }, transform:transform };
}

module.exports = {
  createGameHtmlRenderPolicy:createGameHtmlRenderPolicy,
  normalizeConfig:normalizeConfig,
  replaceSwfObjectParam:replaceSwfObjectParam,
};
