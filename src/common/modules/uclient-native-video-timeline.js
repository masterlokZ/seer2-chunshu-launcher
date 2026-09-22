'use strict';

// v4 removes the last bounded downscale (the v3 1600x900 envelope).  The
// version bump forces already converted event-video artifacts to be rebuilt
// with native source dimensions instead of silently reusing a low-resolution
// SWF.
const NATIVE_VIDEO_TIMELINE_VERSION = 4;

function createUClientNativeVideoTimeline(dependencies) {
  const fs = dependencies.fs;
  const path = dependencies.path;
  const crypto = dependencies.crypto;
  const spawn = dependencies.spawn;
  const processRef = dependencies.process;

  function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
  }

  function sha256File(file) {
    return new Promise(function(resolve,reject) {
      const digest = crypto.createHash('sha256');
      const stream = fs.createReadStream(file,{highWaterMark:1024 * 1024});
      stream.on('data',function(chunk) { digest.update(chunk); });
      stream.on('error',reject);
      stream.on('end',function() { resolve(digest.digest('hex').toUpperCase()); });
    });
  }

  function resolveExecutable(name, environmentName) {
    const candidates = [];
    if (processRef.env[environmentName]) candidates.push(processRef.env[environmentName]);
    if (processRef.env.SEER_FFMPEG) {
      candidates.push(path.join(path.dirname(processRef.env.SEER_FFMPEG), name));
    }
    candidates.push(path.join('D:\\seer2-development-kit','tools','ffmpeg','bin',name));
    candidates.push(path.join('D:\\seer2-development-kit','downloads',
      'ffmpeg-release-essentials-20260812','ffmpeg-9.0.1-essentials_build','bin',name));
    return candidates.map(function(file) { return path.resolve(file); }).find(function(file) {
      try { return fs.existsSync(file); } catch (_) { return false; }
    }) || '';
  }

  function run(executable, args, timeoutMilliseconds) {
    return new Promise(function(resolve, reject) {
      let stdout = '';
      let stderr = '';
      const child = spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
      const timer = setTimeout(function() {
        try { child.kill(); } catch (_) {}
        reject(new Error('U-client native video tool timed out'));
      },timeoutMilliseconds);
      if (child.stdout) child.stdout.on('data',function(chunk) {
        stdout = (stdout + chunk.toString('utf8')).slice(-1024 * 1024);
      });
      if (child.stderr) child.stderr.on('data',function(chunk) {
        stderr = (stderr + chunk.toString('utf8')).slice(-1024 * 1024);
      });
      child.on('error',function(error) { clearTimeout(timer); reject(error); });
      child.on('close',function(code) {
        clearTimeout(timer);
        if (code !== 0) reject(new Error('U-client native video tool failed: ' + String(stderr || code)));
        else resolve({stdout:stdout,stderr:stderr});
      });
    });
  }

  function readSwf(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16 ||
        buffer.slice(0,3).toString('ascii') !== 'FWS') {
      throw new Error('U-client native video SWF must be an uncompressed FWS timeline');
    }
    const bits = buffer[8] >>> 3;
    const tagsOffset = 8 + Math.ceil((5 + bits * 4) / 8) + 4;
    const tags = [];
    let offset = tagsOffset;
    while (offset + 2 <= buffer.length) {
      const header = buffer.readUInt16LE(offset); offset += 2;
      const code = header >>> 6;
      let length = header & 63;
      if (length === 63) {
        if (offset + 4 > buffer.length) throw new Error('U-client native video SWF tag header is truncated');
        length = buffer.readUInt32LE(offset); offset += 4;
      }
      if (offset + length > buffer.length) throw new Error('U-client native video SWF tag is truncated');
      tags.push({code:code,body:buffer.slice(offset,offset + length)});
      offset += length;
      if (code === 0) break;
    }
    if (!tags.length || tags[tags.length - 1].code !== 0 || offset !== buffer.length) {
      throw new Error('U-client native video SWF has trailing or unterminated data');
    }
    return {version:buffer[3],tags:tags};
  }

  function auditSwf(buffer, expected) {
    const parsed = readSwf(buffer);
    const counts = {};
    parsed.tags.forEach(function(tag) { counts[tag.code] = (counts[tag.code] || 0) + 1; });
    const fileAttributes = parsed.tags.filter(function(tag) { return tag.code === 69; });
    const streams = parsed.tags.filter(function(tag) { return tag.code === 60; });
    const soundHeads = parsed.tags.filter(function(tag) { return tag.code === 45; });
    const soundBlocks = parsed.tags.filter(function(tag) { return tag.code === 19; });
    if (parsed.version < 9 || fileAttributes.length !== 1 || parsed.tags[0].code !== 69 ||
        fileAttributes[0].body.length !== 4 || (fileAttributes[0].body.readUInt32LE(0) & 8) === 0) {
      throw new Error('U-client native video SWF is not an AVM2 timeline');
    }
    if (streams.length !== 1 || streams[0].body.length !== 10 || streams[0].body[9] !== 2) {
      throw new Error('U-client native video SWF must contain exactly one FLV1 video stream');
    }
    const width = streams[0].body.readUInt16LE(4);
    const height = streams[0].body.readUInt16LE(6);
    const streamFrames = streams[0].body.readUInt16LE(2);
    const videoFrames = counts[61] || 0;
    const showFrames = counts[1] || 0;
    if (width !== expected.width || height !== expected.height ||
        streamFrames !== expected.frameCount || videoFrames !== expected.frameCount ||
        showFrames !== expected.frameCount || (counts[82] || 0) !== 0 ||
        (counts[12] || 0) !== 0 || (counts[59] || 0) !== 0) {
      throw new Error('U-client native video SWF frame or executable-code contract is invalid');
    }
    if (expected.audio === true) {
      if (soundHeads.length !== 1 || soundHeads[0].body.length < 2 ||
          (soundHeads[0].body[1] >>> 4) !== 2 || soundBlocks.length < 1) {
        throw new Error('U-client native video SWF MP3 stream contract is invalid');
      }
    } else if (soundHeads.length || soundBlocks.length) {
      throw new Error('U-client native video SWF contains unexpected audio tags');
    }
    return {
      version:parsed.version,width:width,height:height,frameCount:videoFrames,
      defineVideoStream:counts[60] || 0,videoFrames:videoFrames,
      placeObject2:counts[26] || 0,showFrames:showFrames,
      fileAttributes:fileAttributes.length,doAbc:counts[82] || 0,
      actionScript:counts[12] || 0,imports:counts[57] || 0,
      soundStreamHead2:soundHeads.length,soundStreamBlocks:soundBlocks.length,
      audioCodec:expected.audio === true ? 'mp3' : '',
    };
  }

  function rational(value) {
    const parts = String(value || '').split('/');
    const numerator = Number(parts[0]);
    const denominator = Number(parts[1] || 1);
    return denominator > 0 ? numerator / denominator : 0;
  }

  async function probe(input) {
    const executable = resolveExecutable('ffprobe.exe','SEER_FFPROBE');
    if (!executable) throw new Error('U-client video probe is missing');
    const result = await run(executable,[
      '-v','error','-show_entries',
      'stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,nb_frames,duration,sample_rate,channels:format=duration',
      '-of','json',input,
    ],60000);
    const document = JSON.parse(result.stdout || '{}');
    const streams = document && Array.isArray(document.streams) ? document.streams : [];
    const stream = streams.find(function(item) { return item && item.codec_type === 'video'; });
    const audioStreams = streams.filter(function(item) { return item && item.codec_type === 'audio'; });
    if (!stream) throw new Error('U-client video has no primary video stream');
    return {
      width:Number(stream.width || 0),height:Number(stream.height || 0),
      pixelFormat:String(stream.pix_fmt || ''),
      frameRate:rational(stream.avg_frame_rate || stream.r_frame_rate),
      frameCount:Number(stream.nb_frames || 0),
      durationSeconds:Number(stream.duration || document.format && document.format.duration || 0),
      audioTracks:audioStreams.length,
      audioCodec:audioStreams.length ? String(audioStreams[0].codec_name || '') : '',
      audioSampleRate:audioStreams.length ? Number(audioStreams[0].sample_rate || 0) : 0,
      audioChannels:audioStreams.length ? Number(audioStreams[0].channels || 0) : 0,
    };
  }

  async function build(input, output, metadata) {
    metadata = metadata || {};
    const inputStat = await fs.promises.stat(input);
    if (!inputStat.isFile() || inputStat.size < 12 || inputStat.size > 64 * 1024 * 1024) {
      throw new Error('U-client event video source size is outside the x32 bound');
    }
    const inputSha256 = await sha256File(input);
    if (inputStat.size !== Number(metadata.bytes || 0) ||
        inputSha256 !== String(metadata.sha256 || '').toUpperCase()) {
      throw new Error('U-client event video bytes do not match extracted metadata');
    }
    const media = await probe(input);
    const expectedRate = Number(metadata.frameRate || 0);
    const expectedFrames = Number(metadata.frameCount || 0);
    if (!(media.width > 0 && media.height > 0 && media.width <= 8192 && media.height <= 8192) ||
        !/^yuv420p$/i.test(media.pixelFormat) || !(media.frameRate >= 1 && media.frameRate <= 60) ||
        !(media.frameCount >= 2 && media.frameCount <= 1800) ||
        Math.abs(media.frameRate - expectedRate) > 0.01 || media.frameCount !== expectedFrames ||
        Math.abs(media.width - Number(metadata.width || 0)) > 0 ||
        Math.abs(media.height - Number(metadata.height || 0)) > 0 || media.audioTracks > 1 ||
        media.audioTracks !== Number(metadata.audioTracks || 0)) {
      throw new Error('U-client event video media metadata is unsupported or inconsistent');
    }
    const hasAudio = media.audioTracks === 1;
    const frameRate = Math.round(media.frameRate * 1000) / 1000;
    // Preserve the authored pixels.  The old fixed 1200x660 path stretched
    // the source and the v3 1600x900 envelope still downscaled wide videos
    // such as 1400691 (2800x1288).  Scaling the event video is a quality loss
    // that cannot be recovered by the Flash Video object's smoothing flag.
    // Keep the exact source dimensions, then let the AS3 template fit that native stream into
    // the logical 1200x660 stage without altering its aspect ratio.
    // yuv420p is chroma-subsampled and must already have even dimensions.  An
    // odd source is rejected instead of silently dropping its last row/column.
    if ((media.width & 1) !== 0 || (media.height & 1) !== 0) {
      throw new Error('U-client event video source dimensions must be even for lossless geometry');
    }
    const targetWidth = media.width;
    const targetHeight = media.height;
    const executable = resolveExecutable('ffmpeg.exe','SEER_FFMPEG');
    if (!executable) throw new Error('U-client native video converter is missing');
    const executableSha256 = await sha256File(executable);
    const temporary = output + '.part-' + processRef.pid;
    await fs.promises.mkdir(path.dirname(output),{recursive:true});
    try { await fs.promises.unlink(temporary); } catch (_) {}
    const args = [
      '-hide_banner','-nostdin','-loglevel','error','-i',input,
      '-map','0:v:0',
    ].concat(hasAudio ? ['-map','0:a:0'] : ['-an']).concat([
      '-sn','-dn','-map_metadata','-1','-map_chapters','-1',
      '-vf','fps=' + frameRate + ',format=yuv420p,setsar=1',
      '-r',String(frameRate),'-fps_mode','cfr','-frames:v',String(media.frameCount),
      '-c:v','flv','-q:v','1','-fflags','+bitexact','-flags:v','+bitexact',
    ]).concat(hasAudio ? ['-c:a','libmp3lame','-b:a','128k','-ar','44100','-ac','2'] : []).concat([
      '-f','avm2','-y',temporary,
    ]);
    try {
      await run(executable,args,180000);
      const outputBytes = await fs.promises.readFile(temporary);
      if (outputBytes.length < 256 || outputBytes.length > 96 * 1024 * 1024) {
        throw new Error('U-client native video SWF size is outside the x32 bound');
      }
      const audit = auditSwf(outputBytes,{
        width:targetWidth,height:targetHeight,frameCount:media.frameCount,audio:hasAudio,
      });
      try { await fs.promises.unlink(output); } catch (_) {}
      await fs.promises.rename(temporary,output);
      return {
        converted:true,version:NATIVE_VIDEO_TIMELINE_VERSION,file:output,
        bytes:outputBytes.length,sha256:sha256(outputBytes),
        sourceBytes:inputStat.size,sourceSha256:inputSha256,
        sourceMedia:media,frameRate:frameRate,frameCount:media.frameCount,
        durationSeconds:media.frameCount / frameRate,width:targetWidth,height:targetHeight,
        codec:'flv1',fitPolicy:'authored-aspect-native-no-downscale',
        audioPolicy:hasAudio ? 'stream-mp3-embedded' : 'video-only-no-source-audio',
        qualityPolicy:'resource-local-flv1-q1',
        ffmpegSha256:executableSha256,ffmpegArgv:args.slice(0,-1).concat(['<draft-native.swf>']),
        swfAudit:audit,
      };
    } finally {
      try { await fs.promises.unlink(temporary); } catch (_) {}
    }
  }

  return { probe:probe,build:build,auditSwf:auditSwf,version:NATIVE_VIDEO_TIMELINE_VERSION };
}

module.exports = {
  NATIVE_VIDEO_TIMELINE_VERSION:NATIVE_VIDEO_TIMELINE_VERSION,
  createUClientNativeVideoTimeline:createUClientNativeVideoTimeline,
};
