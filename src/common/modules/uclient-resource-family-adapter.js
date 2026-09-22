'use strict';

const crypto = require('crypto');

const SAFE_CLIP = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const VIDEO_EVENT = /^event_video_([A-Za-z0-9][A-Za-z0-9_-]*)$/;

function lower(value) { return String(value || '').toLowerCase(); }

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map(String).filter(Boolean)));
}

function labelsFromFrame(frame) {
  const result = [];
  if (!frame || typeof frame !== 'object') return result;
  ['l','labels','events'].forEach(function(key) {
    const value = frame[key];
    if (typeof value === 'string') result.push(value);
    else if (Array.isArray(value)) value.forEach(function(item) {
      if (typeof item === 'string') result.push(item);
      else if (item && typeof item === 'object') {
        if (typeof item.label === 'string') result.push(item.label);
        else if (typeof item.event === 'string') result.push(item.event);
        else if (typeof item.name === 'string') result.push(item.name);
      }
    });
  });
  if (typeof frame.label === 'string') result.push(frame.label);
  if (typeof frame.event === 'string') result.push(frame.event);
  return uniqueStrings(result);
}

function animationSequences(animation) {
  const root = animation && animation.animation && typeof animation.animation === 'object'
    ? animation.animation : animation;
  if (!root || typeof root !== 'object') return [];
  if (Array.isArray(root.sequences)) return root.sequences;
  if (root.sequences && typeof root.sequences === 'object') {
    return Object.keys(root.sequences).map(function(name) {
      const value = root.sequences[name] || {};
      return Object.assign({name:name},value);
    });
  }
  if (Array.isArray(root.actions)) return root.actions;
  if (root.actions && typeof root.actions === 'object') {
    return Object.keys(root.actions).map(function(name) {
      const value = root.actions[name] || {};
      return Object.assign({name:name},value);
    });
  }
  return [];
}

function collectFtrVideoEvents(animation) {
  const events = [];
  animationSequences(animation).forEach(function(sequence,sequenceIndex) {
    const action = String(sequence && (sequence.name || sequence.action) || '').trim();
    if (!action) throw new Error('FTR sequence has no action identity');
    const frames = Array.isArray(sequence.frames) ? sequence.frames : [];
    frames.forEach(function(frame,frameIndex) {
      labelsFromFrame(frame).forEach(function(label,labelIndex) {
        const match = String(label).match(VIDEO_EVENT);
        if (!match) return;
        events.push({
          action:action, frame:frameIndex, label:String(label), clip:String(match[1]),
          sequenceIndex:sequenceIndex, labelIndex:labelIndex,
        });
      });
    });
  });
  return events;
}

function collectUnsupportedFtrResourceEvents(animation) {
  const unsupported = new Set();
  animationSequences(animation).forEach(function(sequence) {
    const frames = Array.isArray(sequence && sequence.frames) ? sequence.frames : [];
    frames.forEach(function(frame) {
      labelsFromFrame(frame).forEach(function(label) {
        const text = String(label || '');
        if (/^event_/i.test(text) && !VIDEO_EVENT.test(text)) unsupported.add(lower(text));
      });
    });
  });
  return Array.from(unsupported).sort();
}

function exactPath(kind, ownerId, suffix) {
  const escapedOwner = String(ownerId).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const escapedSuffix = String(suffix).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if (kind === 'standard-event-video') {
    return new RegExp('^Assets/Game/Videos/' + escapedOwner + '/' + escapedSuffix + '\\.mp4$','i');
  }
  if (kind === 'skill-timeline-video') {
    return new RegExp('^Assets/SkillTimeline/Videos/' + escapedOwner + '/' + escapedSuffix + '\\.mp4$','i');
  }
  if (kind === 'skill-timeline') {
    return new RegExp('^Assets/SkillTimeline/Timelines/' + escapedOwner + '/' + escapedSuffix + '\\.playable$','i');
  }
  if (kind === 'skill-timeline-effect') {
    return new RegExp('^Assets/SkillTimeline/Effects/' + escapedOwner + '/' + escapedSuffix + '\\.prefab$','i');
  }
  throw new Error('Unsupported U-client supplemental resource family: ' + String(kind));
}

function validateBundleRecord(record, context) {
  if (!record || !/^[0-9a-f]{32}$/i.test(String(record.fileHash || '')) ||
      !(Number(record.bytes) > 0) || !/^https:\/\//i.test(String(record.url || ''))) {
    throw new Error('U-client bundle evidence is missing or invalid: ' + String(context || 'resource'));
  }
}

function validateEvidence(evidence, kind, ownerId, suffix) {
  if (!evidence || Number(evidence.ownerId || ownerId) !== Number(ownerId) ||
      String(evidence.resourceFamily || kind) !== kind ||
      !exactPath(kind,ownerId,suffix).test(String(evidence.assetPath || ''))) {
    throw new Error('U-client supplemental asset ownership is invalid for ' +
      String(kind) + ' ' + String(ownerId) + '/' + String(suffix));
  }
  validateBundleRecord(evidence,evidence.assetPath);
  const dependencyBundles = Array.isArray(evidence.dependencyBundles)
    ? evidence.dependencyBundles : [];
  dependencyBundles.forEach(function(item,index) {
    validateBundleRecord(item,String(evidence.assetPath) + ' dependency ' + String(index));
  });
  return evidence;
}

function credentialFamilies(credential) {
  const families = credential && credential.resourceFamilies || {};
  const skill = families.skillTimeline || {};
  const videos = Array.isArray(credential && credential.videos) ? credential.videos : [];
  return {
    standardEventVideos:Array.isArray(families.standardEventVideos)
      ? families.standardEventVideos
      : videos.filter(function(item) { return /^Assets\/Game\/Videos\//i.test(String(item && item.assetPath || '')); }),
    skillTimeline:{
      timelines:Array.isArray(skill.timelines) ? skill.timelines
        : (Array.isArray(credential && credential.timeline) ? credential.timeline : []),
      effects:Array.isArray(skill.effects) ? skill.effects
        : (Array.isArray(credential && credential.effects) ? credential.effects : []),
      videos:Array.isArray(skill.videos) ? skill.videos
        : videos.filter(function(item) { return /^Assets\/SkillTimeline\/Videos\//i.test(String(item && item.assetPath || '')); }),
    },
  };
}

function stableAssetKey(item) {
  const dependencies = (Array.isArray(item && item.dependencyBundles)
    ? item.dependencyBundles : []).map(function(dep) {
      return [String(dep.packageKey || item.packageKey || ''),lower(dep.fileHash),
        Number(dep.bytes || 0),lower(dep.url)].join(':');
    }).sort();
  return [String(item.packageKey || ''),lower(item.assetPath),lower(item.fileHash),
    Number(item.bytes || 0),lower(item.url),dependencies.join(',')].join('|');
}

function compareAssets(left, right) {
  return lower(left && left.assetPath).localeCompare(lower(right && right.assetPath)) ||
    lower(left && left.resourceFamily).localeCompare(lower(right && right.resourceFamily)) ||
    stableAssetKey(left).localeCompare(stableAssetKey(right));
}

function distinctSortedAssets(records) {
  return Array.from(new Map((records || []).map(function(item) {
    return [stableAssetKey(item),item];
  })).values()).sort(compareAssets);
}

function canonicalBundleRecord(record, fallbackPackageKey) {
  return {
    packageKey:String(record && record.packageKey || fallbackPackageKey || ''),
    fileHash:lower(record && record.fileHash),
    bytes:Number(record && record.bytes || 0),
    url:lower(record && record.url),
  };
}

function canonicalResource(record) {
  return {
    packageKey:String(record && record.packageKey || ''),
    resourceFamily:String(record && record.resourceFamily || ''),
    ownerId:Number(record && record.ownerId || 0),
    action:String(record && record.action || ''),
    clip:String(record && record.clip || ''),
    assetPath:lower(record && record.assetPath),
    fileHash:lower(record && record.fileHash),
    bytes:Number(record && record.bytes || 0),
    url:lower(record && record.url),
    dependencyBundles:(Array.isArray(record && record.dependencyBundles)
      ? record.dependencyBundles : []).map(function(dependency) {
        return canonicalBundleRecord(dependency,record && record.packageKey);
      }).sort(function(left,right) {
        return [left.packageKey,left.fileHash,left.bytes,left.url].join('|').localeCompare(
          [right.packageKey,right.fileHash,right.bytes,right.url].join('|'));
      }),
  };
}

function resourceClosureSha256(ownerId, version, skillTimelineMode, resources) {
  const document = {
    ownerId:Number(ownerId),
    planVersion:Number(version),
    skillTimeline:String(skillTimelineMode || ''),
    resources:(resources || []).map(canonicalResource),
  };
  return crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex').toUpperCase();
}

function assertUniqueByOwnerKey(records, keyOf, description) {
  const groups = new Map();
  records.forEach(function(item) {
    const key = lower(keyOf(item));
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(item);
  });
  groups.forEach(function(items,key) {
    const distinct = new Set(items.map(stableAssetKey));
    if (distinct.size > 1) {
      throw new Error('Ambiguous U-client ' + description + ' for owner key ' + key);
    }
  });
}

function buildResourcePlan(credential, animation, options) {
  options = options || {};
  const includeOwnedSkillTimeline = options.skillTimeline === 'all-owned';
  const planVersion = includeOwnedSkillTimeline ? 3 : 2;
  const ownerId = Number(credential && credential.assetId || 0);
  if (!(ownerId > 0)) throw new Error('U-client credential has no asset owner identity');
  const families = credentialFamilies(credential);
  const events = collectFtrVideoEvents(animation);
  const unsupportedRequiredFamilies = collectUnsupportedFtrResourceEvents(animation);

  const standardRecords = families.standardEventVideos.map(function(item) {
    const clip = String(item && (item.clip || (String(item.assetPath || '').match(/\/([^/]+)\.mp4$/i) || [])[1]) || '');
    if (!SAFE_CLIP.test(clip)) throw new Error('U-client standard video clip identity is invalid');
    return validateEvidence(item,'standard-event-video',ownerId,clip);
  });
  assertUniqueByOwnerKey(standardRecords,function(item) { return item.clip; },'standard video');
  const standardByClip = new Map();
  standardRecords.forEach(function(item) {
    const key = lower(item.clip);
    if (!standardByClip.has(key)) standardByClip.set(key,[]);
    standardByClip.get(key).push(item);
  });

  const triggers = events.map(function(event) {
    const matches = standardByClip.get(lower(event.clip)) || [];
    const distinct = Array.from(new Map(matches.map(function(item) {
      return [stableAssetKey(item),item];
    })).values());
    if (distinct.length !== 1) {
      throw new Error((distinct.length ? 'Ambiguous' : 'Missing') +
        ' U-client video for event ' + event.label + ' owned by ' + String(ownerId));
    }
    return Object.assign({},event,{evidence:distinct[0]});
  });

  const timelineRecords = distinctSortedAssets(families.skillTimeline.timelines.map(function(item) {
    const action = String(item && (item.action || (String(item.assetPath || '').match(/\/([^/]+)\.playable$/i) || [])[1]) || '');
    if (!action) throw new Error('U-client SkillTimeline action identity is invalid');
    return validateEvidence(item,'skill-timeline',ownerId,action);
  }));
  const effectRecords = distinctSortedAssets(families.skillTimeline.effects.map(function(item) {
    const action = String(item && (item.action || (String(item.assetPath || '').match(/\/([^/]+)\.prefab$/i) || [])[1]) || '');
    if (!action) throw new Error('U-client SkillTimeline Effect action identity is invalid');
    return validateEvidence(item,'skill-timeline-effect',ownerId,action);
  }));
  const timelineVideoRecords = distinctSortedAssets(families.skillTimeline.videos.map(function(item) {
    const clip = String(item && (item.clip || (String(item.assetPath || '').match(/\/([^/]+)\.mp4$/i) || [])[1]) || '');
    if (!SAFE_CLIP.test(clip)) throw new Error('U-client SkillTimeline video clip identity is invalid');
    return validateEvidence(item,'skill-timeline-video',ownerId,clip);
  }));
  assertUniqueByOwnerKey(timelineRecords,function(item) { return item.action; },'SkillTimeline');
  assertUniqueByOwnerKey(effectRecords,function(item) { return item.action; },'SkillTimeline Effect');
  assertUniqueByOwnerKey(timelineVideoRecords,function(item) { return item.clip; },'SkillTimeline video');

  const selectedStandard = distinctSortedAssets(triggers.map(function(item) {
    return item.evidence;
  }));
  const selectedSkillTimeline = includeOwnedSkillTimeline
    ? distinctSortedAssets(timelineRecords.concat(effectRecords,timelineVideoRecords)) : [];
  const resources = distinctSortedAssets(selectedStandard.concat(selectedSkillTimeline));
  const requiredFamilies = [];
  if (selectedStandard.length) requiredFamilies.push('standard-event-video');
  if (includeOwnedSkillTimeline && timelineRecords.length) requiredFamilies.push('skill-timeline');
  if (includeOwnedSkillTimeline && effectRecords.length) requiredFamilies.push('skill-timeline-effect');
  if (includeOwnedSkillTimeline && timelineVideoRecords.length) requiredFamilies.push('skill-timeline-video');
  /*
   * The legacy default only converts resources explicitly referenced by an FTR
   * event label.  all-owned is an opt-in v3 contract for the separate
   * Spine/PlayableDirector family: every exact owner-scoped timeline, effect,
   * and video becomes required conversion input.
   */
  const bundleMap = new Map();
  resources.forEach(function(item) {
    const primaryKey = String(item.packageKey || '') + '|' + lower(item.fileHash);
    if (!bundleMap.has(primaryKey)) bundleMap.set(primaryKey,{
      packageKey:String(item.packageKey || ''), fileHash:lower(item.fileHash),
      bytes:Number(item.bytes), url:String(item.url), assets:[], dependencies:[],
    });
    const bundle = bundleMap.get(primaryKey);
    if (bundle.bytes !== Number(item.bytes) || lower(bundle.url) !== lower(item.url)) {
      throw new Error('Ambiguous U-client primary bundle evidence for ' + String(item.assetPath));
    }
    if (!bundle.assets.some(function(existing) { return lower(existing.assetPath) === lower(item.assetPath); })) {
      bundle.assets.push(item);
    }
    (item.dependencyBundles || []).forEach(function(dep) {
      const dependencyPackageKey = String(dep.packageKey || item.packageKey || '');
      const depKey = dependencyPackageKey + '|' + lower(dep.fileHash);
      const existingDependency = bundle.dependencies.find(function(existing) {
        return String(existing.packageKey || '') + '|' + lower(existing.fileHash) === depKey;
      });
      if (existingDependency) {
        if (Number(existingDependency.bytes) !== Number(dep.bytes) ||
            lower(existingDependency.url) !== lower(dep.url)) {
          throw new Error('Ambiguous U-client dependency bundle evidence for ' + String(item.assetPath));
        }
      } else {
        bundle.dependencies.push(Object.assign({},dep,{packageKey:dependencyPackageKey}));
      }
    });
  });

  const bundles = Array.from(bundleMap.values()).map(function(bundle) {
    bundle.assets.sort(compareAssets);
    bundle.dependencies.sort(function(left,right) {
      return [String(left.packageKey || ''),lower(left.fileHash)].join('|').localeCompare(
        [String(right.packageKey || ''),lower(right.fileHash)].join('|'));
    });
    return bundle;
  }).sort(function(left,right) {
    return [String(left.packageKey || ''),lower(left.fileHash)].join('|').localeCompare(
      [String(right.packageKey || ''),lower(right.fileHash)].join('|'));
  });

  const timelineActions = {};
  function attachAction(kind,items) {
    items.forEach(function(item) {
      const action = String(item.action);
      if (!timelineActions[action]) timelineActions[action] = {timeline:null,effect:null};
      timelineActions[action][kind] = item;
    });
  }
  attachAction('timeline',timelineRecords);
  attachAction('effect',effectRecords);

  return {
    version:planVersion, ownerId:ownerId,
    events:events, triggers:triggers,
    requiredFamilies:requiredFamilies,
    unsupportedRequiredFamilies:unsupportedRequiredFamilies,
    standardEventVideos:selectedStandard,
    unreferencedStandardVideos:standardRecords.filter(function(item) {
      return !selectedStandard.some(function(selected) { return stableAssetKey(selected) === stableAssetKey(item); });
    }),
    skillTimeline:{
      actions:timelineActions,
      timelines:timelineRecords, effects:effectRecords, videos:timelineVideoRecords,
      selectedResources:selectedSkillTimeline,
      conversionRole:includeOwnedSkillTimeline
        ? 'required-exact-owned-skill-timeline-family'
        : 'discovered-unconsumed-spine-timeline-family',
    },
    resources:resources,
    bundles:bundles,
    requiredResourceCount:resources.length,
    closureSha256:resourceClosureSha256(ownerId,planVersion,
      includeOwnedSkillTimeline ? 'all-owned' : '',resources),
    conversionComplete:resources.length === 0 && unsupportedRequiredFamilies.length === 0,
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex').toLowerCase();
}

async function executeResourcePlan(plan, io) {
  io = io || {};
  if (!plan || !(Number(plan.ownerId) > 0) || !Array.isArray(plan.bundles)) {
    throw new Error('U-client resource plan is invalid');
  }
  if (Array.isArray(plan.unsupportedRequiredFamilies) && plan.unsupportedRequiredFamilies.length) {
    throw new Error('U-client resource plan contains unsupported required families: ' +
      plan.unsupportedRequiredFamilies.join(', '));
  }
  if (typeof io.downloadBundle !== 'function' || typeof io.extractAsset !== 'function') {
    throw new Error('U-client resource executor is missing download/extract adapters');
  }
  const downloaded = new Map();
  const converted = [];
  async function download(record,packageKey) {
    const key = String(packageKey || '') + '|' + lower(record.fileHash);
    validateBundleRecord(record,'download ' + key);
    if (downloaded.has(key)) {
      const cached = downloaded.get(key);
      if (cached.bytes !== Number(record.bytes)) {
        throw new Error('Ambiguous U-client cached bundle evidence for ' + key);
      }
      return cached;
    }
    const value = await io.downloadBundle(Object.assign({packageKey:packageKey},record));
    const buffer = Buffer.isBuffer(value) ? value : value && value.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length !== Number(record.bytes)) {
      throw new Error('U-client downloaded bundle size mismatch for ' + key);
    }
    if (md5(buffer) !== lower(record.fileHash)) {
      throw new Error('U-client downloaded bundle fileHash MD5 mismatch for ' + key);
    }
    const result = {buffer:buffer,bytes:buffer.length,sha256:sha256(buffer)};
    downloaded.set(key,result);
    return result;
  }
  for (const bundle of plan.bundles) {
    const primary = await download(bundle,bundle.packageKey);
    const dependencies = [];
    for (const dependency of bundle.dependencies || []) {
      dependencies.push(await download(dependency,dependency.packageKey || bundle.packageKey));
    }
    for (const evidence of bundle.assets || []) {
      const extracted = await io.extractAsset({
        ownerId:plan.ownerId, evidence:evidence, buffer:primary.buffer,
        dependencies:dependencies.map(function(item) { return item.buffer; }),
      });
      if (!extracted || lower(extracted.assetPath) !== lower(evidence.assetPath)) {
        throw new Error('U-client extracted asset identity mismatch for ' + String(evidence.assetPath));
      }
      let converter = null;
      if (/video$/.test(String(evidence.resourceFamily))) converter = io.convertVideo;
      else if (evidence.resourceFamily === 'skill-timeline') converter = io.convertTimeline;
      else if (evidence.resourceFamily === 'skill-timeline-effect') converter = io.convertEffect;
      if (typeof converter !== 'function') {
        throw new Error('U-client converter is unavailable for ' + String(evidence.resourceFamily));
      }
      const output = await converter({
        ownerId:plan.ownerId, evidence:evidence, extracted:extracted,
        bundleSha256:primary.sha256,
        triggers:plan.triggers.filter(function(item) {
          return stableAssetKey(item.evidence) === stableAssetKey(evidence);
        }),
      });
      if (!output || output.converted !== true) {
        throw new Error('U-client conversion did not produce a verified result for ' + String(evidence.assetPath));
      }
      converted.push({evidence:evidence,output:output,bundleSha256:primary.sha256});
    }
  }
  const requiredCount = Number(plan.requiredResourceCount == null
    ? converted.length : plan.requiredResourceCount);
  if (converted.length !== requiredCount) {
    throw new Error('U-client required resource conversion closure is incomplete');
  }
  return {
    ownerId:plan.ownerId,downloadedBundles:downloaded.size,converted:converted,
    requiredResourceCount:requiredCount,conversionComplete:true,
  };
}

module.exports = {
  collectFtrVideoEvents:collectFtrVideoEvents,
  validateEvidence:validateEvidence,
  buildResourcePlan:buildResourcePlan,
  executeResourcePlan:executeResourcePlan,
};
