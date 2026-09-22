'use strict';

function createUClientEmbeddedCinematic(dependencies) {
  var fs = dependencies.fs;
  var path = dependencies.path;
  var crypto = dependencies.crypto;
  var writeAtomic = dependencies.writeAtomic;
  var moduleDirectory = dependencies.moduleDirectory;
  var profileFile = path.join(moduleDirectory,'resources','uclient-embedded-cinematics.json');
  var document = JSON.parse(fs.readFileSync(profileFile,'utf8'));
  if (Number(document.schemaVersion) !== 2 || !Array.isArray(document.profiles)) {
    throw new Error('U-client embedded cinematic profile document is invalid');
  }

  function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
  }
  function normalizedPath(value) {
    return String(value || '').replace(/\\/g,'/').toLowerCase();
  }
  function normalizedActionTiming(profile, windows) {
    var input = profile && profile.actionTiming;
    var actions = input && input.actions;
    var tolerance = Number(input && input.durationToleranceSeconds);
    var returnMix = Number(input && input.returnMixSeconds);
    if (!actions || typeof actions !== 'object' || !Number.isFinite(tolerance) || tolerance <= 0 ||
        !Number.isFinite(returnMix) || returnMix < 0 || returnMix > .5) {
      throw new Error('U-client embedded cinematic action timing is invalid');
    }
    var normalizedActions = {};
    Object.keys(actions).forEach(function(key) {
      var action = String(key || '').toLowerCase();
      var value = actions[key] || {};
      var duration = Number(value.durationSeconds);
      var hit = value.hitSeconds == null ? null : Number(value.hitSeconds);
      if (!action || !Number.isFinite(duration) || duration <= 0 ||
          (hit != null && (!Number.isFinite(hit) || hit < 0 || hit > duration + tolerance))) {
        throw new Error('U-client embedded cinematic action timing entry is invalid');
      }
      normalizedActions[action] = { durationSeconds:duration };
      if (hit != null) normalizedActions[action].hitSeconds = hit;
    });
    windows.forEach(function(window) {
      var action = normalizedActions[window.action];
      if (!action || window.endSeconds > action.durationSeconds + tolerance) {
        throw new Error('U-client embedded cinematic window exceeds its official action timing');
      }
    });
    return {
      source:String(input.source || ''),
      durationToleranceSeconds:tolerance,
      returnMixSeconds:returnMix,
      actions:normalizedActions,
    };
  }
  function select(videoMetadata) {
    var assetPath = normalizedPath(videoMetadata && videoMetadata.assetPath);
    var sourceSha = String(videoMetadata && videoMetadata.sha256 || '').toUpperCase();
    if (!assetPath || !sourceSha) return null;
    return document.profiles.find(function(profile) {
      return normalizedPath(profile.videoAssetPath) === assetPath &&
        String(profile.sourceVideoSha256 || '').toUpperCase() === sourceSha;
    }) || null;
  }
  async function removeStale(previewRoot) {
    await Promise.all(['uclient-cinematic.swf','uclient-cinematic.json'].map(async function(name) {
      try { await fs.promises.unlink(path.join(previewRoot,name)); }
      catch(error) { if (!error || error.code !== 'ENOENT') throw error; }
    }));
  }
  async function prepare(previewRoot, videoMetadata) {
    var profile = select(videoMetadata);
    if (!profile) { await removeStale(previewRoot); return null; }
    var source = path.join(moduleDirectory,'resources',String(profile.nativeSwf || ''));
    var bytes = await fs.promises.readFile(source);
    var nativeSha = sha256(bytes);
    if (nativeSha !== String(profile.nativeSwfSha256 || '').toUpperCase()) {
      throw new Error('Bundled U-client cinematic does not match its audited profile');
    }
    var spineSource = JSON.parse(await fs.promises.readFile(path.join(previewRoot,'spine-source.json'),'utf8'));
    var skeletonName = String(spineSource && spineSource.skeletonFile || '');
    if (!/^[\w.-]+$/.test(skeletonName)) {
      throw new Error('U-client embedded cinematic Spine source is invalid');
    }
    var skeletonBytes = await fs.promises.readFile(path.join(previewRoot,skeletonName));
    var skeletonSha = sha256(skeletonBytes);
    if (skeletonSha !== String(profile.spineSkeletonSha256 || '').toUpperCase()) {
      throw new Error('U-client embedded cinematic Spine skeleton does not match its audited profile');
    }
    var windows = (Array.isArray(profile.windows) ? profile.windows : []).map(function(window) {
      var action = String(window && window.action || '').toLowerCase();
      var start = Number(window && window.startSeconds);
      var end = Number(window && window.endSeconds);
      var frameRate = Math.max(1,Math.min(60,Number(window && window.frameRate) || 30));
      if (!action || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error('U-client embedded cinematic window is invalid');
      }
      return { action:action,startSeconds:start,endSeconds:end,frameRate:frameRate };
    });
    if (!windows.length) throw new Error('U-client embedded cinematic has no playback window');
    var actionTiming = normalizedActionTiming(profile,windows);
    var record = {
      version:1,enabled:true,policy:String(document.policy || ''),
      videoAssetPath:String(videoMetadata.assetPath || ''),
      sourceVideoSha256:String(videoMetadata.sha256 || '').toUpperCase(),
      spineAssetPath:String(profile.spineAssetPath || ''),
      spineSkeletonSha256:skeletonSha,spineSkeletonBytes:skeletonBytes.length,
      nativeSwfSha256:nativeSha,nativeSwfBytes:bytes.length,windows:windows,
      actionTiming:actionTiming,
      evidence:String(profile.evidence || ''),preparedAt:new Date().toISOString(),
    };
    await writeAtomic(path.join(previewRoot,'uclient-cinematic.swf'),bytes);
    await writeAtomic(path.join(previewRoot,'uclient-cinematic.json'),
      Buffer.from(JSON.stringify(record,null,2),'utf8'));
    return record;
  }
  return { select:select,prepare:prepare,profileCount:document.profiles.length,policy:document.policy };
}

function embeddedCinematicMatchesFightBuild(videoBuild, fightBuild) {
  var expected = videoBuild && videoBuild.cinematic;
  var actual = fightBuild && fightBuild.cinematic;
  if (!expected) return !actual || actual.embedded !== true;
  if (!actual || actual.embedded !== true) return false;
  function upper(value) { return String(value || '').toUpperCase(); }
  function lower(value) { return String(value || '').replace(/\\/g,'/').toLowerCase(); }
  return lower(actual.videoAssetPath) === lower(expected.videoAssetPath) &&
    upper(actual.sourceVideoSha256) === upper(expected.sourceVideoSha256) &&
    upper(actual.nativeSwfSha256) === upper(expected.nativeSwfSha256) &&
    Number(actual.nativeSwfBytes) === Number(expected.nativeSwfBytes) &&
    lower(actual.spineAssetPath) === lower(expected.spineAssetPath) &&
    upper(actual.spineSkeletonSha256) === upper(expected.spineSkeletonSha256) &&
    JSON.stringify(actual.windows || []) === JSON.stringify(expected.windows || []) &&
    JSON.stringify(actual.actionTiming || null) === JSON.stringify(expected.actionTiming || null);
}

module.exports = {
  createUClientEmbeddedCinematic:createUClientEmbeddedCinematic,
  embeddedCinematicMatchesFightBuild:embeddedCinematicMatchesFightBuild,
};
