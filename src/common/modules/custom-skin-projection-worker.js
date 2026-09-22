'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseId(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : 0;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function fileBytes(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? Number(stat.size) || 0 : 0;
  } catch (_) { return 0; }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex').toUpperCase();
}

function requiredFilesExist(root, conversion) {
  const required = Array.isArray(conversion && conversion.requiredFiles)
    ? conversion.requiredFiles : [];
  for (let index = 0; index < required.length; index++) {
    const relative = String(required[index] || '').replace(/\\/g, '/');
    if (!relative || relative === '..' || relative.indexOf('../') === 0 || path.isAbsolute(relative)) return false;
    const absolute = path.resolve(root, relative);
    const relation = path.relative(path.resolve(root), absolute);
    if (!relation || relation === '..' || relation.indexOf('..' + path.sep) === 0 || path.isAbsolute(relation)) return false;
    if (!fs.existsSync(absolute)) return false;
  }
  return true;
}

function inspectBattleRoot(root, sourceId, manifest) {
  const selected = String(manifest && manifest.selectedBattleVariant || '');
  const primary = manifest && manifest.primary || {};
  const primaryName = String(primary.file || 'fight.swf');
  const primaryFile = path.resolve(root, primaryName);
  const relation = path.relative(path.resolve(root), primaryFile);
  if (!relation || relation === '..' || relation.indexOf('..' + path.sep) === 0 || path.isAbsolute(relation)) {
    return { ok:false, selectedBattleVariant:selected, reason:'primary-path-outside-root' };
  }
  const bytes = fileBytes(primaryFile);
  if (!bytes) return { ok:false, selectedBattleVariant:selected, reason:'primary-missing' };
  if (Number(primary.bytes) > 0 && Number(primary.bytes) !== bytes) {
    return { ok:false, selectedBattleVariant:selected, reason:'primary-size-mismatch' };
  }
  const expectedSha = String(primary.sha256 || '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(expectedSha) || sha256File(primaryFile) !== expectedSha) {
    return { ok:false, selectedBattleVariant:selected, reason:'primary-sha256-mismatch' };
  }
  if (selected === 'legacy-swf') {
    const legacy = manifest && manifest.variants && manifest.variants.legacySwf || {};
    const capabilities = legacy.capabilities || {};
    if (capabilities.legacyPlayable !== true || capabilities.staticPoseWrapper === true) {
      return { ok:false, selectedBattleVariant:selected, reason:'legacy-action-contract-invalid' };
    }
    const legacySha = String(legacy.sha256 || '').toUpperCase();
    if (legacySha && legacySha !== expectedSha) {
      return { ok:false, selectedBattleVariant:selected, reason:'legacy-primary-sha256-mismatch' };
    }
    return { ok:true, selectedBattleVariant:selected, reason:'' };
  }
  if (selected === 'uclient-self-contained') {
    const uclient = manifest && manifest.variants && manifest.variants.uclient || {};
    const conversion = uclient.conversion || {};
    if (uclient.complete !== true || primary.selfContained !== true || parseId(conversion.sourceId) !== sourceId) {
      return { ok:false, selectedBattleVariant:selected, reason:'uclient-conversion-contract-invalid' };
    }
    const conversionSha = String(conversion.fightSha256 || '').toUpperCase();
    if (conversionSha && conversionSha !== expectedSha) {
      return { ok:false, selectedBattleVariant:selected, reason:'uclient-primary-sha256-mismatch' };
    }
    if (!requiredFilesExist(root, conversion)) {
      return { ok:false, selectedBattleVariant:selected, reason:'uclient-required-file-missing' };
    }
    return { ok:true, selectedBattleVariant:selected, reason:'' };
  }
  return { ok:false, selectedBattleVariant:selected, reason:'unsupported-selected-variant' };
}

function scanInventory(root, manifestVersion) {
  const ids = new Set();
  const uClientIds = new Set();
  const entries = [];
  if (!root || !fs.existsSync(root)) return { ids:[], uClientIds:[], entries:[] };
  fs.readdirSync(root).forEach(function(name) {
    const id = parseId(name);
    if (!id) return;
    const itemRoot = path.join(root, String(name));
    let stat;
    try { stat = fs.statSync(itemRoot); } catch (_) { return; }
    if (!stat.isDirectory()) return;
    const files = {};
    ['normal','fight','icon','skill'].forEach(function(type) {
      files[type] = fileBytes(path.join(itemRoot, type + '.swf'));
    });
    const hasPreview = fs.existsSync(path.join(itemRoot, 'uclient-preview', 'uclient-preview.json')) &&
      fs.existsSync(path.join(itemRoot, 'uclient-preview', 'uclient-animation.json.gz')) &&
      (fs.existsSync(path.join(itemRoot, 'uclient-preview', 'uclient-atlas.webp')) ||
       fs.existsSync(path.join(itemRoot, 'uclient-preview', 'uclient-atlas.png')));
    let variantManifest = readJson(path.join(itemRoot, 'battle-variants.json'));
    if (!variantManifest || variantManifest.version !== manifestVersion ||
        parseId(variantManifest.sourceId) !== id) variantManifest = null;
    let fightBuild = readJson(path.join(itemRoot, 'uclient-fight-build.json'));
    if (!fightBuild || parseId(fightBuild.sourceId) !== id) fightBuild = null;
    const selectedBattleVariant = String(variantManifest && variantManifest.selectedBattleVariant || '');
    let battleIntegrity = null;
    if (files.fight > 0 && variantManifest) {
      try { battleIntegrity = inspectBattleRoot(itemRoot, id, variantManifest); }
      catch (error) { battleIntegrity = { ok:false, reason:error.message }; }
    }
    const battlePlayable = !!(battleIntegrity && battleIntegrity.ok === true &&
      (battleIntegrity.selectedBattleVariant === 'legacy-swf' ||
       battleIntegrity.selectedBattleVariant === 'uclient-self-contained'));
    const hasUClient = !!((battlePlayable && selectedBattleVariant === 'uclient-self-contained') || hasPreview);
    if (hasUClient) uClientIds.add(id);
    if (!hasUClient && !Object.keys(files).some(function(key) { return files[key] > 0; })) return;
    ids.add(id);
    entries.push({
      sourceId:id,
      files:files,
      uClientAvailable:hasUClient,
      selectedBattleVariant:selectedBattleVariant,
      selectionReason:String(variantManifest && variantManifest.selectionReason || ''),
      battlePlayable:battlePlayable,
      battleArtifactLayer:battlePlayable ? String(fightBuild && fightBuild.artifactLayer || 'battle') : 'missing',
      battleIntegrityReason:battlePlayable ? 'verified-at-commit' :
        (files.fight > 0 ? String(battleIntegrity && battleIntegrity.reason ||
          (variantManifest ? 'battle-integrity-unverified' : 'battle-manifest-missing')) : 'missing-fight'),
      previewAvailable:hasPreview,
      previewArtifactLayer:hasPreview ? 'preview-inventory' : 'missing',
      skillBuildReady:files.skill > 0,
      skillIntegrityReason:fs.existsSync(path.join(itemRoot, 'uclient-video-build.json')) && files.skill <= 0
        ? 'missing-skill' : '',
      legacyStaticPoseWrapper:!!(variantManifest && variantManifest.variants &&
        variantManifest.variants.legacySwf && variantManifest.variants.legacySwf.staticPoseWrapper),
      variantManifest:variantManifest,
    });
  });
  return {
    ids:Array.from(ids).sort(function(a,b) { return a-b; }),
    uClientIds:Array.from(uClientIds).sort(function(a,b) { return a-b; }),
    entries:entries.sort(function(a,b) { return a.sourceId-b.sourceId; }),
  };
}

function scanRegisteredFiles(entries) {
  const result = {};
  (Array.isArray(entries) ? entries : []).forEach(function(entry) {
    const id = parseId(entry && entry.skinId);
    if (!id) return;
    const sizes = {};
    const files = entry && entry.files || {};
    Object.keys(files).forEach(function(type) {
      const source = String(files[type] || '');
      sizes[type] = source && !/^https?:\/\//i.test(source) ? fileBytes(source) : 0;
    });
    result[String(id)] = sizes;
  });
  return result;
}

try {
  parentPort.postMessage({
    ok:true,
    requestId:workerData.requestId,
    inventory:scanInventory(workerData.downloadRoot, workerData.manifestVersion),
    registeredFileBytes:scanRegisteredFiles(workerData.registeredEntries),
  });
} catch (error) {
  parentPort.postMessage({ ok:false, requestId:workerData.requestId, error:error && error.message || String(error) });
}
