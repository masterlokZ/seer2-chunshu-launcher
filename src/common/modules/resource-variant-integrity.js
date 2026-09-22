'use strict';

var ftrPipelineContract = require('./uclient-ftr-flash-pipeline');
var EVENT_VIDEO_BUILD_VERSION = 3;
var NATIVE_VIDEO_TIMELINE_VERSION = 4;
var NATIVE_EVENT_VIDEO_FIT_POLICY = 'authored-aspect-native-no-downscale';
var FTR_BATTLE_TEMPLATE_VERSION = ftrPipelineContract.UClientFtr_BATTLE_TEMPLATE_VERSION;
var FTR_ASSET_VERSION = ftrPipelineContract.UClientFtr_FLASH_ASSET_VERSION;
var SPINE_BATTLE_TEMPLATE_VERSION = ftrPipelineContract.UCLIENT_SPINE_TEMPLATE_VERSION;
var SPINE_ASSET_VERSION = ftrPipelineContract.UCLIENT_SPINE_TEMPLATE_VERSION;
var MAX_FLASH_ATLAS_PAGES = ftrPipelineContract.MAX_FLASH_ATLAS_PAGES;
var FLASH_OUTPUT_SCALE = ftrPipelineContract.UClientFtr_FLASH_OUTPUT_SCALE;
var FLASH_QUALITY_POLICY = ftrPipelineContract.UClientFtr_FLASH_QUALITY_POLICY;
var FTR_RESIDENCY_POLICY = ftrPipelineContract.UClientFtr_FLASH_RESIDENCY_POLICY;
var SPINE_RESIDENCY_POLICY = 'spine-model-lifetime-lossless-v1';
var FTR_RENDERER_POLICY = 'resource-local-quality-model-residency';
var SPINE_RENDERER_POLICY = 'uclient-spine40-cpu-resource-local-texture';
var FTR_EVENT_VIDEO_CONVERSION_POLICY = 'ftr-event-label-freeze-native-avm2-flv1-mp3-embedded';
var SPINE_CINEMATIC_POLICY = 'exact-official-video-evidence-embedded-into-uclient-fight';

/**
 * Keep discovery evidence, source variants, preview inventory and runnable
 * primary builds separate.  This module is intentionally synchronous: the
 * downloaded-inventory projection is synchronous and must make exactly the
 * same decision as the later auto-import gate.
 */
function createResourceVariantIntegrity(deps) {
  deps = deps || {};
  var fs = deps.fs;
  var path = deps.path;
  var crypto = deps.crypto;
  var zlib = deps.zlib || require('zlib');
  if (!fs || !path || !crypto) throw new Error('resource variant integrity dependencies are incomplete');

  function parseId(value) {
    var text = String(value == null ? '' : value).trim();
    if (!/^\d+$/.test(text)) return 0;
    var id = Number(text);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  function normalizedHash(value) {
    var hash = String(value || '').trim().toUpperCase();
    return /^[0-9A-F]{64}$/.test(hash) ? hash : '';
  }

  function missing(reason, extra) {
    return Object.assign({
      ok:false,
      state:'missing',
      file:'',
      bytes:0,
      sha256:'',
      reason:String(reason || 'missing'),
    }, extra || {});
  }

  function containedFile(root, relative) {
    var text = String(relative || '').trim();
    if (!text || path.isAbsolute(text)) return '';
    var base = path.resolve(root);
    var target = path.resolve(base, text.replace(/[\\/]+/g, path.sep));
    var rel = path.relative(base, target);
    if (!rel || rel === '..' || rel.indexOf('..' + path.sep) === 0 || path.isAbsolute(rel)) return '';
    return target;
  }

  function sha256File(file, stat) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
  }

  function inspectFile(file, expected) {
    expected = expected || {};
    var target = String(file || '').trim();
    if (!target) return missing('path-missing');
    var stat;
    try { stat = fs.statSync(target); }
    catch(error) { return missing('path-missing', { cause:String(error && error.code || '') }); }
    if (!stat.isFile()) return missing('not-a-file');
    var bytes = Number(stat.size || 0);
    if (!bytes) return missing('empty-file');

    var expectedBytes = Number(expected.bytes || expected.skillBytes || expected.fightBytes || 0);
    if (expectedBytes < 0 || (Object.prototype.hasOwnProperty.call(expected, 'bytes') && !expectedBytes)) {
      return missing('invalid-zero-byte-evidence', { stale:true });
    }
    if (expectedBytes && bytes !== expectedBytes) {
      return missing('byte-mismatch', { stale:true, actualBytes:bytes, expectedBytes:expectedBytes });
    }

    var declaredHash = String(expected.sha256 || expected.skillSha256 || expected.fightSha256 || '').trim();
    var expectedHash = normalizedHash(declaredHash);
    if (declaredHash && !expectedHash) return missing('invalid-hash-evidence', { stale:true });
    var actualHash = '';
    if (expectedHash || expected.computeHash === true) {
      try { actualHash = sha256File(target, stat); }
      catch(error) { return missing('hash-read-failed', { cause:String(error && error.message || error) }); }
      if (expectedHash && actualHash !== expectedHash) {
        return missing('hash-mismatch', { stale:true, actualSha256:actualHash, expectedSha256:expectedHash });
      }
    }
    return {
      ok:true,
      state:'ready',
      file:path.resolve(target),
      bytes:bytes,
      sha256:actualHash || expectedHash,
      reason:'verified-file',
    };
  }

  function readJson(file) {
    try {
      var stat = fs.statSync(file);
      if (!stat.isFile() || !stat.size) return missing('json-missing');
      var value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return missing('json-not-object');
      return { ok:true, file:path.resolve(file), bytes:Number(stat.size), value:value };
    } catch(error) {
      return missing(error && error.code === 'ENOENT' ? 'json-missing' : 'json-invalid', {
        cause:String(error && error.message || error),
      });
    }
  }

  function sameEvidence(left, right) {
    return Number(left && left.bytes || 0) > 0 &&
      Number(left && left.bytes || 0) === Number(right && right.bytes || 0) &&
      normalizedHash(left && (left.sha256 || left.fightSha256 || left.skillSha256)) &&
      normalizedHash(left && (left.sha256 || left.fightSha256 || left.skillSha256)) ===
        normalizedHash(right && (right.sha256 || right.fightSha256 || right.skillSha256));
  }

  function currentTemplateSha256(family) {
    var leaf = family === 'spine' ? 'uclient-spine-template.swf' : 'uclient-ftr-battle-template.swf';
    var file = path.resolve(__dirname,'..',leaf);
    try {
      var stat = fs.statSync(file);
      if (!stat.isFile() || !stat.size) return '';
      return sha256File(file,stat);
    } catch(_) { return ''; }
  }

  function hasOwn(value, key) {
    return !!value && Object.prototype.hasOwnProperty.call(value, key);
  }

  function exactPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
  }

  function sameJson(left, right) {
    try { return JSON.stringify(left) === JSON.stringify(right); }
    catch(_) { return false; }
  }

  function normalizeFtrResidencyPlan(value, pageCount) {
    if (!Array.isArray(value) || !value.length || !exactPositiveInteger(pageCount) ||
        pageCount > MAX_FLASH_ATLAS_PAGES) return null;
    var pageSet = new Set();
    var actions = [];
    for (var actionIndex = 0; actionIndex < value.length; actionIndex++) {
      var item = value[actionIndex];
      var action = lowerText(item && item.action);
      var windowSize = Number(item && item.windowSize);
      var windows = Array.isArray(item && item.windows) ? item.windows : null;
      if (!action || !exactPositiveInteger(windowSize) || !windows || !windows.length) return null;
      var normalizedWindows = [];
      for (var windowIndex = 0; windowIndex < windows.length; windowIndex++) {
        var window = windows[windowIndex];
        var startFrame = Number(window && window.startFrame);
        var endFrame = Number(window && window.endFrame);
        var pages = Array.isArray(window && window.pages) ? window.pages : null;
        if (!Number.isInteger(startFrame) || startFrame < 0 || !Number.isInteger(endFrame) ||
            endFrame < startFrame || !pages || !pages.length) return null;
        var normalizedPages = [];
        for (var pageIndex = 0; pageIndex < pages.length; pageIndex++) {
          var page = Number(pages[pageIndex]);
          if (!Number.isInteger(page) || page < 0 || page >= pageCount ||
              normalizedPages.indexOf(page) >= 0) return null;
          normalizedPages.push(page);
          pageSet.add(page);
        }
        normalizedWindows.push({ startFrame:startFrame, endFrame:endFrame, pages:normalizedPages });
      }
      actions.push({ action:action, windowSize:windowSize, windows:normalizedWindows });
    }
    if (pageSet.size !== pageCount) return null;
    for (var requiredPage = 0; requiredPage < pageCount; requiredPage++) {
      if (!pageSet.has(requiredPage)) return null;
    }
    return actions;
  }

  function normalizedSpineCinematic(value, sourceId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.embedded === false) {
      return Object.keys(value).length === 1 ? { embedded:false } : null;
    }
    if (value.embedded !== true || String(value.policy || '') !== SPINE_CINEMATIC_POLICY) return null;
    var videoAssetPath = String(value.videoAssetPath || '').trim().replace(/\\/g, '/');
    var spineAssetPath = String(value.spineAssetPath || '').trim().replace(/\\/g, '/');
    var videoMatch = videoAssetPath.match(/^Assets\/SkillTimeline\/Videos\/(\d+)\/([A-Za-z0-9_-]+)\.(?:mp4|m4v)$/i);
    var spineMatch = spineAssetPath.match(/^Assets\/SkillTimeline\/Spines\/(\d+)\/([A-Za-z0-9_-]+)\.prefab$/i);
    var sourceVideoSha256 = normalizedHash(value.sourceVideoSha256);
    var nativeSwfSha256 = normalizedHash(value.nativeSwfSha256);
    var spineSkeletonSha256 = normalizedHash(value.spineSkeletonSha256);
    var nativeSwfBytes = Number(value.nativeSwfBytes);
    var windows = Array.isArray(value.windows) ? value.windows : null;
    var timing = value.actionTiming;
    if (!videoMatch || !spineMatch || parseId(videoMatch[1]) !== sourceId ||
        parseId(spineMatch[1]) !== sourceId || !sourceVideoSha256 || !nativeSwfSha256 ||
        !spineSkeletonSha256 || !exactPositiveInteger(nativeSwfBytes) || !windows || !windows.length ||
        !timing || typeof timing !== 'object' || Array.isArray(timing) ||
        !String(timing.source || '').trim() || !Number.isFinite(Number(timing.durationToleranceSeconds)) ||
        Number(timing.durationToleranceSeconds) < 0 || !Number.isFinite(Number(timing.returnMixSeconds)) ||
        Number(timing.returnMixSeconds) < 0 || !timing.actions || typeof timing.actions !== 'object' ||
        Array.isArray(timing.actions)) return null;
    var normalizedWindows = [];
    for (var index = 0; index < windows.length; index++) {
      var window = windows[index];
      var action = lowerText(window && window.action);
      var startSeconds = Number(window && window.startSeconds);
      var endSeconds = Number(window && window.endSeconds);
      var frameRate = Number(window && window.frameRate);
      var actionTiming = timing.actions[action];
      if (!action || !Number.isFinite(startSeconds) || startSeconds < 0 ||
          !Number.isFinite(endSeconds) || endSeconds <= startSeconds ||
          !Number.isFinite(frameRate) || frameRate <= 0 || !actionTiming ||
          !Number.isFinite(Number(actionTiming.durationSeconds)) ||
          Number(actionTiming.durationSeconds) + Number(timing.durationToleranceSeconds) < endSeconds) return null;
      normalizedWindows.push({
        action:action, startSeconds:startSeconds, endSeconds:endSeconds, frameRate:frameRate,
      });
    }
    return {
      embedded:true,
      policy:SPINE_CINEMATIC_POLICY,
      videoAssetPath:videoAssetPath,
      sourceVideoSha256:sourceVideoSha256,
      nativeSwfSha256:nativeSwfSha256,
      nativeSwfBytes:nativeSwfBytes,
      windows:normalizedWindows,
      spineAssetPath:spineAssetPath,
      spineSkeletonSha256:spineSkeletonSha256,
      actionTiming:timing,
    };
  }

  function inspectUClientBuildPolicy(build, conversion, sourceId) {
    if (!build || typeof build !== 'object' || Array.isArray(build) ||
        !conversion || typeof conversion !== 'object' || Array.isArray(conversion)) {
      return missing('uclient-build-policy-incomplete', { artifactLayer:'primary' });
    }
    var ftr = build.artifactRole === 'battle' && !hasOwn(build, 'family');
    var spine = build.family === 'spine' && !hasOwn(build, 'artifactRole');
    if (!ftr && !spine) {
      return missing('uclient-build-family-unsupported', { artifactLayer:'primary', stale:true });
    }
    var expectedVersion = ftr ? FTR_BATTLE_TEMPLATE_VERSION : SPINE_BATTLE_TEMPLATE_VERSION;
    var expectedAssetVersion = ftr ? FTR_ASSET_VERSION : SPINE_ASSET_VERSION;
    var expectedTemplateSha256 = currentTemplateSha256(ftr ? 'ftr' : 'spine');
    var expectedRendererPolicy = ftr ? FTR_RENDERER_POLICY : SPINE_RENDERER_POLICY;
    var expectedResidencyPolicy = ftr ? FTR_RESIDENCY_POLICY : SPINE_RESIDENCY_POLICY;
    var pages = Number(ftr ? conversion.pages : build.pages);
    var requiredBuildFields = ['version','sourceId','templateSha256','fightSha256','bytes','rendererPolicy',
      'assetVersion','qualityPolicy','residencyPolicy','outputScale'];
    if (!ftr) requiredBuildFields.push('pages');
    if (requiredBuildFields.some(function(key) { return !hasOwn(build,key); }) ||
        !expectedTemplateSha256 || Number(build.version) !== expectedVersion || parseId(build.sourceId) !== sourceId ||
        normalizedHash(build.templateSha256) !== expectedTemplateSha256 ||
        !normalizedHash(build.fightSha256) || !exactPositiveInteger(Number(build.bytes)) ||
        String(build.rendererPolicy || '') !== expectedRendererPolicy ||
        Number(build.assetVersion) !== expectedAssetVersion ||
        String(build.qualityPolicy || '') !== FLASH_QUALITY_POLICY ||
        String(build.residencyPolicy || '') !== expectedResidencyPolicy ||
        Number(build.outputScale) !== FLASH_OUTPUT_SCALE || !exactPositiveInteger(pages) ||
        pages > MAX_FLASH_ATLAS_PAGES ||
        (hasOwn(build,'pages') && Number(build.pages) !== pages)) {
      return missing('uclient-build-policy-incomplete', {
        artifactLayer:'primary', stale:true, family:ftr ? 'ftr' : 'spine',
      });
    }
    var requiredConversionFields = ['version','sourceId','templateSha256','bytes','sha256','rendererPolicy',
      'assetVersion','qualityPolicy','residencyPolicy','outputScale','pages'];
    if (requiredConversionFields.some(function(key) { return !hasOwn(conversion,key); }) ||
        Number(conversion.version) !== expectedVersion || parseId(conversion.sourceId) !== sourceId ||
        normalizedHash(conversion.templateSha256) !== expectedTemplateSha256 ||
        Number(conversion.bytes) !== Number(build.bytes) ||
        String(conversion.rendererPolicy || '') !== expectedRendererPolicy ||
        Number(conversion.assetVersion) !== expectedAssetVersion ||
        String(conversion.qualityPolicy || '') !== FLASH_QUALITY_POLICY ||
        String(conversion.residencyPolicy || '') !== expectedResidencyPolicy ||
        Number(conversion.outputScale) !== FLASH_OUTPUT_SCALE || Number(conversion.pages) !== pages ||
        (hasOwn(conversion,'templateVersion') && Number(conversion.templateVersion) !== expectedVersion) ||
        normalizedHash(conversion.fightSha256 || conversion.sha256) !== normalizedHash(build.fightSha256)) {
      return missing('uclient-build-policy-mismatch', {
        artifactLayer:'primary', stale:true, family:ftr ? 'ftr' : 'spine',
      });
    }
    if (ftr) {
      var residencyPlan = normalizeFtrResidencyPlan(build.residencyPlan,pages);
      if (!residencyPlan || !sameJson(build.residencyPlan,conversion.residencyPlan)) {
        return missing('uclient-ftr-residency-evidence-incomplete', {
          artifactLayer:'primary', stale:true, family:'ftr',
        });
      }
      if (hasOwn(build,'cinematic') || hasOwn(conversion,'cinematic')) {
        return missing('uclient-build-family-evidence-conflict', {
          artifactLayer:'primary', stale:true, family:'ftr',
        });
      }
    } else {
      var buildCinematic = normalizedSpineCinematic(build.cinematic,sourceId);
      var conversionCinematic = normalizedSpineCinematic(conversion.cinematic,sourceId);
      if (!buildCinematic || !conversionCinematic || !sameJson(buildCinematic,conversionCinematic)) {
        return missing('uclient-spine-cinematic-evidence-incomplete', {
          artifactLayer:'primary', stale:true, family:'spine',
        });
      }
      if (hasOwn(build,'eventVideos') || hasOwn(conversion,'eventVideos')) {
        return missing('uclient-build-family-evidence-conflict', {
          artifactLayer:'primary', stale:true, family:'spine',
        });
      }
    }
    return { ok:true, family:ftr ? 'ftr' : 'spine', pages:pages };
  }

  function readSwfTags(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('fight swf is invalid');
    var signature = buffer.slice(0, 3).toString('ascii');
    var declaredLength = buffer.readUInt32LE(4);
    if (declaredLength < 12 || declaredLength > 256 * 1024 * 1024) {
      throw new Error('fight swf declared size exceeds the x32 integrity bound');
    }
    var body;
    if (signature === 'CWS') body = zlib.inflateSync(buffer.slice(8));
    else if (signature === 'FWS') body = buffer.slice(8);
    else throw new Error('fight swf compression is unsupported');
    var uncompressed = Buffer.concat([Buffer.from('FWS'), buffer.slice(3, 8), body]);
    if (uncompressed.length !== declaredLength) throw new Error('fight swf declared size is inconsistent');
    var rectBits = uncompressed[8] >>> 3;
    var tagsOffset = 8 + Math.ceil((5 + rectBits * 4) / 8) + 4;
    var tags = [];
    var offset = tagsOffset;
    while (offset + 2 <= uncompressed.length) {
      var header = uncompressed.readUInt16LE(offset); offset += 2;
      var code = header >>> 6;
      var length = header & 63;
      if (length === 63) { length = uncompressed.readUInt32LE(offset); offset += 4; }
      if (offset + length > uncompressed.length) throw new Error('fight swf tag is truncated');
      tags.push({ code:code, body:uncompressed.slice(offset, offset + length) });
      offset += length;
      if (code === 0) break;
    }
    return { tags:tags };
  }

  function swfSymbolClasses(tags) {
    var output = new Map();
    (tags || []).forEach(function(tag) {
      if (!tag || tag.code !== 76 || !Buffer.isBuffer(tag.body) || tag.body.length < 2) return;
      var count = tag.body.readUInt16LE(0);
      var offset = 2;
      for (var index = 0; index < count && offset + 2 <= tag.body.length; index++) {
        var id = tag.body.readUInt16LE(offset); offset += 2;
        var end = tag.body.indexOf(0, offset);
        if (end < 0) break;
        output.set(tag.body.slice(offset, end).toString('utf8'), id);
        offset = end + 1;
      }
    });
    return output;
  }

  function lowerText(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function sameText(left, right) {
    return lowerText(left) === lowerText(right);
  }

  function normalizedEventTrigger(trigger, clipName) {
    var action = lowerText(trigger && trigger.action);
    var frame = Number(trigger && trigger.frame);
    var clip = String(trigger && trigger.clip || '').trim();
    var label = String(trigger && trigger.label || '').trim();
    if (!action || !Number.isInteger(frame) || frame < 0 || !clip || !label) return null;
    if (lowerText(label) !== ('event_video_' + lowerText(clip))) return null;
    return {
      action:action,
      frame:frame,
      label:label,
      clip:clip,
    };
  }

  function eventTriggerKey(trigger) {
    return [
      lowerText(trigger && trigger.action),
      String(Number(trigger && trigger.frame)),
      lowerText(trigger && trigger.label),
      lowerText(trigger && trigger.clip),
    ].join('|');
  }

  function normalizeEmbeddedEventClip(item, index) {
    var slot = Number(item && item.slot);
    var clip = String(item && item.clip || '').trim();
    var width = Number(item && item.width);
    var height = Number(item && item.height);
    var frameRate = Number(item && item.frameRate);
    var frameCount = Number(item && item.frameCount);
    var durationSeconds = Number(item && item.durationSeconds);
    var nativeTimelineVersion = Number(item && item.nativeTimelineVersion);
    var fitPolicy = String(item && item.fitPolicy || '').trim();
    var triggers = Array.isArray(item && item.triggers) ? item.triggers : null;
    if (slot !== index || !clip || !Number.isInteger(width) || width <= 0 || (width & 1) !== 0 ||
        !Number.isInteger(height) || height <= 0 || (height & 1) !== 0 ||
        !Number.isFinite(frameRate) || frameRate <= 0 || !Number.isInteger(frameCount) || frameCount <= 0 ||
        !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
        nativeTimelineVersion !== NATIVE_VIDEO_TIMELINE_VERSION ||
        fitPolicy !== NATIVE_EVENT_VIDEO_FIT_POLICY || !triggers || !triggers.length) return null;
    var normalizedTriggers = [];
    for (var i = 0; i < triggers.length; i++) {
      var normalized = normalizedEventTrigger(triggers[i], clip);
      if (!normalized) return null;
      normalizedTriggers.push(normalized);
    }
    return {
      slot:slot,
      clip:clip,
      width:width,
      height:height,
      frameRate:frameRate,
      frameCount:frameCount,
      durationSeconds:durationSeconds,
      nativeTimelineVersion:nativeTimelineVersion,
      fitPolicy:fitPolicy,
      triggers:normalizedTriggers,
    };
  }

  function normalizeBuildEventClip(item, index) {
    var normalized = normalizeEmbeddedEventClip(item, index);
    var assetPath = String(item && item.assetPath || '').trim();
    var sourceBytes = Number(item && item.sourceBytes);
    var sourceSha256 = normalizedHash(item && item.sourceSha256);
    var nativeBytes = Number(item && item.nativeBytes);
    var nativeSha256 = normalizedHash(item && item.nativeSha256);
    var codec = String(item && item.codec || '').trim();
    var fitPolicy = String(item && item.fitPolicy || '').trim();
    var audioPolicy = String(item && item.audioPolicy || '').trim();
    var assetMatch = assetPath.replace(/\\/g,'/').match(
      /^Assets\/Game\/Videos\/(\d+)\/([A-Za-z0-9_-]+)\.(?:mp4|m4v)$/i);
    if (!normalized || !assetMatch || !sameText(assetMatch[2],normalized.clip) ||
        !Number.isInteger(sourceBytes) || sourceBytes <= 0 || !sourceSha256 ||
        !Number.isInteger(nativeBytes) || nativeBytes <= 0 || !nativeSha256 ||
        codec !== 'flv1' || fitPolicy !== NATIVE_EVENT_VIDEO_FIT_POLICY ||
        (audioPolicy !== 'stream-mp3-embedded' &&
         audioPolicy !== 'video-only-no-source-audio')) return null;
    return Object.assign({}, normalized, {
      assetPath:assetPath.replace(/\\/g,'/'),
      ownerId:parseId(assetMatch[1]),
      sourceBytes:sourceBytes,
      sourceSha256:sourceSha256,
      nativeBytes:nativeBytes,
      nativeSha256:nativeSha256,
      codec:codec,
      fitPolicy:fitPolicy,
      audioPolicy:audioPolicy,
    });
  }

  function normalizeEventVideoEvidence(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var clips = Array.isArray(value.clips) ? value.clips : null;
    var version = Number(value.version || 0);
    var embedded = value.embedded === true;
    var nativeTimelineVersion = Number(value.nativeTimelineVersion || 0);
    var conversionPolicy = String(value.conversionPolicy || '').trim();
    if (!clips || clips.length > 8 || embedded !== (clips.length > 0)) return null;
    if (clips.length > 0 && (version !== EVENT_VIDEO_BUILD_VERSION ||
        nativeTimelineVersion !== NATIVE_VIDEO_TIMELINE_VERSION ||
        conversionPolicy !== FTR_EVENT_VIDEO_CONVERSION_POLICY)) return null;
    if (!clips.length && (version !== 1 || nativeTimelineVersion !== 0 || conversionPolicy)) return null;
    var normalizedClips = [];
    for (var i = 0; i < clips.length; i++) {
      var clip = normalizeBuildEventClip(clips[i], i);
      if (!clip) return null;
      normalizedClips.push(clip);
    }
    return {
      embedded:embedded,
      version:version,
      nativeTimelineVersion:nativeTimelineVersion,
      conversionPolicy:conversionPolicy,
      clips:normalizedClips,
    };
  }

  function sameEventVideoClip(left, right) {
    if (!left || !right) return false;
    if (Number(left.slot) !== Number(right.slot) || !sameText(left.clip, right.clip) ||
        !sameText(left.assetPath, right.assetPath) ||
        Number(left.sourceBytes) !== Number(right.sourceBytes) ||
        normalizedHash(left.sourceSha256) !== normalizedHash(right.sourceSha256) ||
        Number(left.nativeBytes) !== Number(right.nativeBytes) ||
        normalizedHash(left.nativeSha256) !== normalizedHash(right.nativeSha256) ||
        Number(left.width) !== Number(right.width) ||
        Number(left.height) !== Number(right.height) ||
        Number(left.frameRate) !== Number(right.frameRate) ||
        Number(left.frameCount) !== Number(right.frameCount) ||
        Number(left.durationSeconds) !== Number(right.durationSeconds) ||
        Number(left.nativeTimelineVersion) !== Number(right.nativeTimelineVersion) ||
        String(left.codec || '') !== String(right.codec || '') ||
        String(left.fitPolicy || '') !== String(right.fitPolicy || '') ||
        String(left.audioPolicy || '') !== String(right.audioPolicy || '')) return false;
    if (left.triggers.length !== right.triggers.length) return false;
    for (var i = 0; i < left.triggers.length; i++) {
      if (eventTriggerKey(left.triggers[i]) !== eventTriggerKey(right.triggers[i])) return false;
    }
    return true;
  }

  function sameEventVideoEvidence(left, right) {
    if (!left || !right || left.embedded !== right.embedded ||
        Number(left.version) !== Number(right.version) ||
        Number(left.nativeTimelineVersion) !== Number(right.nativeTimelineVersion) ||
        String(left.conversionPolicy || '') !== String(right.conversionPolicy || '') ||
        left.clips.length !== right.clips.length) return false;
    for (var i = 0; i < left.clips.length; i++) {
      if (!sameEventVideoClip(left.clips[i], right.clips[i])) return false;
    }
    return true;
  }

  function inspectFightEventVideoClosure(fightFile, expected) {
    var eventVideos = expected || { embedded:false, version:1, conversionPolicy:'', clips:[] };
    if (!eventVideos.embedded && !eventVideos.clips.length) return { ok:true };
    var buffer;
    try { buffer = fs.readFileSync(fightFile); }
    catch(error) { return missing('uclient-event-video-fight-read-failed', { cause:String(error && error.message || error) }); }
    var parsed;
    try { parsed = readSwfTags(buffer); }
    catch(error) { return missing('uclient-event-video-fight-invalid', { stale:true, cause:String(error && error.message || error) }); }
    var symbols = swfSymbolClasses(parsed.tags);
    var manifestId = Number(symbols.get('pet_ManifestBytes') || 0);
    if (!manifestId) return missing('uclient-event-video-fight-manifest-missing', { stale:true });
    var binaries = new Map();
    (parsed.tags || []).forEach(function(tag) {
      if (!tag || tag.code !== 87 || !Buffer.isBuffer(tag.body) || tag.body.length < 6) return;
      binaries.set(tag.body.readUInt16LE(0), tag.body.slice(6));
    });
    var manifestBinary = binaries.get(manifestId);
    if (!manifestBinary || !manifestBinary.length) {
      return missing('uclient-event-video-fight-manifest-missing', { stale:true });
    }
    var manifest;
    try { manifest = JSON.parse(manifestBinary.toString('utf8')); }
    catch(error) {
      return missing('uclient-event-video-fight-manifest-invalid', {
        stale:true, cause:String(error && error.message || error),
      });
    }
    var manifestVideos = Array.isArray(manifest && manifest.eventVideos) ? manifest.eventVideos : [];
    if (manifestVideos.length !== eventVideos.clips.length) {
      return missing('uclient-event-video-fight-manifest-mismatch', { stale:true });
    }
    for (var i = 0; i < eventVideos.clips.length; i++) {
      var expectedClip = eventVideos.clips[i];
      var manifestClip = normalizeEmbeddedEventClip(manifestVideos[i], i);
      if (!manifestClip || Number(manifestClip.slot) !== Number(expectedClip.slot) ||
          !sameText(manifestClip.clip, expectedClip.clip) ||
          Number(manifestClip.width) !== Number(expectedClip.width) ||
          Number(manifestClip.height) !== Number(expectedClip.height) ||
          Number(manifestClip.frameRate) !== Number(expectedClip.frameRate) ||
          Number(manifestClip.frameCount) !== Number(expectedClip.frameCount) ||
          Number(manifestClip.durationSeconds) !== Number(expectedClip.durationSeconds) ||
          manifestClip.triggers.length !== expectedClip.triggers.length) {
        return missing('uclient-event-video-fight-manifest-mismatch', { stale:true });
      }
      for (var triggerIndex = 0; triggerIndex < expectedClip.triggers.length; triggerIndex++) {
        if (eventTriggerKey(manifestClip.triggers[triggerIndex]) !==
            eventTriggerKey(expectedClip.triggers[triggerIndex])) {
          return missing('uclient-event-video-fight-manifest-mismatch', { stale:true });
        }
      }
      var symbolId = Number(symbols.get('pet_EventVideo' + expectedClip.slot) || 0);
      var binary = symbolId ? binaries.get(symbolId) : null;
      if (!symbolId || !binary || !binary.length) {
        return missing('uclient-event-video-fight-native-missing', { stale:true });
      }
      var actualSha256 = crypto.createHash('sha256').update(binary).digest('hex').toUpperCase();
      if (binary.length !== Number(expectedClip.nativeBytes) ||
          actualSha256 !== normalizedHash(expectedClip.nativeSha256)) {
        return missing('uclient-event-video-fight-native-mismatch', { stale:true });
      }
    }
    return { ok:true };
  }

  function inspectBattleEventVideoClosure(primaryFile, build, conversion, sourceId) {
    var buildValue = build && build.eventVideos;
    var conversionValue = conversion && conversion.eventVideos;
    var buildEvidence = normalizeEventVideoEvidence(buildValue);
    var conversionEvidence = normalizeEventVideoEvidence(conversionValue);
    if (!buildEvidence || !conversionEvidence) {
      return missing('uclient-event-video-evidence-incomplete', {
        artifactLayer:'primary',
      });
    }
    if (!sameEventVideoEvidence(buildEvidence, conversionEvidence)) {
      return missing('uclient-event-video-build-mismatch', {
        artifactLayer:'primary', stale:true,
      });
    }
    if (buildEvidence.clips.some(function(clip) { return parseId(clip.ownerId) !== sourceId; })) {
      return missing('uclient-event-video-owner-mismatch', {
        artifactLayer:'primary', stale:true,
      });
    }
    var fightEvidence = inspectFightEventVideoClosure(primaryFile, buildEvidence);
    if (!fightEvidence.ok) {
      return missing(fightEvidence.reason, Object.assign({
        artifactLayer:'primary',
      }, fightEvidence.stale === true ? { stale:true } : {}, fightEvidence.cause ? { cause:fightEvidence.cause } : {}));
    }
    return { ok:true, eventVideos:buildEvidence };
  }

  function legacyPlayable(legacy) {
    var capabilities = legacy && legacy.capabilities || {};
    if (!legacy || legacy.available === false || legacy.staticPoseWrapper === true ||
        capabilities.staticPoseWrapper === true || capabilities.legacyPlayable === false) return false;
    return capabilities.legacyPlayable === true || capabilities.ok === true ||
      !!(legacy.playback && legacy.playback.verified === true);
  }

  function inspectBattleRoot(itemRoot, options) {
    options = options || {};
    var root = path.resolve(String(itemRoot || ''));
    var manifestResult = readJson(path.join(root, 'battle-variants.json'));
    if (!manifestResult.ok) return missing('battle-manifest-missing', {
      artifactLayer:'primary', manifest:manifestResult,
    });
    var manifest = manifestResult.value;
    var sourceId = parseId(options.sourceId);
    if (Number(manifest.version || 0) < 1 || !parseId(manifest.sourceId) ||
        (sourceId && parseId(manifest.sourceId) !== sourceId)) {
      return missing('battle-manifest-identity-mismatch', { artifactLayer:'primary', stale:true });
    }
    var selected = String(manifest.selectedBattleVariant || '');
    if (selected !== 'uclient-self-contained' && selected !== 'legacy-swf') {
      return missing('battle-variant-unselected', { artifactLayer:'primary' });
    }
    var primary = manifest.primary || {};
    var primaryFile = containedFile(root, primary.file);
    if (!primaryFile || Number(primary.bytes || 0) <= 0 || !normalizedHash(primary.sha256)) {
      return missing('primary-evidence-incomplete', { artifactLayer:'primary', selectedBattleVariant:selected });
    }
    var primaryResult = inspectFile(primaryFile, { bytes:primary.bytes, sha256:primary.sha256 });
    if (!primaryResult.ok) return missing('primary-' + primaryResult.reason, {
      artifactLayer:'primary', selectedBattleVariant:selected, primary:primaryResult, stale:primaryResult.stale === true,
    });

    var variants = manifest.variants || {};
    if (selected === 'uclient-self-contained') {
      var uClient = variants.uclient || {};
      var conversion = uClient.conversion || {};
      var buildResult = readJson(path.join(root, 'uclient-fight-build.json'));
      if (primary.selfContained !== true || uClient.complete !== true || conversion.ok !== true ||
          conversion.selfContained !== true || !buildResult.ok) {
        return missing('uclient-build-closure-incomplete', {
          artifactLayer:'primary', selectedBattleVariant:selected, build:buildResult,
        });
      }
      var conversionFile = containedFile(root, conversion.file);
      if (!conversionFile || path.resolve(conversionFile) !== path.resolve(primaryFile) ||
          !sameEvidence(primary, conversion)) {
        return missing('uclient-conversion-primary-mismatch', {
          artifactLayer:'primary', selectedBattleVariant:selected, stale:true,
        });
      }
      var build = buildResult.value;
      if (parseId(build.sourceId) !== parseId(manifest.sourceId) || !sameEvidence(primary, {
        bytes:build.bytes,
        sha256:build.fightSha256 || build.sha256,
      })) {
        return missing('uclient-build-manifest-mismatch', {
          artifactLayer:'primary', selectedBattleVariant:selected, stale:true,
        });
      }
      var policyClosure = inspectUClientBuildPolicy(build,conversion,parseId(manifest.sourceId));
      if (!policyClosure.ok) return missing(policyClosure.reason, {
        artifactLayer:'primary', selectedBattleVariant:selected, stale:policyClosure.stale === true,
        family:policyClosure.family,
      });
      var capabilities = uClient.capabilities || {};
      if (!(capabilities.standby && capabilities.physical && capabilities.special &&
            capabilities.property && capabilities.hurt)) {
        return missing('uclient-action-closure-incomplete', {
          artifactLayer:'primary', selectedBattleVariant:selected,
        });
      }
      if (policyClosure.family === 'ftr') {
        var eventVideoClosure = inspectBattleEventVideoClosure(
          primaryFile,build,conversion,parseId(manifest.sourceId));
        if (!eventVideoClosure.ok) return missing(eventVideoClosure.reason, {
          artifactLayer:'primary', selectedBattleVariant:selected, stale:eventVideoClosure.stale === true,
          cause:eventVideoClosure.cause,
        });
      }
      return Object.assign({}, primaryResult, {
        artifactLayer:'primary', buildLayer:'self-contained-conversion',
        selectedBattleVariant:selected, selfContained:true,
        manifestFile:manifestResult.file, buildFile:buildResult.file, manifest:manifest,
      });
    }

    var legacy = variants.legacySwf || {};
    if (!legacyPlayable(legacy)) {
      return missing(legacy && (legacy.staticPoseWrapper === true ||
        (legacy.capabilities && legacy.capabilities.staticPoseWrapper === true))
        ? 'legacy-static-shell' : 'legacy-playback-unverified', {
        artifactLayer:'primary', selectedBattleVariant:selected,
      });
    }
    var legacyFile = containedFile(root, legacy.file);
    if (!legacyFile || Number(legacy.bytes || 0) <= 0 || !normalizedHash(legacy.sha256)) {
      return missing('legacy-source-evidence-incomplete', {
        artifactLayer:'source-variant', selectedBattleVariant:selected,
      });
    }
    var legacyResult = inspectFile(legacyFile, { bytes:legacy.bytes, sha256:legacy.sha256 });
    if (!legacyResult.ok || !sameEvidence(primary, legacy)) {
      return missing(!legacyResult.ok ? 'legacy-source-' + legacyResult.reason : 'legacy-primary-mismatch', {
        artifactLayer:'source-variant', selectedBattleVariant:selected, stale:true,
      });
    }
    return Object.assign({}, primaryResult, {
      artifactLayer:'primary', buildLayer:'verified-legacy',
      selectedBattleVariant:selected, selfContained:false,
      manifestFile:manifestResult.file, manifest:manifest,
      sourceVariantFile:legacyResult.file,
    });
  }

  function inspectVideoSkillRoot(itemRoot, options) {
    options = options || {};
    var root = path.resolve(String(itemRoot || ''));
    var buildResult = readJson(path.join(root, 'uclient-video-build.json'));
    if (!buildResult.ok) return missing('video-build-manifest-missing', {
      artifactLayer:'primary', build:buildResult,
    });
    var build = buildResult.value;
    var sourceId = parseId(options.sourceId);
    if (Number(build.version || 0) < 1 || build.family !== 'video' || build.selfContained !== true ||
        !parseId(build.sourceId) || (sourceId && parseId(build.sourceId) !== sourceId) ||
        !String(build.assetPath || '').trim() || !/^[0-9a-f]{32}$/i.test(String(build.bundleFileHash || ''))) {
      return missing('video-build-evidence-incomplete', { artifactLayer:'primary' });
    }
    if (options.assetPath && String(options.assetPath).toLowerCase() !== String(build.assetPath).toLowerCase()) {
      return missing('video-asset-path-stale', { artifactLayer:'primary', stale:true });
    }
    if (options.bundleFileHash && String(options.bundleFileHash).toLowerCase() !== String(build.bundleFileHash).toLowerCase()) {
      return missing('video-bundle-stale', { artifactLayer:'primary', stale:true });
    }
    var fileResult = inspectFile(path.join(root, 'skill.swf'), {
      bytes:build.skillBytes,
      sha256:build.skillSha256,
    });
    if (!fileResult.ok) return missing('video-skill-' + fileResult.reason, {
      artifactLayer:'primary', stale:fileResult.stale === true,
    });
    return Object.assign({}, fileResult, {
      artifactLayer:'primary', buildLayer:'self-contained-video', selfContained:true,
      buildFile:buildResult.file, build:build,
    });
  }

  function inspectPreviewRoot(itemRoot, previewRoot, options) {
    options = options || {};
    var root = path.resolve(String(itemRoot || ''));
    var preview = path.resolve(String(previewRoot || ''));
    var metadataResult = readJson(path.join(preview, 'uclient-preview.json'));
    if (!metadataResult.ok) return missing('preview-metadata-missing', {
      artifactLayer:'preview-inventory', metadata:metadataResult,
    });
    var metadata = metadataResult.value;
    var sourceId = parseId(options.sourceId);
    if (sourceId && parseId(metadata.sourceId) && parseId(metadata.sourceId) !== sourceId) {
      return missing('preview-identity-mismatch', { artifactLayer:'preview-inventory', stale:true });
    }

    var battle = inspectBattleRoot(root, { sourceId:sourceId });
    if (battle.ok) return {
      ok:true,
      state:'ready',
      artifactLayer:'primary',
      previewMode:'flash-primary',
      flashReady:true,
      canvasReady:false,
      mainBuildReady:true,
      file:battle.file,
      bytes:battle.bytes,
      sha256:battle.sha256,
      selectedBattleVariant:battle.selectedBattleVariant,
      battle:battle,
      metadata:metadata,
    };

    // A preview-only Spine conversion may have a verified SWF but deliberately
    // no battle-variants.json.  It is playable in the preview window only and
    // must never be projected as a downloaded/runtime primary build.
    var previewBuild = metadata.flashBattleSwf || {};
    var previewFight = inspectFile(path.join(root, 'fight.swf'), {
      bytes:previewBuild.bytes,
      sha256:previewBuild.fightSha256 || previewBuild.sha256,
    });
    if (String(options.location || '') === 'preview-cache' && previewFight.ok &&
        Number(previewBuild.bytes || 0) > 0 && normalizedHash(previewBuild.fightSha256 || previewBuild.sha256)) {
      return {
        ok:true,
        state:'ready',
        artifactLayer:'preview-inventory',
        previewMode:'flash-preview-build',
        flashReady:true,
        canvasReady:false,
        mainBuildReady:false,
        file:previewFight.file,
        bytes:previewFight.bytes,
        sha256:previewFight.sha256,
        selectedBattleVariant:'',
        battle:battle,
        metadata:metadata,
      };
    }

    var animation = inspectFile(path.join(preview, 'uclient-animation.json.gz'));
    var atlasCandidates = ['uclient-atlas.webp', 'uclient-atlas.png'];
    var atlas = missing('preview-atlas-missing');
    for (var i = 0; i < atlasCandidates.length; i++) {
      var current = inspectFile(path.join(preview, atlasCandidates[i]));
      if (current.ok) { atlas = current; break; }
    }
    if (animation.ok && atlas.ok) {
      return {
        ok:true,
        state:'ready',
        artifactLayer:'preview-inventory',
        previewMode:'native-canvas-preview',
        flashReady:false,
        canvasReady:true,
        mainBuildReady:false,
        file:'',
        bytes:0,
        sha256:'',
        battle:battle,
        metadata:metadata,
        animationFile:animation.file,
        atlasFile:atlas.file,
      };
    }
    return missing('preview-payload-incomplete', {
      artifactLayer:'preview-inventory', battle:battle, animation:animation, atlas:atlas,
    });
  }

  function inspectDownloadRecord(record) {
    record = record || {};
    var type = String(record.type || '').toLowerCase();
    var sourceId = parseId(record.id || record.sourceId);
    var file = String(record.file || '').trim();
    var itemRoot = file ? path.dirname(path.resolve(file)) : String(record.itemRoot || '');
    if (type === 'fight' || type === 'uclient') {
      var battle = inspectBattleRoot(itemRoot, { sourceId:sourceId });
      if (!battle.ok) return battle;
      if (file && path.resolve(file) !== path.resolve(battle.file)) {
        return missing('record-primary-path-mismatch', { artifactLayer:'primary', stale:true });
      }
      return battle;
    }
    if (type === 'skill' && record.actionEvidence && record.actionEvidence.family === 'video') {
      return inspectVideoSkillRoot(itemRoot, {
        sourceId:sourceId,
        assetPath:record.actionEvidence.assetPath,
        bundleFileHash:record.actionEvidence.bundleFileHash,
      });
    }
    var fileResult = inspectFile(file, { bytes:record.bytes });
    if (!fileResult.ok) return fileResult;
    return Object.assign({}, fileResult, {
      artifactLayer:record.resourceRole === 'source-variant' ? 'source-variant' : 'primary',
      buildLayer:type === 'skill' ? 'verified-legacy-companion' : 'direct-resource',
    });
  }

  return {
    inspectFile:inspectFile,
    inspectBattleRoot:inspectBattleRoot,
    inspectVideoSkillRoot:inspectVideoSkillRoot,
    inspectPreviewRoot:inspectPreviewRoot,
    inspectDownloadRecord:inspectDownloadRecord,
    readJson:readJson,
    missing:missing,
  };
}

module.exports = { createResourceVariantIntegrity:createResourceVariantIntegrity };
