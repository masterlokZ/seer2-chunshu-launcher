'use strict';

// Pepper Flash stores PetSkinConfig's per-account assignments as an AMF3 LSO:
//   data[petResourceId] = selectedSkinId
// Keep this parser intentionally narrow.  PetSkinConfig only writes numeric
// values, and rejecting anything else lets the caller use its corrupt-file
// fallback without accidentally rewriting an unfamiliar SharedObject.

function readU29(buffer, offset) {
  var value = 0;
  var start = offset;
  for (var index = 0; index < 4; index++) {
    if (offset >= buffer.length) throw new Error('AMF3 U29 is truncated at ' + start);
    var byte = buffer[offset++];
    if (index < 3) {
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return { value:value >>> 0, next:offset };
    } else {
      value = (value << 8) | byte;
      return { value:(value & 0x1fffffff) >>> 0, next:offset };
    }
  }
  throw new Error('Invalid AMF3 U29 at ' + start);
}

function readString(buffer, offset, references) {
  var header = readU29(buffer, offset);
  if ((header.value & 1) === 0) {
    var referenceIndex = header.value >>> 1;
    if (referenceIndex >= references.length) throw new Error('Invalid AMF3 string reference ' + referenceIndex);
    return { value:references[referenceIndex], next:header.next };
  }
  var length = header.value >>> 1;
  var end = header.next + length;
  if (end > buffer.length) throw new Error('AMF3 string is truncated');
  var value = buffer.toString('utf8', header.next, end);
  if (value) references.push(value);
  return { value:value, next:end };
}

function parseAssignments(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 25) throw new Error('skinDefine.sol is too short');
  if (buffer[0] !== 0x00 || buffer[1] !== 0xbf) throw new Error('skinDefine.sol has an invalid LSO signature');
  if (buffer.toString('ascii', 6, 10) !== 'TCSO') throw new Error('skinDefine.sol has an invalid TCSO header');
  var nameLength = buffer.readUInt16BE(16);
  var versionOffset = 18 + nameLength + 3;
  if (versionOffset >= buffer.length || buffer[versionOffset] !== 0x03) {
    throw new Error('skinDefine.sol is not an AMF3 SharedObject');
  }

  var bodyOffset = versionOffset + 1;
  var offset = bodyOffset;
  var references = [];
  var entries = [];
  while (offset < buffer.length) {
    // An empty LSO body may contain one final padding byte.  For populated
    // bodies the zero after each value is the entry delimiter.
    if (buffer[offset] === 0 && offset === buffer.length - 1) break;
    var start = offset;
    var key = readString(buffer, offset, references);
    offset = key.next;
    if (!key.value) throw new Error('skinDefine.sol contains an empty assignment key');
    if (offset >= buffer.length) throw new Error('skinDefine.sol assignment has no value');
    var marker = buffer[offset++];
    var numericValue;
    if (marker === 0x04) {
      var integer = readU29(buffer, offset);
      numericValue = integer.value;
      offset = integer.next;
    } else if (marker === 0x05) {
      if (offset + 8 > buffer.length) throw new Error('skinDefine.sol double value is truncated');
      numericValue = buffer.readDoubleBE(offset);
      offset += 8;
    } else {
      throw new Error('skinDefine.sol contains unsupported AMF3 marker 0x' + marker.toString(16));
    }
    if (offset >= buffer.length || buffer[offset] !== 0) {
      throw new Error('skinDefine.sol assignment delimiter is missing');
    }
    offset++;
    entries.push({ key:key.value, value:numericValue, start:start, end:offset });
  }
  return { bodyOffset:bodyOffset, entries:entries };
}

function filterAssignments(buffer, skinIds) {
  var ids = new Set(Array.from(skinIds || []).map(function(value) {
    return parseInt(value, 10);
  }).filter(function(value) { return Number.isFinite(value) && value > 0; }));
  var parsed = parseAssignments(buffer);
  var kept = parsed.entries.filter(function(entry) { return !ids.has(Number(entry.value)); });
  var removedBindings = parsed.entries.length - kept.length;
  if (!removedBindings) {
    return {
      buffer:buffer,
      changed:false,
      removedBindings:0,
      totalBindings:parsed.entries.length,
      remainingBindings:parsed.entries.length,
    };
  }

  var body = kept.length
    ? Buffer.concat(kept.map(function(entry) { return buffer.slice(entry.start, entry.end); }))
    : Buffer.from([0]);
  var output = Buffer.concat([buffer.slice(0, parsed.bodyOffset), body]);
  // The LSO length excludes the first signature and length fields (6 bytes).
  output.writeUInt32BE(output.length - 6, 2);
  return {
    buffer:output,
    changed:true,
    removedBindings:removedBindings,
    totalBindings:parsed.entries.length,
    remainingBindings:kept.length,
  };
}

module.exports = {
  parseAssignments:parseAssignments,
  filterAssignments:filterAssignments,
};
