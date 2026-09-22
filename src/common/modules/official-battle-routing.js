'use strict';

function normalizeId(value) {
  var id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function createOfficialBattleRouting(document) {
  if (!document || Number(document.schemaVersion) !== 2 ||
      document.policy !== 'traditional-swf-whitelist-default-u-client' ||
      document.defaultSource !== 'u-client') {
    throw new Error('Official battle routing document is incompatible');
  }
  var whitelist = document.traditionalSwfWhitelist || {};
  var ranges = (Array.isArray(whitelist.ranges) ? whitelist.ranges : []).map(function(pair) {
    var start = normalizeId(pair && pair[0]);
    var end = normalizeId(pair && pair[1]);
    if (!start || end < start) throw new Error('Official battle routing range is invalid');
    return [start,end];
  }).sort(function(left,right) { return left[0] - right[0]; });
  for (var index = 1; index < ranges.length; index++) {
    if (ranges[index][0] <= ranges[index - 1][1]) {
      throw new Error('Official battle routing ranges overlap');
    }
  }
  var singles = new Set((Array.isArray(whitelist.singleIds) ? whitelist.singleIds : []).map(function(value) {
    var id = normalizeId(value);
    if (!id) throw new Error('Official battle routing singleton is invalid');
    return id;
  }));
  var expandedCount = ranges.reduce(function(total,pair) {
    return total + pair[1] - pair[0] + 1;
  },0) + singles.size;
  if (expandedCount !== Number(whitelist.verifiedCount)) {
    throw new Error('Official battle routing verified count does not match its ranges');
  }

  function containsRange(id) {
    var low = 0;
    var high = ranges.length - 1;
    while (low <= high) {
      var middle = (low + high) >>> 1;
      var pair = ranges[middle];
      if (id < pair[0]) high = middle - 1;
      else if (id > pair[1]) low = middle + 1;
      else return true;
    }
    return false;
  }

  function isTraditional(value) {
    var id = normalizeId(value);
    return !!id && (singles.has(id) || containsRange(id));
  }

  function route(value) {
    var id = normalizeId(value);
    if (!id) throw new Error('Official battle resource id is invalid');
    var traditional = isTraditional(id);
    return {
      id:id,
      source:traditional ? 'traditional-swf' : 'u-client',
      traditionalSwf:traditional,
      uClient:!traditional,
      reason:traditional
        ? 'verified-traditional-swf-whitelist'
        : 'not-in-verified-traditional-swf-whitelist',
    };
  }

  return {
    route:route,
    isTraditional:isTraditional,
    verifiedCount:expandedCount,
    generatedAt:String(document.generatedAt || ''),
    catalogFingerprint:String(document.catalogFingerprint || ''),
    policy:document.policy,
  };
}

module.exports = { createOfficialBattleRouting:createOfficialBattleRouting };
