'use strict';

const CATALOG_SCHEMA_VERSION = 7;

function stableObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.keys(value).sort().reduce(function(output, key) {
    output[key] = value[key];
    return output;
  }, {});
}

function normalizedIds(values, parseId) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(parseId).filter(Boolean)))
    .sort(function(a, b) { return a - b; });
}

function createOfficialCatalogStore(options) {
  options = options || {};
  var fs = options.fs;
  var path = options.path;
  var crypto = options.crypto;
  var parseId = options.parseId;
  var getFile = options.getFile;
  var commitQueue = Promise.resolve();

  if (!fs || !path || !crypto || typeof parseId !== 'function' || typeof getFile !== 'function') {
    throw new Error('official catalog store dependencies are incomplete');
  }

  function migrate(catalog) {
    if (!catalog || typeof catalog !== 'object') return catalog;
    var requestIds = Array.isArray(catalog.uClientModelRequestIds)
      ? catalog.uClientModelRequestIds : catalog.uClientPetIds;
    catalog.uClientModelRequestIds = normalizedIds(requestIds, parseId);
    if (!catalog.uClientBattlePackageVersion && catalog.uClientPetPackageVersion) {
      catalog.uClientBattlePackageVersion = String(catalog.uClientPetPackageVersion);
    }
    if (!catalog.uClientCheckedAt && catalog.uClientPetCheckedAt) {
      catalog.uClientCheckedAt = String(catalog.uClientPetCheckedAt);
    }
    delete catalog.uClientPetIds;
    delete catalog.uClientPetPackageVersion;
    delete catalog.uClientPetCheckedAt;
    // An error from an older field/schema is not evidence about the current
    // four-package closure and must never survive a successful migration.
    delete catalog.uClientPetRefreshError;
    catalog.schemaVersion = CATALOG_SCHEMA_VERSION;
    return catalog;
  }

  function revision(catalog) {
    migrate(catalog);
    var material = {
      schemaVersion:CATALOG_SCHEMA_VERSION,
      versionTag:String(catalog.versionTag || ''),
      officialDiscoveryFingerprint:String(catalog.officialDiscoveryFingerprint || ''),
      uClientSnapshotFingerprint:String(catalog.uClientSnapshotFingerprint || ''),
      uClientActionIndexFingerprint:String(catalog.uClientActionIndexFingerprint || ''),
      ultimateCapabilitySchemaVersion:Number(catalog.ultimateCapabilitySchemaVersion || 0),
      uClientPackageVersions:stableObject(catalog.uClientPackageVersions || {}),
      uClientManifestSha256:stableObject(catalog.uClientManifestSha256 || {}),
    };
    return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 24).toUpperCase();
  }

  async function syncFile(file) {
    var handle = await fs.promises.open(file, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async function replaceBytesAtomically(file, bytes, suffix) {
    var temporary = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + suffix;
    await fs.promises.writeFile(temporary, bytes, { flag:'wx' });
    await syncFile(temporary);
    await fs.promises.rename(temporary, file);
  }

  async function commitNow(catalog, commitOptions) {
    commitOptions = commitOptions || {};
    var file = String(getFile() || '');
    if (!file) return { ok:true, skipped:true, catalog:catalog };
    migrate(catalog);
    catalog.catalogRevision = revision(catalog);
    var bytes = Buffer.from(JSON.stringify(catalog), 'utf8');
    var directory = path.dirname(file);
    var temporary = file + '.tmp-' + process.pid + '-' + Date.now();
    var backup = file + '.write-backup';
    var original = null;
    var swapped = false;
    await fs.promises.mkdir(directory, { recursive:true });
    try {
      try { original = await fs.promises.readFile(file); } catch(error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      await fs.promises.writeFile(temporary, bytes, { flag:'wx' });
      await syncFile(temporary);
      if (typeof commitOptions.injectFailure === 'function') commitOptions.injectFailure('after-temp');
      if (original) {
        await fs.promises.writeFile(backup, original);
        await syncFile(backup);
      } else {
        try { await fs.promises.unlink(backup); } catch(_) {}
      }
      if (typeof commitOptions.injectFailure === 'function') commitOptions.injectFailure('before-rename');
      await fs.promises.rename(temporary, file);
      swapped = true;
      if (typeof commitOptions.injectFailure === 'function') commitOptions.injectFailure('after-rename');
      try { await fs.promises.unlink(backup); } catch(_) {}
      return { ok:true, bytes:bytes.length, revision:catalog.catalogRevision, catalog:catalog };
    } catch(error) {
      try { await fs.promises.unlink(temporary); } catch(_) {}
      if (swapped) {
        try {
          if (original) await replaceBytesAtomically(file, original, 'rollback');
          else await fs.promises.unlink(file);
        } catch(rollbackError) {
          error.rollbackError = rollbackError;
        }
      }
      try { await fs.promises.unlink(backup); } catch(_) {}
      throw error;
    }
  }

  function commit(catalog, commitOptions) {
    var operation = commitQueue.then(function() { return commitNow(catalog, commitOptions); });
    commitQueue = operation.catch(function() {});
    return operation;
  }

  async function read() {
    var file = String(getFile() || '');
    if (!file) return null;
    var backup = file + '.write-backup';
    try {
      var catalog = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      return migrate(catalog);
    } catch(error) {
      try {
        var backupBytes = await fs.promises.readFile(backup);
        var recovered = JSON.parse(backupBytes.toString('utf8'));
        await replaceBytesAtomically(file, backupBytes, 'recover');
        try { await fs.promises.unlink(backup); } catch(_) {}
        return migrate(recovered);
      } catch(_) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
    }
  }

  return {
    schemaVersion:CATALOG_SCHEMA_VERSION,
    migrate:migrate,
    revision:revision,
    read:read,
    commit:commit,
  };
}

module.exports = {
  CATALOG_SCHEMA_VERSION:CATALOG_SCHEMA_VERSION,
  createOfficialCatalogStore:createOfficialCatalogStore,
};
