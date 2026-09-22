'use strict';

const skillTimelineOverlayContract = require('./uclient-skill-timeline-overlay');

// Version 17 restores the authored action-local display list while retaining
// every lossless atlas, download, conversion and residency fix from version 16.
const UClientFtr_FLASH_ASSET_VERSION = 17;
// Version 16 uses the proven resource-managed v13 renderer template.  Background
// and model quads remain siblings under the active action so battle hosts can
// apply their generic direct-Shape cover rule without a detached scene layer.
const UClientFtr_BATTLE_TEMPLATE_VERSION = 16;
const UClientFtr_BATTLE_TEMPLATE_SHA256 = 'BE4E8BA3E55884972E6A93959C7BAA807110394C4DFFC83D841BCE9FA4FBFA14';
const UClientFtr_FOLLOW_TEMPLATE_VERSION = 1;
const UCLIENT_SPINE_TEMPLATE_VERSION = 9;
const UCLIENT_VIDEO_TEMPLATE_VERSION = 1;
const UClientFtr_BATTLE_MODEL_SCALE_FACTOR = 1.22;
const UClientFtr_BATTLE_SCENE_UNIT_SCALE = 50;
const UClientFtr_BATTLE_MODEL_SCALE_POLICY = 'standby-fit-with-adaptive-large-model-no-floor-center-anchor-v4';
const MAX_FLASH_ATLAS_PAGES = 64;
const MAX_EVENT_VIDEO_CLIPS = 8;
const EVENT_VIDEO_BUILD_VERSION = 3;
const NATIVE_VIDEO_TIMELINE_VERSION = 4;
const NATIVE_EVENT_VIDEO_FIT_POLICY = 'authored-aspect-native-no-downscale';
const MAX_FLASH_ATLAS_EDGE = 4095;
const UClientFtr_FLASH_RESIDENCY_TARGET_PIXELS = 750000;
const UClientFtr_FLASH_QUALITY_POLICY = 'resource-local-lossless-source-pixels-v1';
const UClientFtr_FLASH_RESIDENCY_POLICY = 'cpu-model-frame-window-residency-v1';
const UClientFtr_FLASH_OUTPUT_SCALE = 1;
const UClientFtr_SCENE_ROUTE_POLICY = 'action-local-direct-shape-host-cover-v1';

function planUClientFtrLosslessAtlasPages(regions, options) {
  options = options || {};
  var maximumPages = Math.max(1, Number(options.maximumPages) || MAX_FLASH_ATLAS_PAGES);
  var maximumEdge = Math.max(1, Number(options.maximumEdge) || MAX_FLASH_ATLAS_EDGE);
  var padding = Math.max(0, Number(options.padding) || 0);
  var outputScale = Number(options.outputScale == null ? 1 : options.outputScale);
  var requestedFloorPixels = Math.max(1,
    Number(options.requestedPixels) || UClientFtr_FLASH_RESIDENCY_TARGET_PIXELS);
  if (!Array.isArray(regions) || !regions.length || !(outputScale > 0)) {
    throw new Error('UClientFtr lossless atlas planner input is invalid');
  }
  regions.forEach(function(region) {
    if (!region || !(Number(region.w) > 0) || !(Number(region.h) > 0) ||
        Number(region.w) + padding * 2 > maximumEdge ||
        Number(region.h) + padding * 2 > maximumEdge) {
      throw new Error('UClientFtr atlas region exceeds the lossless Flash bitmap boundary');
    }
  });

  var orderedRegions = regions.slice().sort(function(a, b) {
    return Number(a.firstUse) - Number(b.firstUse) ||
      Number(b.h) - Number(a.h) || Number(b.w) - Number(a.w) ||
      Number(a.index) - Number(b.index);
  });
  function regionPixels(region) {
    return (Number(region.w) + padding * 2) * (Number(region.h) + padding * 2);
  }
  function groupPixels(group) {
    return group.reduce(function(total, region) { return total + regionPixels(region); }, 0);
  }
  var paddedSourcePixels = groupPixels(orderedRegions);
  var requestedOutputPixels = Math.max(requestedFloorPixels,
    Math.ceil(paddedSourcePixels * outputScale * outputScale / maximumPages));
  var effectiveSourcePixels = requestedOutputPixels / (outputScale * outputScale);

  function layoutGroup(groupRegions) {
    var minimumWidth = groupRegions.reduce(function(value, region) {
      return Math.max(value, Number(region.w) + padding * 2);
    }, 1);
    var widthCandidates = [minimumWidth,1536,2048,2560,3072,3584,maximumEdge]
      .filter(function(value, index, all) {
        return value >= minimumWidth && value <= maximumEdge && all.indexOf(value) === index;
      }).sort(function(a, b) { return a - b; });
    var sorted = groupRegions.slice().sort(function(a, b) {
      return Number(b.h) - Number(a.h) || Number(b.w) - Number(a.w) ||
        Number(a.index) - Number(b.index);
    });
    for (var widthIndex = 0; widthIndex < widthCandidates.length; widthIndex++) {
      var limit = widthCandidates[widthIndex];
      var shelves = [];
      var nextY = 0;
      var usedWidth = 1;
      var usedHeight = 1;
      var placements = [];
      var valid = true;
      for (var regionIndex = 0; regionIndex < sorted.length; regionIndex++) {
        var region = sorted[regionIndex];
        var placed = false;
        for (var shelfIndex = 0; shelfIndex < shelves.length; shelfIndex++) {
          var shelf = shelves[shelfIndex];
          if (Number(region.h) <= shelf.h &&
              shelf.x + Number(region.w) + padding * 2 <= limit) {
            placements.push({ region:region, x:shelf.x + padding, y:shelf.y + padding });
            shelf.x += Number(region.w) + padding * 2;
            usedWidth = Math.max(usedWidth,shelf.x);
            usedHeight = Math.max(usedHeight,shelf.y + shelf.h);
            placed = true;
            break;
          }
        }
        if (placed) continue;
        if (nextY + Number(region.h) + padding * 2 > maximumEdge) {
          valid = false;
          break;
        }
        var nextShelf = {
          x:Number(region.w) + padding * 2,
          y:nextY,
          h:Number(region.h) + padding * 2,
        };
        shelves.push(nextShelf);
        placements.push({ region:region, x:padding, y:nextY + padding });
        nextY += nextShelf.h;
        usedWidth = Math.max(usedWidth,nextShelf.x);
        usedHeight = Math.max(usedHeight,nextY);
      }
      if (valid) return { usedWidth:usedWidth, usedHeight:usedHeight, placements:placements };
    }
    return null;
  }

  function buildTemporalGroups(capacity) {
    var result = [];
    var group = [];
    var pixels = 0;
    orderedRegions.forEach(function(region) {
      var nextPixels = regionPixels(region);
      if (group.length && pixels + nextPixels > capacity) {
        result.push(group);
        group = [];
        pixels = 0;
      }
      group.push(region);
      pixels += nextPixels;
    });
    if (group.length) result.push(group);
    return result;
  }

  var maximumResidencyBudget = Math.max(effectiveSourcePixels,paddedSourcePixels);
  var groups = buildTemporalGroups(effectiveSourcePixels);
  while (groups.length > maximumPages && effectiveSourcePixels < maximumResidencyBudget) {
    effectiveSourcePixels = Math.min(maximumResidencyBudget,
      Math.max(effectiveSourcePixels + 1,Math.ceil(effectiveSourcePixels * 1.5)));
    groups = buildTemporalGroups(effectiveSourcePixels);
  }
  var layouts = groups.map(layoutGroup);
  var strategy = 'temporal-first-use-adaptive';

  if (groups.length > maximumPages || layouts.some(function(layout) { return !layout; })) {
    // The temporal budget is a locality preference, not a validity boundary.
    // Use the same height-first shelf proof as the global capacity check to
    // produce concrete groups whenever a temporal group is spatially awkward.
    // No source pixels are rescaled or dropped.
    var globalPages = [];
    var spatialRegions = regions.slice().sort(function(a, b) {
      return Number(b.h) - Number(a.h) || Number(b.w) - Number(a.w) ||
        Number(a.index) - Number(b.index);
    });
    function placeOnGlobalPage(page, region) {
      for (var shelfIndex = 0; shelfIndex < page.shelves.length; shelfIndex++) {
        var shelf = page.shelves[shelfIndex];
        if (Number(region.h) <= shelf.h &&
            shelf.x + Number(region.w) + padding * 2 <= maximumEdge) {
          shelf.x += Number(region.w) + padding * 2;
          page.regions.push(region);
          return true;
        }
      }
      if (page.nextY + Number(region.h) + padding * 2 > maximumEdge) return false;
      page.shelves.push({
        x:Number(region.w) + padding * 2,
        y:page.nextY,
        h:Number(region.h) + padding * 2,
      });
      page.nextY += Number(region.h) + padding * 2;
      page.regions.push(region);
      return true;
    }
    for (var spatialIndex = 0; spatialIndex < spatialRegions.length; spatialIndex++) {
      var spatialRegion = spatialRegions[spatialIndex];
      var globallyPlaced = globalPages.some(function(page) {
        return placeOnGlobalPage(page,spatialRegion);
      });
      if (globallyPlaced) continue;
      if (globalPages.length >= maximumPages) {
        throw new Error('UClientFtr atlas cannot fit source pixels losslessly within ' +
          maximumPages + ' Flash pages');
      }
      var globalPage = { shelves:[], nextY:0, regions:[] };
      globalPages.push(globalPage);
      if (!placeOnGlobalPage(globalPage,spatialRegion)) {
        throw new Error('UClientFtr atlas region cannot fit a lossless Flash bitmap');
      }
    }
    groups = globalPages.map(function(page) { return page.regions; });
    layouts = groups.map(layoutGroup);
    if (!groups.length || groups.length > maximumPages ||
        layouts.some(function(layout) { return !layout; })) {
      throw new Error('UClientFtr global lossless atlas fallback did not reproduce its capacity proof');
    }
    effectiveSourcePixels = Math.max(requestedOutputPixels / (outputScale * outputScale),
      groups.reduce(function(value, group) { return Math.max(value,groupPixels(group)); }, 0));
    strategy = 'global-height-shelf-lossless-fallback';
  }

  return {
    groups:groups,
    layouts:layouts,
    requestedPixels:requestedOutputPixels,
    effectivePixels:Math.ceil(effectiveSourcePixels * outputScale * outputScale),
    strategy:strategy,
  };
}

function computeVisibleSequenceBounds(sequence, regions) {
  if (!sequence || !Array.isArray(sequence.frames) || !sequence.frames.length) {
    return sequence ? sequence.bounds : null;
  }
  var transientRegions = new Set();
  sequence.frames.forEach(function(f) {
    if (f && Array.isArray(f.o) && Array.isArray(f.r)) {
      for (var q = 0; q < f.o.length; q++) {
        if (f.o[q] <= 5 && q < f.r.length) {
          transientRegions.add(f.r[q]);
        }
      }
    }
  });

  function scan(filterTransient) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var found = false;
    for (var f = 0; f < sequence.frames.length; f++) {
      var frame = sequence.frames[f];
      var v = frame.v;
      var r = frame.r;
      var o = frame.o;
      if (!v || !r) continue;
      var quadCount = Math.floor(v.length / 8);
      for (var q = 0; q < quadCount; q++) {
        if (o && o[q] !== undefined && o[q] <= 5) continue;
        var regIdx = r[q];
        if (filterTransient && transientRegions.has(regIdx)) continue;
        var region = Array.isArray(regions) ? regions[regIdx] : null;
        if (region && region.w <= 2 && region.h <= 2) continue;

        for (var k = 0; k < 4; k++) {
          var vx = v[q * 8 + k * 2];
          var vy = v[q * 8 + k * 2 + 1];
          if (Number.isFinite(vx) && Number.isFinite(vy)) {
            if (vx < minX) minX = vx;
            if (vx > maxX) maxX = vx;
            if (vy < minY) minY = vy;
            if (vy > maxY) maxY = vy;
            found = true;
          }
        }
      }
    }
    return found ? [minX, minY, maxX, maxY] : null;
  }

  var scanTransientFiltered = scan(true);
  var scanFullVisible = scan(false);
  var visible = scanTransientFiltered;
  if (scanFullVisible) {
    if (!scanTransientFiltered) {
      visible = scanFullVisible;
    } else {
      var fullWidth = scanFullVisible[2] - scanFullVisible[0];
      var filteredWidth = scanTransientFiltered[2] - scanTransientFiltered[0];
      if (fullWidth > 0.001 && (filteredWidth / fullWidth) < 0.75) {
        visible = scanFullVisible;
      }
    }
  }
  if (!visible) return sequence.bounds;

  var minX = visible[0], minY = visible[1], maxX = visible[2], maxY = visible[3];
  var orig = sequence.bounds;
  if (Array.isArray(orig) && orig.length === 4) {
    var o0 = Number(orig[0]);
    var o1 = Number(orig[1]);
    var o2 = Number(orig[2]);
    var o3 = Number(orig[3]);
    if (Number.isFinite(o0) && Number.isFinite(o1) && Number.isFinite(o2) && Number.isFinite(o3)) {
      if (minY - o1 > 0.2 || o3 - maxY > 0.2 || minX - o0 > 0.2 || o2 - maxX > 0.2) {
        return [minX, minY, maxX, maxY];
      }
      return orig;
    }
  }
  return [minX, minY, maxX, maxY];
}

function computeUClientFtrBattleModelScale(standbyBounds) {
  if (!Array.isArray(standbyBounds) || standbyBounds.length < 4) {
    throw new Error('UClientFtr standby bounds are invalid');
  }
  var standbyWidth = Math.max(.001, Number(standbyBounds[2]) - Number(standbyBounds[0]));
  var standbyHeight = Math.max(.001, Number(standbyBounds[3]) - Number(standbyBounds[1]));
  if (!Number.isFinite(standbyWidth) || !Number.isFinite(standbyHeight)) {
    throw new Error('UClientFtr standby bounds are not finite');
  }
  var fittedUnitScale = Math.min(64, 340 / standbyWidth, 360 / standbyHeight);
  // Very large authored bounds produce a fitted scene unit below the normal
  // 50-unit floor.  Applying that floor again enlarges the model and makes the
  // initial battle body cover UI controls.  Preserve the floor for regular and
  // compact models, but let oversized geometry use its fitted unit scale so the
  // visual remains inside the common battle viewport.  This is structural and
  // does not inspect resource IDs, hashes, or source kind beyond the measured
  // standby bounds.
  var selectedUnitScale = fittedUnitScale;
  var fittedModelScale = fittedUnitScale * UClientFtr_BATTLE_MODEL_SCALE_FACTOR;
  var modelScale = selectedUnitScale * UClientFtr_BATTLE_MODEL_SCALE_FACTOR;
  var scaleFloorDelta = Math.max(0, modelScale - fittedModelScale);
  // The renderer measures vertices from the standby bottom edge.  When the
  // scene floor enlarges an effect-heavy model, keeping that bottom edge fixed
  // moves the whole visual upward.  Compensate inside the generated SWF so all
  // hosts (battle UIs and in-game previews) retain the fitted visual centre.
  var anchorOffsetY = scaleFloorDelta * standbyHeight / 2;
  return {
    policy:UClientFtr_BATTLE_MODEL_SCALE_POLICY,
    standbyWidth:standbyWidth,
    standbyHeight:standbyHeight,
    fittedUnitScale:fittedUnitScale,
    fittedModelScale:fittedModelScale,
    sceneUnitScale:UClientFtr_BATTLE_SCENE_UNIT_SCALE,
    selectedUnitScale:selectedUnitScale,
    modelScale:modelScale,
    scaleFloorDelta:scaleFloorDelta,
    anchorOffsetY:anchorOffsetY,
  };
}

function createUClientFtrFlashPipeline(dependencies) {
  var fs = dependencies.fs;
  var path = dependencies.path;
  var zlib = dependencies.zlib;
  var crypto = dependencies.crypto;
  var app = dependencies.app;
  var processRef = dependencies.process;
  var spawn = dependencies.spawn;
  var uClientFtrNativeConverter = dependencies.uClientFtrNativeConverter ||
    dependencies.uClientFtrX86Converter;
  var parseId = dependencies.parseId;
  var writeAtomic = dependencies.writeAtomic;
  var customSkinsFile = dependencies.customSkinsFile;
  var getCustomSkinsFile = dependencies.getCustomSkinsFile;
  var moduleDirectory = dependencies.moduleDirectory;
  var resourceAdapter = dependencies.resourceAdapter;
  var skillTimelineOverlay = skillTimelineOverlayContract.createUClientSkillTimelineOverlay({
    fs:fs,path:path,crypto:crypto,moduleDirectory:moduleDirectory,
    resourceAdapter:dependencies.resourceAdapter,writeAtomic:writeAtomic,
  });

  function resolveCustomSkinsFile() {
    var file = typeof getCustomSkinsFile === 'function'
      ? getCustomSkinsFile()
      : customSkinsFile;
    if (typeof file !== 'string' || !file.trim()) {
      throw new Error('custom skin registry path is not initialized');
    }
    return path.resolve(file);
  }

  function resolveUClientFtrNativeAtlasConverter() {
    var architecture = processRef.arch === 'x64' ? 'x64' : 'x86';
    var name = 'Seer2UClientFtrAtlasConverter-' + architecture + '.exe';
    var environmentName = architecture === 'x64'
      ? 'SEER_UCLIENT_FTR_X64_ATLAS_CONVERTER'
      : 'SEER_UCLIENT_FTR_X86_ATLAS_CONVERTER';
    var candidates = [];
    if (processRef.env[environmentName]) {
      candidates.push(processRef.env[environmentName]);
    }
    if (app.isPackaged) {
      candidates.push(path.join(processRef.resourcesPath, 'app.asar.unpacked', name));
      candidates.push(path.join(processRef.resourcesPath, name));
    }
    candidates.push(path.join(moduleDirectory.replace(/app\.asar([\\/]|$)/i, 'app.asar.unpacked$1'), name));
    candidates.push(path.join(moduleDirectory, name));
    candidates.push(path.join(moduleDirectory, 'uclient-ftr-x86-converter', 'build', name));
    var executable = candidates.map(function(file) { return path.resolve(file); }).find(function(file) {
      try { return fs.existsSync(file); } catch(_) { return false; }
    }) || '';
    return { architecture:architecture, executable:executable };
  }

  async function renderUClientFtrPetFlashAtlasPages(payload) {
    if (Number(payload && payload.outputScale == null ? 1 : payload && payload.outputScale) !==
        UClientFtr_FLASH_OUTPUT_SCALE) {
      throw new Error('UClientFtr lossless atlas conversion requires outputScale=1');
    }
    var nativeConverter = resolveUClientFtrNativeAtlasConverter();
    if (!nativeConverter.executable) {
      throw new Error(nativeConverter.architecture +
        ' UClientFtr atlas converter is missing; high-memory Chromium fallback is disabled');
    }
    return uClientFtrNativeConverter.convert(Object.assign({}, payload, {
      executable:nativeConverter.executable,
      expectedArchitecture:nativeConverter.architecture,
      tileEdge:1024,
      outputScale:UClientFtr_FLASH_OUTPUT_SCALE,
      timeoutMilliseconds:600000,
    }));
  }

  function readSwfTags(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('UClientFtr battle SWF template is invalid');
    var signature = buffer.slice(0, 3).toString('ascii');
    var body;
    if (signature === 'CWS') body = zlib.inflateSync(buffer.slice(8));
    else if (signature === 'FWS') body = buffer.slice(8);
    else throw new Error('UClientFtr battle SWF template compression is unsupported');
    var uncompressed = Buffer.concat([Buffer.from('FWS'), buffer.slice(3, 8), body]);
    var rectBits = uncompressed[8] >>> 3;
    var tagsOffset = 8 + Math.ceil((5 + rectBits * 4) / 8) + 4;
    var tags = [];
    var offset = tagsOffset;
    while (offset + 2 <= uncompressed.length) {
      var header = uncompressed.readUInt16LE(offset); offset += 2;
      var code = header >>> 6;
      var length = header & 63;
      if (length === 63) { length = uncompressed.readUInt32LE(offset); offset += 4; }
      if (offset + length > uncompressed.length) throw new Error('UClientFtr battle SWF template tag is truncated');
      tags.push({ code:code, body:uncompressed.slice(offset, offset + length) });
      offset += length;
      if (code === 0) break;
    }
    return { version:buffer[3], prefix:uncompressed.slice(0, tagsOffset), tags:tags };
  }

  function encodeSwfTag(code, body) {
    var long = body.length >= 63;
    var header = Buffer.alloc(long ? 6 : 2);
    header.writeUInt16LE((code << 6) | (long ? 63 : body.length), 0);
    if (long) header.writeUInt32LE(body.length, 2);
    return Buffer.concat([header, body]);
  }

  function encodeSwfU32(value) {
    value = Number(value) >>> 0;
    var bytes = [];
    do {
      var next = value & 127;
      value >>>= 7;
      if (value) next |= 128;
      bytes.push(next);
    } while (value);
    return Buffer.from(bytes);
  }

  function followDirectionLabelTag() {
    var labels = ['down','leftdown','left','leftup','up','rightup','right','rightdown'];
    var parts = [encodeSwfU32(0), encodeSwfU32(labels.length)];
    labels.forEach(function(label) {
      // These labels are an explicit legacy normal.swf contract.  Every label
      // selects the same official U FollowPackage await sequence at runtime;
      // no synthetic directional animation is introduced.
      parts.push(encodeSwfU32(0), Buffer.from(label + '\0','utf8'));
    });
    return encodeSwfTag(86, Buffer.concat(parts));
  }

  function swfSymbolClasses(tags) {
    var output = new Map();
    tags.forEach(function(tag) {
      if (tag.code !== 76 || tag.body.length < 2) return;
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

  function authoredEventVideoTriggers(manifest) {
    var output = [];
    var seen = new Set();
    var sequences = manifest && Array.isArray(manifest.sequences) ? manifest.sequences : [];
    sequences.forEach(function(sequence) {
      var action = String(sequence && sequence.name || '').toLowerCase();
      var frames = sequence && Array.isArray(sequence.frames) ? sequence.frames : [];
      frames.forEach(function(frame, frameIndex) {
        var labels = frame && Array.isArray(frame.l) ? frame.l : [];
        labels.forEach(function(value) {
          var label = String(value || '');
          var match = label.match(/^event_video_([A-Za-z0-9][A-Za-z0-9_-]*)$/i);
          if (!match) return;
          var trigger = {
            action:action,
            frame:frameIndex,
            label:label,
            clip:String(match[1]),
          };
          var key = [trigger.action, trigger.frame, trigger.label.toLowerCase(),
            trigger.clip.toLowerCase()].join('|');
          if (!seen.has(key)) {
            seen.add(key);
            output.push(trigger);
          }
        });
      });
    });
    return output;
  }

  function assertEventVideoTriggerClosure(manifest, eventClips) {
    var authored = authoredEventVideoTriggers(manifest);
    var embedded = [];
    (eventClips || []).forEach(function(clip) {
      var clipName = String(clip && clip.clip || '');
      var triggers = clip && Array.isArray(clip.triggers) ? clip.triggers : [];
      if (!clipName || !triggers.length) {
        throw new Error('UClientFtr embedded event video has no authored trigger');
      }
      triggers.forEach(function(trigger) {
        var normalized = {
          action:String(trigger && trigger.action || '').toLowerCase(),
          frame:Number(trigger && trigger.frame),
          label:String(trigger && trigger.label || ''),
          clip:String(trigger && trigger.clip || clipName),
        };
        if (!normalized.action || !Number.isInteger(normalized.frame) || normalized.frame < 0 ||
            normalized.clip.toLowerCase() !== clipName.toLowerCase() ||
            normalized.label.toLowerCase() !== ('event_video_' + clipName).toLowerCase()) {
          throw new Error('UClientFtr embedded event video trigger evidence is invalid');
        }
        embedded.push(normalized);
      });
    });
    function keyOf(trigger) {
      return [trigger.action, trigger.frame, trigger.label.toLowerCase(),
        trigger.clip.toLowerCase()].join('|');
    }
    var authoredKeys = Array.from(new Set(authored.map(keyOf))).sort();
    var embeddedKeys = Array.from(new Set(embedded.map(keyOf))).sort();
    if (authoredKeys.length !== embeddedKeys.length ||
        authoredKeys.some(function(value,index) { return value !== embeddedKeys[index]; })) {
      throw new Error('UClientFtr event_video authored/embedded trigger closure is incomplete');
    }
    return authored;
  }

  async function buildUClientFtrPetSwf(previewRoot, sourceId, options) {
    options = options || {};
    var artifactRole = options.artifactRole === 'follow' ? 'follow' : 'battle';
    var templateLeaf = artifactRole === 'follow'
      ? 'uclient-ftr-follow-template.swf' : 'uclient-ftr-battle-template.swf';
    var targetLeaf = artifactRole === 'follow' ? 'normal.swf' : 'fight.swf';
    var buildLeaf = artifactRole === 'follow' ? 'uclient-follow-build.json' : 'uclient-fight-build.json';
    var templateVersion = artifactRole === 'follow'
      ? UClientFtr_FOLLOW_TEMPLATE_VERSION : UClientFtr_BATTLE_TEMPLATE_VERSION;
    var templateFile = path.join(moduleDirectory, templateLeaf);
    var manifestFile = path.join(previewRoot, 'flash-animation.json');
    var markerFile = path.join(previewRoot, 'flash-assets.json');
    var target = path.join(path.dirname(previewRoot), targetLeaf);
    var templateBuffer = await fs.promises.readFile(templateFile);
    var templateSha256 = crypto.createHash('sha256').update(templateBuffer).digest('hex').toUpperCase();
    if (artifactRole === 'battle' && templateSha256 !== UClientFtr_BATTLE_TEMPLATE_SHA256) {
      throw new Error('UClientFtr battle template does not match the direct-Shape display-tree contract');
    }
    var template = readSwfTags(templateBuffer);
    var symbols = swfSymbolClasses(template.tags);
    var manifestId = symbols.get('pet_ManifestBytes');
    var marker = JSON.parse(await fs.promises.readFile(markerFile, 'utf8'));
    var pages = Array.isArray(marker.pages) ? marker.pages : [];
    if (!manifestId || !pages.length || pages.length > MAX_FLASH_ATLAS_PAGES) {
      throw new Error('UClientFtr ' + artifactRole + ' SWF template capacity is invalid');
    }
    if (Number(marker.version) !== UClientFtr_FLASH_ASSET_VERSION ||
        Number(marker.outputScale) !== UClientFtr_FLASH_OUTPUT_SCALE ||
        String(marker.qualityPolicy || '') !== UClientFtr_FLASH_QUALITY_POLICY ||
        String(marker.residencyPolicy || '') !== UClientFtr_FLASH_RESIDENCY_POLICY) {
      throw new Error('UClientFtr ' + artifactRole + ' atlas marker is stale or not lossless');
    }
    var replacements = new Map();
    var manifestDocument = JSON.parse(await fs.promises.readFile(manifestFile,'utf8'));
    if (Array.isArray(manifestDocument.sequences) && Array.isArray(manifestDocument.regions)) {
      var boundsUpdated = false;
      manifestDocument.sequences.forEach(function(sequence) {
        var newBounds = computeVisibleSequenceBounds(sequence, manifestDocument.regions);
        if (newBounds !== sequence.bounds) {
          sequence.bounds = newBounds;
          boundsUpdated = true;
        }
      });
      if (boundsUpdated) {
        var standbySeq = manifestDocument.sequences.find(function(s) { return s.name === 'standby'; }) || manifestDocument.sequences[0];
        if (standbySeq && Array.isArray(standbySeq.bounds)) {
          var recomputed = computeUClientFtrBattleModelScale(standbySeq.bounds);
          manifestDocument.modelScale = recomputed.modelScale;
          manifestDocument.anchorOffsetY = recomputed.anchorOffsetY;
        }
        try {
          await writeAtomic(manifestFile, Buffer.from(JSON.stringify(manifestDocument), 'utf8'));
        } catch(_) {}
      }
    }
    var eventVideoBuild = {
      version:1,ownerId:parseId(sourceId),converted:true,clips:[],triggers:[],requiredResourceCount:0,
    };
    if (artifactRole === 'battle') {
      try {
        eventVideoBuild = JSON.parse(await fs.promises.readFile(
          path.join(previewRoot,'uclient-event-videos.json'),'utf8'));
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      var eventClips = Array.isArray(eventVideoBuild.clips) ? eventVideoBuild.clips : [];
      if (eventVideoBuild.converted !== true || Number(eventVideoBuild.ownerId) !== parseId(sourceId) ||
          (eventClips.length > 0 && Number(eventVideoBuild.version) !== EVENT_VIDEO_BUILD_VERSION) ||
          (eventClips.length > 0 && Number(eventVideoBuild.nativeTimelineVersion) !== NATIVE_VIDEO_TIMELINE_VERSION) ||
          eventClips.length > MAX_EVENT_VIDEO_CLIPS ||
          Number(eventVideoBuild.requiredResourceCount || 0) !== eventClips.length) {
        throw new Error('UClientFtr embedded event video build closure is invalid');
      }
      assertEventVideoTriggerClosure(manifestDocument,eventClips);
      var aggregateEventBytes = 0;
      for (var eventIndex = 0; eventIndex < eventClips.length; eventIndex++) {
        var eventClip = eventClips[eventIndex] || {};
        var eventSlot = Number(eventClip.slot);
        var eventSymbolId = symbols.get('pet_EventVideo' + eventSlot);
        var eventFileName = String(eventClip.nativeFile || '');
        var eventWidth = Number(eventClip.width);
        var eventHeight = Number(eventClip.height);
        if (eventSlot !== eventIndex || !eventSymbolId ||
            !/^event-video-slot-[0-7]\.swf$/i.test(eventFileName) ||
            Number(eventClip.nativeTimelineVersion) !== NATIVE_VIDEO_TIMELINE_VERSION ||
            String(eventClip.fitPolicy || '') !== NATIVE_EVENT_VIDEO_FIT_POLICY ||
            !Number.isInteger(eventWidth) || eventWidth <= 0 || (eventWidth & 1) !== 0 ||
            !Number.isInteger(eventHeight) || eventHeight <= 0 || (eventHeight & 1) !== 0) {
          throw new Error('UClientFtr embedded event video slot is invalid');
        }
        var eventBytes = await fs.promises.readFile(path.join(previewRoot,eventFileName));
        var eventSha = crypto.createHash('sha256').update(eventBytes).digest('hex').toUpperCase();
        aggregateEventBytes += eventBytes.length;
        if (eventBytes.length !== Number(eventClip.nativeBytes || 0) ||
            eventSha !== String(eventClip.nativeSha256 || '').toUpperCase() ||
            aggregateEventBytes > 128 * 1024 * 1024) {
          throw new Error('UClientFtr embedded event video bytes do not match conversion evidence');
        }
        replacements.set(eventSymbolId,binaryDataTag(eventSymbolId,eventBytes));
      }
      manifestDocument.eventVideos = eventClips.map(function(item) {
        return {
          slot:Number(item.slot),clip:String(item.clip || ''),
          nativeTimelineVersion:Number(item.nativeTimelineVersion || 0),
          fitPolicy:String(item.fitPolicy || ''),
          width:Number(item.width),height:Number(item.height),
          frameRate:Number(item.frameRate),frameCount:Number(item.frameCount),
          durationSeconds:Number(item.durationSeconds),
          triggers:Array.isArray(item.triggers) ? item.triggers.map(function(trigger) {
            return { action:String(trigger.action || '').toLowerCase(),frame:Number(trigger.frame),
              label:String(trigger.label || ''),clip:String(trigger.clip || '') };
          }) : [],
        };
      });
    } else {
      manifestDocument.eventVideos = [];
    }
    var manifest = Buffer.from(JSON.stringify(manifestDocument),'utf8');
    var binaryBody = Buffer.allocUnsafe(6 + manifest.length);
    binaryBody.writeUInt16LE(manifestId, 0);
    binaryBody.writeUInt32LE(0, 2);
    manifest.copy(binaryBody, 6);
    replacements.set(manifestId, { code:87, body:binaryBody });
    for (var pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      var page = pages[pageIndex];
      var bitmapId = symbols.get('pet_Atlas' + pageIndex);
      var width = Number(page.width) | 0;
      var height = Number(page.height) | 0;
      if (!bitmapId || width < 1 || height < 1 || width > MAX_FLASH_ATLAS_EDGE ||
          height > MAX_FLASH_ATLAS_EDGE || !page.losslessFile) {
        throw new Error('UClientFtr ' + artifactRole + ' atlas page ' + pageIndex + ' is invalid');
      }
      var compressedPixels = await fs.promises.readFile(path.join(previewRoot, page.losslessFile));
      var bitmapBody = Buffer.allocUnsafe(7 + compressedPixels.length);
      bitmapBody.writeUInt16LE(bitmapId, 0);
      bitmapBody[2] = 5;
      bitmapBody.writeUInt16LE(width, 3);
      bitmapBody.writeUInt16LE(height, 5);
      compressedPixels.copy(bitmapBody, 7);
      replacements.set(bitmapId, { code:36, body:bitmapBody });
    }
    var encodedTags = template.tags.map(function(tag) {
      var id = tag.body.length >= 2 ? tag.body.readUInt16LE(0) : 0;
      var replacement = (tag.code === 36 || tag.code === 87) ? replacements.get(id) : null;
      return encodeSwfTag(replacement ? replacement.code : tag.code, replacement ? replacement.body : tag.body);
    });
    if (artifactRole === 'follow') {
      var endIndex = template.tags.findIndex(function(tag) { return tag.code === 0; });
      encodedTags.splice(endIndex < 0 ? encodedTags.length : endIndex, 0, followDirectionLabelTag());
    }
    var uncompressed = Buffer.concat([template.prefix].concat(encodedTags));
    uncompressed.write('FWS', 0, 3, 'ascii');
    uncompressed.writeUInt32LE(uncompressed.length, 4);
    var header = Buffer.alloc(8);
    header.write('CWS', 0, 3, 'ascii');
    header[3] = template.version;
    header.writeUInt32LE(uncompressed.length, 4);
    var output = Buffer.concat([header, zlib.deflateSync(uncompressed.slice(8), { level:1 })]);
    await writeAtomic(target, output);
    var outputSha256 = crypto.createHash('sha256').update(output).digest('hex').toUpperCase();
    var buildRecord = {
      version:templateVersion,
      sourceId:parseId(sourceId),
      artifactRole:artifactRole,
      templateSha256:templateSha256,
      fightSha256:outputSha256,
      bytes:output.length,
      rendererPolicy:'resource-local-quality-model-residency',
      assetVersion:UClientFtr_FLASH_ASSET_VERSION,
      qualityPolicy:UClientFtr_FLASH_QUALITY_POLICY,
      residencyPolicy:UClientFtr_FLASH_RESIDENCY_POLICY,
      sceneRoutePolicy:UClientFtr_SCENE_ROUTE_POLICY,
      outputScale:UClientFtr_FLASH_OUTPUT_SCALE,
      pages:pages.length,
      residencyPlan:marker.residencyPlan || null,
      eventVideos:artifactRole === 'battle' ? {
        embedded:Array.isArray(eventVideoBuild.clips) && eventVideoBuild.clips.length > 0,
        version:Number(eventVideoBuild.version || 0),
        nativeTimelineVersion:Number(eventVideoBuild.nativeTimelineVersion || 0),
        conversionPolicy:String(eventVideoBuild.conversionPolicy || ''),
        clips:(eventVideoBuild.clips || []).map(function(item) {
          return {
            slot:Number(item.slot),clip:String(item.clip || ''),assetPath:String(item.assetPath || ''),
            sourceBytes:Number(item.sourceBytes || 0),sourceSha256:String(item.sourceSha256 || ''),
            nativeBytes:Number(item.nativeBytes || 0),nativeSha256:String(item.nativeSha256 || ''),
            width:Number(item.width || 0),height:Number(item.height || 0),
            frameRate:Number(item.frameRate || 0),frameCount:Number(item.frameCount || 0),
            durationSeconds:Number(item.durationSeconds || 0),codec:String(item.codec || ''),
            nativeTimelineVersion:Number(item.nativeTimelineVersion || 0),
            fitPolicy:String(item.fitPolicy || ''),audioPolicy:String(item.audioPolicy || ''),
            triggers:Array.isArray(item.triggers) ? item.triggers : [],
          };
        }),
      } : { embedded:false,clips:[] },
    };
    await writeAtomic(path.join(path.dirname(previewRoot), buildLeaf),
      Buffer.from(JSON.stringify(buildRecord, null, 2), 'utf8'));
    // A forced rebuild can change the self-contained SWF without repeating the
    // download/selection phase.  Keep the resource-variant evidence aligned
    // with the bytes that will actually be imported and played.
    var variantManifestFile = path.join(path.dirname(previewRoot), 'battle-variants.json');
    try {
      if (artifactRole === 'battle' && fs.existsSync(variantManifestFile)) {
        var variantManifest = JSON.parse(await fs.promises.readFile(variantManifestFile, 'utf8'));
        variantManifest.updatedAt = new Date().toISOString();
        variantManifest.primary = Object.assign({}, variantManifest.primary || {}, {
          file:'fight.swf', bytes:output.length, sha256:outputSha256, selfContained:true,
        });
        variantManifest.variants = variantManifest.variants || {};
        variantManifest.variants.uclient = variantManifest.variants.uclient || {};
        variantManifest.variants.uclient.conversion = Object.assign(
          {}, variantManifest.variants.uclient.conversion || {}, {
            ok:true,
            selfContained:true,
            file:'fight.swf',
            version:buildRecord.version,
            sourceId:buildRecord.sourceId,
            bytes:output.length,
            sha256:outputSha256,
            fightSha256:outputSha256,
            qualityPolicy:String(marker.qualityPolicy || UClientFtr_FLASH_QUALITY_POLICY),
            residencyPolicy:String(marker.residencyPolicy || UClientFtr_FLASH_RESIDENCY_POLICY),
            sceneRoutePolicy:UClientFtr_SCENE_ROUTE_POLICY,
            rendererPolicy:buildRecord.rendererPolicy,
            outputScale:Number(marker.outputScale || 1),
            assetVersion:UClientFtr_FLASH_ASSET_VERSION,
            pages:pages.length,
            residencyPlan:buildRecord.residencyPlan,
            templateVersion:UClientFtr_BATTLE_TEMPLATE_VERSION,
            templateSha256:templateSha256,
            convertedAt:new Date().toISOString(),
            eventVideos:buildRecord.eventVideos,
          }
        );
        await writeAtomic(variantManifestFile,
          Buffer.from(JSON.stringify(variantManifest, null, 2), 'utf8'));
      }
      if (artifactRole === 'battle') {
        var previewMetadataFile = path.join(previewRoot, 'uclient-preview.json');
        if (fs.existsSync(previewMetadataFile)) {
          var previewMetadata = JSON.parse(await fs.promises.readFile(previewMetadataFile, 'utf8'));
          if (Number(previewMetadata.sourceId || sourceId) !== parseId(sourceId)) {
            throw new Error('UClientFtr preview metadata identity does not match forced rebuild');
          }
          previewMetadata.flashBattleSwf = Object.assign({}, buildRecord, { file:target });
          await writeAtomic(previewMetadataFile,
            Buffer.from(JSON.stringify(previewMetadata, null, 2), 'utf8'));
        }
      }
    } catch(error) {
      throw new Error('UClientFtr battle variant evidence update failed: ' +
        String(error && error.message || error));
    }
    return Object.assign({ file:target }, buildRecord);
  }

  async function buildUClientFtrPetBattleSwf(previewRoot, sourceId) {
    return buildUClientFtrPetSwf(previewRoot, sourceId, { artifactRole:'battle' });
  }

  async function buildUClientFtrFollowSwf(previewRoot, sourceId) {
    return buildUClientFtrPetSwf(previewRoot, sourceId, { artifactRole:'follow' });
  }

  async function ensureUClientSpineFlashAssets(previewRoot, force) {
    var sourceFile = path.join(previewRoot, 'spine-source.json');
    var markerFile = path.join(previewRoot, 'spine-flash-assets.json');
    var source = JSON.parse(await fs.promises.readFile(sourceFile, 'utf8'));
    var atlases = Array.isArray(source.sourceAtlases) ? source.sourceAtlases : [];
    if (source.family !== 'spine' || !atlases.length || atlases.length > 8) {
      throw new Error('U Spine source atlas set is invalid or exceeds x32 capacity');
    }
    var sourceStats = await Promise.all(atlases.map(function(item) {
      return fs.promises.stat(path.join(previewRoot, String(item.file || '')));
    }));
    // Spine follows the same source-pixel contract as FTR.  Never silently
    // downsample a native atlas to satisfy a process-wide memory heuristic;
    // each atlas remains an exact-resolution page and unsupported dimensions
    // fail explicitly below.
    var outputScale = UClientFtr_FLASH_OUTPUT_SCALE;
    if (!force) {
      try {
        var existing = JSON.parse(await fs.promises.readFile(markerFile, 'utf8'));
        if (existing && existing.version === UCLIENT_SPINE_TEMPLATE_VERSION &&
            Number(existing.outputScale) === UClientFtr_FLASH_OUTPUT_SCALE &&
            String(existing.qualityPolicy || '') === UClientFtr_FLASH_QUALITY_POLICY &&
            String(existing.residencyPolicy || '') === 'spine-model-lifetime-lossless-v1' &&
            Array.isArray(existing.sourceBytes) &&
            existing.sourceBytes.every(function(bytes,index) { return Number(bytes) === sourceStats[index].size; }) &&
            Array.isArray(existing.pages) && existing.pages.length === atlases.length &&
            existing.pages.every(function(page) {
              return page && Number(page.width) >= 1 && Number(page.width) <= MAX_FLASH_ATLAS_EDGE &&
                Number(page.height) >= 1 && Number(page.height) <= MAX_FLASH_ATLAS_EDGE &&
                Number(page.scaleX || 1) === UClientFtr_FLASH_OUTPUT_SCALE &&
                Number(page.scaleY || 1) === UClientFtr_FLASH_OUTPUT_SCALE &&
                fs.existsSync(path.join(previewRoot,String(page.losslessFile || '')));
            })) return existing;
      } catch(_) {}
    }
    var pages = [];
    for (var atlasIndex = 0; atlasIndex < atlases.length; atlasIndex++) {
      var atlas = atlases[atlasIndex];
      var width = Number(atlas.width || 0) | 0;
      var height = Number(atlas.height || 0) | 0;
      if (width < 1 || height < 1 || width > MAX_FLASH_ATLAS_EDGE || height > MAX_FLASH_ATLAS_EDGE) {
        throw new Error('U Spine atlas dimensions exceed the lossless Flash bitmap boundary');
      }
      var definitions = await renderUClientFtrPetFlashAtlasPages({
        atlasFile:path.join(previewRoot,String(atlas.file)),
        atlasFormat:String(atlas.format || 'bc7'),
        previewFile:path.join(previewRoot,String(atlas.previewFile || ('uclient-atlas-' + atlasIndex + '.png'))),
        previewRoot:previewRoot,
        atlasWidth:width, atlasHeight:height,
        padding:0, outputScale:outputScale, pageOffset:atlasIndex,
        pages:[{ index:0, width:width, height:height }],
        regions:[{ page:0, sx:0, sy:0, w:width, h:height, x:0, y:0 }],
      });
      if (!definitions.length) throw new Error('U Spine atlas conversion returned no page');
      if (Number(definitions[0].scaleX || 1) !== UClientFtr_FLASH_OUTPUT_SCALE ||
          Number(definitions[0].scaleY || 1) !== UClientFtr_FLASH_OUTPUT_SCALE) {
        throw new Error('U Spine converter returned a downsampled atlas page');
      }
      pages.push(definitions[0]);
    }
    var marker = {
      version:UCLIENT_SPINE_TEMPLATE_VERSION,
      family:'spine', sourceId:Number(source.sourceId || 0),
      qualityPolicy:UClientFtr_FLASH_QUALITY_POLICY,
      residencyPolicy:'spine-model-lifetime-lossless-v1',
      outputScale:outputScale,
      sourceBytes:sourceStats.map(function(stat) { return stat.size; }),
      pages:pages,
      actions:Array.isArray(source.actions) ? source.actions : [],
    };
    await writeAtomic(markerFile,Buffer.from(JSON.stringify(marker,null,2),'utf8'));
    return marker;
  }

  function binaryDataTag(symbolId, body) {
    var output = Buffer.allocUnsafe(6 + body.length);
    output.writeUInt16LE(symbolId,0);
    output.writeUInt32LE(0,2);
    body.copy(output,6);
    return { code:87, body:output };
  }

  function resolveUClientVideoRemuxer() {
    var candidates = [];
    if (processRef.env.SEER_FFMPEG) candidates.push(processRef.env.SEER_FFMPEG);
    if (app.isPackaged) {
      candidates.push(path.join(processRef.resourcesPath,'app.asar.unpacked','ffmpeg.exe'));
      candidates.push(path.join(processRef.resourcesPath,'ffmpeg.exe'));
    }
    // This launcher is currently developed and deployed on the pinned local
    // workstation.  Keep its audited toolchain path as a final resolver while
    // still allowing packaged or environment-provided copies to win.
    candidates.push('D:\\seer2-development-kit\\downloads\\ffmpeg-release-essentials-20260812\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe');
    return candidates.map(function(file) { return path.resolve(file); }).find(function(file) {
      try { return fs.existsSync(file); } catch(_) { return false; }
    }) || '';
  }

  async function remuxUClientVideoToFlv(input, output) {
    var executable = resolveUClientVideoRemuxer();
    if (!executable) throw new Error('U-client video remuxer is missing');
    await fs.promises.mkdir(path.dirname(output),{recursive:true});
    var temporary = output + '.part-' + processRef.pid;
    try { await fs.promises.unlink(temporary); } catch(_) {}
    var args = ['-hide_banner','-loglevel','error','-i',input,'-map','0:v:0',
      '-an','-c:v','copy','-f','flv','-y',temporary];
    var diagnostic = '';
    var child = spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    if (child.stdout) child.stdout.on('data',function(chunk) { diagnostic = (diagnostic + chunk).slice(-8192); });
    if (child.stderr) child.stderr.on('data',function(chunk) { diagnostic = (diagnostic + chunk).slice(-8192); });
    var code = await new Promise(function(resolve,reject) {
      var timer = setTimeout(function() {
        try { child.kill(); } catch(_) {}
        reject(new Error('U-client video remux timed out'));
      },60000);
      child.on('error',function(error) { clearTimeout(timer); reject(error); });
      child.on('close',function(value) { clearTimeout(timer); resolve(value); });
    });
    if (code !== 0) throw new Error('U-client video remux failed: ' + String(diagnostic || code));
    var stat = await fs.promises.stat(temporary);
    if (stat.size < 256) throw new Error('U-client video remux returned an empty FLV');
    try { await fs.promises.unlink(output); } catch(_) {}
    await fs.promises.rename(temporary,output);
    return { file:output, bytes:stat.size, executable:executable };
  }

  async function buildUClientVideoSkillSwf(previewRoot, sourceId) {
    var itemRoot = path.dirname(previewRoot);
    var metadataFile = path.join(previewRoot,'uclient-video.json');
    var metadata = JSON.parse(await fs.promises.readFile(metadataFile,'utf8'));
    var mp4File = path.join(previewRoot,String(metadata.file || 'uclient-video.mp4'));
    var frameRate = Math.max(1,Math.min(60,Number(metadata.frameRate) || 30));
    var frameCount = Math.max(2,Math.min(1800,Math.round(Number(metadata.frameCount) ||
      Number(metadata.durationSeconds || 0) * frameRate)));
    if (metadata.family !== 'video' || Number(metadata.sourceId) !== Number(sourceId) ||
        Number(metadata.width) < 1 || Number(metadata.height) < 1) {
      throw new Error('U-client video metadata identity is invalid');
    }
    var flvFile = path.join(previewRoot,'uclient-video.flv');
    var remux = await remuxUClientVideoToFlv(mp4File,flvFile);
    var flv = await fs.promises.readFile(flvFile);
    var manifest = Buffer.from(JSON.stringify({
      version:UCLIENT_VIDEO_TEMPLATE_VERSION, sourceId:Number(sourceId),
      width:Number(metadata.width), height:Number(metadata.height),
      frameCount:frameCount, frameRate:frameRate,
      durationSeconds:Number(metadata.durationSeconds || frameCount / frameRate),
    }),'utf8');
    var templateFile = path.join(moduleDirectory,'uclient-video-template.swf');
    var templateBuffer = await fs.promises.readFile(templateFile);
    var template = readSwfTags(templateBuffer);
    var symbols = swfSymbolClasses(template.tags);
    var videoId = symbols.get('skill_VideoBytes');
    var manifestId = symbols.get('skill_ManifestBytes');
    if (!videoId || !manifestId || symbols.get('skill') !== 0) {
      throw new Error('U-client video SWF template symbols are invalid');
    }
    var replacements = new Map([
      [videoId,binaryDataTag(videoId,flv)],
      [manifestId,binaryDataTag(manifestId,manifest)],
    ]);
    var existingFrames = template.tags.filter(function(tag) { return tag.code === 1; }).length;
    var encoded = [];
    template.tags.forEach(function(tag) {
      if (tag.code === 0) {
        for (var index = existingFrames; index < frameCount; index++) {
          encoded.push(encodeSwfTag(1,Buffer.alloc(0)));
        }
      }
      var id = tag.body.length >= 2 ? tag.body.readUInt16LE(0) : 0;
      var replacement = tag.code === 87 ? replacements.get(id) : null;
      encoded.push(encodeSwfTag(replacement ? replacement.code : tag.code,
        replacement ? replacement.body : tag.body));
    });
    var prefix = Buffer.from(template.prefix);
    prefix.writeUInt16LE(frameCount,prefix.length - 2);
    var uncompressed = Buffer.concat([prefix].concat(encoded));
    uncompressed.write('FWS',0,3,'ascii');
    uncompressed.writeUInt32LE(uncompressed.length,4);
    var header = Buffer.alloc(8);
    header.write('CWS',0,3,'ascii'); header[3] = template.version;
    header.writeUInt32LE(uncompressed.length,4);
    var output = Buffer.concat([header,zlib.deflateSync(uncompressed.slice(8),{level:9})]);
    var target = path.join(itemRoot,'skill.swf');
    await writeAtomic(target,output);
    var record = {
      version:UCLIENT_VIDEO_TEMPLATE_VERSION, family:'video', sourceId:parseId(sourceId),
      assetPath:String(metadata.assetPath || ''), width:Number(metadata.width), height:Number(metadata.height),
      frameCount:frameCount, frameRate:frameRate, durationSeconds:Number(metadata.durationSeconds),
      mp4Bytes:Number(metadata.bytes), mp4Sha256:String(metadata.sha256 || ''),
      sourceUrl:String(metadata.sourceUrl || ''), packageKey:String(metadata.packageKey || ''),
      packageVersion:String(metadata.packageVersion || ''),
      bundleFileHash:String(metadata.bundleFileHash || ''),
      bundleBytes:Number(metadata.bundleBytes || 0),
      bundleSha256:String(metadata.bundleSha256 || ''),
      flvBytes:remux.bytes, flvSha256:crypto.createHash('sha256').update(flv).digest('hex').toUpperCase(),
      templateSha256:crypto.createHash('sha256').update(templateBuffer).digest('hex').toUpperCase(),
      skillBytes:output.length, skillSha256:crypto.createHash('sha256').update(output).digest('hex').toUpperCase(),
      conversionPolicy:'lossless-h264-stream-copy-embedded-flv', selfContained:true,
    };
    await writeAtomic(path.join(itemRoot,'uclient-video-build.json'),
      Buffer.from(JSON.stringify(record,null,2),'utf8'));
    return Object.assign({file:target},record);
  }

  async function buildUClientSpineBattleSwf(previewRoot, sourceId, force, credential) {
    var marker = await ensureUClientSpineFlashAssets(previewRoot,force === true);
    var source = JSON.parse(await fs.promises.readFile(path.join(previewRoot,'spine-source.json'),'utf8'));
    await skillTimelineOverlay.prepare(previewRoot,credential,source);
    var templateFile = path.join(moduleDirectory,'uclient-spine-template.swf');
    var templateBuffer = await fs.promises.readFile(templateFile);
    var template = readSwfTags(templateBuffer);
    var symbols = swfSymbolClasses(template.tags);
    var manifestId = symbols.get('pet_ManifestBytes');
    var atlasId = symbols.get('pet_AtlasText');
    var skeletonId = symbols.get('pet_SkeletonBytes');
    var cinematicId = symbols.get('pet_CinematicBytes');
    var skillTimelineId = symbols.get('pet_SkillTimelineBytes');
    if (!manifestId || !atlasId || !skeletonId || !cinematicId || !skillTimelineId) {
      throw new Error('U Spine SWF template data symbols are missing');
    }
    var cinematic = { version:1,enabled:false,windows:[] };
    var cinematicBytes = await fs.promises.readFile(
      path.join(moduleDirectory,'uclient-spine-template','placeholder-cinematic.swf'));
    try {
      var selectedCinematic = JSON.parse(await fs.promises.readFile(
        path.join(previewRoot,'uclient-cinematic.json'),'utf8'));
      var selectedBytes = await fs.promises.readFile(path.join(previewRoot,'uclient-cinematic.swf'));
      var selectedSha = crypto.createHash('sha256').update(selectedBytes).digest('hex').toUpperCase();
      if (selectedCinematic.enabled !== true || !Array.isArray(selectedCinematic.windows) ||
          !selectedCinematic.windows.length ||
          selectedSha !== String(selectedCinematic.nativeSwfSha256 || '').toUpperCase()) {
        throw new Error('U-client embedded cinematic evidence is invalid');
      }
      cinematic = selectedCinematic;
      cinematicBytes = selectedBytes;
    } catch(error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    // request/source ids may name a catalogue skin while assetId names the
    // exact official Spine/SkillTimeline owner. prepare() already keys the
    // overlay by assetId; use the same identity for load() or a skin routed to
    // an owner's model would create valid artifacts and then reject them as an
    // "incomplete" closure under the catalogue id.
    var skillTimelineOwnerId = parseId(credential && credential.assetId || sourceId);
    var skillTimeline = await skillTimelineOverlay.load(
      previewRoot,skillTimelineOwnerId,credential);
    var skillTimelineBytes = skillTimeline.enabled ? skillTimeline.bytes :
      await fs.promises.readFile(path.join(moduleDirectory,'uclient-spine-template',
        'placeholder-skill-timeline.swf'));
    var pageNames = (source.sourceAtlases || []).map(function(item) {
      return String(item.name || '') + '.png';
    });
    var manifest = Buffer.from(JSON.stringify({
      version:UCLIENT_SPINE_TEMPLATE_VERSION,
      sourceId:Number(source.sourceId || sourceId),
      scale:Number(source.scale || .01),
      pageNames:pageNames,
      actions:Array.isArray(source.actions) && source.actions.length ? source.actions :
        ['appear','attack','await','cp','hidemove','hited','sa'],
      cinematic:cinematic,
      skillTimeline:skillTimeline.manifest,
    }),'utf8');
    var replacements = new Map();
    replacements.set(manifestId,binaryDataTag(manifestId,manifest));
    replacements.set(atlasId,binaryDataTag(atlasId,
      await fs.promises.readFile(path.join(previewRoot,String(source.atlasFile)))));
    replacements.set(skeletonId,binaryDataTag(skeletonId,
      await fs.promises.readFile(path.join(previewRoot,String(source.skeletonFile)))));
    replacements.set(cinematicId,binaryDataTag(cinematicId,cinematicBytes));
    replacements.set(skillTimelineId,binaryDataTag(skillTimelineId,skillTimelineBytes));
    for (var pageIndex = 0; pageIndex < marker.pages.length; pageIndex++) {
      var page = marker.pages[pageIndex];
      var bitmapId = symbols.get('pet_Atlas' + pageIndex);
      if (!bitmapId) throw new Error('U Spine SWF template page capacity is insufficient');
      var pixels = await fs.promises.readFile(path.join(previewRoot,String(page.losslessFile)));
      var bitmapBody = Buffer.allocUnsafe(7 + pixels.length);
      bitmapBody.writeUInt16LE(bitmapId,0); bitmapBody[2] = 5;
      bitmapBody.writeUInt16LE(Number(page.width),3); bitmapBody.writeUInt16LE(Number(page.height),5);
      pixels.copy(bitmapBody,7);
      replacements.set(bitmapId,{ code:36, body:bitmapBody });
    }
    var encoded = template.tags.map(function(tag) {
      var id = tag.body.length >= 2 ? tag.body.readUInt16LE(0) : 0;
      var replacement = (tag.code === 36 || tag.code === 87) ? replacements.get(id) : null;
      return encodeSwfTag(replacement ? replacement.code : tag.code,replacement ? replacement.body : tag.body);
    });
    var uncompressed = Buffer.concat([template.prefix].concat(encoded));
    uncompressed.write('FWS',0,3,'ascii'); uncompressed.writeUInt32LE(uncompressed.length,4);
    var header = Buffer.alloc(8); header.write('CWS',0,3,'ascii'); header[3] = template.version;
    header.writeUInt32LE(uncompressed.length,4);
    var output = Buffer.concat([header,zlib.deflateSync(uncompressed.slice(8),{level:9})]);
    var target = path.join(path.dirname(previewRoot),'fight.swf');
    await writeAtomic(target,output);
    var sha256 = crypto.createHash('sha256').update(output).digest('hex').toUpperCase();
    var build = {
      version:UCLIENT_SPINE_TEMPLATE_VERSION, family:'spine', sourceId:parseId(sourceId),
      templateSha256:crypto.createHash('sha256').update(templateBuffer).digest('hex').toUpperCase(),
      fightSha256:sha256, bytes:output.length,
      rendererPolicy:'uclient-spine40-cpu-resource-local-texture',
      assetVersion:UCLIENT_SPINE_TEMPLATE_VERSION,
      qualityPolicy:UClientFtr_FLASH_QUALITY_POLICY,
      residencyPolicy:'spine-model-lifetime-lossless-v1',
      outputScale:Number(marker.outputScale), pages:marker.pages.length,
      cinematic:cinematic.enabled === true ? {
        embedded:true, policy:String(cinematic.policy || ''),
        videoAssetPath:String(cinematic.videoAssetPath || ''),
        sourceVideoSha256:String(cinematic.sourceVideoSha256 || ''),
        nativeSwfSha256:String(cinematic.nativeSwfSha256 || ''),
        nativeSwfBytes:cinematicBytes.length,
        windows:cinematic.windows,
        spineAssetPath:String(cinematic.spineAssetPath || ''),
        spineSkeletonSha256:String(cinematic.spineSkeletonSha256 || ''),
        actionTiming:cinematic.actionTiming || null,
      } : { embedded:false },
      skillTimeline:skillTimeline.enabled ? Object.assign({ embedded:true },skillTimeline.build) : {
        embedded:false,version:Number(skillTimeline.manifest.version || 0),
        policy:String(skillTimeline.manifest.policy || ''),
        ownerId:Number(skillTimeline.manifest.ownerId || 0),
        actionTiming:skillTimeline.manifest.actionTiming || null,
      },
    };
    await writeAtomic(path.join(path.dirname(previewRoot),'uclient-fight-build.json'),
      Buffer.from(JSON.stringify(build,null,2),'utf8'));
    return Object.assign({ file:target },build);
  }

  async function buildUClientFtrPetBattleAssetsIsolated(previewRoot, sourceId, directory, force) {
    if (processRef.env.LAUNCHER_AUTOTEST_UCLIENT_FTR_FLASH_ASSETS) {
      var localFlash = await ensureUClientFtrPetFlashAssets(previewRoot, force === true);
      return { flashBattle:localFlash, flashBattleSwf:await buildUClientFtrPetBattleSwf(previewRoot, sourceId) };
    }
    var id = parseId(sourceId);
    if (!id) throw new Error('UClientFtr battle worker source id is invalid');
    var workerToken = processRef.pid + '-' + crypto.randomBytes(5).toString('hex');
    var resultFile = path.join(previewRoot, '.flash-build-result-' + workerToken + '.json');
    var workerSkinRoot = path.resolve(previewRoot, '.flash-worker-custom-skins-' + workerToken);
    var previewBase = path.resolve(previewRoot);
    var workerSkinRelative = path.relative(previewBase, workerSkinRoot);
    if (!workerSkinRelative || path.isAbsolute(workerSkinRelative) || workerSkinRelative === '..' ||
        workerSkinRelative.indexOf('..' + path.sep) === 0) {
      throw new Error('UClientFtr battle worker custom-skin root escaped previewRoot');
    }
    await fs.promises.mkdir(workerSkinRoot, { recursive:true });
    try {
      var workerEnvironment = Object.assign({}, processRef.env, {
        LAUNCHER_AUTOTEST:'1',
        LAUNCHER_AUTOTEST_EXIT_AFTER_MS:'190000',
        LAUNCHER_AUTOTEST_CUSTOM_SKIN_ROOT:workerSkinRoot,
        LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_DIR:path.resolve(directory),
        LAUNCHER_AUTOTEST_UCLIENT_FTR_FLASH_ASSETS:String(id),
        LAUNCHER_AUTOTEST_UCLIENT_FTR_FLASH_ASSETS_FORCE:force === true ? '1' : '0',
        LAUNCHER_AUTOTEST_UCLIENT_FTR_FLASH_ASSETS_RESULT_FILE:resultFile,
      });
      delete workerEnvironment.LAUNCHER_AUTOTEST_SKIN_DOWNLOAD_IDS;
      delete workerEnvironment.LAUNCHER_AUTOTEST_RESULT_FILE;
      var workerArguments = app.isPackaged ? [] : [app.getAppPath()];
      var worker = spawn(processRef.execPath, workerArguments, {
        cwd:path.dirname(processRef.execPath),
        env:workerEnvironment,
        windowsHide:true,
        stdio:['ignore', 'pipe', 'pipe'],
      });
      var diagnostic = '';
      function capture(chunk) {
        diagnostic = (diagnostic + String(chunk || '')).slice(-16384);
      }
      if (worker.stdout) worker.stdout.on('data', capture);
      if (worker.stderr) worker.stderr.on('data', capture);
      var exit = await new Promise(function(resolve, reject) {
        var settled = false;
        var timeout = setTimeout(function() {
          if (settled) return;
          settled = true;
          try { worker.kill(); } catch(_) {}
          reject(new Error('UClientFtr battle worker timed out after 180 seconds'));
        }, 180000);
        worker.once('error', function(error) {
          if (settled) return;
          settled = true; clearTimeout(timeout); reject(error);
        });
        worker.once('exit', function(code, signal) {
          if (settled) return;
          settled = true; clearTimeout(timeout); resolve({ code:code, signal:signal });
        });
      });
      var result;
      try { result = JSON.parse(await fs.promises.readFile(resultFile, 'utf8')); }
      catch(error) {
        throw new Error('UClientFtr battle worker returned no result (exit ' + exit.code + ')' +
          (diagnostic ? ': ' + diagnostic.trim() : ''));
      }
      if (!result || result.ok !== true || exit.code !== 0) {
        throw new Error(String(result && result.error || 'UClientFtr battle worker failed') +
          (diagnostic ? ': ' + diagnostic.trim() : ''));
      }
      var built = (result.results || []).find(function(item) { return Number(item.id) === id; });
      if (!built || !built.result || !built.battleSwf || !fs.existsSync(built.battleSwf.file)) {
        throw new Error('UClientFtr battle worker produced an incomplete result');
      }
      return { flashBattle:built.result, flashBattleSwf:built.battleSwf };
    } finally {
      var workerCleanupError = null;
      try { await fs.promises.unlink(resultFile); }
      catch(error) { if (!error || error.code !== 'ENOENT') workerCleanupError = error; }
      try { await fs.promises.rmdir(workerSkinRoot, { recursive:true }); }
      catch(error) { if ((!error || error.code !== 'ENOENT') && !workerCleanupError) workerCleanupError = error; }
      if (fs.existsSync(workerSkinRoot) && !workerCleanupError) {
        workerCleanupError = new Error('UClientFtr battle worker custom-skin root cleanup is incomplete');
      }
      if (workerCleanupError) throw workerCleanupError;
    }
  }

  async function validateUClientFtrPetCompactDownload(itemRoot, sourceId) {
    var id = parseId(sourceId);
    var previewRoot = path.join(itemRoot, 'uclient-preview');
    var fightFile = path.join(itemRoot, 'fight.swf');
    var buildFile = path.join(itemRoot, 'uclient-fight-build.json');
    var variantFile = path.join(itemRoot, 'battle-variants.json');
    try {
      if (!id) throw new Error('invalid source id');
      var metadata = JSON.parse(await fs.promises.readFile(path.join(previewRoot, 'uclient-preview.json'), 'utf8'));
      var spine = String(metadata.family || '').toLowerCase() === 'spine';
      var build = JSON.parse(await fs.promises.readFile(buildFile, 'utf8'));
      var variant = JSON.parse(await fs.promises.readFile(variantFile, 'utf8'));
      var storedConversion = variant && variant.variants && variant.variants.uclient &&
        variant.variants.uclient.conversion || {};
      var storagePolicy = String(build.storagePolicy || storedConversion.storagePolicy || '');
      var metadataOnly = storagePolicy === 'runtime-metadata-compact-v2';
      var markerName = spine ? 'spine-flash-assets.json' : 'flash-assets.json';
      var marker = null;
      try { marker = JSON.parse(await fs.promises.readFile(path.join(previewRoot, markerName), 'utf8')); }
      catch(error) { if (!metadataOnly || !error || error.code !== 'ENOENT') throw error; }
      var expectedAssetVersion = spine ? UCLIENT_SPINE_TEMPLATE_VERSION : UClientFtr_FLASH_ASSET_VERSION;
      var expectedResidencyPolicy = spine ? 'spine-model-lifetime-lossless-v1' : UClientFtr_FLASH_RESIDENCY_POLICY;
      var expectedTemplateSha256 = '';
      if (!spine) {
        expectedTemplateSha256 = crypto.createHash('sha256').update(
          await fs.promises.readFile(path.join(moduleDirectory, 'uclient-ftr-battle-template.swf'))
        ).digest('hex').toUpperCase();
        if (expectedTemplateSha256 !== UClientFtr_BATTLE_TEMPLATE_SHA256) {
          throw new Error('installed UClientFtr battle template violates the direct-Shape display-tree contract');
        }
      }
      if (Number(build.assetVersion) !== expectedAssetVersion ||
          String(build.qualityPolicy || '') !== UClientFtr_FLASH_QUALITY_POLICY ||
          String(build.residencyPolicy || '') !== expectedResidencyPolicy ||
          (!spine && String(build.sceneRoutePolicy || '') !== UClientFtr_SCENE_ROUTE_POLICY) ||
          (!spine && String(build.templateSha256 || '').toUpperCase() !== expectedTemplateSha256) ||
          Number(build.outputScale) !== UClientFtr_FLASH_OUTPUT_SCALE) {
        throw new Error('battle build record is stale or violates the lossless/direct-Shape policy');
      }
      if (marker && (Number(marker.outputScale) !== UClientFtr_FLASH_OUTPUT_SCALE ||
          String(marker.qualityPolicy || '') !== UClientFtr_FLASH_QUALITY_POLICY ||
          String(marker.residencyPolicy || '') !== expectedResidencyPolicy ||
          (!spine && Number(marker.templateVersion) !== UClientFtr_BATTLE_TEMPLATE_VERSION) ||
          (!spine && String(marker.templateSha256 || '').toUpperCase() !== expectedTemplateSha256) ||
          (!spine && String(marker.sceneRoutePolicy || '') !== UClientFtr_SCENE_ROUTE_POLICY))) {
        throw new Error('atlas marker violates the lossless/direct-Shape policy');
      }
      var animation = null;
      if (!spine && !metadataOnly) {
        animation = JSON.parse(zlib.gunzipSync(
          await fs.promises.readFile(path.join(previewRoot, 'uclient-animation.json.gz'))
        ).toString('utf8'));
        var atlasName = String(animation && animation.atlas && animation.atlas.file || '');
        if (!/^[^\\/:*?"<>|]+$/.test(atlasName)) throw new Error('invalid preview atlas');
        var atlasStat = await fs.promises.stat(path.join(previewRoot, atlasName));
        if (!atlasStat.isFile() || !atlasStat.size) throw new Error('preview atlas is missing');
      }
      var fight = await fs.promises.readFile(fightFile);
      var fightSha256 = crypto.createHash('sha256').update(fight).digest('hex').toUpperCase();
      var conversion = variant && variant.variants && variant.variants.uclient &&
        variant.variants.uclient.conversion || {};
      var expectedVersion = spine ? UCLIENT_SPINE_TEMPLATE_VERSION : UClientFtr_BATTLE_TEMPLATE_VERSION;
      if (Number(build.sourceId) !== id || Number(build.version) !== expectedVersion ||
          Number(build.bytes) !== fight.length || String(build.fightSha256 || '').toUpperCase() !== fightSha256) {
        throw new Error('battle build record does not match fight.swf');
      }
      if (conversion.ok !== true || Number(conversion.bytes) !== fight.length ||
        String(conversion.sha256 || '').toUpperCase() !== fightSha256) {
        throw new Error('battle variant record does not match fight.swf');
      }
      if (Number(conversion.outputScale) !== UClientFtr_FLASH_OUTPUT_SCALE ||
          String(conversion.qualityPolicy || '') !== UClientFtr_FLASH_QUALITY_POLICY ||
          String(conversion.residencyPolicy || '') !== expectedResidencyPolicy ||
          (!spine && Number(conversion.templateVersion) !== UClientFtr_BATTLE_TEMPLATE_VERSION) ||
          (!spine && String(conversion.templateSha256 || '').toUpperCase() !== expectedTemplateSha256) ||
          (!spine && String(conversion.sceneRoutePolicy || '') !== UClientFtr_SCENE_ROUTE_POLICY)) {
        throw new Error('battle variant record violates the lossless/direct-Shape policy');
      }
      if (!spine) {
        // Page-slot consistency: for every page index i in the manifest page
        // table, the bitmap actually embedded in the pet_Atlas{i} slot must
        // match pages[i].width/height.  A fight.swf whose embedded page order
        // was shuffled past the byte/SHA records above otherwise renders with
        // large black regions (real UClient FTR incident), so this hard gate
        // rejects the download instead of trusting the records.  Extra
        // template placeholder slots (index >= pages.length) are unconstrained.
        var groundManifest = null;
        var groundAtlasDims = {};
        var groundTags = readSwfTags(fight);
        groundTags.tags.forEach(function(tag) {
          if (tag.code === 36) {
            groundAtlasDims[tag.body.readUInt16LE(0)] = {
              width: tag.body.readUInt16LE(3),
              height: tag.body.readUInt16LE(5),
            };
          } else if (tag.code === 87) {
            try {
              var candidate = JSON.parse(tag.body.slice(6).toString('utf8'));
              if (candidate && candidate.sequences) groundManifest = candidate;
            } catch(_) {}
          }
        });
        if (!groundManifest || !Array.isArray(groundManifest.pages) || !groundManifest.pages.length) {
          throw new Error('battle SWF manifest is missing the atlas page table');
        }
        var groundSymbols = swfSymbolClasses(groundTags.tags);
        for (var groundPageSlot = 0; groundPageSlot < groundManifest.pages.length; groundPageSlot++) {
          var groundPage = groundManifest.pages[groundPageSlot];
          var groundSymbolId = groundSymbols.get('pet_Atlas' + groundPageSlot);
          var groundDims = groundSymbolId === undefined ? null : groundAtlasDims[groundSymbolId];
          if (!groundDims || !groundPage ||
              Number(groundDims.width) !== Number(groundPage.width) ||
              Number(groundDims.height) !== Number(groundPage.height)) {
            throw new Error('atlas page ' + groundPageSlot +
              ' does not match the manifest page table (embedded page order does not match region indices)');
          }
        }
      }
      if (spine && build.skillTimeline && build.skillTimeline.embedded === true) {
        var overlayOwnerId = parseId(metadata.assetId || sourceId);
        var cachedOverlay = await skillTimelineOverlay.load(previewRoot,overlayOwnerId);
        if (!cachedOverlay.enabled ||
            Number(build.skillTimeline.ownerId) !== overlayOwnerId ||
            String(build.skillTimeline.policy || '') !== String(cachedOverlay.manifest.policy || '') ||
            Number(build.skillTimeline.nativeBytes) !== cachedOverlay.bytes.length ||
            String(build.skillTimeline.nativeSha256 || '').toUpperCase() !==
              String(cachedOverlay.build.nativeSha256 || '').toUpperCase()) {
          throw new Error('cached SkillTimeline overlay does not match the embedded fight build');
        }
        if (metadataOnly) {
          var retainedSpineSource = JSON.parse(await fs.promises.readFile(
            path.join(previewRoot,'spine-source.json'),'utf8'));
          var retainedSkeletonName = String(retainedSpineSource && retainedSpineSource.skeletonFile || '');
          if (!/^[\w.-]+$/.test(retainedSkeletonName)) {
            throw new Error('cached SkillTimeline restore source is invalid');
          }
          var retainedSkeleton = await fs.promises.stat(path.join(previewRoot,retainedSkeletonName));
          if (!retainedSkeleton.isFile() || !retainedSkeleton.size) {
            throw new Error('cached SkillTimeline restore skeleton is missing');
          }
        }
      }
      var uClientFtrVariant = variant.variants.uclient || {};
      return {
        ok:true, sourceId:id, itemRoot:itemRoot, previewRoot:previewRoot,
        metadata:metadata, animation:animation, family:spine ? 'spine' : 'ftr', build:build, variant:variant,
        storagePolicy:storagePolicy, metadataOnly:metadataOnly,
        fightFile:fightFile, fightBytes:fight.length, fightSha256:fightSha256,
        bundleEvidence:{ bytes:Number(uClientFtrVariant.bundleBytes || 0), sha256:String(uClientFtrVariant.bundleSha256 || '') },
      };
    } catch(error) {
      return { ok:false, sourceId:id, error:error.message };
    }
  }

  async function reconcileCachedUClientSpineSkillTimeline(previewRoot, sourceId, credential,
    metadata, build) {
    var ownerId = parseId(credential && credential.assetId || metadata && metadata.assetId || sourceId);
    var embedded = build && build.skillTimeline || {};
    function matchesEmbedded(loaded) {
      return loaded && loaded.enabled && embedded.embedded === true &&
        Number(embedded.ownerId) === ownerId &&
        String(embedded.policy || '') === String(loaded.manifest.policy || '') &&
        Number(embedded.nativeBytes) === loaded.bytes.length &&
        String(embedded.nativeSha256 || '').toUpperCase() ===
          String(loaded.build.nativeSha256 || '').toUpperCase();
    }
    // A dynamic owner profile lives beside the downloaded preview, not in the
    // launcher's static profile document.  Attempt that persisted closure
    // before selectProfile(); otherwise an unknown owner would be mistaken for
    // an ordinary model and prepare({sourceId}) would erase its valid sidecar.
    try {
      var cached = await skillTimelineOverlay.load(previewRoot,ownerId,credential);
      if (matchesEmbedded(cached)) {
        return { ok:true, enabled:true, restored:false,
          nativeBytes:cached.bytes.length,nativeSha256:cached.build.nativeSha256 };
      }
    } catch(_) {}
    var profile = skillTimelineOverlay.selectProfile(ownerId);
    if (!profile) {
      var completeOfficialFamily = false;
      try {
        var officialPlan = resourceAdapter.buildResourcePlan(
          credential,null,{ skillTimeline:'all-owned' });
        var officialSkill = officialPlan && officialPlan.skillTimeline || {};
        completeOfficialFamily = Number(officialPlan && officialPlan.version) === 3 &&
          Number(officialPlan && officialPlan.ownerId) === ownerId &&
          Array.isArray(officialSkill.timelines) && officialSkill.timelines.length === 5 &&
          Array.isArray(officialSkill.effects) && officialSkill.effects.length === 5 &&
          Array.isArray(officialSkill.videos) && officialSkill.videos.length >= 1;
      } catch(_) {}
      if (completeOfficialFamily) {
        return { ok:false,enabled:false,status:'adaptation-required',
          reason:'official SkillTimeline family requires first-use automatic adaptation' };
      }
      return embedded.embedded === true
        ? { ok:false, enabled:false,
          reason:'cached fight embeds a SkillTimeline profile that is no longer installed' }
        : { ok:true, enabled:false, restored:false };
    }
    var spineSource;
    try {
      spineSource = JSON.parse(await fs.promises.readFile(path.join(previewRoot,'spine-source.json'),'utf8'));
    } catch(error) {
      return { ok:false, enabled:true, reason:'SkillTimeline restore source is missing: ' + error.message };
    }
    var prepared = await skillTimelineOverlay.prepare(previewRoot,credential,spineSource);
    if (!prepared) {
      return { ok:false, enabled:true, reason:'SkillTimeline profile or source evidence no longer matches' };
    }
    var loaded;
    try { loaded = await skillTimelineOverlay.load(previewRoot,ownerId); }
    catch(error) { return { ok:false, enabled:true, reason:error.message }; }
    if (!matchesEmbedded(loaded)) {
      return { ok:false, enabled:true, reason:'restored SkillTimeline overlay does not match cached fight.swf' };
    }
    return { ok:true, enabled:true, restored:true,
      nativeBytes:loaded.bytes.length,nativeSha256:loaded.build.nativeSha256 };
  }

  async function compactUClientFtrPetDownloadArtifacts(itemRoot, sourceId) {
    var validated = await validateUClientFtrPetCompactDownload(itemRoot, sourceId);
    if (!validated.ok) throw new Error('UClientFtr compact storage validation failed: ' + validated.error);
    var previewRoot = validated.previewRoot;
    var marker = {};
    var markerName = validated.family === 'spine' ? 'spine-flash-assets.json' : 'flash-assets.json';
    try { marker = JSON.parse(await fs.promises.readFile(path.join(previewRoot, markerName), 'utf8')); }
    catch(_) {}
    var previewAtlasName = String(validated.animation && validated.animation.atlas &&
      validated.animation.atlas.file || '');
    var sourceAtlasName = String(validated.animation && validated.animation.sourceAtlas &&
      validated.animation.sourceAtlas.file || previewAtlasName);
    var retainedSkillTimelineFiles = [];
    var retainSpineRestoreSource = false;
    if (validated.family === 'spine') {
      var overlayMetadataFile = path.join(previewRoot,'uclient-skill-timeline.json');
      var overlayNativeFile = path.join(previewRoot,'uclient-skill-timeline.swf');
      var overlayMetadataExists = fs.existsSync(overlayMetadataFile);
      var overlayNativeExists = fs.existsSync(overlayNativeFile);
      if (overlayMetadataExists !== overlayNativeExists) {
        throw new Error('UClientFtr compact storage refused an incomplete SkillTimeline overlay closure');
      }
      if (validated.build.skillTimeline && validated.build.skillTimeline.embedded === true) {
        if (!overlayMetadataExists) {
          throw new Error('UClientFtr compact storage refused a missing embedded SkillTimeline overlay closure');
        }
        var overlayOwnerId = parseId(validated.metadata.assetId || sourceId);
        var retainedOverlay = await skillTimelineOverlay.load(previewRoot,overlayOwnerId);
        if (!retainedOverlay.enabled ||
            String(validated.build.skillTimeline.nativeSha256 || '').toUpperCase() !==
              String(retainedOverlay.build.nativeSha256 || '').toUpperCase()) {
          throw new Error('UClientFtr compact storage refused a stale SkillTimeline overlay closure');
        }
        var restoreSource = JSON.parse(await fs.promises.readFile(
          path.join(previewRoot,'spine-source.json'),'utf8'));
        var restoreSkeletonName = String(restoreSource && restoreSource.skeletonFile || '');
        if (!/^[\w.-]+$/.test(restoreSkeletonName)) {
          throw new Error('UClientFtr compact storage refused an invalid SkillTimeline restore source');
        }
        var restoreSkeleton = await fs.promises.stat(path.join(previewRoot,restoreSkeletonName));
        if (!restoreSkeleton.isFile() || !restoreSkeleton.size) {
          throw new Error('UClientFtr compact storage refused a missing SkillTimeline restore skeleton');
        }
        retainSpineRestoreSource = true;
        retainedSkillTimelineFiles = [
          'uclient-preview/uclient-skill-timeline.swf',
          'uclient-preview/uclient-skill-timeline.json',
          'uclient-preview/spine-source.json',
          'uclient-preview/' + restoreSkeletonName,
        ];
      } else if (overlayMetadataExists) {
        throw new Error('UClientFtr compact storage refused an overlay not embedded in fight.swf');
      }
    }
    var candidates = [
      path.join(itemRoot, 'uclient-pet.bundle'),
      path.join(itemRoot, 'uclient-video.bundle'),
      path.join(previewRoot, 'flash-animation.json'),
      path.join(previewRoot, 'flash-assets.json'),
      path.join(previewRoot, 'spine-flash-assets.json'),
      path.join(previewRoot, 'uclient-video.mp4'),
      path.join(previewRoot, 'uclient-video.flv'),
      path.join(previewRoot, 'uclient-video.json'),
      path.join(previewRoot, 'uclient-event-videos.json'),
      path.join(previewRoot, 'uclient-cinematic.swf'),
      path.join(previewRoot, 'uclient-cinematic.json'),
    ];
    for (var eventVideoIndex = 0; eventVideoIndex < MAX_EVENT_VIDEO_CLIPS; eventVideoIndex++) {
      candidates.push(path.join(previewRoot,'event-video-slot-' + eventVideoIndex + '.swf'));
    }
    if (!fs.existsSync(path.join(itemRoot,'skill.swf'))) {
      candidates.push(path.join(itemRoot,'uclient-video-build.json'));
    }
    if (validated.family === 'ftr') {
      candidates.push(path.join(previewRoot, 'uclient-animation.json.gz'));
      if (previewAtlasName && /^[^\\/:*?\"<>|]+$/.test(previewAtlasName)) {
        candidates.push(path.join(previewRoot, previewAtlasName));
      }
    }
    if (validated.family === 'spine') {
      if (!retainSpineRestoreSource) candidates.push(path.join(previewRoot,'spine-source.json'));
      candidates.push(path.join(previewRoot,'spine.atlas'));
      if (!retainSpineRestoreSource) candidates.push(path.join(previewRoot,'spine-skeleton.skel'));
      (validated.metadata.sourceAtlases || []).forEach(function(page) {
        [page.file,page.previewFile].forEach(function(file) {
          if (/^[\w.-]+$/i.test(String(file || ''))) candidates.push(path.join(previewRoot,String(file)));
        });
      });
    }
    if (sourceAtlasName && sourceAtlasName !== previewAtlasName && /^[^\\/:*?"<>|]+$/.test(sourceAtlasName)) {
      candidates.push(path.join(previewRoot, sourceAtlasName));
    }
    (Array.isArray(marker.pages) ? marker.pages : []).forEach(function(page) {
      var file = String(page && page.losslessFile || '');
      if (/^[\w.-]+\.lossless\.zlib$/i.test(file)) candidates.push(path.join(previewRoot, file));
    });
    var deletedFiles = [];
    var freedBytes = 0;
    var seen = new Set();
    for (var index = 0; index < candidates.length; index++) {
      var target = path.resolve(candidates[index]);
      var key = target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      var parent = path.dirname(target);
      if (parent !== path.resolve(itemRoot) && parent !== path.resolve(previewRoot)) continue;
      try {
        var stat = await fs.promises.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        await fs.promises.unlink(target);
        freedBytes += Number(stat.size) || 0;
        deletedFiles.push(path.relative(itemRoot, target).replace(/\\/g, '/'));
      } catch(error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
    var compactedAt = new Date().toISOString();
    var build = Object.assign({}, validated.build, {
      storagePolicy:'runtime-metadata-compact-v2',
      compactedAt:compactedAt,
      compactedFreedBytes:freedBytes,
      compactedDeletedFiles:deletedFiles,
      retainedFiles:['fight.swf','battle-variants.json','uclient-fight-build.json',
        'uclient-preview/uclient-preview.json'].concat(
            fs.existsSync(path.join(itemRoot,'skill.swf'))
              ? ['skill.swf','uclient-video-build.json'] : []).concat(retainedSkillTimelineFiles),
    });
    await writeAtomic(path.join(itemRoot, 'uclient-fight-build.json'),
      Buffer.from(JSON.stringify(build, null, 2), 'utf8'));
    var variant = validated.variant;
    variant.updatedAt = compactedAt;
    variant.variants.uclient.conversion = Object.assign({}, variant.variants.uclient.conversion || {}, {
      storagePolicy:'runtime-metadata-compact-v2',
      compactedAt:compactedAt,
      compactedFreedBytes:freedBytes,
      compactedDeletedFiles:deletedFiles,
    });
    await writeAtomic(path.join(itemRoot, 'battle-variants.json'),
      Buffer.from(JSON.stringify(variant, null, 2), 'utf8'));
    return {
      ok:true, sourceId:validated.sourceId, storagePolicy:'runtime-metadata-compact-v2',
      freedBytes:freedBytes, deletedFiles:deletedFiles,
    };
  }

  async function ensureUClientFtrPetFlashAssets(previewRoot, force) {
    var animationFile = path.join(previewRoot, 'uclient-animation.json.gz');
    var outputFile = path.join(previewRoot, 'flash-animation.json');
    var markerFile = path.join(previewRoot, 'flash-assets.json');
    var animationStat = await fs.promises.stat(animationFile);
    var animation = JSON.parse(zlib.gunzipSync(await fs.promises.readFile(animationFile)).toString('utf8'));
    var sourceAtlas = animation && animation.sourceAtlas || animation && animation.atlas || {};
    var sourceAtlasName = String(sourceAtlas.file || 'uclient-atlas.webp');
    if (!/^[^\\/:*?"<>|]+$/.test(sourceAtlasName)) throw new Error('UClientFtr source atlas name is invalid');
    var atlasFile = path.join(previewRoot, sourceAtlasName);
    var atlasFormat = String(sourceAtlas.format || (/\.bc7$/i.test(sourceAtlasName) ? 'bc7' :
      /\.bc3$/i.test(sourceAtlasName) ? 'bc3' : 'webp')).toLowerCase();
    var previewAtlasName = String(animation && animation.atlas && animation.atlas.file || 'uclient-atlas.webp');
    if (!/^[^\\/:*?"<>|]+$/.test(previewAtlasName)) throw new Error('UClientFtr preview atlas name is invalid');
    var previewAtlasFile = path.join(previewRoot, previewAtlasName);
    var atlasStat = await fs.promises.stat(atlasFile);
    var battleTemplateBuffer = await fs.promises.readFile(
      path.join(moduleDirectory, 'uclient-ftr-battle-template.swf'));
    var battleTemplateSha256 = crypto.createHash('sha256').update(battleTemplateBuffer)
      .digest('hex').toUpperCase();
    if (battleTemplateSha256 !== UClientFtr_BATTLE_TEMPLATE_SHA256) {
      throw new Error('UClientFtr battle template violates the direct-Shape display-tree contract');
    }
    if (!force) {
      try {
        var marker = JSON.parse(await fs.promises.readFile(markerFile, 'utf8'));
        if (marker && marker.version === UClientFtr_FLASH_ASSET_VERSION &&
            Number(marker.modelScaleFactor) === UClientFtr_BATTLE_MODEL_SCALE_FACTOR &&
            marker.modelScalePolicy === UClientFtr_BATTLE_MODEL_SCALE_POLICY &&
            Number(marker.sceneUnitScale) === UClientFtr_BATTLE_SCENE_UNIT_SCALE &&
            Number(marker.templateVersion) === UClientFtr_BATTLE_TEMPLATE_VERSION &&
            String(marker.templateSha256 || '').toUpperCase() === battleTemplateSha256 &&
            String(marker.sceneRoutePolicy || '') === UClientFtr_SCENE_ROUTE_POLICY &&
            Number(marker.outputScale) === UClientFtr_FLASH_OUTPUT_SCALE &&
            String(marker.qualityPolicy || '') === UClientFtr_FLASH_QUALITY_POLICY &&
            String(marker.residencyPolicy || '') === UClientFtr_FLASH_RESIDENCY_POLICY &&
            Number(marker.residencyRequestedPixels) > 0 &&
            Number(marker.residencyTargetPixels) >= Number(marker.residencyRequestedPixels) &&
            /^(?:temporal-first-use-adaptive|global-height-shelf-lossless-fallback)$/.test(
              String(marker.residencyPackingStrategy || '')) &&
            marker.animationBytes === animationStat.size &&
            marker.atlasBytes === atlasStat.size && fs.existsSync(outputFile) &&
            ((atlasFormat !== 'bc7' && atlasFormat !== 'bc3') || fs.existsSync(previewAtlasFile)) &&
            Array.isArray(marker.pages) && marker.pages.every(function(page) {
              return page && Number(page.width) >= 1 && Number(page.width) <= MAX_FLASH_ATLAS_EDGE &&
                Number(page.height) >= 1 && Number(page.height) <= MAX_FLASH_ATLAS_EDGE &&
                /^[\w.-]+\.lossless\.zlib$/i.test(String(page.losslessFile || '')) &&
                fs.existsSync(path.join(previewRoot, page.losslessFile));
            })) {
          if (fs.existsSync(outputFile)) {
            var existingManifest = JSON.parse(await fs.promises.readFile(outputFile, 'utf8'));
            var existingStandby = Array.isArray(existingManifest.sequences) &&
              (existingManifest.sequences.find(function(s) { return s.name === 'standby'; }) || existingManifest.sequences[0]);
            if (existingStandby && Array.isArray(existingStandby.bounds)) {
              var corrected = computeVisibleSequenceBounds(existingStandby, existingManifest.regions);
              if (corrected !== existingStandby.bounds) {
                throw new Error('cached flash-animation bounds contain phantom extremes');
              }
            }
          }
          return marker;
        }
      } catch(_) {}
    }

    var atlasWidth = Number(sourceAtlas.width || 0);
    var atlasHeight = Number(sourceAtlas.height || 0);
    if (!atlasWidth || !atlasHeight) throw new Error('UClientFtr atlas dimensions are missing');

    function decodeRegion(firstValue, secondValue) {
      var first = Number(firstValue) >>> 0;
      var second = Number(secondValue) >>> 0;
      var u0 = ((first >>> 16) & 65535) / 65535;
      var v0 = (first & 65535) / 65535;
      var u1 = ((second >>> 16) & 65535) / 65535;
      var v1 = (second & 65535) / 65535;
      var x0 = Math.max(0, Math.min(atlasWidth - 1, Math.round(u0 * atlasWidth)));
      var y0 = Math.max(0, Math.min(atlasHeight - 1, Math.round((1 - v1) * atlasHeight)));
      var x1 = Math.max(x0 + 1, Math.min(atlasWidth, Math.round(u1 * atlasWidth)));
      var y1 = Math.max(y0 + 1, Math.min(atlasHeight, Math.round((1 - v0) * atlasHeight)));
      return { sx:x0, sy:y0, w:x1 - x0, h:y1 - y0 };
    }

    var regions = [];
    var regionByUv = new Map();
    function signed16(value) {
      value = Number(value) & 65535;
      return value > 32767 ? value - 65536 : value;
    }
    function frameQuadOpacities(frame, quadCount) {
      var colors = Array.isArray(frame && frame.m) ? frame.m : [];
      var output = new Array(quadCount);
      for (var quad = 0; quad < quadCount; quad++) {
        var packedIndex = quad * 2 + 1;
        var opacity = packedIndex < colors.length ? signed16(colors[packedIndex]) / 512 : 1;
        output[quad] = Math.max(0, Math.min(255, Math.round(opacity * 255)));
      }
      return output;
    }
    var flashSequences = (animation.sequences || []).map(function(sequence) {
      return {
        name:String(sequence.name || '').toLowerCase(),
        bounds:Array.isArray(sequence.bounds) ? sequence.bounds.slice(0, 4) : [0, 0, 1, 1],
        frames:(sequence.frames || []).map(function(frame) {
          var uv = Array.isArray(frame.u) ? frame.u : [];
          var frameRegions = [];
          for (var uvIndex = 0; uvIndex + 1 < uv.length; uvIndex += 2) {
            var uvKey = (Number(uv[uvIndex]) >>> 0) + ':' + (Number(uv[uvIndex + 1]) >>> 0);
            var regionIndex = regionByUv.get(uvKey);
            if (regionIndex == null) {
              regionIndex = regions.length;
              regionByUv.set(uvKey, regionIndex);
              regions.push(Object.assign({ index:regionIndex }, decodeRegion(uv[uvIndex], uv[uvIndex + 1])));
            }
            frameRegions.push(regionIndex);
          }
          return {
            v:Array.isArray(frame.v) ? frame.v : [],
            r:frameRegions,
            o:frameQuadOpacities(frame, frameRegions.length),
            s:Array.isArray(frame.s) ? frame.s : [],
            b:Array.isArray(frame.b) ? frame.b : [],
            l:Array.isArray(frame.l) ? frame.l : [],
          };
        }),
      };
    }).filter(function(sequence) { return sequence.name && sequence.frames.length; });
    if (!flashSequences.length || !regions.length) {
      throw new Error('UClientFtr animation contains no Flash-renderable mesh regions');
    }

    flashSequences.forEach(function(sequence) {
      sequence.bounds = computeVisibleSequenceBounds(sequence, regions);
    });

    var padding = 2;
    // The converter must preserve source pixels.  A lower outputScale would
    // make the final DefineBitsLossless2 bitmap smaller but visibly blur the
    // model; it is therefore forbidden.  Capacity is solved by temporal page
    // packing (up to 64 pages, each within Flash's 4095px boundary).  If the
    // source cannot fit at 1.0, fail explicitly instead of silently producing
    // a degraded fallback.
    var outputScale = UClientFtr_FLASH_OUTPUT_SCALE;
    var maximumPackingEdge = MAX_FLASH_ATLAS_EDGE;

    // Preserve source pixels and group by action/adjacent-frame windows.  The
    // first-use order is only a deterministic tie breaker; the resulting
    // residencyPlan below records exactly which pages each action window uses.
    // Hosts can therefore prefetch the next window and release pages that have
    // left the active window without pinning every source atlas page.
    regions.forEach(function(region) {
      region.firstUse = Number.MAX_SAFE_INTEGER;
      region.actionWindows = new Set();
    });
    flashSequences.forEach(function(sequence, sequenceIndex) {
      sequence.frames.forEach(function(frame, frameIndex) {
        var windowKey = sequence.name + '#' + Math.floor(frameIndex / 8);
        frame.r.forEach(function(regionIndex) {
          regions[regionIndex].firstUse = Math.min(regions[regionIndex].firstUse,
            sequenceIndex * 100000 + Math.floor(frameIndex / 8));
          regions[regionIndex].actionWindows.add(windowKey);
        });
      });
    });
    var atlasPlan = planUClientFtrLosslessAtlasPages(regions, {
      maximumPages:MAX_FLASH_ATLAS_PAGES,
      maximumEdge:maximumPackingEdge,
      padding:padding,
      outputScale:outputScale,
      requestedPixels:UClientFtr_FLASH_RESIDENCY_TARGET_PIXELS,
    });
    var targetOutputPixels = atlasPlan.requestedPixels;
    var effectiveOutputPixels = atlasPlan.effectivePixels;
    var residencyPackingStrategy = atlasPlan.strategy;
    var pages = atlasPlan.layouts.map(function(layout, pageIndex) {
      layout.placements.forEach(function(placement) {
        placement.region.page = pageIndex;
        placement.region.x = placement.x;
        placement.region.y = placement.y;
      });
      return { index:pageIndex, usedWidth:layout.usedWidth, usedHeight:layout.usedHeight };
    });
    var pageDefinitions = await renderUClientFtrPetFlashAtlasPages({
      atlasFile:atlasFile,
      atlasFormat:atlasFormat,
      previewFile:previewAtlasFile,
      atlasWidth:atlasWidth,
      atlasHeight:atlasHeight,
      previewRoot:previewRoot,
      padding:padding,
      outputScale:outputScale,
      pages:pages.map(function(page) {
        return { index:page.index, width:Math.max(1, page.usedWidth), height:Math.max(1, page.usedHeight) };
      }),
      regions:regions.map(function(region) {
        return { page:region.page, sx:region.sx, sy:region.sy, w:region.w, h:region.h, x:region.x, y:region.y };
      }),
    });
    pageDefinitions.forEach(function(page) {
      if (Number(page.scaleX || 1) !== UClientFtr_FLASH_OUTPUT_SCALE ||
          Number(page.scaleY || 1) !== UClientFtr_FLASH_OUTPUT_SCALE) {
        throw new Error('UClientFtr converter returned a downsampled atlas page');
      }
    });
    var pageScaleByIndex = new Map(pageDefinitions.map(function(page, index) {
      return [index, { x:Number(page.scaleX || 1), y:Number(page.scaleY || 1) }];
    }));
    regions.forEach(function(region) {
      var scale = pageScaleByIndex.get(region.page) || { x:1, y:1 };
      region.x = Math.round(region.x * scale.x * 10000) / 10000;
      region.y = Math.round(region.y * scale.y * 10000) / 10000;
      region.w = Math.round(region.w * scale.x * 10000) / 10000;
      region.h = Math.round(region.h * scale.y * 10000) / 10000;
    });
    var flashBytes = pageDefinitions.reduce(function(total, page) {
      return total + Number(page.bytes || 0) + Number(page.losslessBytes || 0);
    }, 0);
    var residencyPlan = flashSequences.map(function(sequence) {
      var windows = [];
      for (var frameIndex = 0; frameIndex < sequence.frames.length; frameIndex += 8) {
        var pageSet = new Set();
        sequence.frames.slice(frameIndex, frameIndex + 8).forEach(function(frame) {
          frame.r.forEach(function(regionIndex) {
            var region = regions[regionIndex];
            if (region && Number.isInteger(region.page)) pageSet.add(region.page);
          });
        });
        windows.push({
          startFrame:frameIndex,
          endFrame:Math.min(sequence.frames.length - 1, frameIndex + 7),
          pages:Array.from(pageSet).sort(function(a, b) { return a - b; }),
        });
      }
      return { action:sequence.name, windowSize:8, windows:windows };
    });

    var standby = flashSequences.find(function(sequence) { return sequence.name === 'standby'; }) || flashSequences[0];
    var standbyBounds = standby.bounds;
    var modelScaleSelection = computeUClientFtrBattleModelScale(standbyBounds);
    var modelScale = modelScaleSelection.modelScale;
    var flashAnimation = {
      version:UClientFtr_FLASH_ASSET_VERSION,
      sourceId:Number(animation.sourceId || 0),
      frameRate:Number(animation.frameRate || 24),
      modelScale:modelScale,
      anchorOffsetY:modelScaleSelection.anchorOffsetY,
      sceneRoutePolicy:UClientFtr_SCENE_ROUTE_POLICY,
      pages:pageDefinitions.map(function(page) { return { file:page.file, width:page.width, height:page.height }; }),
      regions:regions.map(function(region) {
        return { page:region.page, x:region.x, y:region.y, w:region.w, h:region.h };
      }),
      qualityPolicy:UClientFtr_FLASH_QUALITY_POLICY,
      residencyPolicy:UClientFtr_FLASH_RESIDENCY_POLICY,
      outputScale:UClientFtr_FLASH_OUTPUT_SCALE,
      residencyPlan:residencyPlan,
      sequences:flashSequences,
    };
    var outputBuffer = Buffer.from(JSON.stringify(flashAnimation), 'utf8');
    await writeAtomic(outputFile, outputBuffer);
    flashBytes += outputBuffer.length;
    var markerOutput = {
      version:UClientFtr_FLASH_ASSET_VERSION,
      modelScaleFactor:UClientFtr_BATTLE_MODEL_SCALE_FACTOR,
      modelScalePolicy:modelScaleSelection.policy,
      sceneUnitScale:modelScaleSelection.sceneUnitScale,
      fittedUnitScale:modelScaleSelection.fittedUnitScale,
      fittedModelScale:modelScaleSelection.fittedModelScale,
      selectedUnitScale:modelScaleSelection.selectedUnitScale,
      standbyWidth:modelScaleSelection.standbyWidth,
      standbyHeight:modelScaleSelection.standbyHeight,
      modelScale:modelScale,
      scaleFloorDelta:modelScaleSelection.scaleFloorDelta,
      anchorOffsetY:modelScaleSelection.anchorOffsetY,
      templateVersion:UClientFtr_BATTLE_TEMPLATE_VERSION,
      templateSha256:battleTemplateSha256,
      sceneRoutePolicy:UClientFtr_SCENE_ROUTE_POLICY,
      animationBytes:animationStat.size,
      atlasBytes:atlasStat.size,
      flashBytes:flashBytes,
      actions:flashSequences.map(function(sequence) { return sequence.name; }),
      pages:pageDefinitions,
      converter:pageDefinitions.converter || null,
      qualityPolicy:UClientFtr_FLASH_QUALITY_POLICY,
      residencyPolicy:UClientFtr_FLASH_RESIDENCY_POLICY,
      residencyRequestedPixels:targetOutputPixels,
      residencyTargetPixels:effectiveOutputPixels,
      residencyPackingStrategy:residencyPackingStrategy,
      outputScale:UClientFtr_FLASH_OUTPUT_SCALE,
      residencyPlan:residencyPlan,
    };
    await writeAtomic(markerFile, Buffer.from(JSON.stringify(markerOutput, null, 2), 'utf8'));
    return markerOutput;
  }

  return {
    resolveCustomSkinsFile:resolveCustomSkinsFile,
    resolveUClientFtrNativeAtlasConverter:resolveUClientFtrNativeAtlasConverter,
    renderUClientFtrPetFlashAtlasPages:renderUClientFtrPetFlashAtlasPages,
    readSwfTags:readSwfTags,
    encodeSwfTag:encodeSwfTag,
    swfSymbolClasses:swfSymbolClasses,
    buildUClientFtrPetBattleSwf:buildUClientFtrPetBattleSwf,
    buildUClientFtrFollowSwf:buildUClientFtrFollowSwf,
    ensureUClientSpineFlashAssets:ensureUClientSpineFlashAssets,
    buildUClientSpineBattleSwf:buildUClientSpineBattleSwf,
    resolveUClientVideoRemuxer:resolveUClientVideoRemuxer,
    buildUClientVideoSkillSwf:buildUClientVideoSkillSwf,
    buildUClientFtrPetBattleAssetsIsolated:buildUClientFtrPetBattleAssetsIsolated,
    validateUClientFtrPetCompactDownload:validateUClientFtrPetCompactDownload,
    reconcileCachedUClientSpineSkillTimeline:reconcileCachedUClientSpineSkillTimeline,
    compactUClientFtrPetDownloadArtifacts:compactUClientFtrPetDownloadArtifacts,
    ensureUClientFtrPetFlashAssets:ensureUClientFtrPetFlashAssets,
  };
}

module.exports = {
  UClientFtr_FLASH_ASSET_VERSION:UClientFtr_FLASH_ASSET_VERSION,
  UClientFtr_BATTLE_TEMPLATE_VERSION:UClientFtr_BATTLE_TEMPLATE_VERSION,
  UClientFtr_FOLLOW_TEMPLATE_VERSION:UClientFtr_FOLLOW_TEMPLATE_VERSION,
  UCLIENT_SPINE_TEMPLATE_VERSION:UCLIENT_SPINE_TEMPLATE_VERSION,
  UCLIENT_VIDEO_TEMPLATE_VERSION:UCLIENT_VIDEO_TEMPLATE_VERSION,
  UClientFtr_BATTLE_MODEL_SCALE_FACTOR:UClientFtr_BATTLE_MODEL_SCALE_FACTOR,
  UClientFtr_BATTLE_SCENE_UNIT_SCALE:UClientFtr_BATTLE_SCENE_UNIT_SCALE,
  UClientFtr_BATTLE_MODEL_SCALE_POLICY:UClientFtr_BATTLE_MODEL_SCALE_POLICY,
  MAX_FLASH_ATLAS_PAGES:MAX_FLASH_ATLAS_PAGES,
  MAX_FLASH_ATLAS_EDGE:MAX_FLASH_ATLAS_EDGE,
  UClientFtr_FLASH_QUALITY_POLICY:UClientFtr_FLASH_QUALITY_POLICY,
  UClientFtr_FLASH_RESIDENCY_POLICY:UClientFtr_FLASH_RESIDENCY_POLICY,
  UClientFtr_FLASH_OUTPUT_SCALE:UClientFtr_FLASH_OUTPUT_SCALE,
  UClientFtr_SCENE_ROUTE_POLICY:UClientFtr_SCENE_ROUTE_POLICY,
  UClientFtr_BATTLE_TEMPLATE_SHA256:UClientFtr_BATTLE_TEMPLATE_SHA256,
  computeUClientFtrBattleModelScale:computeUClientFtrBattleModelScale,
  computeVisibleSequenceBounds:computeVisibleSequenceBounds,
  planUClientFtrLosslessAtlasPages:planUClientFtrLosslessAtlasPages,
  createUClientFtrFlashPipeline:createUClientFtrFlashPipeline,
};
