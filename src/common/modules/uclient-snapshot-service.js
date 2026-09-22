'use strict';

function createUClientSnapshotService(options) {
  options = options || {};
  var fs = options.fs;
  var path = options.path;
  var crypto = options.crypto;
  var catalog = options.catalog;
  var fetchBuffer = options.fetchBuffer;
  var freshUrl = options.freshUrl;
  var writeBuffer = options.writeBuffer;
  var runExtractor = options.runExtractor;
  var cacheDirectory = options.cacheDirectory;
  var cacheTtlMs = Math.max(0, Number(options.cacheTtlMs) || 5 * 60 * 1000);
  var snapshotCache = null;
  var modelManifestCache = null;
  var checkedAt = 0;

  if (!fs || !path || !crypto || !catalog || typeof fetchBuffer !== 'function' ||
      typeof freshUrl !== 'function' || typeof writeBuffer !== 'function' ||
      typeof runExtractor !== 'function' || typeof cacheDirectory !== 'function') {
    throw new Error('U-client snapshot service dependencies are incomplete');
  }

  async function loadPackage(key, forceRefresh) {
    var packageName = catalog.PACKAGES[key];
    var urls = catalog.packageUrls(packageName);
    // Mutable version pointers are always cache-busted. Versioned manifests
    // and bundles remain reusable unless this request is a forced refresh.
    var versionBuffer = await fetchBuffer(freshUrl(urls.version, true), 15000, 0, 1024);
    var version = versionBuffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!/^\d{8,20}$/.test(version)) throw new Error(packageName + ' version response is invalid');
    var manifestUrl = catalog.packageUrls(packageName, version).manifest;
    var manifestBuffer = await fetchBuffer(freshUrl(manifestUrl, forceRefresh === true), 60000, 0, 16 * 1024 * 1024);
    var manifest = catalog.parseYooManifest(manifestBuffer);
    if (manifest.packageName !== packageName || String(manifest.packageVersion) !== version) {
      throw new Error(packageName + ' live manifest identity does not match its version endpoint');
    }
    return {
      key:key,
      name:packageName,
      version:version,
      manifest:manifest,
      manifestUrl:manifestUrl,
      manifestBytes:manifestBuffer.length,
      manifestSha256:crypto.createHash('sha256').update(manifestBuffer).digest('hex').toUpperCase(),
    };
  }

  async function loadIdentityConfig(configPackage, forceRefresh) {
    var manifest = configPackage.manifest;
    var required = ['monsters', 'pet_skin'].map(function(name) {
      return manifest.assets.find(function(asset) {
        return new RegExp('(?:^|/)' + name + '\\.bytes$', 'i').test(String(asset.assetPath || ''));
      });
    });
    if (required.some(function(asset) { return !asset; }) ||
        Number(required[0].bundleID) !== Number(required[1].bundleID)) {
      throw new Error('ConfigPackage does not provide one atomic monsters/pet_skin bundle');
    }
    var evidence = catalog.bundleEvidence(manifest, required[0]);
    var root = path.join(cacheDirectory(), configPackage.version);
    var bundleFile = path.join(root, evidence.fileHash + '.bundle');
    var outputRoot = path.join(root, 'identity');
    await fs.promises.mkdir(outputRoot, { recursive:true });
    var reusable = false;
    try { reusable = !forceRefresh && (await fs.promises.stat(bundleFile)).size === evidence.bytes; } catch(_) {}
    if (!reusable) {
      var buffer = await fetchBuffer(freshUrl(evidence.url, forceRefresh === true), 90000, 0, evidence.bytes + 1024);
      if (buffer.length !== evidence.bytes) throw new Error('ConfigPackage bundle size does not match live manifest');
      await writeBuffer(bundleFile, buffer);
    }
    var configFile = path.join(outputRoot, 'uclient-config.json');
    var configReusable = false;
    try {
      var current = JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
      var bundleSha = crypto.createHash('sha256').update(await fs.promises.readFile(bundleFile)).digest('hex').toUpperCase();
      configReusable = !forceRefresh && current && current.source &&
        String(current.source.bundleSha256 || '').toUpperCase() === bundleSha;
    } catch(_) {}
    if (!configReusable) await runExtractor(bundleFile, outputRoot, 0, [], { mode:'config' });
    return JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
  }

  async function buildSnapshot(forceRefresh) {
    var keys = Object.keys(catalog.PACKAGES);
    var loaded = await Promise.all(keys.map(function(key) { return loadPackage(key, forceRefresh === true); }));
    var packages = {};
    loaded.forEach(function(item) { packages[item.key] = item; });
    var config = await loadIdentityConfig(packages.config, forceRefresh === true);
    return catalog.snapshot(packages, config);
  }

  async function buildIdentitySnapshot(forceRefresh) {
    var configPackage = await loadPackage('config', forceRefresh === true);
    var config = await loadIdentityConfig(configPackage, forceRefresh === true);
    var fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      version:String(configPackage.version || ''),
      manifestSha256:String(configPackage.manifestSha256 || ''),
      monsters:config && config.source && config.source.monstersSha256,
      skins:config && config.source && config.source.petSkinSha256,
    })).digest('hex').toUpperCase();
    return {
      version:1,
      generatedAt:new Date().toISOString(),
      packages:{ config:configPackage },
      config:config,
      fingerprint:fingerprint,
      identityOnly:true,
    };
  }

  function resourceSnapshotClosureError(candidate) {
    if (!candidate) return 'snapshot is empty';
    if (candidate.identityOnly === true) return 'identity-only snapshot';
    if (!candidate.packages || !candidate.config || !candidate.index) {
      return 'snapshot is missing packages, config, or index';
    }
    var packageKeys = Object.keys(catalog.PACKAGES);
    for (var packageIndex = 0; packageIndex < packageKeys.length; packageIndex++) {
      var key = packageKeys[packageIndex];
      var expectedName = String(catalog.PACKAGES[key] || '');
      var packageRecord = candidate.packages[key];
      var manifest = packageRecord && packageRecord.manifest;
      if (!packageRecord || !manifest) return 'snapshot is missing package ' + key;
      if (!Array.isArray(manifest.assets) || !Array.isArray(manifest.bundles)) {
        return key + ' package manifest is incomplete';
      }
      if (String(manifest.packageName || '') !== expectedName ||
          !String(packageRecord.version || '') ||
          String(manifest.packageVersion || '') !== String(packageRecord.version || '')) {
        return key + ' package identity does not match its manifest';
      }
      for (var assetIndex = 0; assetIndex < manifest.assets.length; assetIndex++) {
        var asset = manifest.assets[assetIndex] || {};
        var bundleId = Number(asset.bundleID);
        if (!Number.isInteger(bundleId) || bundleId < 0 || bundleId >= manifest.bundles.length) {
          return key + ' package asset bundle closure is incomplete';
        }
        var dependIds = Array.isArray(asset.dependIDs) ? asset.dependIDs : [];
        for (var dependIndex = 0; dependIndex < dependIds.length; dependIndex++) {
          var dependId = Number(dependIds[dependIndex]);
          if (!Number.isInteger(dependId) || dependId < 0 || dependId >= manifest.bundles.length) {
            return key + ' package dependency bundle closure is incomplete';
          }
        }
      }
    }
    var indexKeys = ['ftr','small','spine','follows','presentations','timelines','effects',
      'videos','standardEventVideos','skillTimelineVideos'];
    for (var indexKeyIndex = 0; indexKeyIndex < indexKeys.length; indexKeyIndex++) {
      var indexValue = candidate.index[indexKeys[indexKeyIndex]];
      if (!indexValue || typeof indexValue.get !== 'function' ||
          typeof indexValue.has !== 'function' || typeof indexValue.forEach !== 'function') {
        return 'snapshot resource index closure is incomplete';
      }
    }
    if (!String(candidate.fingerprint || '')) return 'snapshot fingerprint is missing';
    return '';
  }

  function isCompleteResourceSnapshot(candidate) {
    return !resourceSnapshotClosureError(candidate);
  }

  function publishSnapshot(candidate) {
    if (candidate && candidate.identityOnly === true) {
      // Identity refreshes are intentionally independent from resource
      // manifests.  Keep the resource cache empty so the next download
      // obtains all four live packages instead of reading a partial snapshot.
      clear();
      throw new Error('cannot publish an identity-only U-client snapshot');
    }
    var closureError = resourceSnapshotClosureError(candidate);
    if (closureError) {
      throw new Error('cannot publish an incomplete U-client snapshot: ' + closureError);
    }
    snapshotCache = candidate;
    modelManifestCache = null;
    checkedAt = Date.now();
    return candidate;
  }

  async function stageSnapshot(forceRefresh) {
    return await buildSnapshot(forceRefresh === true);
  }

  async function stageIdentitySnapshot(forceRefresh) {
    return await buildIdentitySnapshot(forceRefresh === true);
  }

  async function getSnapshot(forceRefresh) {
    if (!forceRefresh && isCompleteResourceSnapshot(snapshotCache) &&
        Date.now() - checkedAt < cacheTtlMs) return snapshotCache;
    if (snapshotCache && !isCompleteResourceSnapshot(snapshotCache)) clear();
    return publishSnapshot(await buildSnapshot(forceRefresh === true));
  }

  function modelManifestFromSnapshot(snapshot) {
    if (!isCompleteResourceSnapshot(snapshot)) {
      throw new Error('U-client resource snapshot is incomplete; retrying full package refresh');
    }
    var battle = snapshot.packages.battle;
    var byPath = new Map();
    battle.manifest.assets.forEach(function(asset) {
      byPath.set(String(asset.assetPath || '').toLowerCase(), asset);
    });
    return {
      version:battle.version,
      manifest:battle.manifest,
      byPath:byPath,
      modelRequestIds:catalog.modelRequestIds(snapshot),
      snapshot:snapshot,
      fingerprint:snapshot.fingerprint,
    };
  }

  async function getModelManifest(forceRefresh) {
    var snapshot = await getSnapshot(!!forceRefresh);
    modelManifestCache = modelManifestFromSnapshot(snapshot);
    checkedAt = Date.now();
    return modelManifestCache;
  }

  function clear() {
    snapshotCache = null;
    modelManifestCache = null;
    checkedAt = 0;
  }

  return {
    getSnapshot:getSnapshot,
    stageSnapshot:stageSnapshot,
    stageIdentitySnapshot:stageIdentitySnapshot,
    publishSnapshot:publishSnapshot,
    getModelManifest:getModelManifest,
    modelManifestFromSnapshot:modelManifestFromSnapshot,
    peekSnapshot:function() { return snapshotCache; },
    peekModelManifest:function() { return modelManifestCache; },
    captureState:function() {
      return { snapshot:snapshotCache, manifest:modelManifestCache, checkedAt:checkedAt };
    },
    restoreState:function(state) {
      state = state || {};
      if (!state.snapshot) {
        clear();
        return;
      }
      if (!isCompleteResourceSnapshot(state.snapshot)) {
        clear();
        throw new Error('cannot restore an incomplete U-client snapshot');
      }
      snapshotCache = state.snapshot;
      modelManifestCache = state.manifest || null;
      checkedAt = Number(state.checkedAt) || 0;
    },
    clear:clear,
    _loadPackage:loadPackage,
    _loadIdentityConfig:loadIdentityConfig,
  };
}

module.exports = { createUClientSnapshotService:createUClientSnapshotService };
