'use strict';

const zlib = require('zlib');

function createCustomSkinSwfUtils(options) {
  options = options || {};
  if (typeof options.parseId !== 'function') throw new TypeError('parseId is required');
  var parseId = options.parseId;

  function customSkinTypeFromName(source) {
    var value = String(source || '').toLowerCase().replace(/\\\\/g, '/');
    var base = value.slice(value.lastIndexOf('/') + 1).replace(/\.swf(?:\?.*)?$/i, '');
    var parent = value.slice(0, value.lastIndexOf('/'));
    parent = parent.slice(parent.lastIndexOf('/') + 1);
    var haystack = base + ' ' + parent;
    if (/(^|[^a-z])(fight|battle)([^a-z]|$)|战斗|对战/.test(haystack)) return 'fight';
    if (/(^|[^a-z])(physical|physicaleffect)([^a-z]|$)|物攻特效/.test(haystack)) return 'physical';
    if (/(^|[^a-z])(special|specialeffect)([^a-z]|$)|特攻特效/.test(haystack)) return 'special';
    if (/(^|[^a-z])(property|propertyeffect)([^a-z]|$)|属性特效/.test(haystack)) return 'property';
    if (/(^|[^a-z])(skill|ultimate)([^a-z]|$)|技能特效|大招特效/.test(haystack)) return 'skill';
    if (/(^|[^a-z])primary([^a-z]|$)|首发|出场门/.test(haystack)) return 'primary';
    if (/(^|[^a-z])(dictionary|dict)([^a-z]|$)|图鉴/.test(haystack)) return 'dictionary';
    if (/(^|[^a-z])(icon|avatar)([^a-z]|$)|头像|图标/.test(haystack)) return 'icon';
    if (/(^|[^a-z])(demo|display|show)([^a-z]|$)|展示|预览/.test(haystack)) return 'demo';
    if (/(^|[^a-z])(normal|map)([^a-z]|$)|地图|跟随/.test(haystack)) return 'normal';
    return '';
  }

  function customSkinIdFromName(source) {
    var value = String(source || '').replace(/\\\\/g, '/').split('?')[0];
    var parts = value.split('/').slice(-2).reverse();
    for (var i = 0; i < parts.length; i++) {
      var matches = parts[i].match(/\d{1,10}/g);
      if (!matches || !matches.length) continue;
      var parsed = parseId(matches[matches.length - 1]);
      if (parsed > 0) return parsed;
    }
    return 0;
  }

  function customSkinReadRectSize(buffer) {
    try {
      if (!buffer || buffer.length < 12) return null;
      var data = buffer;
      var sig = buffer.slice(0, 3).toString('ascii');
      if (sig === 'CWS') {
        data = Buffer.concat([Buffer.from('FWS'), buffer.slice(3, 8), zlib.inflateSync(buffer.slice(8))]);
      } else if (sig !== 'FWS') {
        return null;
      }
      var bitOffset = 8 * 8;
      function bits(count) {
        var out = 0;
        for (var n = 0; n < count; n++) {
          var byte = data[bitOffset >> 3];
          out = (out << 1) | ((byte >> (7 - (bitOffset & 7))) & 1);
          bitOffset++;
        }
        return out;
      }
      function signed(value, count) {
        var sign = Math.pow(2, count - 1);
        return value >= sign ? value - Math.pow(2, count) : value;
      }
      var count = bits(5);
      var xmin = signed(bits(count), count);
      var xmax = signed(bits(count), count);
      var ymin = signed(bits(count), count);
      var ymax = signed(bits(count), count);
      return { width:Math.round((xmax - xmin) / 20), height:Math.round((ymax - ymin) / 20), data:data };
    } catch(e) {
      return null;
    }
  }

  function inflateCustomSkinSwfAsync(buffer) {
    return new Promise(function(resolve, reject) {
      if (!buffer || buffer.length < 12) { resolve(null); return; }
      var sig = buffer.slice(0, 3).toString('ascii');
      if (sig === 'FWS') { resolve(buffer); return; }
      if (sig !== 'CWS') { resolve(null); return; }
      zlib.inflate(buffer.slice(8), function(err, body) {
        if (err) { reject(err); return; }
        resolve(Buffer.concat([Buffer.from('FWS'), buffer.slice(3, 8), body]));
      });
    });
  }

  async function customSkinReadRectSizeAsync(buffer) {
    var data = await inflateCustomSkinSwfAsync(buffer);
    return data ? customSkinReadRectSize(data) : null;
  }

  function customSkinStaticIconInfo(buffer) {
    try {
      if (!buffer || buffer.length < 20 || buffer.length > 8 * 1024 * 1024) {
        return { ok:false, error:'头像 SWF 大小无效' };
      }
      var info = customSkinReadRectSize(buffer);
      if (!info || !info.data || info.data.length < 20) {
        return { ok:false, error:'不是有效的 FWS/CWS 文件' };
      }
      var data = info.data;
      var nbits = data[8] >> 3;
      var rectBytes = Math.ceil((5 + 4 * nbits) / 8);
      var frameHeader = 8 + rectBytes;
      if (frameHeader + 4 > data.length) {
        return { ok:false, error:'SWF 帧头不完整' };
      }
      var rootFrames = data.readUInt16LE(frameHeader + 2);
      var pos = frameHeader + 4;
      var itemId = -1;
      var spriteFrames = new Map();
      while (pos + 2 <= data.length) {
        var header = data.readUInt16LE(pos);
        pos += 2;
        var code = header >> 6;
        var length = header & 0x3f;
        if (length === 0x3f) {
          if (pos + 4 > data.length) break;
          length = data.readUInt32LE(pos);
          pos += 4;
        }
        var end = pos + length;
        if (end > data.length) break;
        if (code === 39 && length >= 4) {
          spriteFrames.set(data.readUInt16LE(pos), data.readUInt16LE(pos + 2));
        } else if (code === 76 && length >= 2) {
          var cursor = pos;
          var count = data.readUInt16LE(cursor);
          cursor += 2;
          for (var i = 0; i < count && cursor + 2 <= end; i++) {
            var characterId = data.readUInt16LE(cursor);
            cursor += 2;
            var nameStart = cursor;
            while (cursor < end && data[cursor] !== 0) cursor++;
            var className = data.slice(nameStart, cursor).toString('utf8');
            cursor++;
            if (className === 'item') itemId = characterId;
          }
        }
        pos = end;
        if (code === 0) break;
      }
      if (rootFrames !== 1) return { ok:false, error:'头像根时间轴不是单帧' };
      if (itemId < 0) return { ok:false, error:'缺少 item 导出类' };
      if (spriteFrames.get(itemId) !== 1) return { ok:false, error:'item 不是单帧影片剪辑' };
      return {
        ok:true,
        width:info.width,
        height:info.height,
        rootFrames:rootFrames,
        itemFrames:1,
      };
    } catch(e) {
      return { ok:false, error:e.message };
    }
  }

  return {
    customSkinTypeFromName:customSkinTypeFromName,
    customSkinIdFromName:customSkinIdFromName,
    customSkinReadRectSize:customSkinReadRectSize,
    inflateCustomSkinSwfAsync:inflateCustomSkinSwfAsync,
    customSkinReadRectSizeAsync:customSkinReadRectSizeAsync,
    customSkinStaticIconInfo:customSkinStaticIconInfo,
  };
}

module.exports = { createCustomSkinSwfUtils:createCustomSkinSwfUtils };
