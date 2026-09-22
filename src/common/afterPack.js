'use strict';
/**
 * electron-builder afterPack hook.
 *
 * Runs AFTER electron-builder creates the win-unpacked/ directory but
 * BEFORE the NSIS installer is packaged. This is the correct place to
 * add user-visible resource copies into app.asar.unpacked/ so they
 * end up both in win-unpacked/ AND inside the NSIS installer.
 *
 * Files copied are NOT listed in asarUnpack, so the runtime continues
 * to read from app.asar. These copies are purely informational:
 * deleting or modifying them does not affect program behavior.
 */

const path = require('path');
const fs   = require('fs');

// User-facing resource files that should have visible copies in
// app.asar.unpacked/ but are NOT in asarUnpack (runtime reads from asar).
const VIEW_ONLY_COPIES = [
  'local-game-index.html',
  'bilibili.jpg',
  'contact-qq.jpg',
  'qq-group.jpg',
  'icon.ico',
  '5bg.png',
];

module.exports = async function(context) {
  // context.appOutDir = .../dist-build/win-unpacked
  // context.packager.info.projectDir = build workspace root (has the source files)
  const appOutDir  = context.appOutDir;
  const projectDir = context.packager.info.projectDir;
  const unpackDir  = path.join(appOutDir, 'resources', 'app.asar.unpacked');

  try {
    if (!fs.existsSync(unpackDir)) {
      fs.mkdirSync(unpackDir, { recursive: true });
    }
  } catch (e) {
    console.warn('[afterPack] Failed to ensure unpack dir:', e.message);
    return;
  }

  let ok = 0, skip = 0, fail = 0;
  for (const f of VIEW_ONLY_COPIES) {
    const src = path.join(projectDir, f);
    const dst = path.join(unpackDir, f);
    if (!fs.existsSync(src)) { skip++; continue; }
    try {
      fs.copyFileSync(src, dst);
      console.log('[afterPack] view-only copy:', f);
      ok++;
    } catch (e) {
      console.warn('[afterPack] copy failed:', f, '-', e.message);
      fail++;
    }
  }
  console.log('[afterPack] Done. placed=' + ok + ' skipped=' + skip + ' failed=' + fail);
};
