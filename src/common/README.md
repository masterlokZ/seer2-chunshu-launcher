# 赛尔号2 启动器 — src/common 共享源码

Electron 11.5.0(Chrome 87)构建,内置 Flash PPAPI 支持、本地拦截代理、
内存扫描器(原生 exe + ps1 回退)、变速注入、热更新机制。

本目录是被 background / normal 两个变体共享的源码,**不直接运行**:
真正的可分发安装包通过仓库根 `build/scripts/` 下的中文 .cmd 入口产出。

## 构建

不要在这里运行 `npm install` / `electron-builder`。
仓库根目录提供了 14 个构建入口脚本,会自动:

  1. 把 src/common + src/variants/<变体> 拷贝到 workspace
  2. 在 workspace 内 npm install / sync-version / [可选混淆] /
     electron-builder
  3. 把成品 exe 拷到 `output/<模式>/packages/` 与
     `output/<模式>/release-exe/`

详细 mode/arch/variant 矩阵见 `BUILD-GUIDE.md`(注:该文件部分内容已过时,
仅作历史参考)。

## 内存扫描器

  scanner_src.cs        C# 源码,编译为下面两个 native exe
  scanner-x64.exe       x64 启动器使用
  scanner-x86.exe       x32(ia32) 启动器使用 (访问 32 位 Flash PPAPI 的 PEB)
  scanner.ps1           PowerShell 实现,仅作 native exe 缺失/失败时的回退
  compile-scanner.bat   把 scanner_src.cs 编译为上面两个 exe

## 热更新机制

游戏资源文件（图片等）通过
**GitHub 私有仓库 + Cloudflare Pages CDN**(域名:s2.999962.xyz)分发。

启动器每次启动时自动与远端 `manifest.json` 比对 SHA-256,
若有差异则静默下载修复。

  generate-manifest.js  扫描当前目录生成 `manifest.json`
                        (运行环境:开发机,产物随热更新一起推送到远端)
  manifest.json         热更新文件清单 (SHA-256 + 大小)

CoreDLL 与双 UI 适配资源现在由皮肤模式的锁定替换清单管理，不再通过旧的“对战版by春树”本地资源分发。
`dyn-client-config.xml` 不再由本地资源替换，游戏会使用服务器原始资源；替换面板仍禁止用户替换该 URL。

**更新资源文件的流程:**
  1. 修改本地资源文件
  2. 运行 `node generate-manifest.js` 生成新的 `manifest.json`
  3. 将改动的文件 + `manifest.json` 推送到 GitHub 仓库
  4. Cloudflare Pages 自动同步(通常 < 60 秒)

**更新程序代码(main.js 等):** 需重新打包安装包并分发给用户。

## 版本号唯一来源

仓库根 `build/configs/version.json` 是唯一版本配置。
构建脚本会把它复制到 workspace,`sync-version.js` 再把版本号同步到
`package.json` 的 `version` 字段;`main.js` 运行时通过
`require('./version.json')` 读取本地版本,与 Gitee 远端 `version.json` 比对。

不要再为混淆/无混淆模式各维护一份 version.json。

## 目录结构(主要文件)

  main.js                Electron 主进程
  core-net.js            网络层(本地拦截代理 + 缓存 + proxy keepAlive)
  preload.js             启动器 UI 的 preload(暴露 IPC API)
  game-preload.js        游戏窗口 preload(白屏遮罩兜底)
  overlay.html /
   overlay-preload.js    悬浮面板基础设施
  scanner-overlay.html / cache-overlay.html /
   speed-overlay.html / replace-overlay.html /
   sync-overlay.html / proxy-overlay.html
                         具体悬浮面板 (注:状态/性能/总览/FD 等旧面板已移除)
  setup.js               首启依赖检查 / Flash 拷贝逻辑
  download-flash.js      构建期 Flash DLL 注入
  speedhook/             变速 CE 注入器源码 + 预编译 exe
  afterPack.js           electron-builder afterPack hook
  build-obfuscate.js     混淆构建脚本(只在混淆 mode 下运行)
  sync-version.js        把 version.json 同步到 package.json

## 常见问题

**游戏黑屏**:检查 `flash/` 目录中是否存在与启动器架构匹配的
pepflashplayer DLL(x64 启动器需要 64 位 DLL,x32 启动器需要 32 位 DLL)。

**启动时提示文件修复**:正常现象,启动器检测到资源与远端不一致,
自动下载最新版本。

**网络错误 / 超时**:检查网络连接,确保可以访问 s2.999962.xyz。
版本检查使用 6 小时缓存策略;一旦 Gitee 探测到本地版本低于远端,
强制更新状态会持久化保存,断网也会阻断启动直到本地升级到目标版本。
