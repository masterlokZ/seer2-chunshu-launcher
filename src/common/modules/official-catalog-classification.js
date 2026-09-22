'use strict';

function createOfficialCatalogClassification(parseId) {
  if (typeof parseId !== 'function') throw new Error('official catalog classification parseId is required');

  function isNativeUClient(item, modelRequestIds) {
    var id = parseId(item && (item.resourceId || item.id));
    if (!id || !modelRequestIds || !modelRequestIds.has(id)) return false;
    if (String(item && item.uClientFamily || '').toLowerCase() === 'spine') return true;
    if (item && (item.fightAvailable === false || item.fightPlayable === false || item.staticPoseWrapper === true)) return true;
    if (item && item.nonStandardTimeline === true &&
        item.playbackVerifiedOldUi !== true && item.playbackVerifiedNewUi !== true) return true;
    return String(item && (item.availabilityReason || item.reason) || '') === 'battle-static-pose-wrapper';
  }

  function isPreviewOnly(item, modelRequestIds) {
    if (!item) return false;
    if (item.uClientAvailable === true || (modelRequestIds && isNativeUClient(item, modelRequestIds))) return false;
    if (item.publicDiscovery === true && item.downloadable === false) return false;
    if (item.playbackVerifiedOldUi === true || item.playbackVerifiedNewUi === true) return false;
    return item.fightAvailable === false || item.fightPlayable === false ||
      item.availabilityStatus === 'follow-only' || item.availabilityStatus === 'battle-nonstandard';
  }

  function findResource(catalog, sourceId) {
    var id = parseId(sourceId);
    var found = null;
    if (!id) return found;
    (catalog && catalog.items || []).some(function(item) {
      if (parseId(item && item.id) === id) { found = item; return true; }
      var skin = (item && item.extraSkins || []).find(function(candidate) {
        return parseId(candidate && candidate.resourceId) === id;
      });
      if (skin) { found = skin; return true; }
      return false;
    });
    return found;
  }

  function countNativeUClient(catalog) {
    var ids = new Set((catalog && catalog.uClientModelRequestIds || []).map(parseId).filter(Boolean));
    var count = 0;
    (catalog && catalog.items || []).forEach(function(item) {
      if (isNativeUClient(item, ids)) count++;
      (item && item.extraSkins || []).forEach(function(skin) { if (isNativeUClient(skin, ids)) count++; });
    });
    return count;
  }

  return { isNativeUClient:isNativeUClient, isPreviewOnly:isPreviewOnly, findResource:findResource, countNativeUClient:countNativeUClient };
}

module.exports = { createOfficialCatalogClassification:createOfficialCatalogClassification };
