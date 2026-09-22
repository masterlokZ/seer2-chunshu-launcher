'use strict';

// U-client ConfigPackage is the authoritative identity source.
// Explicit catalogue supplements provide a data-driven mechanism for historical
// skins or manual supplements, not numeric-range or capability inferences.
const HISTORICAL_SUPPLEMENT_SKINS = Object.freeze([
  Object.freeze({
    id:310,
    monId:3676,
    name:'猛虎王',
    historicalFlashOnly:true,
  }),
]);
const FLASH_ONLY_TIGER_KING_SKIN = HISTORICAL_SUPPLEMENT_SKINS[0];

const CANONICAL_FORM_NAMES = Object.freeze({
  190003291: '瀚宇星皇（皇帝形态）',
  1900184: '暴虐帝皇·瀚宇星皇（皇帝形态）',
  1900222: '烈阳·瀚宇星皇（皇帝形态）',
  1900510: '极行浪客·瀚宇星皇（皇帝形态）',
  290003788: '混元天尊（荒神赋形）',
  2900512: '时空怪盗·混元天尊（荒神赋形）',
  2900617: '冥烙·混元天尊（荒神赋形）',
  290003393: '马尔修斯（变身形态）',
  2900513: '苍夜传说·马尔修斯（变身形态）',
  290004677: '星辰万象·天启星魂（变身形态）',
  2900805: '群星低语时·天启星魂（变身形态）',
});

const PLAYER_PROFILE_FIELDS = Object.freeze([
  'realId','atk','def','hp','spAtk','spDef','spd','type','petClass',
]);

function isExplicitNonPlayerProfile(item) {
  if (!item || typeof item !== 'object') return false;
  if (!PLAYER_PROFILE_FIELDS.every(function(field) {
    return Object.prototype.hasOwnProperty.call(item, field);
  })) return false;
  return PLAYER_PROFILE_FIELDS.every(function(field) {
    return Number(item[field]) === 0;
  });
}

function createUClientIdentityCatalog(options) {
  options = options || {};
  var parseId = options.parseId;
  if (typeof parseId !== 'function') throw new Error('U-client identity catalog parseId is required');

  function officialSkinRows(snapshot) {
    var rows = Array.isArray(snapshot && snapshot.config && snapshot.config.skins)
      ? snapshot.config.skins.slice() : [];
    HISTORICAL_SUPPLEMENT_SKINS.forEach(function(supp) {
      if (!rows.some(function(item) { return parseId(item && item.id) === supp.id; })) {
        rows.push(Object.assign({}, supp));
      }
    });
    return rows;
  }

  function thumbnailUrl(target, context) {
    if (!target) return '';
    var item = (typeof target === 'object' && target !== null)
      ? target
      : (context && typeof context === 'object' ? context : null);
    var rawId = parseId(typeof target === 'number' || typeof target === 'string'
      ? target
      : (item && (item.resourceId || item.id || (item.catalogueId ? 1400000 + item.catalogueId : 0))));
    var basePetId = item ? (parseId(item.basePetId) || parseId(item.realId)) : 0;
    var isForm = !!(item && (item.isTransformForm === true || item.identitySource === 'u-client-config-form'));
    var finalId = isForm ? (basePetId || rawId) : (rawId || basePetId);
    return finalId ? 'https://seerh5.61.com/resource/assets/pet/head/' + finalId + '.png' : '';
  }

  function deriveFormName(baseName, formType, formId) {
    var rawId = parseId(formId);
    if (rawId && CANONICAL_FORM_NAMES[rawId]) return CANONICAL_FORM_NAMES[rawId];
    baseName = String(baseName || '').trim();
    baseName = baseName.replace(/[·（(].*?[形态赋形变身)）]/g, '').trim();
    var defaultSuffix = '（形态）';
    if (/混元天尊/.test(baseName)) defaultSuffix = '（荒神赋形）';
    else if (/星皇|帝皇/.test(baseName) || formType === 'combo') defaultSuffix = '（皇帝形态）';
    else if (formType === 'transform') defaultSuffix = '（变身形态）';
    return baseName + defaultSuffix;
  }

  function packageObject(snapshot, field) {
    return Object.fromEntries(Object.entries(snapshot && snapshot.packages || {}).map(function(entry) {
      return [entry[0], String(entry[1] && entry[1][field] || '')];
    }));
  }

  function build(snapshot) {
    if (!snapshot || !snapshot.config || !Array.isArray(snapshot.config.monsters) ||
        !Array.isArray(snapshot.config.skins) || !String(snapshot.fingerprint || '')) {
      throw new Error('U-client identity snapshot is incomplete');
    }
    var monsters = new Map();
    snapshot.config.monsters.forEach(function(item) {
      var id = parseId(item && item.id);
      var name = String(item && item.name || '').trim().slice(0, 80);
      if (id && name) monsters.set(id, item);
    });
    var skinRows = officialSkinRows(snapshot);
    var skinResourceIds = new Set();
    var skinsByPet = new Map();
    skinRows.forEach(function(row) {
      var catalogueId = parseId(row && row.id);
      var basePetId = parseId(row && row.monId);
      if (!catalogueId || !basePetId) return;
      var resourceId = 1400000 + catalogueId;
      skinResourceIds.add(resourceId);
      var configured = monsters.get(resourceId);
      var skin = {
        catalogueId:catalogueId,
        resourceId:resourceId,
        basePetId:basePetId,
        name:String(row.name || configured && configured.name || ('官方皮肤 ' + catalogueId)).trim().slice(0, 80),
        officialDefinition:true,
        identitySource:row.historicalFlashOnly === true ? 'flash-manual-supplement' : 'u-client-config',
        historicalFlashOnly:row.historicalFlashOnly === true,
      };
      if (!skinsByPet.has(basePetId)) skinsByPet.set(basePetId, []);
      skinsByPet.get(basePetId).push(skin);
    });

    // Official independent form supplements driven by UClient structure
    var formRows = [];
    snapshot.config.monsters.forEach(function(item) {
      var id = parseId(item && item.id);
      if (!id) return;
      var baseName = String(item && item.name || ('精灵 ' + id)).trim();
      var skinRow = (snapshot.config.skins || []).find(function(s) { return parseId(s && s.id) === (id - 1400000); });
      if (skinRow && skinRow.name) baseName = String(skinRow.name).trim();

      // Transform form
      var transId = parseId(item && item.transform);
      if (transId && transId > 0 && transId !== id) {
        var formName = deriveFormName(baseName, 'transform', transId);
        formRows.push({
          id: transId,
          resourceId: transId,
          catalogueId: transId,
          basePetId: id,
          realId: id,
          name: formName.slice(0, 80),
          officialDefinition: true,
          identitySource: 'u-client-config-form',
          isTransformForm: true,
        });
      }

      // Combo form
      var comboId = parseId(item && item.combo);
      if (comboId && comboId > 0 && comboId !== id) {
        var formName = deriveFormName(baseName, 'combo', comboId);
        formRows.push({
          id: comboId,
          resourceId: comboId,
          catalogueId: comboId,
          basePetId: id,
          realId: id,
          name: formName.slice(0, 80),
          officialDefinition: true,
          identitySource: 'u-client-config-form',
          isTransformForm: true,
        });
      }
    });

    // formRows are independent forms; never push to skinsByPet
    var items = [];
    var excludedNonPlayerProfiles = 0;
    monsters.forEach(function(item, id) {
      if (skinResourceIds.has(id)) return;
      // ConfigPackage also contains mount/vehicle UI identities.  In the live
      // catalogue those rows carry a complete player profile whose combat and
      // class fields are all explicitly zero.  Exclude that structural shape;
      // do not key the decision to a resource id or numeric range.
      if (isExplicitNonPlayerProfile(item)) {
        excludedNonPlayerProfiles++;
        return;
      }
      items.push({
        id:id,
        realId:parseId(item && item.realId),
        name:String(item.name || ('精灵 ' + id)).trim().slice(0, 80),
        officialDefinition:true,
        identitySource:'u-client-config',
        extraSkins:(skinsByPet.get(id) || []).sort(function(a, b) { return a.resourceId - b.resourceId; }),
      });
    });
    // Add independent forms as searchable and downloadable entries
    formRows.forEach(function(form) {
      if (skinResourceIds.has(form.id)) return;
      items.push({
        id:form.id,
        realId:form.basePetId,
        basePetId:form.basePetId,
        name:form.name,
        officialDefinition:true,
        identitySource:'u-client-config-form',
        extraSkins:[],
      });
    });
    items.sort(function(a, b) { return a.id - b.id; });
    var now = new Date().toISOString();
    return {
      version:3,
      schemaVersion:7,
      versionTag:'u-client-' + String(snapshot.fingerprint),
      source:'u-client-config',
      identitySource:'U-client ConfigPackage',
      updatedAt:now,
      officialDiscoverySource:'u-client-live-config',
      officialDiscoveryFingerprint:String(snapshot.fingerprint),
      officialDiscoveryCheckedAt:now,
      uClientSnapshotFingerprint:String(snapshot.fingerprint),
      uClientPackageVersions:packageObject(snapshot, 'version'),
      uClientManifestSha256:packageObject(snapshot, 'manifestSha256'),
      uClientCounts:{
        monsters:snapshot.config.monsters.length,
        skins:snapshot.config.skins.length,
        bodies:items.length,
        catalogSkins:skinRows.length,
        manualSupplements:skinRows.filter(function(row) { return row.historicalFlashOnly === true; }).length,
        excludedNonPlayerProfiles:excludedNonPlayerProfiles,
      },
      manualSupplementIds:HISTORICAL_SUPPLEMENT_SKINS.map(function(s) { return 1400000 + s.id; }),
      items:items,
    };
  }

  function matches(item, query) {
    if (!query) return true;
    return [item.id, item.resourceId, item.catalogueId, item.name,
      item.basePetId, item.basePetName].some(function(value) {
      return String(value == null ? '' : value).toLowerCase().indexOf(query) >= 0;
    }) || (item.extraSkins || []).some(function(skin) { return matches(skin, query); });
  }

  function matchesExactId(item, requestedId) {
    if (!requestedId) return false;
    return [item.id, item.resourceId, item.catalogueId, item.realId, item.basePetId]
      .some(function(value) { return parseId(value) === requestedId; }) ||
      (item.extraSkins || []).some(function(skin) { return matchesExactId(skin, requestedId); });
  }

  function query(catalog, request, downloadedIds) {
    if (!catalog || !Array.isArray(catalog.items)) throw new Error('U-client identity catalog is unavailable');
    request = request || {};
    var requestedCategory = String(request.category || 'pets').toLowerCase();
    var category = ['pets','skins','forms','downloaded'].indexOf(requestedCategory) >= 0
      ? requestedCategory : 'pets';
    var downloadedKind = ['pets','skins','forms'].indexOf(String(request.downloadedKind || '').toLowerCase()) >= 0
      ? String(request.downloadedKind).toLowerCase() : 'all';
    var queryText = String(request.query || '').trim().toLowerCase();
    var hasExactRequestedId = /^\d+$/.test(queryText);
    var exactRequestedId = hasExactRequestedId ? parseId(queryText) : 0;
    var pageSize = Math.max(12, Math.min(60, parseInt(request.pageSize, 10) || 24));
    var page = Math.max(1, parseInt(request.page, 10) || 1);
    var skinItems = [];
    catalog.items.forEach(function(pet) {
      (pet.extraSkins || []).forEach(function(skin) {
        skinItems.push({
          id:skin.resourceId,
          resourceId:skin.resourceId,
          catalogueId:skin.catalogueId,
          name:skin.name,
          basePetId:pet.id,
          basePetName:pet.name,
          sourceCategory:'skins',
          identitySource:skin.identitySource,
          historicalFlashOnly:skin.historicalFlashOnly === true,
          headUrl:thumbnailUrl(skin, pet),
          downloadable:true,
        });
      });
    });
    skinItems.sort(function(a, b) { return a.id - b.id; });
    var formItems = catalog.items.filter(function(pet) {
      return pet.isTransformForm === true || pet.identitySource === 'u-client-config-form';
    }).map(function(pet) {
      var targetId = pet.basePetId || pet.realId;
      var basePet = catalog.items.find(function(p) { return p.id === targetId; });
      var basePetName = basePet ? basePet.name : '';
      if (!basePetName && targetId >= 1400000) {
        for (var i = 0; i < catalog.items.length; i++) {
          var p = catalog.items[i];
          var matchedSkin = (p.extraSkins || []).find(function(s) {
            return s.resourceId === targetId || s.catalogueId === (targetId - 1400000);
          });
          if (matchedSkin) {
            basePetName = matchedSkin.name || p.name;
            break;
          }
        }
      }
      return {
        id:pet.id,
        name:pet.name,
        realId:pet.realId,
        basePetId:pet.basePetId,
        basePetName:basePetName,
        extraSkins:[],
        sourceCategory:'forms',
        identitySource:'u-client-config-form',
        isTransformForm:true,
        headUrl:thumbnailUrl(pet),
        downloadable:true,
      };
    });
    formItems.sort(function(a, b) { return a.id - b.id; });
    var petItems = catalog.items.map(function(pet) {
      return {
        id:pet.id,
        name:pet.name,
        realId:pet.realId,
        extraSkins:(pet.extraSkins || []).map(function(skin) {
          return { resourceId:skin.resourceId, catalogueId:skin.catalogueId, name:skin.name };
        }),
        sourceCategory:'pets',
        identitySource:'u-client-config',
        headUrl:thumbnailUrl(pet),
        downloadable:true,
      };
    });
    var downloaded = new Set((Array.isArray(downloadedIds) ? downloadedIds : [])
      .map(parseId).filter(Boolean));
    var downloadedItems = petItems.concat(skinItems).concat(formItems).filter(function(item) {
      return downloaded.has(parseId(item.id));
    }).sort(function(a, b) { return a.id - b.id; });
    if (downloadedKind !== 'all') downloadedItems = downloadedItems.filter(function(item) {
      return item.sourceCategory === downloadedKind;
    });
    var filtered = category === 'skins' ? skinItems
       : category === 'forms' ? formItems
       : category === 'downloaded' ? downloadedItems
       : petItems;
    filtered = filtered.filter(function(item) {
      return hasExactRequestedId ? matchesExactId(item, exactRequestedId) : matches(item, queryText);
    });
    var total = filtered.length;
    var pageCount = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(page, pageCount);
    var items = filtered.slice((page - 1) * pageSize, page * pageSize);
    return {
      ok:true,
      category:category,
      downloadedKind:downloadedKind,
      items:items,
      total:total,
      petTotal:petItems.length,
      skinTotal:skinItems.length,
      formTotal:formItems.length,
      downloadedTotal:petItems.concat(skinItems).concat(formItems).filter(function(item) {
        return downloaded.has(parseId(item.id));
      }).length,
      downloadedPetTotal:petItems.filter(function(item) { return downloaded.has(parseId(item.id)); }).length,
      downloadedSkinTotal:skinItems.filter(function(item) { return downloaded.has(parseId(item.id)); }).length,
      downloadedFormTotal:formItems.filter(function(item) { return downloaded.has(parseId(item.id)); }).length,
      page:page,
      pageSize:pageSize,
      pageCount:pageCount,
      updatedAt:String(catalog.updatedAt || ''),
      fromCache:catalog.fromCache === true,
      officialDiscoverySource:String(catalog.officialDiscoverySource || ''),
      officialDiscoveryFingerprint:String(catalog.officialDiscoveryFingerprint || ''),
      officialDiscoveryCheckedAt:String(catalog.officialDiscoveryCheckedAt || ''),
      catalogRevision:String(catalog.catalogRevision || ''),
      source:String(catalog.source || ''),
    };
  }

  return {
    build:build,
    query:query,
    officialSkinRows:officialSkinRows,
    thumbnailUrl:thumbnailUrl,
    deriveFormName:deriveFormName,
    canonicalFormNames:CANONICAL_FORM_NAMES,
    historicalSupplementSkins:HISTORICAL_SUPPLEMENT_SKINS,
    flashOnlyTigerKingSkin:FLASH_ONLY_TIGER_KING_SKIN,
    isExplicitNonPlayerProfile:isExplicitNonPlayerProfile,
  };
}

module.exports = {
  CANONICAL_FORM_NAMES:CANONICAL_FORM_NAMES,
  HISTORICAL_SUPPLEMENT_SKINS:HISTORICAL_SUPPLEMENT_SKINS,
  FLASH_ONLY_TIGER_KING_SKIN:FLASH_ONLY_TIGER_KING_SKIN,
  isExplicitNonPlayerProfile:isExplicitNonPlayerProfile,
  createUClientIdentityCatalog:createUClientIdentityCatalog,
};
