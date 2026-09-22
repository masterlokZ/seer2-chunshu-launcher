/**
 * build-obfuscate.js — Seer2 Launcher 构建前混淆脚本
 *
 * 完整混淆目标 (FULL):
 *   main.js, game-preload.js, image-preload.js,
 *   overlay-preload.js, preload.js
 *
 * 轻量混淆目标 (LIGHT):
 *   core-net.js,                          — 网络拦截层, 之前完全明文暴露服务器 URL
 *   custom-skin-sol.js, swf-battle-capability.js, uclient-ftr-x86-converter.js,
 *   modules/*.js (33 个)
 *
 * LIGHT 配置只 compact + hexadecimal 变量名, 不做控制流平坦化/死代码/字符串数组,
 * 对运行时性能零影响。core-net.js 之前完全明文暴露服务器 URL, 现在加 LIGHT 加固。
 *
 * 明确排除:
 *   download-flash.js      — 构建时 CLI 脚本, 运行时不执行; 且 new Function() 无法验证
 *   setup.js               — 纯 Node 安装脚本, 运行时不执行
 *   afterPack.js           — 构建后处理, 运行时不执行
 *   sync-version.js        — 构建时版本同步, 运行时不执行
 *   autotest.js            — 自动测试, 运行时不执行
 *   generate-manifest.js   — 构建时生成 manifest, 运行时不执行
 *   core-net.*.bak.js      — 备份文件
 *   *.html / *.ps1 / *.json / *.bak — 非 JS 文件
 *
 * 所有混淆产物写入前先 new Function() 验证语法, 防止 javascript-obfuscator
 * 偶发生成 SyntaxError 代码导致用户运行时崩溃。
 */
'use strict';

const fs                   = require('fs');
const path                 = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const PRIMARY_TARGET_FILES = [
  'main.js',
  'game-preload.js',
  'image-preload.js',
  'overlay-preload.js',
  'preload.js',
];

const LIGHT_TOP_LEVEL_FILES = [
  'core-net.js',
  'custom-skin-sol.js',
  'swf-battle-capability.js',
  'uclient-ftr-x86-converter.js',
];

const OBFUSCATION_OPTIONS = {
  compact:                              true,
  controlFlowFlattening:                true,
  controlFlowFlatteningThreshold:       0.5,
  deadCodeInjection:                    true,
  deadCodeInjectionThreshold:           0.2,
  debugProtection:                      false,
  debugProtectionInterval:              false,
  disableConsoleOutput:                 true,
  identifierNamesGenerator:             'hexadecimal',
  log:                                  false,
  renameGlobals:                        false,
  rotateStringArray:                    true,
  selfDefending:                        true,
  shuffleStringArray:                   true,
  simplify:                             false, // 禁用：会将 var 转换为 let/const，在嵌套作用域中同名变量触发 SyntaxError: already declared
  splitStrings:                         true,
  splitStringsChunkLength:              10,
  stringArray:                          true,
  stringArrayCallsTransform:            true,
  stringArrayEncoding:                  ['base64'],
  stringArrayIndexShift:                true,
  stringArrayRotate:                    true,
  stringArrayShuffle:                   true,
  stringArrayWrappersCount:             2,
  stringArrayWrappersChainedCalls:      true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType:              'function',
  stringArrayThreshold:                 0.75,
  transformObjectKeys:                  true,
  unicodeEscapeSequence:                false,
};

const LIGHT_OBFUSCATION_OPTIONS = {
  compact:                    true,
  controlFlowFlattening:      false,
  deadCodeInjection:          false,
  debugProtection:            false,
  disableConsoleOutput:       false,
  identifierNamesGenerator:   'hexadecimal',
  renameGlobals:              false,
  selfDefending:              false,
  simplify:                   false,
  stringArray:                false,
  transformObjectKeys:        false,
  unicodeEscapeSequence:      false,
};

const ROOT = __dirname;
let totalOk = 0, totalFail = 0;

const moduleDir = path.join(ROOT, 'modules');
const moduleFiles = fs.existsSync(moduleDir)
  ? fs.readdirSync(moduleDir)
      .filter(function(filename) { return filename.toLowerCase().endsWith('.js'); })
      .sort()
      .map(function(filename) { return path.join('modules', filename); })
  : [];

const targets = PRIMARY_TARGET_FILES
  .map(function(filename) { return { filename:filename, options:OBFUSCATION_OPTIONS, profile:'full' }; })
  .concat(LIGHT_TOP_LEVEL_FILES.map(function(filename) {
    return { filename:filename, options:LIGHT_OBFUSCATION_OPTIONS, profile:'light' };
  }))
  .concat(moduleFiles.map(function(filename) {
    return { filename:filename, options:LIGHT_OBFUSCATION_OPTIONS, profile:'light' };
  }));

console.log('');
console.log('╔═══════════════════════════════════════════════════╗');
console.log('║     Seer2 Launcher — Pre-Build Obfuscation        ║');
console.log('╚═══════════════════════════════════════════════════╝');
console.log('');

targets.forEach(function(target) {
  const filename = target.filename;
  const filePath = path.join(ROOT, filename);

  if (!fs.existsSync(filePath)) {
    console.warn('  [SKIP]  ' + filename + ' — not found');
    return;
  }

  try {
    const original      = fs.readFileSync(filePath, 'utf8');
    const originalSize  = Buffer.byteLength(original, 'utf8');
    console.log('  [....] ' + filename + ' [' + target.profile + '] (' + (originalSize / 1024).toFixed(1) + ' KB)');

    const result        = JavaScriptObfuscator.obfuscate(original, target.options);
    const obfuscated    = result.getObfuscatedCode();
    const obfSize       = Buffer.byteLength(obfuscated, 'utf8');

    // 语法验证: javascript-obfuscator 偶发生成 SyntaxError, 构建时拦截
    try {
      new Function(obfuscated);
    } catch(verr) {
      throw new Error('混淆后语法错误: ' + verr.message);
    }

    // 确保文件可写（ZIP 解压后可能保留只读属性）
    fs.chmodSync(filePath, 0o644);
    fs.writeFileSync(filePath, obfuscated, 'utf8');

    const pct = ((obfSize / originalSize - 1) * 100).toFixed(0);
    console.log('  [ OK ] ' + filename + ' → ' + (obfSize / 1024).toFixed(1) + ' KB (' + (pct >= 0 ? '+' : '') + pct + '%)');
    totalOk++;
  } catch(e) {
    console.error('  [FAIL] ' + filename + ' — ' + e.message);
    totalFail++;
  }
});

console.log('');
console.log('─────────────────────────────────────────────────────');
console.log('  完成: ' + totalOk + ' 个文件混淆成功，' + totalFail + ' 个失败');
console.log('─────────────────────────────────────────────────────');

if (totalFail > 0) {
  console.error('  ⚠  存在失败文件，请检查后再执行 npm run dist');
  process.exit(1);
} else {
  console.log('  ✓  所有文件混淆完成，可执行 npm run dist 开始打包');
  process.exit(0);
}
