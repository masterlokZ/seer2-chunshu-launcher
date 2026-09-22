'use strict';

function createSourceSuiteTransaction(dependencies) {
  var fs = dependencies.fs;
  var path = dependencies.path;
  var crypto = dependencies.crypto;
  var processRef = dependencies.process;

  function parseId(value) {
    var text = String(value == null ? '' : value).trim();
    if (!/^\d+$/.test(text)) return 0;
    var id = Number(text);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  function contained(root,target,allowSelf) {
    var base = path.resolve(root);
    var resolved = path.resolve(target);
    var relative = path.relative(base,resolved);
    return (allowSelf && relative === '') ||
      (!!relative && relative !== '..' && !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative));
  }

  function assertSafeRoot(root) {
    var resolved = path.resolve(String(root || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
      throw new Error('Source suite transaction root is unsafe');
    }
    return resolved;
  }

  async function copyTree(source,target) {
    var stat;
    try { stat = await fs.promises.lstat(source); }
    catch(error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error('Source suite transaction refuses symbolic-link input');
    }
    if (stat.isDirectory()) {
      await fs.promises.mkdir(target,{recursive:true});
      var entries = await fs.promises.readdir(source,{withFileTypes:true});
      for (var index = 0; index < entries.length; index++) {
        var entry = entries[index];
        if (entry.isSymbolicLink()) {
          throw new Error('Source suite transaction refuses symbolic-link members');
        }
        await copyTree(path.join(source,entry.name),path.join(target,entry.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error('Source suite transaction found an unsupported filesystem entry');
    await fs.promises.mkdir(path.dirname(target),{recursive:true});
    // A transaction draft must not share an inode with the live suite.  The
    // download/conversion stages overwrite files in-place, so hard-linking the
    // snapshot would mutate the previous version before commit and make a
    // later rollback unable to restore its original bytes.
    await fs.promises.copyFile(source,target);
  }

  async function removeTree(target,root) {
    if (!contained(root,target,false)) throw new Error('Source suite cleanup escaped its root');
    try { await fs.promises.rmdir(target,{recursive:true}); }
    catch(error) { if (!error || error.code !== 'ENOENT') throw error; }
  }

  async function begin(root,sourceId) {
    var base = assertSafeRoot(root);
    var id = parseId(sourceId);
    if (!id) throw new Error('Source suite transaction identity is invalid');
    await fs.promises.mkdir(base,{recursive:true});
    var nonce = processRef.pid + '-' + crypto.randomBytes(6).toString('hex');
    var draftParent = path.join(base,'.suite-draft-' + id + '-' + nonce);
    var draftItemRoot = path.join(draftParent,String(id));
    var itemRoot = path.join(base,String(id));
    var previousRoot = path.join(base,'.suite-previous-' + id + '-' + nonce);
    var failedRoot = path.join(base,'.suite-failed-' + id + '-' + nonce);
    if (!contained(base,draftParent,false) || !contained(base,draftItemRoot,false) ||
        !contained(base,itemRoot,false) || !contained(base,previousRoot,false) ||
        !contained(base,failedRoot,false)) {
      throw new Error('Source suite transaction paths are unsafe');
    }
    try {
      await fs.promises.mkdir(draftItemRoot,{recursive:true});
      await copyTree(itemRoot,draftItemRoot);
    } catch(error) {
      try { await removeTree(draftParent,base); }
      catch(cleanupError) { error.message += '; draft cleanup failed: ' + cleanupError.message; }
      throw error;
    }
    var state = 'draft';

    function mapFile(file) {
      var value = path.resolve(String(file || ''));
      if (value === draftItemRoot) return itemRoot;
      if (!contained(draftItemRoot,value,false)) return value;
      return path.join(itemRoot,path.relative(draftItemRoot,value));
    }

    var hadPrevious = false;

    async function restorePrevious() {
      var movedLive = false;
      try {
        try {
          await fs.promises.rename(itemRoot,failedRoot);
          movedLive = true;
        } catch(error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
        if (hadPrevious) await fs.promises.rename(previousRoot,itemRoot);
        if (movedLive) await removeTree(failedRoot,base);
      } catch(error) {
        try {
          if (movedLive && !fs.existsSync(itemRoot) && fs.existsSync(failedRoot)) {
            await fs.promises.rename(failedRoot,itemRoot);
          }
        } catch(recoverError) {
          error.message += '; live source suite recovery failed: ' + recoverError.message;
        }
        throw error;
      }
    }

    async function rollback() {
      if (state === 'committed' || state === 'rolled-back') return;
      if (state === 'swapped') {
        await restorePrevious();
      }
      await removeTree(draftParent,base);
      state = 'rolled-back';
    }

    async function swap() {
      if (state !== 'draft') throw new Error('Source suite transaction is not committable');
      try {
        try {
          var previousStat = await fs.promises.lstat(itemRoot);
          if (!previousStat.isDirectory() || previousStat.isSymbolicLink()) {
            throw new Error('Source suite target is not a safe directory');
          }
          await fs.promises.rename(itemRoot,previousRoot);
          hadPrevious = true;
        } catch(error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
        await fs.promises.rename(draftItemRoot,itemRoot);
        state = 'swapped';
      } catch(error) {
        try {
          if (hadPrevious || fs.existsSync(itemRoot)) await restorePrevious();
        } catch(restoreError) {
          error.message += '; previous source suite restore failed: ' + restoreError.message;
        }
        try { await removeTree(draftParent,base); } catch(_) {}
        state = 'rolled-back';
        throw error;
      }
      return { ok:true,sourceId:id,itemRoot:itemRoot,hadPrevious:hadPrevious };
    }

    async function finalize() {
      if (state === 'committed') return { ok:true,sourceId:id,itemRoot:itemRoot,
        hadPrevious:hadPrevious,cleanupErrors:[] };
      if (state !== 'swapped') throw new Error('Source suite transaction is not finalizable');
      var cleanupErrors = [];
      if (hadPrevious) {
        try { await removeTree(previousRoot,base); }
        catch(error) { cleanupErrors.push(error.message); }
      }
      try { await removeTree(draftParent,base); }
      catch(error) { cleanupErrors.push(error.message); }
      state = 'committed';
      return { ok:true,sourceId:id,itemRoot:itemRoot,hadPrevious:hadPrevious,
        cleanupErrors:cleanupErrors };
    }

    async function commit() {
      await swap();
      return await finalize();
    }

    return {
      sourceId:id,root:base,parent:draftParent,itemRoot:itemRoot,
      draftItemRoot:draftItemRoot,previousRoot:previousRoot,failedRoot:failedRoot,
      mapFile:mapFile,swap:swap,finalize:finalize,commit:commit,rollback:rollback,
      state:function() { return state; },
    };
  }

  return { begin:begin };
}

module.exports = { createSourceSuiteTransaction:createSourceSuiteTransaction };
