'use strict';

function createCustomSkinScanIdentity(deps) {
  const fs = deps.fs;
  const path = deps.path;
  const crypto = deps.crypto;
  const parseId = deps.parseId;
  const getManagedRoot = deps.getManagedRoot;
  const getDownloadRoot = deps.getDownloadRoot;
  const getCurrentSkins = deps.getCurrentSkins;
  const resolveStoredSource = deps.resolveStoredSource;

  function pathKey(value) {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function inside(root, target) {
    if (!root || !target) return false;
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return relative !== '' && relative !== '..' && relative.indexOf('..' + path.sep) !== 0 &&
      !path.isAbsolute(relative);
  }

  function managedSkinId(source) {
    const root = path.resolve(String(getManagedRoot() || ''), 'files');
    if (!inside(root, source)) return 0;
    const relative = path.relative(root, path.resolve(source)).split(path.sep);
    return relative.length >= 2 ? parseId(relative[0]) : 0;
  }

  function hashFile(file, cache) {
    const key = pathKey(file);
    if (cache.has(key)) return cache.get(key);
    const pending = new Promise(function(resolve, reject) {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(file, { highWaterMark:1024 * 1024 });
      stream.on('data', function(chunk) { hash.update(chunk); });
      stream.once('error', reject);
      stream.once('end', function() { resolve(hash.digest('hex')); });
    });
    cache.set(key, pending);
    return pending;
  }

  async function sameFile(left, leftStat, right, rightStat, hashCache) {
    if (!leftStat || !rightStat || leftStat.size !== rightStat.size) return false;
    if (leftStat.dev === rightStat.dev && leftStat.ino && leftStat.ino === rightStat.ino) return true;
    const hashes = await Promise.all([hashFile(left, hashCache), hashFile(right, hashCache)]);
    return hashes[0] === hashes[1];
  }

  async function readJson(file) {
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 8 * 1024 * 1024) return null;
      return JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  async function metadataForInventory(root, sourceId) {
    const battleManifest = await readJson(path.join(root, 'battle-variants.json'));
    const fightBuild = await readJson(path.join(root, 'uclient-fight-build.json'));
    const followBuild = await readJson(path.join(root, 'uclient-follow-build.json'));
    const uclient = battleManifest && battleManifest.variants && battleManifest.variants.uclient || {};
    const conversion = uclient && uclient.conversion || fightBuild || {};
    return {
      sourceId:sourceId,
      previewAdapter:battleManifest && battleManifest.selectedBattleVariant === 'uclient-self-contained'
        ? 'uclient' : (battleManifest ? 'swf' : ''),
      selectedBattleVariant:String(battleManifest && battleManifest.selectedBattleVariant || ''),
      selectionReason:String(battleManifest && battleManifest.selectionReason || ''),
      variantManifest:battleManifest ? path.join(root, 'battle-variants.json') : '',
      uClientPackageVersion:String(uclient.packageVersion || conversion.packageVersion || ''),
      uClientAssetPath:String(uclient.assetPath || conversion.assetPath || ''),
      uClientActions:Array.isArray(uclient.actions) ? uclient.actions.slice() :
        (Array.isArray(conversion.actions) ? conversion.actions.slice() : []),
      uClientDedicatedUltimate:!!(uclient.capabilities && uclient.capabilities.dedicatedUltimate),
      uClientFollowAvailable:!!followBuild,
      legacyFightPlayable:!!(battleManifest && battleManifest.variants &&
        battleManifest.variants.legacySwf && battleManifest.variants.legacySwf.available),
    };
  }

  async function createResolver() {
    const hashCache = new Map();
    const inventoryBySize = new Map();
    const metadataCache = new Map();
    const downloadRoot = path.resolve(String(getDownloadRoot() || ''));
    let directories = [];
    try { directories = await fs.promises.readdir(downloadRoot, { withFileTypes:true }); }
    catch (_) { directories = []; }
    for (let dirIndex = 0; dirIndex < directories.length; dirIndex++) {
      const item = directories[dirIndex];
      const sourceId = item.isDirectory() ? parseId(item.name) : 0;
      if (!sourceId) continue;
      const root = path.join(downloadRoot, item.name);
      let files = [];
      try { files = await fs.promises.readdir(root, { withFileTypes:true }); }
      catch (_) { continue; }
      for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
        const fileItem = files[fileIndex];
        if (!fileItem.isFile() || !/\.swf$/i.test(fileItem.name)) continue;
        const file = path.join(root, fileItem.name);
        let stat;
        try { stat = await fs.promises.stat(file); }
        catch (_) { continue; }
        if (!stat.isFile() || stat.size <= 0) continue;
        const list = inventoryBySize.get(stat.size) || [];
        list.push({ sourceId:sourceId, root:root, file:file, stat:stat });
        inventoryBySize.set(stat.size, list);
      }
    }

    async function resolve(source) {
      const absolute = path.resolve(source);
      const preferredSkinId = managedSkinId(absolute);
      let sourceStat;
      try { sourceStat = await fs.promises.stat(absolute); }
      catch (_) { return { preferredSkinId:preferredSkinId, sourceId:0, metadata:null }; }
      const inventoryMatches = [];
      const candidates = inventoryBySize.get(sourceStat.size) || [];
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (await sameFile(absolute, sourceStat, candidate.file, candidate.stat, hashCache)) {
          inventoryMatches.push(candidate);
        }
      }
      const ids = Array.from(new Set(inventoryMatches.map(function(item) { return item.sourceId; })));
      if (ids.length === 1) {
        const sourceId = ids[0];
        if (!metadataCache.has(sourceId)) {
          metadataCache.set(sourceId, metadataForInventory(inventoryMatches[0].root, sourceId));
        }
        return { preferredSkinId:preferredSkinId, sourceId:sourceId,
          metadata:await metadataCache.get(sourceId), evidence:'download-inventory-hash' };
      }

      const current = Array.isArray(getCurrentSkins()) ? getCurrentSkins() : [];
      for (let entryIndex = 0; entryIndex < current.length; entryIndex++) {
        const entry = current[entryIndex] || {};
        const files = entry.files || {};
        const types = Object.keys(files);
        for (let typeIndex = 0; typeIndex < types.length; typeIndex++) {
          const stored = String(files[types[typeIndex]] || '').trim();
          if (!stored || /^https?:\/\//i.test(stored)) continue;
          let existing;
          try { existing = path.resolve(resolveStoredSource(stored)); }
          catch (_) { continue; }
          let existingStat;
          try { existingStat = await fs.promises.stat(existing); }
          catch (_) { continue; }
          if (await sameFile(absolute, sourceStat, existing, existingStat, hashCache)) {
            return {
              preferredSkinId:preferredSkinId || parseId(entry.skinId),
              sourceId:parseId(entry.sourceId),
              metadata:{
                officialName:String(entry.name || ''),
                basePetId:parseId(entry.basePetId),
                officialSkinId:parseId(entry.officialSkinId),
                sourceKind:entry.sourceKind,
                previewAdapter:entry.previewAdapter,
                selectedBattleVariant:entry.selectedBattleVariant,
                selectionReason:entry.battleVariantReason,
                variantManifest:entry.battleVariantManifest,
                uClientPackageVersion:entry.uClientPackageVersion,
                uClientAssetPath:entry.uClientAssetPath,
                uClientActions:entry.uClientActions,
                uClientDedicatedUltimate:entry.uClientDedicatedUltimate,
                uClientFollowAvailable:entry.uClientFollowAvailable,
                legacyFightPlayable:entry.legacyFightPlayable,
              },
              evidence:'registered-file-hash',
            };
          }
        }
      }
      return { preferredSkinId:preferredSkinId, sourceId:0, metadata:null,
        evidence:ids.length > 1 ? 'ambiguous-inventory-hash' : '' };
    }

    return { resolve:resolve };
  }

  return { createResolver:createResolver };
}

module.exports = { createCustomSkinScanIdentity:createCustomSkinScanIdentity };
