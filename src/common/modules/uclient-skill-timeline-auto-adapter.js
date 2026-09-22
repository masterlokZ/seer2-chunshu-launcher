'use strict';

const ACTIONS = Object.freeze(['appear','attack','cp','sa','hidemove']);
const BATTLE_ACTIONS = Object.freeze(['attack','cp','sa','hidemove']);
const INDEX_SCHEMA = 'seer2-uclient-skill-timeline-bundles-v1';
const PROFILE_SOURCE = 'official U-client Timeline playable and signal tracks';
const POLICY = 'official-unity-skilltimeline-black-screen-overlay-v1';
const LEGACY_CONVERSION_POLICY = 'official-playable-png-black-background-avm2-screen-wrapper-v1';
const CURRENT_CONVERSION_POLICY = 'transparent-png-black-flatten-flv1-avm2-screen-wrapper-v2';

function isSupportedConversionPolicy(value) {
  return value === LEGACY_CONVERSION_POLICY || value === CURRENT_CONVERSION_POLICY;
}

function createUClientSkillTimelineAutoAdapter(dependencies) {
  dependencies = dependencies || {};
  const fs = dependencies.fs || require('fs');
  const path = dependencies.path || require('path');
  const crypto = dependencies.crypto || require('crypto');
  const moduleDirectory = dependencies.moduleDirectory;
  const fetchBuffer = dependencies.fetchBuffer;
  const now = dependencies.now || function() { return new Date().toISOString(); };
  const randomBytes = dependencies.randomBytes || function(size) { return crypto.randomBytes(size); };
  const pwshExecutable = String(dependencies.pwshExecutable || 'pwsh.exe');
  const nodeExecutable = String(dependencies.nodeExecutable || 'node');
  let staticProfileOwners = new Set();
  let staticProfiles = new Map();
  try {
    const file = dependencies.staticProfileFile ||
      path.join(moduleDirectory || '','resources','uclient-skill-timeline-overlays.json');
    const document = JSON.parse(fs.readFileSync(file,'utf8'));
    staticProfiles = new Map((document.profiles || []).map(function(item) {
      return [parseOwnerId(item && item.ownerId),item];
    }).filter(function(item) { return item[0] > 0; }));
    staticProfileOwners = new Set(staticProfiles.keys());
  } catch (_) {}

  function hash(buffer, algorithm, upper) {
    const value = crypto.createHash(algorithm).update(buffer).digest('hex');
    return upper ? value.toUpperCase() : value.toLowerCase();
  }
  function sha256(buffer) { return hash(buffer,'sha256',true); }
  function md5(buffer) { return hash(buffer,'md5',false); }
  function parseOwnerId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }
  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  function leaf(value, description) {
    const name = String(value || '');
    if (!name || name !== path.basename(name) || name === '.' || name === '..') {
      throw new Error(description + ' must be a safe file name');
    }
    return name;
  }
  function lower(value) { return String(value || '').toLowerCase(); }
  function normalizeBackgroundMode(value) {
    const mode = lower(value);
    if (!['none','viewport','fullscreen'].includes(mode)) {
      throw new Error('Generated SkillTimeline background mode is invalid: ' + mode);
    }
    return mode;
  }
  function progress(callback, phase, detail) {
    if (typeof callback !== 'function') return Promise.resolve();
    return Promise.resolve(callback(Object.assign({phase:phase},detail || {})));
  }
  function jsonBuffer(value) {
    return Buffer.from(JSON.stringify(value,null,2) + '\n','utf8');
  }
  function randomSuffix() {
    return process.pid + '-' + randomBytes(8).toString('hex');
  }
  async function rmSafe(targetPath, options) {
    const nativeRm = fs.promises && fs.promises['rm'];
    if (typeof nativeRm === 'function') {
      return await nativeRm.call(fs.promises, targetPath, options);
    }
    try {
      const stat = await fs.promises.stat(targetPath);
      if (stat.isDirectory()) {
        return await fs.promises.rmdir(targetPath, { recursive: true });
      } else {
        return await fs.promises.unlink(targetPath);
      }
    } catch (e) {
      if (options && options.force && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return;
      if (e.code !== 'ENOENT') throw e;
    }
  }
  function inside(root, target) {
    const relative = path.relative(path.resolve(root),path.resolve(target));
    return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
  }
  async function readJson(file) {
    return JSON.parse(await fs.promises.readFile(file,'utf8'));
  }
  async function writeAtomic(file, buffer) {
    if (typeof dependencies.writeAtomic === 'function') {
      await dependencies.writeAtomic(file,buffer);
      return;
    }
    await fs.promises.mkdir(path.dirname(file),{recursive:true});
    const temporary = file + '.part-' + randomSuffix();
    try {
      await fs.promises.writeFile(temporary,buffer);
      try { await fs.promises.rename(temporary,file); }
      catch (error) {
        if (!error || !['EEXIST','EPERM','ENOTEMPTY'].includes(error.code)) throw error;
        await rmSafe(file,{force:true});
        await fs.promises.rename(temporary,file);
      }
    } finally {
      await rmSafe(temporary,{force:true}).catch(function() {});
    }
  }

  function exactActionSet(records, kind) {
    if (!Array.isArray(records) || records.length !== ACTIONS.length) return false;
    const names = records.map(function(item) {
      return lower(item && (item.action || (String(item.assetPath || '').match(/\/([^/]+)\.(?:playable|prefab)$/i) || [])[1]));
    });
    return new Set(names).size === ACTIONS.length && ACTIONS.every(function(action) {
      return names.includes(action);
    }) && records.every(function(item) {
      const pattern = kind === 'timeline' ? /\/Timelines\//i : /\/Effects\//i;
      return pattern.test(String(item && item.assetPath || ''));
    });
  }
  function validateBundle(record, fallbackPackageKey, context) {
    const packageKey = String(record && record.packageKey || fallbackPackageKey || '');
    const fileHash = lower(record && record.fileHash);
    const bytes = Number(record && (record.bytes == null ? record.fileSize : record.bytes));
    const url = String(record && record.url || '');
    if (!packageKey || !/^[0-9a-f]{32}$/.test(fileHash) ||
        !Number.isSafeInteger(bytes) || bytes <= 0 || !/^https:\/\//i.test(url)) {
      throw new Error('U-client bundle evidence is invalid: ' + context);
    }
    return {
      packageKey:packageKey,
      packageName:String(record && record.packageName ||
        (packageKey === 'battle' ? 'PetAnimPackage' : 'DefaultPackage')),
      fileHash:fileHash,
      fileSize:bytes,
      url:url,
    };
  }
  function validatePlan(credential, resourcePlan) {
    const ownerId = parseOwnerId(credential && credential.assetId);
    const planOwnerId = parseOwnerId(resourcePlan && resourcePlan.ownerId);
    const closure = String(resourcePlan && resourcePlan.closureSha256 || '').toUpperCase();
    const selected = resourcePlan && resourcePlan.skillTimeline || {};
    const timelines = selected.timelines;
    const effects = selected.effects;
    const videos = selected.videos;
    if (Number(resourcePlan && resourcePlan.version) !== 3 || !ownerId || planOwnerId !== ownerId ||
        !/^[0-9A-F]{64}$/.test(closure)) return null;
    if (!exactActionSet(timelines,'timeline') || !exactActionSet(effects,'effect') ||
        !Array.isArray(videos) || videos.length < 1) return null;
    const timelinePath = new RegExp('^Assets/SkillTimeline/Timelines/' + ownerId +
      '/([A-Za-z0-9_-]+)\\.playable$','i');
    const effectPath = new RegExp('^Assets/SkillTimeline/Effects/' + ownerId +
      '/([A-Za-z0-9_-]+)\\.prefab$','i');
    const videoPath = new RegExp('^Assets/SkillTimeline/Videos/' + ownerId +
      '/[A-Za-z0-9_-]+\\.mp4$','i');
    timelines.forEach(function(item,index) {
      const match = String(item && item.assetPath || '').match(timelinePath);
      const action = lower(item && (item.action || (match && match[1])));
      if (!match || action !== lower(match[1])) {
        throw new Error('U-client Timeline asset identity is invalid: asset ' + index);
      }
    });
    effects.forEach(function(item,index) {
      const match = String(item && item.assetPath || '').match(effectPath);
      const action = lower(item && (item.action || (match && match[1])));
      if (!match || action !== lower(match[1])) {
        throw new Error('U-client Effect asset identity is invalid: asset ' + index);
      }
    });
    videos.forEach(function(item,index) {
      if (!videoPath.test(String(item && item.assetPath || ''))) {
        throw new Error('U-client SkillTimeline video asset identity is invalid: asset ' + index);
      }
    });
    const resources = timelines.concat(effects,videos);
    resources.forEach(function(item,index) {
      validateBundle(item,'','asset ' + index);
      (Array.isArray(item.dependencyBundles) ? item.dependencyBundles :
        (Array.isArray(item.dependencies) ? item.dependencies : [])).forEach(function(dep,depIndex) {
        validateBundle(dep,item.packageKey,'asset ' + index + ' dependency ' + depIndex);
      });
    });
    return {ownerId:ownerId,closureSha256:closure,timelines:timelines,effects:effects,
      videos:videos,resources:resources};
  }

  function collectBundles(plan) {
    const byKey = new Map();
    function add(record, fallbackPackageKey, context) {
      const value = validateBundle(record,fallbackPackageKey,context);
      const key = value.packageKey + '|' + value.fileHash;
      const existing = byKey.get(key);
      if (existing && (existing.fileSize !== value.fileSize || lower(existing.url) !== lower(value.url) ||
          existing.packageName !== value.packageName)) {
        throw new Error('Ambiguous U-client bundle closure: ' + key);
      }
      if (!existing) byKey.set(key,value);
      return key;
    }
    plan.resources.forEach(function(item,index) {
      add(item,'','asset ' + index);
      const dependencies = Array.isArray(item.dependencyBundles) ? item.dependencyBundles :
        (Array.isArray(item.dependencies) ? item.dependencies : []);
      dependencies.forEach(function(dep,depIndex) {
        add(dep,item.packageKey,'asset ' + index + ' dependency ' + depIndex);
      });
    });
    return byKey;
  }

  async function downloadIndex(plan, sourceRoot, onProgress) {
    if (typeof fetchBuffer !== 'function') throw new Error('fetchBuffer dependency is required');
    const bundleRecords = collectBundles(plan);
    let completed = 0;
    await fs.promises.mkdir(sourceRoot,{recursive:true});
    await Promise.all(Array.from(bundleRecords.values()).map(async function(record) {
      const target = path.join(sourceRoot,'bundles',record.packageName,record.fileHash);
      await fs.promises.mkdir(path.dirname(target),{recursive:true});
      let buffer = null;
      try {
        const current = await fs.promises.readFile(target);
        if (current.length === record.fileSize && md5(current) === record.fileHash) buffer = current;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      let reused = true;
      if (!buffer) {
        reused = false;
        const response = await fetchBuffer(record.url,90000,0,record.fileSize + 1024,onProgress);
        buffer = Buffer.isBuffer(response) ? response : response && response.buffer;
        if (!Buffer.isBuffer(buffer)) throw new Error('Bundle download returned no bytes: ' + record.fileHash);
        if (buffer.length !== record.fileSize) throw new Error('Bundle size mismatch: ' + record.fileHash);
        if (md5(buffer) !== record.fileHash) throw new Error('Bundle MD5 mismatch: ' + record.fileHash);
        await writeAtomic(target,buffer);
      }
      record.file = target;
      record.sha256 = sha256(buffer).toLowerCase();
      record.reused = reused;
      completed += 1;
      await progress(onProgress,'download',{completed:completed,total:bundleRecords.size,
        fileHash:record.fileHash,reused:reused});
    }));
    function expanded(record, fallbackPackageKey, context) {
      const value = validateBundle(record,fallbackPackageKey,context);
      return Object.assign({},bundleRecords.get(value.packageKey + '|' + value.fileHash));
    }
    const assets = plan.resources.map(function(item,index) {
      const assetPath = String(item.assetPath || '');
      const dependencies = Array.isArray(item.dependencyBundles) ? item.dependencyBundles :
        (Array.isArray(item.dependencies) ? item.dependencies : []);
      return {
        packageKey:String(item.packageKey || ''),
        packageName:String(item.packageName || (item.packageKey === 'battle' ? 'PetAnimPackage' : 'DefaultPackage')),
        assetPath:assetPath,
        action:String(item.action || item.clip || (assetPath.match(/\/([^/]+)\.(?:playable|prefab|mp4)$/i) || [])[1] || ''),
        bundle:expanded(item,'','asset ' + index),
        dependencies:dependencies.map(function(dep,depIndex) {
          return expanded(dep,item.packageKey,'asset ' + index + ' dependency ' + depIndex);
        }),
      };
    }).sort(function(left,right) { return lower(left.assetPath).localeCompare(lower(right.assetPath)); });
    const bundles = Array.from(bundleRecords.values()).map(function(item) { return Object.assign({},item); })
      .sort(function(left,right) {
        return (left.packageKey + '|' + left.fileHash).localeCompare(right.packageKey + '|' + right.fileHash);
      });
    const index = {
      schema:INDEX_SCHEMA,ownerId:plan.ownerId,generatedAt:String(now()),
      packages:Array.from(new Map(bundles.map(function(item) {
        return [item.packageKey,{key:item.packageKey,packageName:item.packageName}];
      })).values()),
      assetCount:assets.length,uniqueBundleCount:bundles.length,
      totalBundleBytes:bundles.reduce(function(sum,item) { return sum + item.fileSize; },0),
      assets:assets,bundles:bundles,
    };
    if (index.assetCount < 11) throw new Error('Prepared SkillTimeline bundle index is incomplete');
    const indexFile = path.join(sourceRoot,String(plan.ownerId) + '-skill-timeline-bundles.json');
    await writeAtomic(indexFile,jsonBuffer(index));
    return {index:index,indexFile:indexFile};
  }

  async function walkTools(root, current, entries) {
    const names = await fs.promises.readdir(current);
    names.sort();
    for (const name of names) {
      const source = path.join(current,name);
      if (!inside(root,source)) throw new Error('Tool path escaped its source root');
      const stat = await fs.promises.lstat(source);
      if (stat.isSymbolicLink()) throw new Error('Tool directory may not contain symbolic links: ' + source);
      const relative = path.relative(root,source).split(path.sep).join('/');
      if (stat.isDirectory()) {
        entries.push({type:'directory',relative:relative});
        await walkTools(root,source,entries);
      } else if (stat.isFile()) {
        entries.push({type:'file',relative:relative,buffer:await fs.promises.readFile(source)});
      } else {
        throw new Error('Unsupported tool directory entry: ' + source);
      }
    }
  }
  async function materializeTools(cacheRoot) {
    const sourceRoot = path.resolve(dependencies.toolSourceDirectory ||
      path.join(moduleDirectory || '','resources','uclient-skill-timeline-auto-adapter'));
    const entries = [];
    await walkTools(sourceRoot,sourceRoot,entries);
    if (!entries.some(function(item) { return item.type === 'file' &&
        path.posix.basename(item.relative) === 'Auto-Adapt-UClientSkillTimeline.ps1'; })) {
      throw new Error('Auto-Adapt-UClientSkillTimeline.ps1 is missing from the packaged tool directory');
    }
    const digest = crypto.createHash('sha256');
    entries.forEach(function(item) {
      digest.update(item.type + '\0' + item.relative + '\0');
      if (item.buffer) digest.update(item.buffer);
    });
    const version = digest.digest('hex').toUpperCase();
    const toolsRoot = path.join(cacheRoot,'tools',version);
    const marker = path.join(toolsRoot,'.materialized.json');
    try {
      const current = await readJson(marker);
      if (current && current.version === version) return toolsRoot;
    } catch (_) {}
    if (typeof dependencies.materializeTools === 'function') {
      const result = await dependencies.materializeTools({sourceRoot:sourceRoot,targetRoot:toolsRoot,
        version:version,entries:entries});
      const resolved = path.resolve(result || toolsRoot);
      if (!inside(cacheRoot,resolved)) throw new Error('Materialized tool directory escaped the cache root');
      return resolved;
    }
    const temporary = toolsRoot + '.part-' + randomSuffix();
    await rmSafe(temporary,{recursive:true,force:true});
    await fs.promises.mkdir(temporary,{recursive:true});
    try {
      for (const entry of entries) {
        const target = path.join(temporary,...entry.relative.split('/'));
        if (!inside(temporary,target)) throw new Error('Tool materialization escaped its target root');
        if (entry.type === 'directory') await fs.promises.mkdir(target,{recursive:true});
        else {
          await fs.promises.mkdir(path.dirname(target),{recursive:true});
          await fs.promises.writeFile(target,entry.buffer);
        }
      }
      await fs.promises.writeFile(path.join(temporary,'.materialized.json'),
        jsonBuffer({schemaVersion:1,version:version,materializedAt:String(now())}));
      await fs.promises.mkdir(path.dirname(toolsRoot),{recursive:true});
      await rmSafe(toolsRoot,{recursive:true,force:true});
      await fs.promises.rename(temporary,toolsRoot);
    } finally {
      await rmSafe(temporary,{recursive:true,force:true}).catch(function() {});
    }
    return toolsRoot;
  }
  async function findTool(root, name) {
    const entries = [];
    await walkTools(root,root,entries);
    const matches = entries.filter(function(item) {
      return item.type === 'file' && path.posix.basename(item.relative) === name;
    });
    if (matches.length !== 1) throw new Error('Expected one materialized tool named ' + name);
    return path.join(root,...matches[0].relative.split('/'));
  }

  function defaultRunProcess(executable, args, options) {
    const spawn = dependencies.spawn || require('child_process').spawn;
    return new Promise(function(resolve,reject) {
      const child = spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],
        cwd:options && options.cwd,env:options && options.env});
      const stdout = [];
      const stderr = [];
      const timeout = setTimeout(function() {
        try { child.kill(); } catch (_) {}
      }, Number(options && options.timeoutMs || 20 * 60 * 1000));
      if (child.stdout) child.stdout.on('data',function(value) { stdout.push(Buffer.from(value)); });
      if (child.stderr) child.stderr.on('data',function(value) { stderr.push(Buffer.from(value)); });
      child.once('error',function(error) { clearTimeout(timeout); reject(error); });
      child.once('close',function(exitCode) {
        clearTimeout(timeout);
        resolve({exitCode:Number(exitCode),stdout:Buffer.concat(stdout).toString('utf8'),
          stderr:Buffer.concat(stderr).toString('utf8')});
      });
    });
  }

  function validateSummary(summary) {
    if (!isObject(summary)) throw new Error('Timeline summary is invalid');
    const timing = {};
    ACTIONS.forEach(function(action) {
      const record = summary[action];
      const duration = Number(record && record.computedDuration);
      const signals = Array.isArray(record && record.signalMarkers) ? record.signalMarkers : [];
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Timeline summary duration is invalid: ' + action);
      }
      if (action === 'appear' ? signals.length !== 0 : signals.length < 1) {
        throw new Error('Timeline summary must contain an official Signal marker: ' + action);
      }
      const value = {durationSeconds:duration};
      if (action !== 'appear') {
        // A Timeline can contain setup Signals before the actual impact
        // (official owner 4000/hidemove is one such asset).  The final official
        // Signal is the effect/return boundary; never infer from duration.
        const hit = Number(signals[signals.length - 1] && signals[signals.length - 1].time);
        if (!Number.isFinite(hit) || hit < 0 || hit > duration) {
          throw new Error('Timeline summary Signal marker is invalid: ' + action);
        }
        value.hitSeconds = hit;
      }
      timing[action] = value;
    });
    return timing;
  }
  function canonicalDependency(value, fallbackPackageKey) {
    return {packageKey:String(value && value.packageKey || fallbackPackageKey || ''),
      fileHash:lower(value && value.fileHash),bytes:Number(value && value.bytes || 0)};
  }
  function canonicalResource(value) {
    const packageKey = String(value && value.packageKey || '');
    return {assetPath:lower(value && value.assetPath),packageKey:packageKey,
      fileHash:lower(value && value.fileHash),bytes:Number(value && value.bytes || 0),
      dependencies:(Array.isArray(value && (value.dependencies || value.dependencyBundles))
        ? (value.dependencies || value.dependencyBundles) : []).map(function(item) {
        return canonicalDependency(item,packageKey);
      }).sort(function(left,right) {
        return [left.packageKey,left.fileHash,left.bytes].join('|').localeCompare(
          [right.packageKey,right.fileHash,right.bytes].join('|'));
      })};
  }
  function profileFingerprint(profile) {
    const resources = profile.resources.timelines.concat(profile.resources.effects)
      .map(canonicalResource).sort(function(left,right) { return left.assetPath.localeCompare(right.assetPath); });
    return sha256(Buffer.from(JSON.stringify({ownerId:profile.ownerId,
      spineSkeletonSha256:profile.spineSkeletonSha256,resources:resources}),'utf8'));
  }

  function staticResourceKey(value) {
    const packageKey = String(value && value.packageKey || '');
    return [packageKey,lower(value && value.assetPath),lower(value && value.fileHash),
      Number(value && value.bytes || 0)].join('|');
  }

  function staticProfileMatchesPlan(ownerId, plan) {
    const profile = staticProfiles.get(ownerId);
    if (!profile) return false;
    const expected = profile.resources || {};
    const actual = plan || {};
    const expectedTimelines = (Array.isArray(expected.timelines) ? expected.timelines : []).map(function(x) { return lower(x.assetPath); }).sort();
    const actualTimelines = (Array.isArray(actual.timelines) ? actual.timelines : []).map(function(x) { return lower(x.assetPath); }).sort();
    const expectedEffects = (Array.isArray(expected.effects) ? expected.effects : []).map(function(x) { return lower(x.assetPath); }).sort();
    const actualEffects = (Array.isArray(actual.effects) ? actual.effects : []).map(function(x) { return lower(x.assetPath); }).sort();
    return expectedTimelines.length === 5 && actualTimelines.length === 5 &&
      expectedEffects.length === 5 && actualEffects.length === 5 &&
      expectedTimelines.every(function(val, idx) { return val === actualTimelines[idx]; }) &&
      expectedEffects.every(function(val, idx) { return val === actualEffects[idx]; });
  }

  async function stageArtifacts(workRoot, plan, skeletonSha256, cacheKey) {
    const swfFile = path.join(workRoot,'uclient-skill-timeline.swf');
    const evidenceFile = path.join(workRoot,'uclient-skill-timeline.json');
    const summaryFile = path.join(workRoot,String(plan.ownerId) + '-timeline-summary.json');
    const nativeBytes = await fs.promises.readFile(swfFile);
    if (nativeBytes.length < 3 || !['FWS','CWS','ZWS'].includes(nativeBytes.subarray(0,3).toString('ascii'))) {
      throw new Error('Generated SkillTimeline SWF signature is invalid');
    }
    const nativeSha = sha256(nativeBytes);
    const evidence = await readJson(evidenceFile);
    const summary = await readJson(summaryFile);
    const conversionPolicy = String(evidence.conversionPolicy || '');
    if (!isSupportedConversionPolicy(conversionPolicy)) {
      throw new Error('Generated SkillTimeline evidence conversion policy is unsupported');
    }
    const timing = validateSummary(summary);
    const evidenceOwner = parseOwnerId(evidence.ownerId || evidence.sourceId);
    const evidenceActions = Array.isArray(evidence.actions) ? evidence.actions : [];
    const actionNames = evidenceActions.map(function(item) { return lower(item && item.action); });
    if (evidenceOwner !== plan.ownerId || evidence.enabled !== true || evidenceActions.length !== ACTIONS.length ||
        new Set(actionNames).size !== ACTIONS.length || ACTIONS.some(function(action) { return !actionNames.includes(action); }) ||
        Number(evidence.bytes == null ? evidence.nativeBytes : evidence.bytes) !== nativeBytes.length ||
        String(evidence.sha256 || evidence.nativeSha256 || '').toUpperCase() !== nativeSha) {
      throw new Error('Generated SkillTimeline evidence does not match its SWF');
    }
    evidenceActions.forEach(function(item) {
      const action = lower(item.action);
      const duration = Number(item.durationSeconds);
      const frameCount = Number(item.frameCount);
      item.backgroundMode = normalizeBackgroundMode(item.backgroundMode);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(frameCount) || frameCount < 2 ||
          (action !== 'appear' && timing[action].hitSeconds > duration + .05)) {
        throw new Error('Generated SkillTimeline action evidence is invalid: ' + action);
      }
      if (action !== 'appear') {
        item.hitSeconds = timing[action].hitSeconds;
        item.motionEvidence = Object.assign({},isObject(item.motionEvidence) ? item.motionEvidence : {},
          {impactSeconds:timing[action].hitSeconds});
      } else {
        delete item.hitSeconds;
      }
    });
    const profile = {
      ownerId:plan.ownerId,
      native:{file:'uclient-skill-timeline.swf',evidenceFile:'uclient-skill-timeline-source.json',
        bytes:nativeBytes.length,sha256:nativeSha},
      resources:{timelines:plan.timelines,effects:plan.effects,
        videos:plan.videos.map(function(item) { return String(item.assetPath || ''); })},
      actionTiming:{source:PROFILE_SOURCE,durationToleranceSeconds:.05,returnMixSeconds:.1,actions:timing},
      spineSkeletonSha256:skeletonSha256,
      __dynamic:true,
    };
    const fingerprint = profileFingerprint(profile);
    profile.__fingerprint = fingerprint;
    const completedEvidence = Object.assign({},evidence,{
      version:1,enabled:true,policy:POLICY,ownerId:plan.ownerId,
      nativeBytes:nativeBytes.length,nativeSha256:nativeSha,
      resourcePlanVersion:3,resourcePlanClosureSha256:plan.closureSha256,
      spineSkeletonSha256:skeletonSha256,profileFingerprint:fingerprint,
      actions:evidenceActions,
    });
    const sidecar = {schemaVersion:1,profile:profile,resourcePlanVersion:3,
      resourcePlanClosureSha256:plan.closureSha256,cacheKey:cacheKey};
    return {nativeBytes:nativeBytes,evidence:completedEvidence,sourceEvidence:completedEvidence,
      profile:sidecar};
  }

  async function validateCache(previewRoot, plan, skeletonSha256, cacheKey) {
    try {
      const swf = await fs.promises.readFile(path.join(previewRoot,'uclient-skill-timeline.swf'));
      const sidecar = await readJson(path.join(previewRoot,'uclient-skill-timeline-profile.json'));
      const profile = sidecar && sidecar.profile;
      const evidenceFileName = String(profile && profile.native && profile.native.evidenceFile || '');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/i.test(evidenceFileName)) return null;
      const evidence = await readJson(path.join(previewRoot,evidenceFileName));
      const nativeSha = sha256(swf);
      if (!isSupportedConversionPolicy(String(evidence.conversionPolicy || ''))) return null;
      if (!profile || sidecar.cacheKey !== cacheKey || Number(sidecar.resourcePlanVersion) !== 3 ||
          String(sidecar.resourcePlanClosureSha256 || '').toUpperCase() !== plan.closureSha256 ||
          parseOwnerId(profile.ownerId) !== plan.ownerId || profile.__dynamic !== true ||
          String(profile.spineSkeletonSha256 || '').toUpperCase() !== skeletonSha256 ||
          Number(profile.native && profile.native.bytes) !== swf.length ||
          String(profile.native && profile.native.sha256 || '').toUpperCase() !== nativeSha ||
          Number(evidence.nativeBytes) !== swf.length || String(evidence.nativeSha256 || '').toUpperCase() !== nativeSha ||
          Number(evidence.resourcePlanVersion) !== 3 ||
          String(evidence.resourcePlanClosureSha256 || '').toUpperCase() !== plan.closureSha256 ||
          String(evidence.profileFingerprint || '').toUpperCase() !== profileFingerprint(profile)) return null;
      const actions = profile.actionTiming && profile.actionTiming.actions;
      if (!actions || BATTLE_ACTIONS.some(function(action) {
        const profileHit = Number(actions[action] && actions[action].hitSeconds);
        const item = (evidence.actions || []).find(function(value) { return lower(value && value.action) === action; });
        return !Number.isFinite(profileHit) || !item || Number(item.hitSeconds) !== profileHit;
      })) return null;
      return {status:'cache-hit',ownerId:plan.ownerId,cacheKey:cacheKey,
        metadata:evidence,profile:profile};
    } catch (_) { return null; }
  }

  async function commitArtifacts(previewRoot, artifacts) {
    await fs.promises.mkdir(previewRoot,{recursive:true});
    const transaction = path.join(previewRoot,'.uclient-skill-timeline-commit-' + randomSuffix());
    const names = ['uclient-skill-timeline.swf','uclient-skill-timeline.json',
      'uclient-skill-timeline-source.json','uclient-skill-timeline-profile.json'];
    const sourceEvidence = artifacts.sourceEvidence || artifacts.evidence;
    const buffers = [artifacts.nativeBytes,jsonBuffer(artifacts.evidence),
      jsonBuffer(sourceEvidence),jsonBuffer(artifacts.profile)];
    const backedUp = [];
    const installed = [];
    await fs.promises.mkdir(transaction,{recursive:true});
    try {
      for (let index = 0; index < names.length; index += 1) {
        await fs.promises.writeFile(path.join(transaction,'new-' + names[index]),buffers[index]);
      }
      for (const name of names) {
        const target = path.join(previewRoot,name);
        try {
          await fs.promises.rename(target,path.join(transaction,'old-' + name));
          backedUp.push(name);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
      }
      for (const name of names) {
        await fs.promises.rename(path.join(transaction,'new-' + name),path.join(previewRoot,name));
        installed.push(name);
      }
    } catch (error) {
      for (const name of installed) {
        await rmSafe(path.join(previewRoot,name),{force:true}).catch(function() {});
      }
      for (const name of backedUp) {
        await fs.promises.rename(path.join(transaction,'old-' + name),path.join(previewRoot,name));
      }
      throw error;
    } finally {
      await rmSafe(transaction,{recursive:true,force:true}).catch(function() {});
    }
  }

  async function prepare(options) {
    options = options || {};
    if (!String(options.previewRoot || '').trim()) throw new Error('previewRoot is required');
    const previewRoot = path.resolve(String(options.previewRoot));
    const applicable = validatePlan(options.credential,options.resourcePlan);
    if (!applicable) {
      await progress(options.onProgress,'not-applicable');
      return null;
    }
    if (staticProfileOwners.has(applicable.ownerId) &&
        staticProfileMatchesPlan(applicable.ownerId,applicable)) {
      await progress(options.onProgress,'static-profile',{ownerId:applicable.ownerId});
      return {status:'static-profile',ownerId:applicable.ownerId,cacheKey:null};
    }
    const skeletonName = leaf(options.spineSource && options.spineSource.skeletonFile,
      'Spine skeleton');
    const skeletonFile = path.join(previewRoot,skeletonName);
    const skeletonStat = await fs.promises.lstat(skeletonFile);
    if (!skeletonStat.isFile() || skeletonStat.isSymbolicLink()) {
      throw new Error('Spine skeleton must be a regular local file');
    }
    const skeletonSha = sha256(await fs.promises.readFile(skeletonFile));
    const cacheKey = [applicable.ownerId,applicable.closureSha256,skeletonSha].join('-');
    const cached = await validateCache(previewRoot,applicable,skeletonSha,cacheKey);
    if (cached) {
      await progress(options.onProgress,'cache-hit',{ownerId:applicable.ownerId,cacheKey:cacheKey});
      return cached;
    }
    const getUserDataPath = dependencies.getUserDataPath || function() {
      if (dependencies.app && typeof dependencies.app.getPath === 'function') {
        return dependencies.app.getPath('userData');
      }
      throw new Error('getUserDataPath dependency is required');
    };
    const userData = path.resolve(String(await getUserDataPath()));
    const cacheRoot = path.join(userData,'cache','uclient-skill-timeline-auto-adapter');
    const entryRoot = path.join(cacheRoot,'entries',cacheKey);
    if (!inside(cacheRoot,entryRoot)) throw new Error('Auto-adapter cache path escaped userData');
    const cachedEntry = await validateCache(entryRoot,applicable,skeletonSha,cacheKey);
    if (cachedEntry) {
      const cachedArtifacts = {
        nativeBytes:await fs.promises.readFile(path.join(entryRoot,'uclient-skill-timeline.swf')),
        evidence:await readJson(path.join(entryRoot,'uclient-skill-timeline-source.json')),
        sourceEvidence:await readJson(path.join(entryRoot,'uclient-skill-timeline-source.json')),
        profile:await readJson(path.join(entryRoot,'uclient-skill-timeline-profile.json')),
      };
      await commitArtifacts(previewRoot,cachedArtifacts);
      await progress(options.onProgress,'cache-hit',{ownerId:applicable.ownerId,cacheKey:cacheKey});
      return {status:'cache-hit',ownerId:applicable.ownerId,cacheKey:cacheKey,
        metadata:cachedArtifacts.evidence,profile:cachedArtifacts.profile.profile,index:null};
    }
    await progress(options.onProgress,'prepare',{ownerId:applicable.ownerId,cacheKey:cacheKey});
    const toolsRoot = await materializeTools(cacheRoot);
    const autoScript = await findTool(toolsRoot,'Auto-Adapt-UClientSkillTimeline.ps1');
    await rmSafe(entryRoot,{recursive:true,force:true});
    const workRoot = path.join(entryRoot,'work');
    const sourceRoot = path.join(entryRoot,'source');
    await fs.promises.mkdir(workRoot,{recursive:true});
    const prepared = await downloadIndex(applicable,sourceRoot,options.onProgress);
    const runtimeDirectory = path.resolve(String(dependencies.runtimeDirectory || ''));
    const pluginFile = path.resolve(String(dependencies.pluginFile || ''));
    const pythonExecutable = String(dependencies.pythonExecutable || 'python');
    if (!dependencies.runtimeDirectory || !(await fs.promises.stat(runtimeDirectory)).isDirectory()) {
      throw new Error('U-client capture runtime directory is missing');
    }
    if (!dependencies.pluginFile || !(await fs.promises.stat(pluginFile)).isFile()) {
      throw new Error('U-client capture plugin is missing');
    }
    const mxmlcExecutable = path.resolve(String(dependencies.mxmlcExecutable || ''));
    const javaHome = path.resolve(String(dependencies.javaHome || ''));
    const playerGlobalHome = path.resolve(String(dependencies.playerGlobalHome || ''));
    const ffmpegExecutable = path.resolve(String(dependencies.ffmpegExecutable || ''));
    if (!dependencies.mxmlcExecutable || !(await fs.promises.stat(mxmlcExecutable)).isFile() ||
        !dependencies.javaHome || !(await fs.promises.stat(javaHome)).isDirectory() ||
        !dependencies.playerGlobalHome || !(await fs.promises.stat(playerGlobalHome)).isDirectory() ||
        !dependencies.ffmpegExecutable || !(await fs.promises.stat(ffmpegExecutable)).isFile()) {
      throw new Error('U-client SkillTimeline conversion toolchain is incomplete');
    }
    const args = ['-NoLogo','-NoProfile','-NonInteractive','-File',autoScript,
      '-OwnerId',String(applicable.ownerId),'-WorkRoot',workRoot,'-SourceRoot',sourceRoot,
      '-Runtime',runtimeDirectory,'-PluginSource',pluginFile,'-Python',pythonExecutable,
      '-Node',nodeExecutable,'-SpineSkeleton',skeletonFile,
      '-Mxmlc',mxmlcExecutable,'-JavaHome',javaHome,'-PlayerGlobalHome',playerGlobalHome,
      '-Ffmpeg',ffmpegExecutable,'-SkipProfileRegistration'];
    await progress(options.onProgress,'run',{ownerId:applicable.ownerId});
    const runProcess = dependencies.runProcess || defaultRunProcess;
    const result = await runProcess(pwshExecutable,args,{windowsHide:true,cwd:path.dirname(autoScript),
      env:dependencies.processEnv || process.env,timeoutMs:Number(dependencies.timeoutMs || 20 * 60 * 1000)});
    const exitCode = typeof result === 'number' ? result : Number(result && result.exitCode);
    if (exitCode !== 0) {
      throw new Error('U-client SkillTimeline Auto-Adapt failed with exit code ' + String(exitCode) +
        (result && result.stderr ? ': ' + String(result.stderr).trim() : ''));
    }
    if (!fs.existsSync(prepared.indexFile)) throw new Error('Prepared bundle index disappeared during Auto-Adapt');
    const artifacts = await stageArtifacts(workRoot,applicable,skeletonSha,cacheKey);
    // Keep a complete, validated artifact triplet under userData so a later
    // preview/download with the same official closure only copies bytes and
    // never launches the Unity capture process again.
    await writeAtomic(path.join(entryRoot,'uclient-skill-timeline.swf'),artifacts.nativeBytes);
    await writeAtomic(path.join(entryRoot,'uclient-skill-timeline-source.json'),
      jsonBuffer(artifacts.sourceEvidence || artifacts.evidence));
    await writeAtomic(path.join(entryRoot,'uclient-skill-timeline.json'),jsonBuffer(artifacts.evidence));
    await writeAtomic(path.join(entryRoot,'uclient-skill-timeline-profile.json'),jsonBuffer(artifacts.profile));
    await commitArtifacts(previewRoot,artifacts);
    await writeAtomic(path.join(entryRoot,'success.json'),jsonBuffer({schemaVersion:1,
      ownerId:applicable.ownerId,cacheKey:cacheKey,completedAt:String(now())}));
    await progress(options.onProgress,'complete',{ownerId:applicable.ownerId,cacheKey:cacheKey});
    return {status:'built',ownerId:applicable.ownerId,cacheKey:cacheKey,
      metadata:artifacts.evidence,profile:artifacts.profile.profile,index:prepared.index};
  }

  return {prepare:prepare};
}

module.exports = {
  ACTIONS:ACTIONS,
  createUClientSkillTimelineAutoAdapter:createUClientSkillTimelineAutoAdapter,
};
