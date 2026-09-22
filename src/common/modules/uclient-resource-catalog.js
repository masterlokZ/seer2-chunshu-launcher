'use strict';

const crypto = require('crypto');
const conversionRoute = require('./uclient-conversion-route');

const ROOT = 'https://newseer.61.com/Assets/StandaloneWindows64/';
const PACKAGES = Object.freeze({
  config:'ConfigPackage', battle:'PetAnimPackage', follow:'FollowPackage', timeline:'DefaultPackage',
});

function parseYooManifest(buffer) {
  let offset = 0;
  function take(size) {
    if (size < 0 || offset + size > buffer.length) throw new Error('YooAsset manifest is truncated');
    const start = offset; offset += size; return start;
  }
  function u8() { return buffer.readUInt8(take(1)); }
  function bool() { return u8() === 1; }
  function u16() { return buffer.readUInt16LE(take(2)); }
  function i32() { return buffer.readInt32LE(take(4)); }
  function u32() { return buffer.readUInt32LE(take(4)); }
  function i64() { return Number(buffer.readBigInt64LE(take(8))); }
  function text() { const size = u16(); return buffer.slice(take(size),offset).toString('utf8'); }
  function i32Array() {
    const result = [];
    for (let count = u16(), index = 0; index < count; index++) result.push(i32());
    return result;
  }
  if (u32() !== 0x00594f4f) throw new Error('YooAsset manifest signature is invalid');
  const manifest = {
    fileVersion:text(), enableAddressable:bool(), locationToLower:bool(),
    includeAssetGUID:bool(), outputNameStyle:i32(), packageName:text(), packageVersion:text(),
    assets:[], bundles:[],
  };
  for (let count = i32(), index = 0; index < count; index++) manifest.assets.push({
    address:manifest.enableAddressable ? text() : '', assetPath:text(),
    assetGUID:manifest.includeAssetGUID ? text() : '', bundleID:i32(), dependIDs:i32Array(),
  });
  for (let count = i32(), index = 0; index < count; index++) manifest.bundles.push({
    bundleName:text(), unityCRC:u32(), fileHash:text(), fileCRC:text(), fileSize:i64(),
    isRawFile:bool(), loadMethod:u8(), referenceIDs:i32Array(),
  });
  if (offset !== buffer.length) throw new Error('YooAsset manifest has trailing bytes');
  return manifest;
}

function packageUrls(packageName, version) {
  const root = ROOT + packageName + '/';
  return {
    root:root,
    version:root + 'PackageManifest_' + packageName + '.version',
    manifest:version ? root + 'PackageManifest_' + packageName + '_' + version + '.bytes' : '',
  };
}

function bundleEvidence(manifest, asset) {
  if (!asset) return null;
  const bundle = manifest.bundles[Number(asset.bundleID)] || {};
  if (!/^[0-9a-f]{32}$/i.test(String(bundle.fileHash || '')) || Number(bundle.fileSize || 0) <= 0) {
    throw new Error('U-client bundle evidence is invalid for ' + String(asset.assetPath || ''));
  }
  return {
    assetPath:String(asset.assetPath || ''), bundleID:Number(asset.bundleID),
    dependIDs:Array.isArray(asset.dependIDs) ? asset.dependIDs.slice() : [],
    bundleName:String(bundle.bundleName || ''), fileHash:String(bundle.fileHash || '').toLowerCase(),
    bytes:Number(bundle.fileSize || 0), url:packageUrls(manifest.packageName).root + bundle.fileHash,
  };
}

function dependencyEvidence(manifest, asset) {
  const ids = Array.isArray(asset && asset.dependIDs) ? asset.dependIDs : [];
  return Array.from(new Set(ids.map(Number))).map(function(bundleID) {
    const bundle = manifest.bundles[bundleID] || {};
    if (!(bundleID >= 0) || !/^[0-9a-f]{32}$/i.test(String(bundle.fileHash || '')) ||
        Number(bundle.fileSize || 0) <= 0) {
      throw new Error('U-client dependency bundle evidence is invalid for ' +
        String(asset && asset.assetPath || '') + ' at bundle ' + String(bundleID));
    }
    return {
      bundleID:bundleID, bundleName:String(bundle.bundleName || ''),
      fileHash:String(bundle.fileHash).toLowerCase(), bytes:Number(bundle.fileSize),
      url:packageUrls(manifest.packageName).root + String(bundle.fileHash).toLowerCase(),
    };
  });
}

function buildIndex(packages) {
  const battle = packages.battle.manifest;
  const follow = packages.follow.manifest;
  const timeline = packages.timeline.manifest;
  const ftr = new Map(), spine = new Map(), small = new Map(), follows = new Map();
  const timelines = new Map(), effects = new Map(), videos = new Map();
  const standardEventVideos = new Map(), skillTimelineVideos = new Map();
  const presentations = new Map();
  function remember(target,id,asset,packageKey,metadata) {
    if (!(Number(id) > 0)) return;
    if (!target.has(id)) target.set(id,[]);
    // Skill resources can live in either PetAnimPackage or DefaultPackage.
    // Preserve the manifest provenance at index time; looking the same asset
    // up in the wrong package can accidentally resolve an unrelated bundleID.
    target.get(id).push(Object.assign({
      _packageKey:String(packageKey || ''),
      _ownerId:Number(id),
    },metadata || {},asset));
  }
  function rememberSupplemental(value,asset,packageKey) {
    let match = value.match(/^Assets\/Game\/Videos\/(\d+)\/([^/]+)\.mp4$/i);
    if (match) {
      const ownerId = Number(match[1]);
      const metadata = {_resourceFamily:'standard-event-video',_clip:String(match[2])};
      remember(standardEventVideos,ownerId,asset,packageKey,metadata);
      remember(videos,ownerId,asset,packageKey,metadata);
      return true;
    }
    match = value.match(/^Assets\/SkillTimeline\/Videos\/(\d+)\/([^/]+)\.mp4$/i);
    if (match) {
      const ownerId = Number(match[1]);
      const metadata = {_resourceFamily:'skill-timeline-video',_clip:String(match[2])};
      remember(skillTimelineVideos,ownerId,asset,packageKey,metadata);
      remember(videos,ownerId,asset,packageKey,metadata);
      return true;
    }
    match = value.match(/^Assets\/SkillTimeline\/Timelines\/(\d+)\/([^/]+)\.playable$/i);
    if (match) {
      remember(timelines,Number(match[1]),asset,packageKey,{
        _resourceFamily:'skill-timeline',_action:String(match[2]),
      });
      return true;
    }
    // This full anchor is deliberate. DefaultPackage also contains scene
    // Aimat/Throw Effect paths whose numeric names are not pet ownership.
    match = value.match(/^Assets\/SkillTimeline\/Effects\/(\d+)\/([^/]+)\.prefab$/i);
    if (match) {
      remember(effects,Number(match[1]),asset,packageKey,{
        _resourceFamily:'skill-timeline-effect',_action:String(match[2]),
      });
      return true;
    }
    return false;
  }
  battle.assets.forEach(function(asset) {
    const value = String(asset.assetPath || '');
    const route = conversionRoute.classifyModelAssetPath(value);
    if (route) {
      (route.family === 'spine' ? spine : ftr).set(route.ownerId,asset);
      return;
    }
    let match = value.match(/^Assets\/Pets\/(\d+)_small\.prefab$/i);
    if (match) { if (Number(match[1]) > 0) small.set(Number(match[1]),asset); return; }
    rememberSupplemental(value,asset,'battle');
  });
  ftr.forEach(function(_asset,id) {
    if (spine.has(id)) throw new Error('U-client owner has ambiguous FTR and Spine battle models: ' + id);
  });
  follow.assets.forEach(function(asset) {
    const match = String(asset.assetPath || '').match(/^Assets\/Follows\/(\d+)\/\1\.follow\.prefab$/i);
    if (match && Number(match[1]) > 0) follows.set(Number(match[1]),asset);
  });
  timeline.assets.forEach(function(asset) {
    const value = String(asset.assetPath || '');
    let match = value.match(/^Assets\/Game\/Prefabs\/Pet\/body\/(\d+)\.prefab$/i);
    if (match) { if (Number(match[1]) > 0) presentations.set(Number(match[1]),asset); return; }
    rememberSupplemental(value,asset,'timeline');
  });
  return { ftr:ftr, small:small, spine:spine, follows:follows,
    presentations:presentations, timelines:timelines, effects:effects, videos:videos,
    standardEventVideos:standardEventVideos, skillTimelineVideos:skillTimelineVideos };
}

function resolveIdentity(config, requestId, options) {
  options = options || {};
  const id = Number(requestId) || 0;
  const monsters = Array.isArray(config && config.monsters) ? config.monsters : [];
  const skins = Array.isArray(config && config.skins) ? config.skins : [];
  const monsterById = new Map(monsters.map(function(item) { return [Number(item.id),item]; }));
  const skinById = new Map(skins.map(function(item) { return [Number(item.id),item]; }));
  const requestedMonster = monsterById.get(id);
  // The launcher namespace currently stores official skin catalogue IDs at
  // 1400000 + catalogueId.  Treat that arithmetic only as an identity key:
  // it is a skin solely when the live config contains the exact catalogue
  // record.  Do not infer resource capabilities from a numeric ID range.
  const namespacedCatalogue = id - 1400000;
  const inferredCatalogue = skinById.has(namespacedCatalogue) ? namespacedCatalogue : 0;
  const catalogueId = Number(options.catalogueId || inferredCatalogue) || 0;
  const skin = catalogueId ? skinById.get(catalogueId) : null;
  const configuredBase = Number(options.basePetId || 0);
  const basePetId = skin ? Number(skin.monId || 0) : configuredBase;
  if (skin && configuredBase && basePetId !== configuredBase) {
    throw new Error('U-client skin ownership does not match the requested base pet');
  }
  const realId = requestedMonster && Number(requestedMonster.realId || 0) > 0
    ? Number(requestedMonster.realId) : id;
  return {
    requestId:id, assetId:realId, kind:skin ? 'skin' : 'body',
    catalogueId:catalogueId, basePetId:basePetId,
    name:String(skin && skin.name || requestedMonster && requestedMonster.name || options.name || ''),
    configFound:!!requestedMonster, ownershipVerified:skin ? basePetId > 0 : true,
  };
}

function credential(snapshot, requestId, options) {
  const identity = resolveIdentity(snapshot.config,requestId,options);
  const id = identity.assetId;
  const index = snapshot.index;
  const battleAsset = index.spine.get(id) || index.ftr.get(id);
  const family = index.spine.has(id) ? 'spine' : index.ftr.has(id) ? 'ftr' : '';
  const model = battleAsset ? bundleEvidence(snapshot.packages.battle.manifest,battleAsset) : null;
  const followAsset = index.follows.get(id);
  function supplementalEvidence(asset) {
    const packageKey = String(asset && asset._packageKey || 'timeline');
    const packageRecord = snapshot.packages[packageKey];
    if (!packageRecord || !packageRecord.manifest) {
      throw new Error('U-client supplemental asset package provenance is invalid');
    }
    return Object.assign(bundleEvidence(packageRecord.manifest,asset),{
      packageKey:packageKey,
      ownerId:Number(asset && asset._ownerId || 0),
      resourceFamily:String(asset && asset._resourceFamily || ''),
      action:String(asset && asset._action || ''),
      clip:String(asset && asset._clip || ''),
      dependencyBundles:dependencyEvidence(packageRecord.manifest,asset),
    });
  }
  const timelineEvidence = (index.timelines.get(id) || []).map(supplementalEvidence);
  const effectEvidence = (index.effects.get(id) || []).map(supplementalEvidence);
  const standardVideoEvidence = (index.standardEventVideos.get(id) || []).map(supplementalEvidence);
  const skillTimelineVideoEvidence = (index.skillTimelineVideos.get(id) || []).map(supplementalEvidence);
  const resourceFamilies = {
    standardEventVideos:standardVideoEvidence,
    skillTimeline:{
      timelines:timelineEvidence,
      effects:effectEvidence,
      videos:skillTimelineVideoEvidence,
    },
  };
  const selectedConversionRoute = model ? conversionRoute.selectConversionRoute({
    assetId:id,family:family,model:model,resourceFamilies:resourceFamilies,
  }) : null;
  return Object.assign({},identity,{
    family:family, model:model, conversionRoute:selectedConversionRoute,
    small:index.small.has(id) ? bundleEvidence(snapshot.packages.battle.manifest,index.small.get(id)) : null,
    follow:followAsset ? Object.assign(
      bundleEvidence(snapshot.packages.follow.manifest,followAsset),
      { dependencyBundles:dependencyEvidence(snapshot.packages.follow.manifest,followAsset) }
    ) : null,
    presentation:index.presentations.has(id)
      ? bundleEvidence(snapshot.packages.timeline.manifest,index.presentations.get(id)) : null,
    timeline:timelineEvidence,
    effects:effectEvidence,
    videos:standardVideoEvidence.concat(skillTimelineVideoEvidence),
    resourceFamilies:resourceFamilies,
    packageVersions:Object.fromEntries(Object.entries(snapshot.packages).map(function(entry) {
      return [entry[0],entry[1].version];
    })),
    complete:!!model,
  });
}

function modelRequestIds(snapshot) {
  const result = new Set();
  const index = snapshot && snapshot.index;
  if (!index) return [];
  index.ftr.forEach(function(_asset,id) { if (Number(id) > 0) result.add(Number(id)); });
  index.spine.forEach(function(_asset,id) { if (Number(id) > 0) result.add(Number(id)); });
  function remember(requestId, options) {
    try {
      const identity = resolveIdentity(snapshot.config,requestId,options);
      if (index.ftr.has(identity.assetId) || index.spine.has(identity.assetId)) {
        result.add(Number(requestId));
      }
    } catch (_) {}
  }
  (snapshot.config.monsters || []).forEach(function(item) {
    remember(Number(item && item.id),{});
  });
  (snapshot.config.skins || []).forEach(function(item) {
    const catalogueId = Number(item && item.id) || 0;
    const basePetId = Number(item && item.monId) || 0;
    if (catalogueId > 0) remember(1400000 + catalogueId,{
      catalogueId:catalogueId, basePetId:basePetId, name:String(item.name || ''),
    });
  });
  return Array.from(result).filter(function(id) { return id > 0; }).sort(function(a,b) { return a-b; });
}

function snapshot(packages, config) {
  Object.keys(PACKAGES).forEach(function(key) {
    if (!packages[key] || !packages[key].manifest) throw new Error('U-client snapshot is missing ' + key);
  });
  const value = { version:1, generatedAt:new Date().toISOString(), packages:packages, config:config };
  value.index = buildIndex(packages);
  value.fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    versions:Object.fromEntries(Object.entries(packages).map(function(entry) { return [entry[0],entry[1].version]; })),
    monsters:config && config.source && config.source.monstersSha256,
    skins:config && config.source && config.source.petSkinSha256,
  })).digest('hex').toUpperCase();
  return value;
}

module.exports = {
  ROOT:ROOT, PACKAGES:PACKAGES, parseYooManifest:parseYooManifest,
  packageUrls:packageUrls, bundleEvidence:bundleEvidence, dependencyEvidence:dependencyEvidence,
  buildIndex:buildIndex,
  resolveIdentity:resolveIdentity, credential:credential, modelRequestIds:modelRequestIds, snapshot:snapshot,
};
