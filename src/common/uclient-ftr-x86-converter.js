'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

function safeInteger(value, minimum, maximum, label) {
  var number = Number(value);
  if (!Number.isFinite(number)) throw new Error(label + ' is not finite');
  number = Math.round(number);
  if (number < minimum || number > maximum) throw new Error(label + ' is out of range');
  return number;
}

async function replaceFile(source, target) {
  try { await fs.promises.unlink(target); } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  await fs.promises.rename(source, target);
}

function runConverter(executable, argumentsList, timeoutMilliseconds) {
  return new Promise(function(resolve, reject) {
    var child = spawn(executable, argumentsList, {
      windowsHide:true,
      stdio:['ignore', 'pipe', 'pipe'],
    });
    var output = '';
    var settled = false;
    var timeout = setTimeout(function() {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch(_) {}
      reject(new Error('native UClientFtr atlas conversion timed out'));
    }, timeoutMilliseconds);
    function capture(chunk) {
      output = (output + String(chunk || '')).slice(-16384);
    }
    if (child.stdout) child.stdout.on('data', capture);
    if (child.stderr) child.stderr.on('data', capture);
    child.once('error', function(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', function(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error('native UClientFtr atlas converter failed (' + code +
          (signal ? ', ' + signal : '') + ')' + (output.trim() ? ': ' + output.trim() : '')));
      } else resolve();
    });
  });
}

async function removeTemporaryDirectory(directory) {
  var entries = [];
  try { entries = await fs.promises.readdir(directory, { withFileTypes:true }); }
  catch (error) { if (error && error.code === 'ENOENT') return; throw error; }
  for (var index = 0; index < entries.length; index++) {
    var entry = entries[index];
    var target = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeTemporaryDirectory(target);
    else await fs.promises.unlink(target).catch(function(error) {
      if (!error || error.code !== 'ENOENT') throw error;
    });
  }
  await fs.promises.rmdir(directory).catch(function(error) {
    if (!error || error.code !== 'ENOENT') throw error;
  });
}

function cleanupDelay(milliseconds) {
  return new Promise(function(resolve) { setTimeout(resolve, milliseconds); });
}

async function removeTemporaryDirectoryWithRetry(directory) {
  var lastError = null;
  for (var attempt = 0; attempt < 12; attempt++) {
    try {
      await removeTemporaryDirectory(directory);
      return;
    } catch (error) {
      lastError = error;
      // Antivirus/indexing can briefly retain a just-closed 60+ MiB page on
      // Windows.  Retrying cleanup changes no conversion output and prevents
      // repeated UClientFtr downloads from accumulating large raw working files.
      if (!error || ['EBUSY','EPERM','EACCES','ENOTEMPTY'].indexOf(error.code) < 0) throw error;
      await cleanupDelay(100 + attempt * 75);
    }
  }
  throw lastError;
}

function needsShortNativeWorkspace(payload) {
  if (process.platform !== 'win32') return false;
  var previewRoot = path.resolve(payload.previewRoot);
  var previewFile = path.resolve(payload.previewFile || path.join(previewRoot, 'uclient-atlas.png'));
  var atlasFile = path.resolve(payload.atlasFile);
  return atlasFile.length >= 236 || previewFile.length >= 236 || previewRoot.length + 72 >= 236;
}

async function convert(payload) {
  if (!payload || !payload.executable || !payload.atlasFile || !payload.previewRoot) {
    throw new Error('native UClientFtr atlas converter parameters are incomplete');
  }
  var expectedArchitecture = String(payload.expectedArchitecture ||
    (process.arch === 'x64' ? 'x64' : 'x86')).toLowerCase();
  if (expectedArchitecture !== 'x64' && expectedArchitecture !== 'x86') {
    throw new Error('native UClientFtr atlas converter architecture is unsupported');
  }
  var sourceWidth = safeInteger(payload.atlasWidth, 1, 16384, 'atlas width');
  var sourceHeight = safeInteger(payload.atlasHeight, 1, 16384, 'atlas height');
  var atlasFormat = String(payload.atlasFormat || 'webp').toLowerCase();
  if (atlasFormat !== 'webp' && atlasFormat !== 'bc7' && atlasFormat !== 'bc3') {
    throw new Error('unsupported native UClientFtr atlas format: ' + atlasFormat);
  }
  var scale = Number(payload.outputScale == null ? 1 : payload.outputScale);
  if (!isFinite(scale) || scale !== 1) {
    throw new Error('UClientFtr lossless atlas conversion requires outputScale=1');
  }
  var targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  var targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  var padding = Math.max(1, Math.round(safeInteger(payload.padding, 0, 32, 'padding') * scale));
  var inputPages = Array.isArray(payload.pages) ? payload.pages : [];
  var inputRegions = Array.isArray(payload.regions) ? payload.regions : [];
  var pageOffset = safeInteger(payload.pageOffset || 0, 0, 63, 'page offset');
  if (!inputPages.length || inputPages.length > 64 || !inputRegions.length) {
    throw new Error('native UClientFtr atlas conversion plan is empty or exceeds capacity');
  }
  if (pageOffset + inputPages.length > 64) {
    throw new Error('native UClientFtr atlas page offset exceeds capacity');
  }

  var pages = inputPages.map(function(page, index) {
    if (safeInteger(page.index, 0, 63, 'page index') !== index) {
      throw new Error('native UClientFtr atlas pages must be contiguous');
    }
    var sourcePageWidth = safeInteger(page.width, 1, 4095, 'page width');
    var sourcePageHeight = safeInteger(page.height, 1, 4095, 'page height');
    return {
      index:index,
      sourceWidth:sourcePageWidth,
      sourceHeight:sourcePageHeight,
      width:Math.max(1, Math.round(sourcePageWidth * scale)),
      height:Math.max(1, Math.round(sourcePageHeight * scale)),
    };
  });
  var regions = inputRegions.map(function(region, index) {
    var pageIndex = safeInteger(region.page, 0, pages.length - 1, 'region page');
    var width = Math.max(1, Math.round(safeInteger(region.w, 1, sourceWidth, 'region width') * scale));
    var height = Math.max(1, Math.round(safeInteger(region.h, 1, sourceHeight, 'region height') * scale));
    var sourceX = Math.round(safeInteger(region.sx, 0, sourceWidth - 1, 'region source x') * scale);
    var sourceY = Math.round(safeInteger(region.sy, 0, sourceHeight - 1, 'region source y') * scale);
    var destinationX = Math.round(safeInteger(region.x, 0, 4095, 'region destination x') * scale);
    var destinationY = Math.round(safeInteger(region.y, 0, 4095, 'region destination y') * scale);
    width = Math.min(width, targetWidth - sourceX, pages[pageIndex].width - destinationX);
    height = Math.min(height, targetHeight - sourceY, pages[pageIndex].height - destinationY);
    if (width < 1 || height < 1) throw new Error('scaled UClientFtr atlas region ' + index + ' is empty');
    return {
      index:index, page:pageIndex, sourceX:sourceX, sourceY:sourceY,
      width:width, height:height, destinationX:destinationX, destinationY:destinationY,
    };
  });

  var targetPreviewFile = path.resolve(payload.previewFile ||
    path.join(payload.previewRoot, 'uclient-atlas.png'));
  var shortNativeWorkspace = needsShortNativeWorkspace(payload);
  var temporaryRoot = shortNativeWorkspace
    ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'seer2-uclient-atlas-'))
    : path.join(path.resolve(payload.previewRoot),
      '.uclient-ftr-' + expectedArchitecture + '-atlas-' + process.pid + '-' +
        crypto.randomBytes(5).toString('hex'));
  if (!shortNativeWorkspace) await fs.promises.mkdir(temporaryRoot, { recursive:false });
  var nativeAtlasFile = path.resolve(payload.atlasFile);
  var nativePreviewFile = targetPreviewFile;
  if (shortNativeWorkspace) {
    nativeAtlasFile = path.join(temporaryRoot, 'source-atlas.bin');
    nativePreviewFile = path.join(temporaryRoot, 'uclient-atlas-preview.png');
    await fs.promises.copyFile(payload.atlasFile, nativeAtlasFile);
  }
  var planFile = path.join(temporaryRoot, 'conversion.plan');
  var resultFile = path.join(temporaryRoot, 'conversion-result.json');
  var planLines = [
    'UCLIENTFTRATLAS1',
    [sourceWidth, sourceHeight, targetWidth, targetHeight, padding, pages.length, regions.length].join(' '),
  ];
  pages.forEach(function(page) {
    planLines.push(['P', page.index, page.width, page.height].join(' '));
  });
  regions.forEach(function(region) {
    planLines.push(['R', region.index, region.sourceX, region.sourceY, region.width,
      region.height, region.page, region.destinationX, region.destinationY].join(' '));
  });
  await fs.promises.writeFile(planFile, planLines.join('\n') + '\n', 'ascii');

  try {
    var argumentsList = [
      '--atlas', nativeAtlasFile,
      '--atlas-format', atlasFormat,
      '--plan', planFile,
      '--output', temporaryRoot,
      '--result', resultFile,
      '--tile', String(safeInteger(payload.tileEdge || 1024, 256, 2048, 'tile edge')),
    ];
    if (atlasFormat === 'bc7' || atlasFormat === 'bc3') {
      argumentsList.push('--preview', nativePreviewFile);
    }
    await runConverter(path.resolve(payload.executable), argumentsList,
      Number(payload.timeoutMilliseconds) > 0 ? Number(payload.timeoutMilliseconds) : 600000);
    var converter = JSON.parse(await fs.promises.readFile(resultFile, 'utf8'));
    if (!converter || converter.ok !== true || converter.architecture !== expectedArchitecture) {
      throw new Error(expectedArchitecture + ' UClientFtr atlas converter returned an invalid result');
    }
    if (shortNativeWorkspace && (atlasFormat === 'bc7' || atlasFormat === 'bc3')) {
      await fs.promises.mkdir(path.dirname(targetPreviewFile), { recursive:true });
      var previewPartFile = targetPreviewFile + '.part';
      try {
        await fs.promises.copyFile(nativePreviewFile, previewPartFile);
        await replaceFile(previewPartFile, targetPreviewFile);
      } finally {
        try { await fs.promises.unlink(previewPartFile); } catch(_) {}
      }
    }
    // The native converter has already emitted every raw page to disk, so
    // zlib compression is the only remaining CPU-bound stage.  x32 remains at
    // two streams; x64 may use four without recreating unbounded batch pressure.
    // Preserve array order so the marker and final SWF remain byte-identical to
    // the historical sequential implementation.
    var definitions = new Array(pages.length);
    var nextPageIndex = 0;
    var firstCompressionError = null;
    async function compressNextPage() {
      while (!firstCompressionError) {
        var pageIndex = nextPageIndex++;
        if (pageIndex >= pages.length) return;
        var page = pages[pageIndex];
        var rawFile = path.join(temporaryRoot, 'flash-atlas-' + page.index + '.argb.raw');
        var outputPageIndex = pageOffset + page.index;
        var losslessFile = 'flash-atlas-' + outputPageIndex + '.lossless.zlib';
        var finalFile = path.join(payload.previewRoot, losslessFile);
        var partFile = finalFile + '.part';
        try {
          try {
            await pipelineAsync(fs.createReadStream(rawFile), zlib.createDeflate({ level:9 }),
              fs.createWriteStream(partFile, { flags:'w' }));
            await replaceFile(partFile, finalFile);
          } finally {
            try { await fs.promises.unlink(partFile); } catch(_) {}
          }
          var outputStat = await fs.promises.stat(finalFile);
          definitions[pageIndex] = {
            index:outputPageIndex,
            file:'', width:page.width, height:page.height, bytes:0,
            sourceWidth:page.sourceWidth, sourceHeight:page.sourceHeight,
            scaleX:page.width / page.sourceWidth, scaleY:page.height / page.sourceHeight,
            losslessFile:losslessFile, losslessBytes:outputStat.size,
          };
        } catch (error) {
          if (!firstCompressionError) firstCompressionError = error;
          return;
        }
      }
    }
    var compressionWorkers = [];
    var requestedCompressionConcurrency = safeInteger(
      payload.compressionConcurrency == null ? 2 : payload.compressionConcurrency,
      1, 4, 'compression concurrency');
    var compressionConcurrency = Math.min(requestedCompressionConcurrency, pages.length);
    for (var compressionWorker = 0; compressionWorker < compressionConcurrency; compressionWorker++) {
      compressionWorkers.push(compressNextPage());
    }
    // Workers capture their first error instead of rejecting early.  Waiting for
    // both streams to settle prevents the outer finally from deleting raw pages
    // while the other worker is still reading or writing its part file.
    await Promise.all(compressionWorkers);
    if (firstCompressionError) throw firstCompressionError;
    Object.defineProperty(definitions, 'converter', { value:converter, enumerable:false });
    return definitions;
  } finally {
    await removeTemporaryDirectoryWithRetry(temporaryRoot).catch(function() {});
  }
}

module.exports = { convert:convert };
