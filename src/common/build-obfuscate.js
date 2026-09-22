/**
 * build-obfuscate.js — Seer2 Launcher 构建前混淆脚本
 *
 * 完整混淆目标：
 *   main.js, game-preload.js, image-preload.js,
 *   overlay-preload.js, preload.js
 *
 * 轻量混淆目标：
 *   main.js 拆出的 CommonJS 运行模块，以及其它顶层运行辅助模块。
 *   轻量配置只压缩并重命名局部标识符，不做控制流平坦化、死代码
 *   和字符串数组编码，避免重新拉高资源转换与皮肤列表热路径的 CPU。
 *
 * 明确排除：
 *   core-net.js   — 高频网络拦截逻辑，混淆会引发 CPU 尖峰
 *   setup.js      — 纯 Node 安装脚本
 *   *.html / *.ps1 / *.json — 非 JS 文件
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
