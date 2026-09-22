'use strict';

const ultimateCapability = require('./ultimate-capability');
const ultimateActionSeed = require('./uclient-ultimate-action-index.seed.json');

function isSupplementalSkin(skin) {
  if (!skin || typeof skin !== 'object') return false;
  return skin.historicalFlashOnly === true ||
         skin.identitySource === 'flash-manual-supplement' ||
         skin.supplemental === true;
}

function createUClientCatalogProjection(options) {
  options = options || {};
  var parseId = options.parseId;
  if (typeof parseId !== 'function') throw new Error('U-client catalog projection parseId is required');

  function normalizeActions(values) {
    return (Array.isArray(values) ? values : []).map(function(value) {
      return ultimateCapability.normalizeActionName(value);
    }).filter(function(value, index, all) {
      return !!value && value.length <= 80 && all.indexOf(value) === index;
    });
  }

  function actionCapabilities(values) {
    var actions = normalizeActions(values);
    var dedicated = ultimateCapability.normalizeUltimateActions(actions);
    return {
      actions:actions,
      dedicatedUltimateActions:dedicated,
      dedicatedUltimate:dedicated.length > 0,
      standby:actions.indexOf('standby') >= 0 || actions.indexOf('idle') >= 0 || actions.indexOf('await') >= 0,
      physical:actions.some(function(action) { return /^(?:attack|atk|physical)$/.test(action); }),
      special:actions.some(function(action) { return /^(?:sa|special|magic)$/.test(action); }),
      property:actions.some(function(action) { return /^(?:cp|property|buff|effect)$/.test(action); }),
      hurt:actions.some(function(action) { return /^(?:hited|hurt|hit)$/.test(action); }),
      lowHp:actions.some(function(action) { return /^(?:dying|lowhp|weak|dead|death|die)$/.test(action); }),
    };
  }

  function mergeIdentity(catalog, snapshot) {
    if (!catalog || !Array.isArray(catalog.items) || !snapshot || !snapshot.index) return catalog;
    function capabilities(modelId) {
      var timelineCount = (snapshot.index.timelines.get(modelId) || []).length;
      var effectCount = (snapshot.index.effects.get(modelId) || []).length;
      var videoCount = (snapshot.index.videos.get(modelId) || []).length;
      return {
        uClientTimelineCount:timelineCount,
        uClientEffectCount:effectCount,
        uClientVideoCount:videoCount,
        uClientSupplementalAvailable:timelineCount + effectCount + videoCount > 0,
      };
    }
    var monsters = new Map((snapshot.config.monsters || []).map(function(item) {
      return [parseId(item && item.id), item];
    }).filter(function(entry) { return !!entry[0]; }));
    var oldSkins = new Map();
    var historicalSkinsByPet = new Map();
    catalog.items.forEach(function(item) {
      var petId = parseId(item && item.id);
      (item.extraSkins || []).forEach(function(skin) {
        var resourceId = parseId(skin && skin.resourceId);
        if (resourceId) oldSkins.set(resourceId, skin);
        // Preserve explicit catalogue supplements / historical supplementary skins
        // while replacing ordinary U-client skin rows from the live snapshot.
        // This ensures general supplemental skin entries are retained across
        // catalogue projection refreshes.
        if (isSupplementalSkin(skin) && petId &&
            (parseId(skin.basePetId) || petId) === petId) {
          var preserved = historicalSkinsByPet.get(petId) || [];
          preserved.push(skin);
          historicalSkinsByPet.set(petId, preserved);
        }
      });
    });
    var byPet = {};
    (snapshot.config.skins || []).forEach(function(skin) {
      var catalogueId = parseId(skin && skin.id);
      var basePetId = parseId(skin && skin.monId);
      // Namespace arithmetic is allowed only after exact membership in the
      // current U-client pet_skin table has established ownership.
      var resourceId = catalogueId ? 1400000 + catalogueId : 0;
      if (!resourceId || !basePetId) return;
      var config = monsters.get(resourceId);
      var modelId = config && Number(config.realId || 0) > 0 ? Number(config.realId) : resourceId;
      var family = snapshot.index.spine.has(modelId) ? 'spine' : snapshot.index.ftr.has(modelId) ? 'ftr' : '';
      var previous = oldSkins.get(resourceId) || {};
      var normalized = Object.assign({}, previous, {
        catalogueId:catalogueId,
        resourceId:resourceId,
        basePetId:basePetId,
        name:String(skin.name || config && config.name || previous.name || '').trim().slice(0, 80),
        uClientIdentityVerified:true,
        uClientAssetId:modelId,
        uClientFamily:family,
        uClientModelAvailable:!!family,
        uClientFollowAvailable:snapshot.index.follows.has(modelId),
        uClientPresentationAvailable:snapshot.index.presentations.has(modelId),
      }, capabilities(modelId));
      (byPet[String(basePetId)] || (byPet[String(basePetId)] = [])).push(normalized);
    });
    catalog.items.forEach(function(item) {
      var id = parseId(item && item.id);
      var config = monsters.get(id);
      var modelId = config && Number(config.realId || 0) > 0 ? Number(config.realId) : id;
      var family = snapshot.index.spine.has(modelId) ? 'spine' : snapshot.index.ftr.has(modelId) ? 'ftr' : '';
      if (config && String(config.name || '').trim()) item.name = String(config.name).trim().slice(0, 80);
      item.realId = modelId === id ? 0 : modelId;
      item.uClientIdentityVerified = !!config;
      item.uClientAssetId = modelId;
      item.uClientFamily = family;
      item.uClientModelAvailable = !!family;
      item.uClientFollowAvailable = snapshot.index.follows.has(modelId);
      item.uClientPresentationAvailable = snapshot.index.presentations.has(modelId);
      Object.assign(item, capabilities(modelId));
      var mergedSkins = new Map();
      (byPet[String(id)] || []).forEach(function(skin) {
        var resourceId = parseId(skin && skin.resourceId);
        if (resourceId) mergedSkins.set(resourceId, skin);
      });
      (historicalSkinsByPet.get(id) || []).forEach(function(skin) {
        var resourceId = parseId(skin && skin.resourceId);
        if (resourceId && !mergedSkins.has(resourceId)) mergedSkins.set(resourceId, skin);
      });
      item.extraSkins = Array.from(mergedSkins.values()).sort(function(a, b) { return a.resourceId - b.resourceId; });
    });
    catalog.uClientIdentityVersion = 2;
    catalog.uClientSnapshotFingerprint = snapshot.fingerprint;
    catalog.uClientPackageVersions = Object.fromEntries(Object.entries(snapshot.packages).map(function(entry) {
      return [entry[0], entry[1].version];
    }));
    catalog.uClientManifestSha256 = Object.fromEntries(Object.entries(snapshot.packages).map(function(entry) {
      return [entry[0], String(entry[1].manifestSha256 || '')];
    }));
    catalog.uClientCounts = {
      monsters:(snapshot.config.monsters || []).length,
      skins:(snapshot.config.skins || []).length,
      ftr:snapshot.index.ftr.size,
      spine:snapshot.index.spine.size,
      follow:snapshot.index.follows.size,
      presentation:snapshot.index.presentations.size,
      timelines:snapshot.index.timelines.size,
      effects:snapshot.index.effects.size,
      videos:snapshot.index.videos.size,
    };
    ultimateCapability.annotateCatalog(catalog, {
      snapshot:snapshot,
      actionIndex:snapshot.actionIndex || ultimateActionSeed,
      replacementRows:catalog.ultimateReplacementRows || [],
      robotCoreFingerprint:String(catalog.officialDiscoveryFingerprint || ''),
    });
    catalog.uClientActionIndexFingerprint = String(
      ultimateCapability.normalizeActionIndex(snapshot.actionIndex || ultimateActionSeed).fingerprint || '');
    return catalog;
  }

  return {
    normalizeActions:normalizeActions,
    actionCapabilities:actionCapabilities,
    mergeIdentity:mergeIdentity,
    isSupplementalSkin:isSupplementalSkin,
  };
}

module.exports = {
  createUClientCatalogProjection:createUClientCatalogProjection,
  isSupplementalSkin:isSupplementalSkin,
};
