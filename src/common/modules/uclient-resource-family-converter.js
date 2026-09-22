'use strict';

// v3 records the exact native-video timeline contract so a stale v3-era
// 1600x900 event SWF cannot be embedded into a newly lossless fight build.
const EVENT_VIDEO_BUILD_VERSION = 3;
const MAX_EVENT_VIDEO_CLIPS = 8;
const MAX_EVENT_VIDEO_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_VIDEO_NATIVE_BYTES = 128 * 1024 * 1024;

function createUClientResourceFamilyConverter(dependencies) {
  const fs = dependencies.fs;
  const path = dependencies.path;
  const crypto = dependencies.crypto;
  const processRef = dependencies.process;
  const resourceAdapter = dependencies.resourceAdapter;
  const fetchBuffer = dependencies.fetchBuffer;
  const runExtractor = dependencies.runExtractor;
  const nativeVideo = dependencies.nativeVideo;
  const writeAtomic = dependencies.writeAtomic;

  function safeLeaf(value) {
    return String(value || '').replace(/[^0-9A-Za-z._-]+/g,'_').slice(0,96);
  }
  function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
  }
  function logicalVideoPath(value) {
    const normalized = String(value || '').replace(/\\/g,'/').toLowerCase().trim();
    return normalized.endsWith('.m4v') ? normalized.slice(0,-4) + '.mp4' : normalized;
  }
  function eventVideoArtifactLeaves() {
    const leaves = [];
    for (let slot = 0; slot < MAX_EVENT_VIDEO_CLIPS; slot++) {
      leaves.push('event-video-slot-' + slot + '.swf');
    }
    leaves.push('uclient-event-videos.json');
    return leaves;
  }
  function resolvePreviewArtifact(previewRoot, leaf) {
    const target = path.resolve(previewRoot,leaf);
    const relative = path.relative(previewRoot,target);
    if (!relative || path.isAbsolute(relative) || relative === '..' ||
        relative.indexOf('..' + path.sep) === 0 || relative !== leaf) {
      throw new Error('U-client FTR event video cleanup target escaped the preview root: ' + leaf);
    }
    return target;
  }
  async function cleanupEventVideoArtifacts(previewRoot) {
    // Resolve and validate every fixed target before deleting anything.  The
    // manifest is removed last so a partial cleanup cannot look complete.
    const leaves = eventVideoArtifactLeaves();
    const targets = leaves.map(function(leaf) {
      return { leaf:leaf,target:resolvePreviewArtifact(previewRoot,leaf) };
    });
    const removedFiles = [];
    const alreadyAbsentFiles = [];
    for (const item of targets) {
      try {
        await fs.promises.unlink(item.target);
        removedFiles.push(item.leaf);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          alreadyAbsentFiles.push(item.leaf);
          continue;
        }
        throw new Error('U-client FTR event video cleanup failed for ' + item.leaf + ': ' +
          String(error && error.message || error));
      }
    }
    return {
      completed:true,
      policy:'exact-preview-root-event-video-artifacts-v1',
      removedFiles:removedFiles,
      alreadyAbsentFiles:alreadyAbsentFiles,
      removedCount:removedFiles.length,
      alreadyAbsentCount:alreadyAbsentFiles.length,
      managedFileCount:targets.length,
    };
  }
  async function removeTree(target) {
    // fs.rmdir({recursive:true}) is deprecated and is removed by newer Node
    // runtimes.  Conversion cleanup must remain best-effort, but it should use
    // the supported recursive primitive so a future Electron runtime does not
    // leave large event-video work trees behind after every download.
    try { await fs.promises.rmdir(target,{recursive:true}); }
    catch (_) {}
  }

  async function prepareFtrEventVideos(plan, context) {
    context = context || {};
    const previewRootInput = String(context.previewRoot || '').trim();
    const previewRoot = previewRootInput ? path.resolve(previewRootInput) : '';
    if (!previewRoot || previewRoot === path.parse(previewRoot).root || !plan ||
        Number(plan.version) !== 2 || !(Number(plan.ownerId) > 0)) {
      throw new Error('U-client FTR event video conversion plan is invalid');
    }
    if (Array.isArray(plan.unsupportedRequiredFamilies) && plan.unsupportedRequiredFamilies.length) {
      throw new Error('U-client FTR contains unsupported required resource families: ' +
        plan.unsupportedRequiredFamilies.join(', '));
    }
    const required = Array.isArray(plan.standardEventVideos) ? plan.standardEventVideos : [];
    if (!required.length) {
      const cleanup = await cleanupEventVideoArtifacts(previewRoot);
      return {
        version:EVENT_VIDEO_BUILD_VERSION,ownerId:Number(plan.ownerId),
        converted:true,clips:[],triggers:[],requiredResourceCount:0,
        cleanup:cleanup,
      };
    }
    if (required.length > MAX_EVENT_VIDEO_CLIPS) {
      throw new Error('U-client FTR event video count exceeds the x32 embedding capacity');
    }
    const slotByAssetPath = new Map(required.slice().sort(function(a,b) {
      return String(a.assetPath || '').localeCompare(String(b.assetPath || ''));
    }).map(function(item,index) { return [String(item.assetPath || '').toLowerCase(),index]; }));
    const workRoot = path.join(previewRoot,'.event-video-work-' + processRef.pid + '-' +
      crypto.randomBytes(5).toString('hex'));
    await fs.promises.mkdir(workRoot,{recursive:true});
    const extractedByAsset = new Map();
    const outputs = [];
    let downloadedSourceBytes = 0;
    let nativeBytes = 0;
    try {
      const execution = await resourceAdapter.executeResourcePlan(plan,{
        downloadBundle:async function(record) {
          const buffer = await fetchBuffer(String(record.url || ''),90000,0,
            Math.min(MAX_EVENT_VIDEO_SOURCE_BYTES,Number(record.bytes || 0) + 1024),context.onProgress);
          if (buffer.length !== Number(record.bytes || 0)) {
            throw new Error('U-client event video bundle size does not match its credential');
          }
          downloadedSourceBytes += buffer.length;
          if (downloadedSourceBytes > MAX_EVENT_VIDEO_SOURCE_BYTES) {
            throw new Error('U-client event video bundle set exceeds the x32 conversion bound');
          }
          return buffer;
        },
        extractAsset:async function(request) {
          const evidence = request.evidence || {};
          const key = String(evidence.assetPath || '').toLowerCase();
          const slot = slotByAssetPath.get(key);
          if (slot == null) throw new Error('U-client event video has no deterministic embed slot');
          const clipRoot = path.join(workRoot,'clip-' + slot + '-' + safeLeaf(evidence.clip));
          await fs.promises.mkdir(clipRoot,{recursive:true});
          const bundleFile = path.join(clipRoot,'video.bundle');
          await writeAtomic(bundleFile,request.buffer);
          const dependencyFiles = [];
          for (let index = 0; index < request.dependencies.length; index++) {
            const dependencyFile = path.join(clipRoot,'dependency-' + index + '.bundle');
            await writeAtomic(dependencyFile,request.dependencies[index]);
            dependencyFiles.push(dependencyFile);
          }
          const extracted = await runExtractor(bundleFile,clipRoot,plan.ownerId,dependencyFiles,{
            mode:'video',assetPath:String(evidence.assetPath || ''),
          });
          const internalPath = logicalVideoPath(extracted &&
            (extracted.internalAssetPath || extracted.assetPath));
          if (!extracted || internalPath !== logicalVideoPath(key)) {
            throw new Error('U-client event video extractor returned the wrong official asset');
          }
          const value = Object.assign({},extracted,{
            assetPath:String(evidence.assetPath || ''),
            extractedAssetPath:String(extracted.internalAssetPath || extracted.assetPath || ''),
            mp4File:path.join(clipRoot,String(extracted.file || 'uclient-video.mp4')),
            clipRoot:clipRoot,slot:slot,
          });
          extractedByAsset.set(key,value);
          return value;
        },
        convertVideo:async function(request) {
          const evidence = request.evidence || {};
          const key = String(evidence.assetPath || '').toLowerCase();
          const extracted = extractedByAsset.get(key);
          if (!extracted) throw new Error('U-client event video extraction state is missing');
          const nativeFile = path.join(workRoot,'event-video-slot-' + extracted.slot + '.swf');
          const built = await nativeVideo.build(extracted.mp4File,nativeFile,extracted);
          nativeBytes += Number(built.bytes || 0);
          if (nativeBytes > MAX_EVENT_VIDEO_NATIVE_BYTES) {
            throw new Error('U-client embedded event video set exceeds the x32 native SWF bound');
          }
          const triggers = (request.triggers || []).map(function(trigger) {
            return {
              action:String(trigger.action || '').toLowerCase(),frame:Number(trigger.frame),
              label:String(trigger.label || ''),clip:String(trigger.clip || ''),
            };
          });
          const output = Object.assign({},built,{
            converted:true,slot:extracted.slot,clip:String(evidence.clip || ''),
            assetPath:String(evidence.assetPath || ''),internalAssetPath:extracted.extractedAssetPath,
            bundleFileHash:String(evidence.fileHash || '').toLowerCase(),
            bundleBytes:Number(evidence.bytes || 0),bundleSha256:String(request.bundleSha256 || ''),
            packageKey:String(evidence.packageKey || ''),triggers:triggers,
          });
          outputs.push(output);
          return output;
        },
      });
      if (!execution.conversionComplete || outputs.length !== required.length) {
        throw new Error('U-client FTR event video conversion did not close every required clip');
      }
      outputs.sort(function(a,b) { return a.slot - b.slot; });
      const clips = [];
      for (const output of outputs) {
        const nativeName = 'event-video-slot-' + output.slot + '.swf';
        const nativeBuffer = await fs.promises.readFile(output.file);
        if (nativeBuffer.length !== Number(output.bytes) || sha256(nativeBuffer) !== String(output.sha256)) {
          throw new Error('U-client FTR event video native SWF changed before commit');
        }
        await writeAtomic(path.join(previewRoot,nativeName),nativeBuffer);
        clips.push({
          slot:output.slot,clip:output.clip,assetPath:output.assetPath,
          internalAssetPath:output.internalAssetPath,nativeFile:nativeName,
          nativeBytes:output.bytes,nativeSha256:output.sha256,
          width:output.width,height:output.height,frameRate:output.frameRate,
          frameCount:output.frameCount,durationSeconds:output.durationSeconds,
          sourceBytes:output.sourceBytes,sourceSha256:output.sourceSha256,
          sourceMedia:output.sourceMedia,codec:output.codec,fitPolicy:output.fitPolicy,
          nativeTimelineVersion:Number(output.version || 0),
          audioPolicy:output.audioPolicy,qualityPolicy:output.qualityPolicy,
          ffmpegSha256:output.ffmpegSha256,ffmpegArgv:output.ffmpegArgv,
          swfAudit:output.swfAudit,bundleFileHash:output.bundleFileHash,
          bundleBytes:output.bundleBytes,bundleSha256:output.bundleSha256,
          packageKey:output.packageKey,triggers:output.triggers,
        });
      }
      const result = {
        version:EVENT_VIDEO_BUILD_VERSION,planVersion:Number(plan.version),
        nativeTimelineVersion:Number(nativeVideo.version || 0),
        ownerId:Number(plan.ownerId),converted:true,requiredResourceCount:required.length,
        downloadedBundles:Number(execution.downloadedBundles || 0),
        clips:clips,triggers:clips.reduce(function(all,item) { return all.concat(item.triggers); },[]),
        conversionPolicy:'ftr-event-label-freeze-native-avm2-flv1-mp3-embedded',
        preparedAt:new Date().toISOString(),
      };
      await writeAtomic(path.join(previewRoot,'uclient-event-videos.json'),
        Buffer.from(JSON.stringify(result,null,2),'utf8'));
      return result;
    } catch (error) {
      for (let slot = 0; slot < MAX_EVENT_VIDEO_CLIPS; slot++) {
        try { await fs.promises.unlink(path.join(previewRoot,'event-video-slot-' + slot + '.swf')); }
        catch (_) {}
      }
      try { await fs.promises.unlink(path.join(previewRoot,'uclient-event-videos.json')); }
      catch (_) {}
      throw error;
    } finally {
      await removeTree(workRoot);
    }
  }

  return {
    prepareFtrEventVideos:prepareFtrEventVideos,
    version:EVENT_VIDEO_BUILD_VERSION,maxClips:MAX_EVENT_VIDEO_CLIPS,
  };
}

module.exports = {
  EVENT_VIDEO_BUILD_VERSION:EVENT_VIDEO_BUILD_VERSION,
  MAX_EVENT_VIDEO_CLIPS:MAX_EVENT_VIDEO_CLIPS,
  createUClientResourceFamilyConverter:createUClientResourceFamilyConverter,
};
