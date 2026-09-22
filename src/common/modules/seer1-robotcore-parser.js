'use strict';

const zlib = require('zlib');

function createSeer1RobotCoreParser(options) {
  options = options || {};
  if (typeof options.parseId !== 'function') throw new TypeError('parseId is required');
  if (typeof options.readTagHeader !== 'function') throw new TypeError('readTagHeader is required');
  var parseId = options.parseId;
  var readTagHeader = options.readTagHeader;

  function decodeSeer1RobotCoreSwf(buffer) {
    var swf = buffer;
    var signature = swf && swf.length >= 3 ? swf.slice(0, 3).toString('ascii') : '';
    if (signature !== 'FWS' && signature !== 'CWS') {
      if (!swf || swf.length < 16) throw new Error('RobotCoreDLL 内容无效');
      swf = zlib.inflateSync(swf.slice(7));
      signature = swf.slice(0, 3).toString('ascii');
    }
    if (signature === 'CWS') {
      swf = Buffer.concat([Buffer.from('FWS'), swf.slice(3, 8), zlib.inflateSync(swf.slice(8))]);
    }
    if (swf.slice(0, 3).toString('ascii') !== 'FWS') throw new Error('RobotCoreDLL 不是可解析的 SWF');
    return swf;
  }

  function extractSeer1RobotCoreBinaryAssets(buffer) {
    var data = decodeSeer1RobotCoreSwf(buffer);
    var nbits = data[8] >> 3;
    var rootStart = 8 + Math.ceil((5 + 4 * nbits) / 8) + 4;
    var symbols = new Map();
    var binaries = new Map();
    var position = rootStart;
    while (position < data.length) {
      var tag = readTagHeader(data, position, data.length);
      if (!tag) break;
      if (tag.code === 76 && tag.body + 2 <= tag.end) {
        var count = data.readUInt16LE(tag.body);
        var cursor = tag.body + 2;
        for (var i = 0; i < count && cursor + 2 <= tag.end; i++) {
          var characterId = data.readUInt16LE(cursor); cursor += 2;
          var end = cursor;
          while (end < tag.end && data[end] !== 0) end++;
          symbols.set(data.slice(cursor, end).toString('utf8'), characterId);
          cursor = end + 1;
        }
      } else if (tag.code === 87 && tag.body + 6 <= tag.end) {
        binaries.set(data.readUInt16LE(tag.body), data.slice(tag.body + 6, tag.end));
      }
      position = tag.end;
      if (tag.code === 0) break;
    }
    function findBinary(fragment) {
      for (var pair of symbols.entries()) {
        if (pair[0].indexOf(fragment) >= 0 && binaries.has(pair[1])) return binaries.get(pair[1]);
      }
      return null;
    }
    function findBinaryCandidates(fragment) {
      var seen = new Set();
      var output = [];
      for (var pair of symbols.entries()) {
        if (pair[0].indexOf(fragment) < 0 || !binaries.has(pair[1]) || seen.has(pair[1])) continue;
        seen.add(pair[1]);
        output.push({ symbol:String(pair[0]), characterId:pair[1], buffer:binaries.get(pair[1]) });
      }
      return output;
    }
    return {
      petXml:findBinary('PetXMLInfo_xmlClass'),
      skillTable:findBinary('SkillXMLInfo_xmlClass'),
      petSkinCandidates:findBinaryCandidates('PetSkinXMLInfo_xmlClass'),
    };
  }

  function decodeXmlEntities(value) {
    return String(value || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  function parseXmlAttributes(source) {
    var output = {};
    String(source || '').replace(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g, function(_, key, quote, value) {
      output[key] = decodeXmlEntities(value);
      return _;
    });
    return output;
  }

  function parseSeer1RobotCorePetSkinXml(buffer) {
    var xml = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    var rows = [];
    String(xml).replace(/<Skin\b([^>]*)\/?\s*>/gi, function(_, source) {
      var item = parseXmlAttributes(source);
      var id = parseId(item.ID);
      var monId = parseId(item.MonID);
      if (id && monId && String(item.Name || '').trim()) rows.push(item);
      return _;
    });
    rows.sort(function(a, b) { return Number(a.ID) - Number(b.ID); });
    return rows;
  }

  function selectSeer1RobotCorePetSkinTable(candidates) {
    var parsed = (Array.isArray(candidates) ? candidates : []).map(function(candidate) {
      var rows = parseSeer1RobotCorePetSkinXml(candidate && candidate.buffer);
      return {
        symbol:String(candidate && candidate.symbol || ''),
        characterId:Number(candidate && candidate.characterId) || 0,
        bytes:Buffer.isBuffer(candidate && candidate.buffer) ? candidate.buffer.length : 0,
        rows:rows,
        maxId:rows.reduce(function(max, item) { return Math.max(max, parseId(item && item.ID)); }, 0),
      };
    }).filter(function(candidate) { return candidate.rows.length > 0 && candidate.maxId > 0; });
    parsed.sort(function(a, b) {
      return b.maxId - a.maxId || b.rows.length - a.rows.length || b.bytes - a.bytes;
    });
    return parsed[0] || null;
  }

  function parseSeer1RobotCorePetXml(buffer) {
    var xml = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    var monsters = [];
    var match;
    var monsterPattern = /<Monster\b([^>]*)>([\s\S]*?)<\/Monster>/gi;
    while ((match = monsterPattern.exec(xml))) {
      var monster = parseXmlAttributes(match[1]);
      function movesIn(sectionName) {
        var section = new RegExp('<' + sectionName + '\\b[^>]*>([\\s\\S]*?)<\\/' + sectionName + '>', 'i').exec(match[2]);
        var moves = [];
        if (section) String(section[1]).replace(/<Move\b([^>]*)\/?\s*>/gi, function(_, attrs) {
          moves.push(parseXmlAttributes(attrs)); return _;
        });
        return { Move:moves };
      }
      monster.LearnableMoves = movesIn('LearnableMoves');
      monster.ExtraMoves = movesIn('ExtraMoves');
      if (parseId(monster.ID)) monsters.push(monster);
    }
    return { Monsters:{ Monster:monsters } };
  }

  function Seer1Amf3Reader(buffer) {
    this.buffer = buffer; this.offset = 0; this.strings = []; this.objects = []; this.traits = [];
  }
  Seer1Amf3Reader.prototype.byte = function() {
    if (this.offset >= this.buffer.length) throw new Error('AMF3 数据提前结束');
    return this.buffer[this.offset++];
  };
  Seer1Amf3Reader.prototype.u29 = function() {
    var value = 0;
    for (var i = 0; i < 4; i++) {
      var byte = this.byte();
      if (i < 3) { value = (value << 7) | (byte & 0x7f); if (!(byte & 0x80)) return value >>> 0; }
      else return ((value << 8) | byte) >>> 0;
    }
    return value >>> 0;
  };
  Seer1Amf3Reader.prototype.string = function() {
    var header = this.u29();
    if (!(header & 1)) return this.strings[header >>> 1];
    var length = header >>> 1;
    var value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    if (value) this.strings.push(value);
    return value;
  };
  Seer1Amf3Reader.prototype.array = function() {
    var header = this.u29();
    if (!(header & 1)) return this.objects[header >>> 1];
    var count = header >>> 1, result = [];
    this.objects.push(result);
    while (true) { var key = this.string(); if (!key) break; result[key] = this.value(); }
    for (var i = 0; i < count; i++) result.push(this.value());
    return result;
  };
  Seer1Amf3Reader.prototype.object = function() {
    var header = this.u29();
    if (!(header & 1)) return this.objects[header >>> 1];
    var traits;
    if (!(header & 2)) traits = this.traits[header >>> 2];
    else {
      var sealedCount = header >>> 4, sealed = [];
      traits = { externalizable:!!(header & 4), dynamic:!!(header & 8), className:this.string(), sealed:sealed };
      for (var i = 0; i < sealedCount; i++) sealed.push(this.string());
      this.traits.push(traits);
    }
    if (!traits || traits.externalizable) throw new Error('不支持的 AMF3 外部对象');
    var result = {}; this.objects.push(result);
    for (var j = 0; j < traits.sealed.length; j++) result[traits.sealed[j]] = this.value();
    if (traits.dynamic) while (true) { var key = this.string(); if (!key) break; result[key] = this.value(); }
    return result;
  };
  Seer1Amf3Reader.prototype.value = function() {
    var marker = this.byte();
    if (marker === 0x00) return undefined;
    if (marker === 0x01) return null;
    if (marker === 0x02) return false;
    if (marker === 0x03) return true;
    if (marker === 0x04) { var raw = this.u29(); return raw & 0x10000000 ? raw - 0x20000000 : raw; }
    if (marker === 0x05) { var number = this.buffer.readDoubleBE(this.offset); this.offset += 8; return number; }
    if (marker === 0x06) return this.string();
    if (marker === 0x08) { var dateHeader = this.u29(); if (!(dateHeader & 1)) return this.objects[dateHeader >>> 1]; var date = new Date(this.buffer.readDoubleBE(this.offset)); this.offset += 8; this.objects.push(date); return date; }
    if (marker === 0x09) return this.array();
    if (marker === 0x0a) return this.object();
    if (marker === 0x0c) { var bytesHeader = this.u29(); if (!(bytesHeader & 1)) return this.objects[bytesHeader >>> 1]; var length = bytesHeader >>> 1; var bytes = this.buffer.slice(this.offset, this.offset + length); this.offset += length; this.objects.push(bytes); return bytes; }
    throw new Error('不支持的 AMF3 标记 0x' + marker.toString(16));
  };

  function collectSeer1MovesById(root, output) {
    output = output || {};
    var visited = new Set();
    function visit(value) {
      if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Date || visited.has(value)) return;
      visited.add(value);
      var id = parseId(value.ID || value.Id || value.id);
      if (id && (value.Category !== undefined || value.Url !== undefined || value.Name !== undefined)) output[String(id)] = value;
      if (Array.isArray(value)) value.forEach(visit);
      else Object.keys(value).forEach(function(key) { visit(value[key]); });
    }
    visit(root);
    return output;
  }

  return {
    decodeSeer1RobotCoreSwf:decodeSeer1RobotCoreSwf,
    extractSeer1RobotCoreBinaryAssets:extractSeer1RobotCoreBinaryAssets,
    decodeXmlEntities:decodeXmlEntities,
    parseXmlAttributes:parseXmlAttributes,
    parseSeer1RobotCorePetSkinXml:parseSeer1RobotCorePetSkinXml,
    selectSeer1RobotCorePetSkinTable:selectSeer1RobotCorePetSkinTable,
    parseSeer1RobotCorePetXml:parseSeer1RobotCorePetXml,
    Seer1Amf3Reader:Seer1Amf3Reader,
    collectSeer1MovesById:collectSeer1MovesById,
  };
}

module.exports = { createSeer1RobotCoreParser:createSeer1RobotCoreParser };
