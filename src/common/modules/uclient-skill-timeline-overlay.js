'use strict';

const OVERLAY_SCHEMA_VERSION = 1;
const OVERLAY_POLICY = 'official-unity-skilltimeline-black-screen-overlay-v1';
// v2 is the current transparent RenderTexture/FLV1 wrapper emitted by the
// rebuilt capture pipeline.  Keep accepting the v1 evidence format so older
// already-downloaded previews remain loadable while new captures use v2.
const LEGACY_CONVERSION_POLICY = 'official-playable-png-black-background-avm2-screen-wrapper-v1';
const CURRENT_CONVERSION_POLICY = 'transparent-png-black-flatten-flv1-avm2-screen-wrapper-v2';
const REQUIRED_ACTIONS = Object.freeze(['appear','attack','cp','hidemove','sa']);

function isSupportedConversionPolicy(value) {
  return value === LEGACY_CONVERSION_POLICY || value === CURRENT_CONVERSION_POLICY;
}

function createUClientSkillTimelineOverlay(dependencies) {
  const fs = dependencies.fs;
  const path = dependencies.path;
  const crypto = dependencies.crypto;
  const moduleDirectory = dependencies.moduleDirectory;
  const resourceAdapter = dependencies.resourceAdapter;
  const writeAtomic = dependencies.writeAtomic;
  const profileFile = path.join(moduleDirectory,'resources','uclient-skill-timeline-overlays.json');
  const document = JSON.parse(fs.readFileSync(profileFile,'utf8'));
  if (Number(document.schemaVersion) !== OVERLAY_SCHEMA_VERSION ||
      String(document.policy || '') !== OVERLAY_POLICY || !Array.isArray(document.profiles)) {
    throw new Error('U-client SkillTimeline overlay profile document is invalid');
  }

  function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
  }
  function parseId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }
  function lower(value) { return String(value || '').toLowerCase(); }
  function normalizeBackgroundMode(value) {
    const mode = lower(value);
    if (mode !== 'none' && mode !== 'viewport' && mode !== 'fullscreen') {
      throw new Error('U-client SkillTimeline background mode is invalid: ' + mode);
    }
    return mode;
  }
  function normalizeBounds(value, description) {
    const result = {x:Number(value && value.x),y:Number(value && value.y),
      width:Number(value && value.width),height:Number(value && value.height)};
    if (!Number.isSafeInteger(result.x) || !Number.isSafeInteger(result.y) ||
        !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) ||
        result.x < 0 || result.y < 0 || result.width < 1 || result.height < 1) {
      throw new Error('U-client SkillTimeline ' + description + ' is invalid');
    }
    return result;
  }
  function normalizeBackgroundGeometry(value, mode, expectedWidth, expectedHeight) {
    if (mode === 'none') {
      if (value != null) throw new Error('U-client SkillTimeline none background must not carry geometry');
      return null;
    }
    const sourceSize = {width:Number(value && value.sourceSize && value.sourceSize.width),
      height:Number(value && value.sourceSize && value.sourceSize.height)};
    if (!Number.isSafeInteger(sourceSize.width) || !Number.isSafeInteger(sourceSize.height) ||
        sourceSize.width < 1 || sourceSize.height < 1) {
      throw new Error('U-client SkillTimeline background source size is invalid');
    }
    if (Number.isSafeInteger(expectedWidth) && Number.isSafeInteger(expectedHeight) &&
        (sourceSize.width !== expectedWidth || sourceSize.height !== expectedHeight)) {
      throw new Error('U-client SkillTimeline background source size does not match overlay canvas');
    }
    const authoredBounds = normalizeBounds(value && value.authoredBounds,'authored background bounds');
    const renderBounds = normalizeBounds(value && value.renderBounds,'render background bounds');
    const policy = String(value && value.renderPolicy || '');
    const inside = function(bounds) {
      return bounds.x + bounds.width <= sourceSize.width && bounds.y + bounds.height <= sourceSize.height;
    };
    if (!inside(authoredBounds) || !inside(renderBounds) ||
        (mode === 'viewport' && policy !== 'crop-scale-to-canvas-v1') ||
        (mode === 'fullscreen' && policy !== 'full-canvas-v1') ||
        renderBounds.x !== 0 || renderBounds.y !== 0 ||
        renderBounds.width !== sourceSize.width || renderBounds.height !== sourceSize.height ||
        (mode === 'fullscreen' && JSON.stringify(authoredBounds) !== JSON.stringify(renderBounds))) {
      throw new Error('U-client SkillTimeline background geometry contract is invalid');
    }
    return {renderPolicy:policy,sourceSize:sourceSize,authoredBounds:authoredBounds,renderBounds:renderBounds};
  }
  function normalizeBackgroundWindows(value, mode, geometry, durationSeconds, expectedWidth, expectedHeight) {
    const records = Array.isArray(value) ? value : [];
    if ((mode === 'none' && records.length) || (mode !== 'none' && !records.length)) {
      throw new Error('U-client SkillTimeline background windows are inconsistent with mode');
    }
    let previousEnd = -1;
    return records.map(function(item) {
      const startSeconds = Number(item && item.startSeconds);
      const endSeconds = Number(item && item.endSeconds);
      const itemMode = normalizeBackgroundMode(item && item.mode);
      const itemGeometry = normalizeBackgroundGeometry(item && item.backgroundGeometry,itemMode,
        expectedWidth,expectedHeight);
      if (itemMode !== mode || JSON.stringify(itemGeometry) !== JSON.stringify(geometry) ||
          !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
          startSeconds < 0 || endSeconds <= startSeconds || endSeconds > durationSeconds + .05 ||
          startSeconds < previousEnd) {
        throw new Error('U-client SkillTimeline background window is invalid');
      }
      previousEnd = endSeconds;
      return {startSeconds:startSeconds,endSeconds:endSeconds,mode:itemMode,backgroundGeometry:itemGeometry};
    });
  }
  function normalizeActionBackground(item, durationSeconds, expectedWidth, expectedHeight) {
    const backgroundMode = normalizeBackgroundMode(item && item.backgroundMode);
    const backgroundGeometry = normalizeBackgroundGeometry(item && item.backgroundGeometry,backgroundMode,
      expectedWidth,expectedHeight);
    const backgroundWindows = normalizeBackgroundWindows(item && item.backgroundWindows,
      backgroundMode,backgroundGeometry,durationSeconds,expectedWidth,expectedHeight);
    return {backgroundMode:backgroundMode,backgroundGeometry:backgroundGeometry,
      backgroundWindows:backgroundWindows};
  }
  function canonicalDependency(value, fallbackPackageKey) {
    return {
      packageKey:String(value && value.packageKey || fallbackPackageKey || ''),
      fileHash:lower(value && value.fileHash),
      bytes:Number(value && value.bytes || 0),
    };
  }
  function canonicalEvidence(value) {
    const packageKey = String(value && value.packageKey || '');
    return {
      assetPath:lower(value && value.assetPath),
      packageKey:packageKey,
      fileHash:lower(value && value.fileHash),
      bytes:Number(value && value.bytes || 0),
      dependencies:(Array.isArray(value && (value.dependencies || value.dependencyBundles))
        ? (value.dependencies || value.dependencyBundles) : []).map(function(item) {
        return canonicalDependency(item,packageKey);
      }).sort(function(left,right) {
        return [left.packageKey,left.fileHash,left.bytes].join('|').localeCompare(
          [right.packageKey,right.fileHash,right.bytes].join('|'));
      }),
    };
  }
  function strictProfileEvidence(profile) {
    const resources = profile && profile.resources || {};
    const timelines = Array.isArray(resources.timelines) ? resources.timelines : [];
    const effects = Array.isArray(resources.effects) ? resources.effects : [];
    const skeletonSha256 = String(profile && profile.spineSkeletonSha256 || '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(skeletonSha256) || timelines.length !== 5 || effects.length !== 5 ||
        timelines.some(function(item) { return !item || typeof item !== 'object'; }) ||
        effects.some(function(item) { return !item || typeof item !== 'object'; })) return null;
    const exactResources = timelines.concat(effects).map(canonicalEvidence).sort(function(left,right) {
      return left.assetPath.localeCompare(right.assetPath);
    });
    if (exactResources.some(function(item) {
      return !item.assetPath || !item.packageKey || !/^[0-9a-f]{32}$/.test(item.fileHash) ||
        !(item.bytes > 0) || item.dependencies.some(function(dep) {
          return !dep.packageKey || !/^[0-9a-f]{32}$/.test(dep.fileHash) || !(dep.bytes > 0);
        });
    })) return null;
    const evidence = {
      ownerId:parseId(profile.ownerId),
      spineSkeletonSha256:skeletonSha256,
      resources:exactResources,
    };
    evidence.fingerprint = sha256(Buffer.from(JSON.stringify(evidence),'utf8'));
    return evidence;
  }
  function normalizeActionTiming(value) {
    const source = String(value && value.source || '').trim();
    const durationToleranceSeconds = Number(value && value.durationToleranceSeconds);
    const returnMixSeconds = Number(value && value.returnMixSeconds);
    const inputActions = value && value.actions;
    if (!source || !Number.isFinite(durationToleranceSeconds) || durationToleranceSeconds < 0 ||
        !Number.isFinite(returnMixSeconds) || returnMixSeconds < 0 || returnMixSeconds > .5 ||
        !inputActions || typeof inputActions !== 'object' || Array.isArray(inputActions)) {
      throw new Error('U-client SkillTimeline action timing is invalid');
    }
    const actions = {};
    Object.keys(inputActions).forEach(function(key) {
      const action = String(key || '').trim().toLowerCase();
      const record = inputActions[key] || {};
      const durationSeconds = Number(record.durationSeconds);
      const hitSeconds = record.hitSeconds == null ? null : Number(record.hitSeconds);
      if (!/^[a-z0-9_-]+$/.test(action) || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
          (hitSeconds != null && (!Number.isFinite(hitSeconds) || hitSeconds < 0 ||
            hitSeconds > durationSeconds + durationToleranceSeconds))) {
        throw new Error('U-client SkillTimeline action timing entry is invalid: ' + action);
      }
      actions[action] = { durationSeconds:durationSeconds };
      if (hitSeconds != null) actions[action].hitSeconds = hitSeconds;
    });
    if (!Object.keys(actions).length) throw new Error('U-client SkillTimeline profile has no actions');
    REQUIRED_ACTIONS.filter(function(action) { return action !== 'appear'; }).forEach(function(action) {
      if (!actions[action] || !Number.isFinite(actions[action].hitSeconds)) {
        throw new Error('U-client SkillTimeline profile has no official hit signal: ' + action);
      }
    });
    return {
      source:source,
      durationToleranceSeconds:durationToleranceSeconds,
      returnMixSeconds:returnMixSeconds,
      actions:actions,
    };
  }
  function readJsonIfPresent(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file,'utf8'));
    } catch (_) {
      return null;
    }
  }
  function dynamicProfileFile(previewRoot) {
    return path.join(previewRoot,'uclient-skill-timeline-profile.json');
  }
  function dynamicPreviewProfile(previewRoot, credential, spineSource) {
    const ownerId = parseId(credential && credential.assetId || spineSource && spineSource.sourceId);
    if (!ownerId || !resourceAdapter || typeof resourceAdapter.buildResourcePlan !== 'function') return null;
    const metadata = readJsonIfPresent(path.join(previewRoot,'uclient-skill-timeline.json'));
    const nativeFile = path.join(previewRoot,'uclient-skill-timeline.swf');
    const metadataPolicy = String(metadata && metadata.policy || '');
    const conversionPolicy = String(metadata && metadata.conversionPolicy || '');
    const metadataOwnerId = parseId(metadata && (metadata.ownerId || metadata.sourceId));
    if (!metadata || !fs.existsSync(nativeFile) || metadata.enabled !== true ||
        (metadataPolicy && metadataPolicy !== OVERLAY_POLICY) ||
        (conversionPolicy && !isSupportedConversionPolicy(conversionPolicy)) ||
        (!metadataPolicy && !conversionPolicy) || metadataOwnerId !== ownerId) return null;
    const metadataWidth = Number(metadata.width);
    const metadataHeight = Number(metadata.height);
    const actions = Array.isArray(metadata.actions) ? metadata.actions.map(function(item) {
      const action = String(item && item.action || '').trim().toLowerCase();
      const durationSeconds = Number(item && item.durationSeconds);
      const frameCount = Number(item && item.frameCount);
      let background;
      try { background = normalizeActionBackground(item,durationSeconds,metadataWidth,metadataHeight); }
      catch (_) { return null; }
      const inferredImpact = item && item.motionEvidence &&
        item.motionEvidence.impactSeconds == null ? null :
        Number(item && item.motionEvidence && item.motionEvidence.impactSeconds);
      const hitSeconds = item && item.hitSeconds != null ? Number(item.hitSeconds) :
        (Number.isFinite(inferredImpact) && inferredImpact >= 0 ? inferredImpact : null);
      if (!action || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
          !Number.isSafeInteger(frameCount) || frameCount < 2 ||
          (action !== 'appear' && hitSeconds == null) ||
          (hitSeconds != null && (!Number.isFinite(hitSeconds) || hitSeconds < 0 ||
            hitSeconds > durationSeconds + .05))) return null;
      const value = { action:action,durationSeconds:durationSeconds,frameCount:frameCount,
        backgroundMode:background.backgroundMode,backgroundGeometry:background.backgroundGeometry,
        backgroundWindows:background.backgroundWindows };
      if (hitSeconds != null) value.hitSeconds = hitSeconds;
      return value;
    }).filter(Boolean) : [];
    const actionNames = actions.map(function(item) { return item.action; });
    if (actions.length !== REQUIRED_ACTIONS.length ||
        new Set(actionNames).size !== REQUIRED_ACTIONS.length ||
        REQUIRED_ACTIONS.some(function(action) { return actionNames.indexOf(action) < 0; })) return null;
    const skeletonName = String(spineSource && spineSource.skeletonFile || '');
    if (!skeletonName || path.basename(skeletonName) !== skeletonName) return null;
    const skeletonFile = path.join(previewRoot,skeletonName);
    if (!fs.existsSync(skeletonFile) || !fs.statSync(skeletonFile).isFile()) return null;
    const skeletonBytes = fs.readFileSync(skeletonFile);
    const skeletonSha256 = sha256(skeletonBytes);
    if (!/^[0-9A-F]{64}$/.test(skeletonSha256)) return null;
    const plan = resourceAdapter.buildResourcePlan(credential,null,{ skillTimeline:'all-owned' });
    const selected = plan && plan.skillTimeline || {};
    const timelines = Array.isArray(selected.timelines) ? selected.timelines : [];
    const effects = Array.isArray(selected.effects) ? selected.effects : [];
    const videos = Array.isArray(selected.videos) ? selected.videos : [];
    if (Number(plan && plan.version) !== 3 || parseId(plan && plan.ownerId) !== ownerId ||
        timelines.length !== REQUIRED_ACTIONS.length || effects.length !== REQUIRED_ACTIONS.length ||
        videos.length < 1 || !/^[0-9A-F]{64}$/.test(String(plan.closureSha256 || '').toUpperCase())) return null;
    const nativeBytes = fs.readFileSync(nativeFile);
    if (!nativeBytes.length || Number(metadata.nativeBytes) !== nativeBytes.length ||
        String(metadata.nativeSha256 || '').toUpperCase() !== sha256(nativeBytes) ||
        Number(metadata.resourcePlanVersion) !== 3 ||
        String(metadata.resourcePlanClosureSha256 || '').toUpperCase() !==
          String(plan.closureSha256 || '').toUpperCase()) return null;
    const timingActions = {};
    actions.forEach(function(item) {
      const value = { durationSeconds:item.durationSeconds };
      if (item.hitSeconds != null) value.hitSeconds = item.hitSeconds;
      timingActions[item.action] = value;
    });
    const profile = {
      ownerId:ownerId,
      native:{ file:'uclient-skill-timeline.swf', evidenceFile:'uclient-skill-timeline-source.json',
        bytes:nativeBytes.length,sha256:sha256(nativeBytes) },
      resources:{ timelines:timelines, effects:effects,
        videos:videos.map(function(item) { return String(item.assetPath || ''); }) },
      actionTiming:{ source:'auto-discovered official U-client Timeline metadata',
        durationToleranceSeconds:.05, returnMixSeconds:.1, actions:timingActions },
      spineSkeletonSha256:skeletonSha256,
      __dynamic:true,
    };
    const strictEvidence = strictProfileEvidence(profile);
    if (!strictEvidence) return null;
    profile.__fingerprint = strictEvidence.fingerprint;
    return { profile:profile, metadata:metadata, plan:plan, strictEvidence:strictEvidence,
      nativeBytes:nativeBytes, skeletonFile:skeletonFile };
  }
  function persistedDynamicProfile(previewRoot) {
    const value = readJsonIfPresent(dynamicProfileFile(previewRoot));
    const profile = value && value.profile ? value.profile : value;
    if (!profile || !profile.__dynamic) return null;
    const strictEvidence = strictProfileEvidence(profile);
    return strictEvidence ? { profile:profile, strictEvidence:strictEvidence } : null;
  }
  function selectProfile(sourceId, options) {
    options = options || {};
    const id = parseId(sourceId);
    if (!id) return null;
    const profile = options.profile || document.profiles.find(function(item) { return parseId(item && item.ownerId) === id; });
    if (!profile) return null;
    return {
      ownerId:id,
      actionTiming:normalizeActionTiming(profile.actionTiming),
      resources:profile.resources || {},
      spineSkeletonSha256:String(profile.spineSkeletonSha256 || '').toUpperCase(),
      native:profile.native || null,
      strictEvidence:strictProfileEvidence(profile),
      dynamic:profile.__dynamic === true,
    };
  }
  function disabledManifest(profile) {
    return {
      version:OVERLAY_SCHEMA_VERSION,
      enabled:false,
      policy:OVERLAY_POLICY,
      ownerId:profile ? profile.ownerId : 0,
      width:1200,
      height:660,
      frameRate:30,
      actions:[],
      actionTiming:profile ? profile.actionTiming : null,
    };
  }
  async function load(previewRoot, sourceId, credential) {
    const id = parseId(sourceId);
    let profile = selectProfile(id);
    if (!profile) {
      const persisted = persistedDynamicProfile(previewRoot);
      if (persisted && parseId(persisted.profile.ownerId) === id) profile = selectProfile(id,{ profile:persisted.profile });
    }
    // Dynamic profiles are registered during prepare(), which has the Spine
    // source/skeleton identity.  Do not attempt discovery here without that
    // identity; doing so could accidentally treat the preview directory as a
    // skeleton file on Windows.
    const metadataFile = path.join(previewRoot,'uclient-skill-timeline.json');
    const nativeFile = path.join(previewRoot,'uclient-skill-timeline.swf');
    const metadataExists = fs.existsSync(metadataFile);
    const nativeExists = fs.existsSync(nativeFile);
    if (!metadataExists && !nativeExists) {
      return { enabled:false, manifest:disabledManifest(profile), bytes:null, build:null };
    }
    if (!metadataExists || !nativeExists || !profile) {
      throw new Error('U-client SkillTimeline overlay artifact closure is incomplete');
    }
    const metadata = JSON.parse(await fs.promises.readFile(metadataFile,'utf8'));
    const bytes = await fs.promises.readFile(nativeFile);
    const strictEvidence = profile && profile.strictEvidence;
    const width = Number(metadata.width);
    const height = Number(metadata.height);
    const actions = Array.isArray(metadata.actions) ? metadata.actions.map(function(item) {
      const action = String(item && item.action || '').trim().toLowerCase();
      const durationSeconds = Number(item && item.durationSeconds);
      const frameCount = Number(item && item.frameCount);
      const background = normalizeActionBackground(item,durationSeconds,width,height);
      if (!profile.actionTiming.actions[action] || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
          !Number.isSafeInteger(frameCount) || frameCount < 2) {
        throw new Error('U-client SkillTimeline overlay action evidence is invalid: ' + action);
      }
      return { action:action,durationSeconds:durationSeconds,frameCount:frameCount,
        backgroundMode:background.backgroundMode,backgroundGeometry:background.backgroundGeometry,
        backgroundWindows:background.backgroundWindows };
    }) : [];
    const frameRate = Number(metadata.frameRate);
    const resourcePlanVersion = Number(metadata.resourcePlanVersion);
    const resourcePlanClosureSha256 = String(metadata.resourcePlanClosureSha256 || '').toUpperCase();
    let currentResourcePlan = null;
    if (credential && resourceAdapter && typeof resourceAdapter.buildResourcePlan === 'function') {
      currentResourcePlan = resourceAdapter.buildResourcePlan(
        credential,null,{ skillTimeline:'all-owned' });
    }
    if (Number(metadata.version) !== OVERLAY_SCHEMA_VERSION || metadata.enabled !== true ||
        String(metadata.policy || '') !== OVERLAY_POLICY || parseId(metadata.ownerId) !== id ||
        resourcePlanVersion !== 3 || !/^[0-9A-F]{64}$/.test(resourcePlanClosureSha256) ||
        (currentResourcePlan && (Number(currentResourcePlan.version) !== 3 ||
          parseId(currentResourcePlan.ownerId) !== id ||
          String(currentResourcePlan.closureSha256 || '').toUpperCase() !== resourcePlanClosureSha256)) ||
        !strictEvidence || String(metadata.profileFingerprint || '').toUpperCase() !== strictEvidence.fingerprint ||
        String(metadata.spineSkeletonSha256 || '').toUpperCase() !== strictEvidence.spineSkeletonSha256 ||
        !Number.isSafeInteger(width) || width < 1 || width > 4096 ||
        !Number.isSafeInteger(height) || height < 1 || height > 4096 ||
        !Number.isFinite(frameRate) || frameRate < 1 || frameRate > 60 || !actions.length ||
        Number(metadata.nativeBytes) !== bytes.length ||
        String(metadata.nativeSha256 || '').toUpperCase() !== sha256(bytes)) {
      throw new Error('U-client SkillTimeline overlay artifact evidence is invalid');
    }
    const manifest = {
      version:OVERLAY_SCHEMA_VERSION,enabled:true,policy:OVERLAY_POLICY,ownerId:id,
      width:width,height:height,frameRate:frameRate,actions:actions,
      actionTiming:profile.actionTiming,
    };
    return {
      enabled:true,manifest:manifest,bytes:bytes,
      build:Object.assign({},manifest,{
        nativeBytes:bytes.length,nativeSha256:sha256(bytes),
        generatedAt:String(metadata.generatedAt || ''),
        resourcePlanVersion:resourcePlanVersion,
        resourcePlanClosureSha256:resourcePlanClosureSha256,
      }),
    };
  }

  async function removeStale(previewRoot) {
    for (const name of ['uclient-skill-timeline.json','uclient-skill-timeline.swf',
      'uclient-skill-timeline-source.json','uclient-skill-timeline-profile.json']) {
      try { await fs.promises.unlink(path.join(previewRoot,name)); }
      catch(error) { if (!error || error.code !== 'ENOENT') throw error; }
    }
  }
  function sameEvidence(left,right) {
    const l1 = JSON.stringify((left || []).map(canonicalEvidence).sort(function(a,b) {
      return a.assetPath.localeCompare(b.assetPath);
    }));
    const r1 = JSON.stringify(right || []);
    if (l1 === r1) return true;
    const l2 = JSON.stringify((left || []).map(function(item) {
      const v = item || {};
      return [String(v.packageKey || ''), lower(v.assetPath), lower(v.fileHash), Number(v.bytes || 0)].join('|');
    }).sort());
    const r2 = JSON.stringify((right || []).map(function(item) {
      const v = item || {};
      return [String(v.packageKey || ''), lower(v.assetPath), lower(v.fileHash), Number(v.bytes || 0)].join('|');
    }).sort());
    return l2 === r2;
  }
  async function prepare(previewRoot, credential, spineSource) {
    const ownerId = parseId(credential && credential.assetId || spineSource && spineSource.sourceId);
    let profile = selectProfile(ownerId);
    let dynamic = null;
    // For static profiles, the compiled overlay SWF is authoritative if skeleton matches
    // Do not invalidate static profile due to CDN remote manifest drift
    if (!profile) {
      dynamic = dynamicPreviewProfile(previewRoot,credential,spineSource);
      if (dynamic) {
        profile = selectProfile(ownerId,{ profile:dynamic.profile });
        try {
          await writeAtomic(dynamicProfileFile(previewRoot),
            Buffer.from(JSON.stringify(dynamic.profile,null,2),'utf8'));
        } catch (_) {}
      }
    }
    const strictEvidence = profile && profile.strictEvidence;
    try {
      if (!profile || !strictEvidence || !resourceAdapter ||
          typeof resourceAdapter.buildResourcePlan !== 'function' || typeof writeAtomic !== 'function') {
        await removeStale(previewRoot);
        return null;
      }
      const skeletonFile = path.join(previewRoot,String(spineSource && spineSource.skeletonFile || ''));
      const skeletonBytes = await fs.promises.readFile(skeletonFile);
      if (sha256(skeletonBytes) !== strictEvidence.spineSkeletonSha256) {
        await removeStale(previewRoot);
        return null;
      }
      const plan = resourceAdapter.buildResourcePlan(credential,null,{ skillTimeline:'all-owned' });
      const selected = plan && plan.skillTimeline || {};
      const exactResources = (selected.timelines || []).concat(selected.effects || []);
      const resourcePlanClosureSha256 = String(plan && plan.closureSha256 || '').toUpperCase();
      if (profile.dynamic) {
        if (Number(plan && plan.version) !== 3 || parseId(plan && plan.ownerId) !== ownerId ||
            !/^[0-9A-F]{64}$/.test(resourcePlanClosureSha256) ||
            !sameEvidence(exactResources,strictEvidence.resources)) {
          await removeStale(previewRoot);
          return null;
        }
      }
      const native = profile.native || {};
      const nativeFileName = String(native.file || '');
      const evidenceFileName = String(native.evidenceFile || '');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.swf$/i.test(nativeFileName) ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/i.test(evidenceFileName)) {
        await removeStale(previewRoot);
        return null;
      }
      const nativeRoot = path.join(moduleDirectory,'resources','uclient-skill-timeline');
      const nativeFile = profile.dynamic ? path.join(previewRoot,nativeFileName) :
        path.join(nativeRoot,nativeFileName);
      const evidenceFile = profile.dynamic ? path.join(previewRoot,evidenceFileName) :
        path.join(nativeRoot,evidenceFileName);
      const nativeBytes = await fs.promises.readFile(nativeFile);
      const nativeEvidence = JSON.parse(await fs.promises.readFile(evidenceFile,'utf8'));
      const expectedNativeSha = String(native.sha256 || '').toUpperCase();
      if (Number(native.bytes) !== nativeBytes.length || sha256(nativeBytes) !== expectedNativeSha ||
          Number(nativeEvidence.sourceId) !== ownerId || nativeEvidence.enabled !== true ||
          !isSupportedConversionPolicy(String(nativeEvidence.conversionPolicy || '')) ||
          String(nativeEvidence.blendMode || '').toLowerCase() !== 'screen' ||
          Number(nativeEvidence.bytes) !== nativeBytes.length ||
          String(nativeEvidence.sha256 || '').toUpperCase() !== expectedNativeSha ||
          !Array.isArray(nativeEvidence.actions) || nativeEvidence.actions.length !== 5) {
        await removeStale(previewRoot);
        return null;
      }
      const metadata = {
        version:OVERLAY_SCHEMA_VERSION,enabled:true,policy:OVERLAY_POLICY,ownerId:ownerId,
        width:Number(nativeEvidence.width),height:Number(nativeEvidence.height),
        frameRate:Number(nativeEvidence.frameRate),
        actions:nativeEvidence.actions.map(function(item) {
          const action = String(item.action || '').toLowerCase();
          const value = { action:action,
            durationSeconds:Number(item.durationSeconds),frameCount:Number(item.frameCount),
            backgroundMode:normalizeBackgroundMode(item.backgroundMode),
            backgroundGeometry:item.backgroundGeometry,
            backgroundWindows:item.backgroundWindows };
          const background = normalizeActionBackground(value,value.durationSeconds,
            Number(nativeEvidence.width),Number(nativeEvidence.height));
          value.backgroundGeometry = background.backgroundGeometry;
          value.backgroundWindows = background.backgroundWindows;
          const timing = profile.actionTiming.actions[action];
          if (timing && Number.isFinite(timing.hitSeconds)) value.hitSeconds = timing.hitSeconds;
          return value;
        }),
        nativeBytes:nativeBytes.length,nativeSha256:expectedNativeSha,
        generatedAt:String(nativeEvidence.generatedAt || ''),
        profileFingerprint:strictEvidence.fingerprint,
        spineSkeletonSha256:strictEvidence.spineSkeletonSha256,
        resourcePlanVersion:3,
        resourcePlanClosureSha256:resourcePlanClosureSha256,
      };
      if (!profile.dynamic) await writeAtomic(path.join(previewRoot,'uclient-skill-timeline.swf'),nativeBytes);
      await writeAtomic(path.join(previewRoot,'uclient-skill-timeline.json'),
        Buffer.from(JSON.stringify(metadata,null,2),'utf8'));
      if (profile.dynamic) await writeAtomic(dynamicProfileFile(previewRoot),
        Buffer.from(JSON.stringify(dynamic.profile,null,2),'utf8'));
      return metadata;
    } catch(error) {
      await removeStale(previewRoot);
      return null;
    }
  }

  return {
    load:load,
    prepare:prepare,
    selectProfile:selectProfile,
    discoverProfile:function(previewRoot,credential,spineSource) {
      const discovered = dynamicPreviewProfile(previewRoot,credential,spineSource);
      return discovered ? discovered.profile : null;
    },
    policy:OVERLAY_POLICY,
    version:OVERLAY_SCHEMA_VERSION,
  };
}

module.exports = {
  OVERLAY_SCHEMA_VERSION:OVERLAY_SCHEMA_VERSION,
  OVERLAY_POLICY:OVERLAY_POLICY,
  createUClientSkillTimelineOverlay:createUClientSkillTimelineOverlay,
};
