'use strict';

// Keep the identity of an imported skin separate from the runtime target ID.
// skinId is the launcher/game slot and may be renumbered; sourceId and the
// official metadata describe the actual pet/skin shown in the configuration UI.
function parseId(value) {
  var text = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(text)) return 0;
  var id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function deriveCustomSkinIdentity(entry) {
  entry = entry && typeof entry === 'object' ? entry : {};
  var sourceId = parseId(entry.sourceId);
  var basePetId = parseId(entry.basePetId) || sourceId;
  var officialSkinId = parseId(entry.officialSkinId);
  var sourceKind = entry.sourceKind === 'official-skin' ? 'official-skin' : 'pet';
  var identityId = sourceKind === 'official-skin'
    ? (officialSkinId || sourceId || basePetId)
    : (sourceId || basePetId);
  return {
    id: identityId,
    name: String(entry.name || '').trim().slice(0, 80),
    sourceId: sourceId,
    basePetId: basePetId,
    officialSkinId: officialSkinId,
    sourceKind: sourceKind,
    targetId: parseId(entry.skinId),
  };
}

module.exports = { deriveCustomSkinIdentity };
