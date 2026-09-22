'use strict';

function createCustomSkinFolderPackage(deps) {
  const fs = deps.fs;
  const path = deps.path;

  async function collect(root, onProgress) {
    const selectedRoot = path.resolve(root);
    const swfFiles = [];
    const stack = [selectedRoot];
    let scannedDirs = 0;
    while (stack.length && swfFiles.length < 1000) {
      const dir = stack.pop();
      const items = await fs.promises.readdir(dir, { withFileTypes:true });
      items.sort(function(left, right) { return left.name.localeCompare(right.name); });
      items.forEach(function(item) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) stack.push(full);
        else if (item.isFile() && /\.swf$/i.test(item.name)) swfFiles.push(path.resolve(full));
      });
      scannedDirs++;
      if (scannedDirs % 8 === 0) {
        if (typeof onProgress === 'function') {
          onProgress({ state:'scanning', scannedDirs:scannedDirs, found:swfFiles.length });
        }
        await new Promise(function(resolve) { setImmediate(resolve); });
      }
    }
    swfFiles.sort();
    return { root:selectedRoot, swfFiles:swfFiles, scannedDirs:scannedDirs };
  }

  async function discover(scan) {
    return {
      root:scan.root,
      sources:scan.swfFiles.slice(),
      swfCount:scan.swfFiles.length,
      configFile:'',
      configEntryCount:0,
      bindingsBySource:{},
    };
  }

  return { collect:collect, discover:discover };
}

module.exports = { createCustomSkinFolderPackage:createCustomSkinFolderPackage };
