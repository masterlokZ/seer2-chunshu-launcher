# Seer2 Launcher 构建指南

> ⚠️ 历史记录文档,记录的是早期单仓库 `build.bat` / `build-ia32.bat` /
> `build-all.bat` + `dist-build/` 输出布局。当前实际构建入口已迁移到
> `build/scripts/no-obfuscate/` 与 `build/scripts/obfuscate/` 下的中文
> `.cmd` 脚本(共 14 个,覆盖背景/无背景 × x64/x32 × 单架构/双架构/全部 ×
> 混淆/无混淆),输出位于 `output/<mode>/packages/` 与
> `output/<mode>/release-exe/`,版本号统一来自 `build/configs/version.json`。
>
> 下列步骤仅作历史参考,不再代表当前可运行的命令。

## 构建选项

本项目支持三种构建模式:

### 1. 单独构建 x64 版本
```bash
build.bat
```
或
```bash
npm run build
```

**输出文件**: `dist-build/seer2-春树登陆器-1.0.0-x64.exe`
- 仅支持 64 位 Windows 系统
- 文件大小较小
- 包含 x64 专用组件

### 2. 单独构建 ia32 版本
```bash
build-ia32.bat
```
或
```bash
npm run build-x86
```

**输出文件**: `dist-build/seer2-春树登陆器-1.0.0-ia32.exe`
- 仅支持 32 位 Windows 系统
- 文件大小较小
- 包含 ia32 专用组件

### 3. 构建混合架构版本（推荐）
```bash
build-all.bat
```
或
```bash
npm run build-dual
```

**输出文件**: 
- `dist-build/seer2-春树登陆器-1.0.0-x64.exe` (x64 专用)
- `dist-build/seer2-春树登陆器-1.0.0-ia32.exe` (ia32 专用)
- `dist-build/seer2-春树登陆器-1.0.0.exe` (混合包，自动检测)

**混合包特点**:
- 安装程序会自动检测用户的系统架构
- 在 64 位系统上安装 x64 版本
- 在 32 位系统上安装 ia32 版本
- 包含所有必要的组件（两个架构的 DLL 和 Flash 插件）
- 文件大小较大（包含两个架构的资源）

## 配置文件说明

- **package.json**: x64 构建配置
- **package-ia32.json**: ia32 构建配置
- **package-dual.json**: 混合架构构建配置

## 构建流程

1. **代码混淆** (只执行一次)
   - 使用 `javascript-obfuscator` 混淆源代码
   - 保护知识产权

2. **检查 Flash DLL**
   - x64: `pepflashplayer64_34_0_0_330.dll`
   - ia32: `pepflashplayer32_34_0_0_330.dll`
   - 自动从系统 Macromed 目录复制

3. **electron-builder 打包**
   - 使用 Electron 11.5.0
   - NSIS 安装程序
   - 输出到 `dist-build/` 目录

## 注意事项

1. **首次构建**: 需要下载 Electron 二进制文件（约 78MB）
2. **网络环境**: 脚本会自动检测 10808 端口的代理
3. **镜像源**: 使用 npmmirror 加速下载
4. **Flash 插件**: 如果系统没有安装 Flash，需要手动下载到 `flash/` 目录

## 分发建议

- **单一系统用户**: 使用对应架构的专用包（文件小）
- **多系统用户**: 使用混合包（一个安装程序适配所有系统）
- **批量部署**: 根据目标系统选择专用包或混合包
