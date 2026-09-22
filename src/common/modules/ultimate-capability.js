'use strict';

const crypto = require('crypto');
const path = require('path');

const SCHEMA_VERSION = 1;
const DIRECT_ACTION_KINDS = new Set([
  'uclient-ftr-action', 'uclient-spine-action', 'uclient-action-inventory',
  'legacy-dynamic-action', 'downloaded-action-inventory', 'uclient-owned-action',
]);

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function normalizeActionName(value) {
  let action = String(value || '').trim().toLowerCase().replace(/\s+/g, '').replace(/-/g, '_');
  action = action.replace(/_+/g, '_');
  const move = action.match(/^moves?_?(\d+)(?:_?(\d+))?$/);
  if (move) return 'moves_' + move[1] + (move[2] ? '_' + move[2] : '');
  return action.replace(/_/g, '');
}

function isDedicatedUltimateAction(value) {
  const action = normalizeActionName(value);
  return /^(?:attack1|sa5|as5|attack5|hidemove\d*|ultimate\d*|add1|moves_\d+(?:_\d+)?)$/.test(action);
}

function normalizeUltimateActions(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(normalizeActionName).filter(function(action) {
    if (!action || !isDedicatedUltimateAction(action) || seen.has(action)) return false;
    seen.add(action);
    return true;
  });
}

function parseRobotCoreReplacementXml(value) {
  const xml = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  const rows = [];
  const pattern = /<item\s+([^>]+)>\s*<skill\s+([^>]+)\/?\s*>\s*<\/item>/ig;
  function attributes(source) {
    const output = {};
    String(source || '').replace(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g, function(_all, key, _quote, raw) {
      output[key] = raw;
      return _all;
    });
    return output;
  }
  let match;
  while ((match = pattern.exec(xml))) {
    const item = attributes(match[1]);
    const skill = attributes(match[2]);
    const skinId = positiveInteger(item.skinid);
    const petId = positiveInteger(item.petid);
    const requestId = skinId ? 1400000 + skinId : petId;
    const skillId = positiveInteger(skill.id);
    if (!requestId || !skillId) continue;
    rows.push({
      requestId:requestId,
      skinId:skinId,
      petId:petId,
      skillId:skillId,
      replacementSkillId:positiveInteger(skill.replaceId),
      action:normalizeActionName(skill.action),
      source:'robotcore-replacement',
    });
  }
  return normalizeReplacementRows(rows);
}

function normalizeReplacementRows(values) {
  const rows = [];
  const seen = new Set();
  function add(raw) {
    raw = raw || {};
    const skinId = positiveInteger(raw.skinId || raw.skinid);
    const petId = positiveInteger(raw.petId || raw.petid);
    const requestId = positiveInteger(raw.requestId) || (skinId ? 1400000 + skinId : petId);
    const skill = raw.skill || {};
    const skillId = positiveInteger(raw.skillId || skill.id);
    const action = normalizeActionName(raw.action || skill.action);
    if (!requestId || !skillId) return;
    const replacementSkillId = positiveInteger(raw.replacementSkillId || skill.replaceId);
    const key = [requestId, skillId, replacementSkillId, action].join(':');
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ requestId, skinId, petId, skillId, replacementSkillId, action,
      source:String(raw.source || 'robotcore-replacement') });
  }
  if (Array.isArray(values)) values.forEach(add);
  else {
    const root = values && values.Root;
    const items = root && root.item;
    (Array.isArray(items) ? items : (items ? [items] : [])).forEach(add);
  }
  return rows.sort(function(a, b) {
    return a.requestId - b.requestId || a.skillId - b.skillId || a.replacementSkillId - b.replacementSkillId;
  });
}

function replacementRowsToLegacyConfig(rows) {
  return { Root:{ item:normalizeReplacementRows(rows).map(function(row) {
    return {
      skinid:row.skinId,
      petid:row.petId,
      skill:{ id:row.skillId, replaceId:row.replacementSkillId, action:row.action },
    };
  }) } };
}

function mergeReplacementRows() {
  const merged = [];
  for (let i = 0; i < arguments.length; i++) {
    normalizeReplacementRows(arguments[i]).forEach(function(row) { merged.push(row); });
  }
  // Later/live sources replace older rows with the same exact credential and skill.
  const byKey = new Map();
  merged.forEach(function(row) { byKey.set(row.requestId + ':' + row.skillId, row); });
  return Array.from(byKey.values()).sort(function(a, b) {
    return a.requestId - b.requestId || a.skillId - b.skillId;
  });
}

function normalizeActionIndex(value) {
  value = value || {};
  const sourceRecords = value.records || value;
  const records = {};
  if (sourceRecords instanceof Map) {
    sourceRecords.forEach(function(record, key) { records[String(key)] = record; });
  } else if (Array.isArray(sourceRecords)) {
    sourceRecords.forEach(function(record) {
      const id = positiveInteger(record && (record.assetId || record.id));
      if (id) records[String(id)] = record;
    });
  } else if (sourceRecords && typeof sourceRecords === 'object') {
    Object.keys(sourceRecords).forEach(function(key) { records[String(key)] = sourceRecords[key]; });
  }
  const normalized = {};
  Object.keys(records).forEach(function(key) {
    const raw = records[key] || {};
    const assetId = positiveInteger(raw.assetId || key);
    if (!assetId) return;
    const actions = Array.from(new Set((Array.isArray(raw.actions) ? raw.actions : [])
      .map(normalizeActionName).filter(Boolean)));
    normalized[String(assetId)] = {
      assetId:assetId,
      family:String(raw.family || ''),
      bundleHash:String(raw.bundleHash || raw.fileHash || '').toLowerCase(),
      bundleBytes:Number(raw.bundleBytes || raw.bytes || 0),
      actions:actions,
      extractorVersion:String(raw.extractorVersion || value.extractorVersion || ''),
      inspectedAt:String(raw.inspectedAt || value.generatedAt || ''),
    };
  });
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').toUpperCase();
  return {
    version:positiveInteger(value.version) || SCHEMA_VERSION,
    generatedAt:String(value.generatedAt || ''),
    extractorVersion:String(value.extractorVersion || ''),
    snapshotFingerprint:String(value.snapshotFingerprint || ''),
    records:normalized,
    fingerprint:fingerprint,
  };
}

function mergeActionIndexes() {
  const records = {};
  let generatedAt = '';
  let extractorVersion = '';
  let snapshotFingerprint = '';
  for (let index = 0; index < arguments.length; index++) {
    const normalized = normalizeActionIndex(arguments[index] || {});
    Object.keys(normalized.records).forEach(function(key) {
      records[key] = normalized.records[key];
    });
    generatedAt = normalized.generatedAt || generatedAt;
    extractorVersion = normalized.extractorVersion || extractorVersion;
    snapshotFingerprint = normalized.snapshotFingerprint || snapshotFingerprint;
  }
  return normalizeActionIndex({ version:SCHEMA_VERSION, generatedAt:generatedAt,
    extractorVersion:extractorVersion, snapshotFingerprint:snapshotFingerprint,
    records:records });
}

function modelBundleEvidence(snapshot, assetId) {
  if (!snapshot || !snapshot.index || !snapshot.packages || !snapshot.packages.battle) return null;
  const asset = snapshot.index.ftr.get(assetId) || snapshot.index.spine.get(assetId);
  if (!asset) return null;
  const bundle = snapshot.packages.battle.manifest.bundles[Number(asset.bundleID)] || {};
  return {
    family:snapshot.index.spine.has(assetId) ? 'spine' : 'ftr',
    assetPath:String(asset.assetPath || ''),
    bundleHash:String(bundle.fileHash || '').toLowerCase(),
    bundleBytes:Number(bundle.fileSize || 0),
  };
}

function exactSupplementalEvidence(snapshot, assetId) {
  if (!snapshot || !snapshot.index) return [];
  const result = [];
  const owned = new RegExp('^Assets/SkillTimeline/(Timelines|Effects|Videos)/' + assetId + '/', 'i');
  [['timeline', snapshot.index.timelines], ['effect', snapshot.index.effects], ['video', snapshot.index.videos]]
    .forEach(function(entry) {
      const kind = entry[0];
      (entry[1].get(assetId) || []).forEach(function(asset) {
        const assetPath = String(asset.assetPath || '');
        if (!owned.test(assetPath)) return;
        const base = path.basename(assetPath).replace(/\.(?:playable|prefab|mp4)$/i, '');
        result.push({ kind:'uclient-owned-' + kind, requestId:0, assetId:assetId,
          action:normalizeActionName(base), assetPath:assetPath, exactOwner:true });
      });
    });
  return result;
}

function normalizeEvidence(raw, credential) {
  raw = raw || {};
  const kind = String(raw.kind || raw.source || '').toLowerCase();
  const requestId = positiveInteger(raw.requestId) || credential.requestId;
  const assetId = positiveInteger(raw.assetId) || credential.assetId;
  if (requestId !== credential.requestId || assetId !== credential.assetId) return null;
  const action = normalizeActionName(raw.action);
  const dedicated = isDedicatedUltimateAction(action);
  let status = 'none';
  if (/(?:^|-)replacement$/.test(kind) && dedicated) {
    // The replacement table is a live RobotCore declaration bound to the
    // exact launcher request identity.  A row is authoritative only when the
    // caller also supplies the current RobotCore fingerprint; imported/stale
    // rows remain candidates until another exact playback source verifies it.
    status = kind === 'robotcore-replacement' && raw.current === true && raw.exactOwner === true
      ? 'verified' : 'candidate';
  }
  else if (DIRECT_ACTION_KINDS.has(kind) && dedicated && raw.dynamic !== false && raw.current !== false) status = 'verified';
  else if (/^uclient-owned-(?:timeline|effect|video)$/.test(kind) && raw.exactOwner === true) {
    status = dedicated ? 'verified' : 'candidate';
  }
  return {
    kind:kind,
    requestId:requestId,
    assetId:assetId,
    action:action,
    status:status,
    dynamic:raw.dynamic === true,
    current:raw.current === true,
    exactOwner:raw.exactOwner === true,
    skillId:positiveInteger(raw.skillId),
    replacementSkillId:positiveInteger(raw.replacementSkillId),
    fingerprint:String(raw.fingerprint || raw.bundleHash || ''),
    assetPath:String(raw.assetPath || ''),
    reason:String(raw.reason || ''),
  };
}

function deriveUltimateCapability(credential, evidenceRows, options) {
  credential = {
    requestId:positiveInteger(credential && credential.requestId),
    assetId:positiveInteger(credential && credential.assetId),
  };
  if (!credential.requestId || !credential.assetId) {
    return { state:'none', dedicatedUltimate:false, actions:[], evidence:[], reason:'invalid-credential' };
  }
  const evidence = (Array.isArray(evidenceRows) ? evidenceRows : []).map(function(row) {
    return normalizeEvidence(row, credential);
  }).filter(Boolean);
  const verified = evidence.filter(function(row) { return row.status === 'verified'; });
  const candidates = evidence.filter(function(row) { return row.status === 'candidate'; });
  // Candidate evidence is deliberately not cross-promoted.  An exact owned
  // `appear` timeline, for example, cannot prove a RobotCore `hidemove` row.
  // Each verified source must independently prove the same exact credential
  // and a recognized dedicated action.
  let state = verified.length ? 'verified' :
    (candidates.length ? 'candidate' : (options && options.actionInventoryKnown === false ? 'unknown' : 'none'));
  const actions = Array.from(new Set(verified.map(function(row) {
    return row.action;
  }).filter(isDedicatedUltimateAction)));
  return {
    state:state,
    dedicatedUltimate:state === 'verified',
    actions:actions,
    evidence:evidence,
    reason:state === 'verified' ? 'exact-capability-evidence' :
      (state === 'candidate' ? 'candidate-needs-playable-action' :
        (state === 'unknown' ? 'uclient-action-inventory-missing' : 'no-dedicated-action')),
  };
}

function annotateCredential(target, context) {
  if (!target) return target;
  context = context || {};
  const requestId = positiveInteger(target.resourceId || target.id);
  const assetId = positiveInteger(target.uClientAssetId || target.realId || requestId) || requestId;
  const credential = { requestId:requestId, assetId:assetId };
  const evidence = [];
  const replacements = normalizeReplacementRows(context.replacementRows || []);
  replacements.filter(function(row) { return row.requestId === requestId; }).forEach(function(row) {
    evidence.push({ kind:String(row.source || 'seer-uclient-replacement'), requestId:requestId, assetId:assetId,
      action:row.action, skillId:row.skillId, replacementSkillId:row.replacementSkillId,
      fingerprint:String(context.robotCoreFingerprint || ''),
      current:row.source === 'robotcore-replacement' && !!String(context.robotCoreFingerprint || ''),
      exactOwner:true });
  });

  const actionIndex = context.normalizedActionIndex || normalizeActionIndex(context.actionIndex || {});
  const actionRecord = actionIndex.records[String(assetId)];
  const model = modelBundleEvidence(context.snapshot, assetId);
  const actionInventoryCurrent = !!(actionRecord && model && actionRecord.bundleHash &&
    actionRecord.bundleHash === model.bundleHash);
  if (actionInventoryCurrent) {
    normalizeUltimateActions(actionRecord.actions).forEach(function(action) {
      evidence.push({ kind:'uclient-action-inventory', requestId:requestId, assetId:assetId,
        action:action, dynamic:true, current:true, fingerprint:actionRecord.bundleHash });
    });
  }

  exactSupplementalEvidence(context.snapshot, assetId).forEach(function(row) {
    row.requestId = requestId;
    evidence.push(row);
  });

  const check = context.legacyCheck || {};
  // Variant capability is additive.  A verified dynamic legacy variant is
  // still valid evidence when a U-client model is selected as primary.  Never
  // fall back to all frame labels here: static compatibility shells publish
  // convincing labels without any playable action branch.
  if (check.fightPlayable === true && check.staticPoseWrapper !== true) {
    normalizeUltimateActions(check.dynamicCoreActions || []).forEach(function(action) {
      evidence.push({ kind:'legacy-dynamic-action', requestId:requestId, assetId:assetId,
        action:action, dynamic:true, current:true, fingerprint:String(check.fightFingerprint || '') });
    });
  }
  const capability = deriveUltimateCapability(credential, evidence, {
    actionInventoryKnown:target.uClientModelAvailable === true ? actionInventoryCurrent : true,
  });
  target.ultimateCapabilitySchemaVersion = SCHEMA_VERSION;
  target.ultimateCapabilityState = capability.state;
  target.ultimateCapabilityReason = capability.reason;
  target.ultimateEvidence = capability.evidence;
  target.dedicatedUltimateActions = capability.actions;
  target.dedicatedUltimate = capability.dedicatedUltimate;
  target.uClientActionInventoryKnown = target.uClientModelAvailable === true ? actionInventoryCurrent : null;
  target.uClientActionIndexFingerprint = actionIndex.fingerprint;
  return target;
}

function collectUltimateProbeIds(catalog, page, pageSize) {
  catalog = catalog || {};
  page = Math.max(1, positiveInteger(page) || 1);
  pageSize = Math.max(1, positiveInteger(pageSize) || 24);
  const ids = [];
  const seen = new Set();
  function remember(value) {
    const id = positiveInteger(value);
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  }
  // Candidate and unknown sets are intentionally included: deriving the
  // probe page from the already-verified category recreates the old
  // self-closed classifier and makes missing entries impossible to discover.
  (catalog.ultimateCandidateIds || []).forEach(remember);
  (catalog.uClientActionUnknownIds || []).forEach(remember);
  (catalog.ultimateVerifiedIds || []).forEach(remember);
  ids.sort(function(a, b) { return a - b; });
  const start = (page - 1) * pageSize;
  return ids.slice(start, start + pageSize);
}

function annotateCatalog(catalog, context) {
  if (!catalog || !Array.isArray(catalog.items)) return catalog;
  context = context || {};
  context = Object.assign({}, context, {
    normalizedActionIndex:context.normalizedActionIndex || normalizeActionIndex(context.actionIndex || {}),
  });
  const checks = catalog.modelStructureChecks || {};
  const candidateIds = [];
  const verifiedIds = [];
  const unknownIds = [];
  catalog.items.forEach(function(item) {
    const itemId = positiveInteger(item && item.id);
    annotateCredential(item, Object.assign({}, context, { legacyCheck:checks[String(itemId)] || {} }));
    if (item.ultimateCapabilityState === 'verified') verifiedIds.push(itemId);
    else if (item.ultimateCapabilityState === 'candidate') candidateIds.push(itemId);
    else if (item.ultimateCapabilityState === 'unknown') unknownIds.push(itemId);
    (item.extraSkins || []).forEach(function(skin) {
      const skinId = positiveInteger(skin && skin.resourceId);
      annotateCredential(skin, Object.assign({}, context, { legacyCheck:checks[String(skinId)] || {} }));
      if (skin.ultimateCapabilityState === 'verified') verifiedIds.push(skinId);
      else if (skin.ultimateCapabilityState === 'candidate') candidateIds.push(skinId);
      else if (skin.ultimateCapabilityState === 'unknown') unknownIds.push(skinId);
    });
  });
  catalog.ultimateCapabilitySchemaVersion = SCHEMA_VERSION;
  catalog.ultimateCandidateIds = Array.from(new Set(candidateIds)).sort(function(a, b) { return a - b; });
  catalog.ultimateVerifiedIds = Array.from(new Set(verifiedIds)).sort(function(a, b) { return a - b; });
  catalog.uClientActionUnknownIds = Array.from(new Set(unknownIds)).sort(function(a, b) { return a - b; });
  return catalog;
}

module.exports = {
  SCHEMA_VERSION,
  normalizeActionName,
  isDedicatedUltimateAction,
  normalizeUltimateActions,
  parseRobotCoreReplacementXml,
  normalizeReplacementRows,
  replacementRowsToLegacyConfig,
  mergeReplacementRows,
  normalizeActionIndex,
  mergeActionIndexes,
  deriveUltimateCapability,
  annotateCredential,
  annotateCatalog,
  exactSupplementalEvidence,
  collectUltimateProbeIds,
};
