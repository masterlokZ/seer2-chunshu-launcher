'use strict';

function createSkinStorage(dependencies) {
  var fs = dependencies.fs;
  var path = dependencies.path;
  var crypto = dependencies.crypto;
  var processRef = dependencies.process;
  var getDownloadDirectory = dependencies.getDownloadDirectory;
  var getManagedDirectory = dependencies.getManagedDirectory;

  function inside(root, target) {
    var relative = path.relative(path.resolve(root), path.resolve(target));
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative);
  }

  async function materializeManagedFile(source, target) {
    var sourceFile = path.resolve(source);
    var targetFile = path.resolve(target);
    var downloadDirectory = typeof getDownloadDirectory === 'function' ? getDownloadDirectory() : '';
    var managedDirectory = typeof getManagedDirectory === 'function' ? getManagedDirectory() : '';
    if ((downloadDirectory && inside(downloadDirectory, sourceFile)) ||
        (managedDirectory && inside(managedDirectory, sourceFile))) {
      var temporary = targetFile + '.hardlink-' + processRef.pid + '-' +
        crypto.randomBytes(4).toString('hex');
      try {
        await fs.promises.link(sourceFile, temporary);
        try { await fs.promises.unlink(targetFile); } catch(error) {
          if (error && error.code !== 'ENOENT') throw error;
        }
        await fs.promises.rename(temporary, targetFile);
        return 'hardlink';
      } catch(_) {
        try { await fs.promises.unlink(temporary); } catch(_) {}
      }
    }
    await fs.promises.copyFile(sourceFile, targetFile);
    return 'copy';
  }

  function materializeManagedFileSync(source, target) {
    var sourceFile = path.resolve(source);
    var targetFile = path.resolve(target);
    var downloadDirectory = typeof getDownloadDirectory === 'function' ? getDownloadDirectory() : '';
    var managedDirectory = typeof getManagedDirectory === 'function' ? getManagedDirectory() : '';
    if ((downloadDirectory && inside(downloadDirectory, sourceFile)) ||
        (managedDirectory && inside(managedDirectory, sourceFile))) {
      var temporary = targetFile + '.hardlink-' + processRef.pid + '-' +
        crypto.randomBytes(4).toString('hex');
      try {
        fs.linkSync(sourceFile, temporary);
        try { fs.unlinkSync(targetFile); } catch(error) {
          if (error && error.code !== 'ENOENT') throw error;
        }
        fs.renameSync(temporary, targetFile);
        return 'hardlink';
      } catch(_) {
        try { fs.unlinkSync(temporary); } catch(_) {}
      }
    }
    fs.copyFileSync(sourceFile, targetFile);
    return 'copy';
  }

  return {
    materializeManagedFile:materializeManagedFile,
    materializeManagedFileSync:materializeManagedFileSync,
  };
}

module.exports = { createSkinStorage:createSkinStorage };
