'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const catalog = require('../src/common/modules/uclient-resource-catalog.js');

function parseArguments(argv) {
  const result = { ownerId:0, outputRoot:'' };
  argv.forEach(function(argument) {
    let match = String(argument || '').match(/^--owner=(\d+)$/);
    if (match) result.ownerId = Number(match[1]);
    match = String(argument || '').match(/^--output=(.+)$/);
    if (match) result.outputRoot = path.resolve(match[1]);
  });
  if (!Number.isSafeInteger(result.ownerId) || result.ownerId <= 0) {
    throw new Error('Usage: node Fetch-UClientSkillTimelineBundles.js --owner=<positive-id> --output=<directory>');
  }
  if (!result.outputRoot) {
    throw new Error('A managed output directory is required with --output=<directory>');
  }
  return result;
}

function hash(data, algorithm) {
  return crypto.createHash(algorithm).update(data).digest('hex').toLowerCase();
}

async function fetchVerified(url, maximumBytes) {
  const response = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), {
    cache:'no-store',
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > maximumBytes) {
    throw new Error('unexpected response size for ' + url + ': ' + data.length);
  }
  return data;
}

async function loadLivePackage(input, outputRoot) {
  const urls = catalog.packageUrls(input.name);
  const version = (await fetchVerified(urls.version,1024)).toString('utf8')
    .replace(/^\uFEFF/,'').trim();
  if (!/^\d{8,20}$/.test(version)) throw new Error('invalid live version for ' + input.name);
  const manifestUrl = catalog.packageUrls(input.name,version).manifest;
  const manifestBytes = await fetchVerified(manifestUrl,16 * 1024 * 1024);
  const manifest = catalog.parseYooManifest(manifestBytes);
  if (manifest.packageName !== input.name || String(manifest.packageVersion) !== version) {
    throw new Error('live manifest identity mismatch for ' + input.name);
  }
  const manifestRoot = path.join(outputRoot,'manifests');
  await fs.promises.mkdir(manifestRoot,{recursive:true});
  const manifestPath = path.join(manifestRoot,
    'PackageManifest_' + input.name + '_' + version + '.bytes');
  await fs.promises.writeFile(manifestPath,manifestBytes);
  return Object.assign({},input,{
    version,manifestUrl,manifestPath,manifestBytes,manifest,
    packageRoot:catalog.packageUrls(input.name).root,
  });
}

async function download(record, outputRoot) {
  const target = path.join(outputRoot,'bundles',record.packageName,record.fileHash);
  await fs.promises.mkdir(path.dirname(target),{recursive:true});
  if (fs.existsSync(target)) {
    const current = await fs.promises.readFile(target);
    if (current.length === record.fileSize && hash(current,'md5') === record.fileHash) {
      return Object.assign({},record,{file:target,reused:true,sha256:hash(current,'sha256')});
    }
  }
  const response = await fetch(record.packageRoot + record.fileHash,{cache:'no-store'});
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + record.fileHash);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length !== record.fileSize) throw new Error('size mismatch for ' + record.fileHash);
  if (hash(data,'md5') !== record.fileHash) throw new Error('MD5 mismatch for ' + record.fileHash);
  const temporary = target + '.part-' + process.pid;
  await fs.promises.writeFile(temporary,data);
  await fs.promises.rename(temporary,target);
  return Object.assign({},record,{file:target,reused:false,sha256:hash(data,'sha256')});
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const packageInputs = [
    {key:'timeline',name:'DefaultPackage'},
    {key:'battle',name:'PetAnimPackage'},
  ];
  const packages = await Promise.all(packageInputs.map(function(input) {
    return loadLivePackage(input,options.outputRoot);
  }));
  const owned = [];
  const ownerPattern = new RegExp('^Assets/SkillTimeline/(?:Timelines|Effects|Videos)/' +
    String(options.ownerId) + '/','i');
  packages.forEach(function(packageRecord) {
    packageRecord.manifest.assets.forEach(function(asset) {
      if (ownerPattern.test(String(asset.assetPath || ''))) owned.push({packageRecord,asset});
    });
  });
  const ownedTimelineCount = owned.filter(function(item) {
    return /\/Timelines\//i.test(String(item.asset && item.asset.assetPath || ''));
  }).length;
  const ownedEffectCount = owned.filter(function(item) {
    return /\/Effects\//i.test(String(item.asset && item.asset.assetPath || ''));
  }).length;
  const ownedVideoCount = owned.filter(function(item) {
    return /\/Videos\//i.test(String(item.asset && item.asset.assetPath || ''));
  }).length;
  if (ownedTimelineCount !== 5 || ownedEffectCount !== 5 || ownedVideoCount < 1) {
    throw new Error('expected complete 5 Timeline + 5 Effect + video owner closure for ' +
      String(options.ownerId) + ', found ' + [ownedTimelineCount,ownedEffectCount,ownedVideoCount].join('/'));
  }

  const bundleKeys = new Set();
  owned.forEach(function(item) {
    bundleKeys.add(item.packageRecord.key + ':' + Number(item.asset.bundleID));
    (item.asset.dependIDs || []).forEach(function(dependency) {
      bundleKeys.add(item.packageRecord.key + ':' + Number(dependency));
    });
  });
  const packageByKey = new Map(packages.map(function(item) { return [item.key,item]; }));
  const records = Array.from(bundleKeys).sort().map(function(key) {
    const parts = key.split(':');
    const packageRecord = packageByKey.get(parts[0]);
    const bundleID = Number(parts[1]);
    const bundle = packageRecord.manifest.bundles[bundleID];
    if (!bundle) throw new Error('missing bundle ' + String(bundleID));
    return {
      packageKey:packageRecord.key,
      packageName:packageRecord.name,
      packageRoot:packageRecord.packageRoot,
      bundleID:bundleID,
      bundleName:String(bundle.bundleName || ''),
      fileHash:String(bundle.fileHash || '').toLowerCase(),
      fileSize:Number(bundle.fileSize || 0),
      isRawFile:bundle.isRawFile === true,
      url:packageRecord.packageRoot + String(bundle.fileHash || '').toLowerCase(),
    };
  });

  const downloads = [];
  for (const record of records) downloads.push(await download(record,options.outputRoot));
  const byKey = new Map(downloads.map(function(item) {
    return [item.packageKey + ':' + item.bundleID,item];
  }));
  const assets = owned.map(function(item) {
    const assetPath = String(item.asset.assetPath || '');
    return {
      packageKey:item.packageRecord.key,
      packageName:item.packageRecord.name,
      assetPath:assetPath,
      action:path.basename(assetPath).replace(/\.(?:playable|prefab|mp4)$/i,''),
      bundle:byKey.get(item.packageRecord.key + ':' + Number(item.asset.bundleID)),
      dependencies:(item.asset.dependIDs || []).map(function(id) {
        return byKey.get(item.packageRecord.key + ':' + Number(id));
      }),
    };
  }).sort(function(left,right) {
    return left.assetPath.toLowerCase().localeCompare(right.assetPath.toLowerCase());
  });
  const result = {
    schema:'seer2-uclient-skill-timeline-bundles-v1',
    ownerId:options.ownerId,
    generatedAt:new Date().toISOString(),
    packages:packages.map(function(item) {
      return {
        key:item.key,
        packageName:item.manifest.packageName,
        packageVersion:item.manifest.packageVersion,
        manifest:{
          file:item.manifestPath,
          bytes:item.manifestBytes.length,
          sha256:hash(item.manifestBytes,'sha256'),
        },
      };
    }),
    assetCount:assets.length,
    uniqueBundleCount:downloads.length,
    totalBundleBytes:downloads.reduce(function(sum,item) { return sum + item.fileSize; },0),
    assets:assets,
    bundles:downloads,
  };
  await fs.promises.mkdir(options.outputRoot,{recursive:true});
  const indexFile = path.join(options.outputRoot,String(options.ownerId) + '-skill-timeline-bundles.json');
  await fs.promises.writeFile(indexFile,JSON.stringify(result,null,2) + '\n');
  process.stdout.write(JSON.stringify({
    ownerId:options.ownerId,
    packages:result.packages.map(function(item) {
      return item.packageName + '@' + item.packageVersion;
    }),
    assetCount:result.assetCount,
    uniqueBundleCount:result.uniqueBundleCount,
    totalBundleBytes:result.totalBundleBytes,
    indexFile:indexFile,
  },null,2) + '\n');
}

main().catch(function(error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
