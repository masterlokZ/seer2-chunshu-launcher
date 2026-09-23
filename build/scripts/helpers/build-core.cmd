@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ---------------------------------------------------------------------------
rem build-core.cmd — 统一的单架构单变体构建内核
rem
rem 用法:
rem   build-core.cmd <variant> <arch> <obfuscate>
rem
rem 参数:
rem   variant   = background | normal      变体
rem   arch      = x64        | ia32        架构
rem   obfuscate = 0          | 1           是否混淆 (1=混淆)
rem
rem 所有中文入口脚本都通过此 helper 驱动。此脚本严格遵守:
rem   1. 只读 src/common、src/variants、build/configs/version.json
rem   2. 把所需文件复制到 workspace, 在 workspace 内完成
rem      npm install / sync-version / build-obfuscate / electron-builder
rem   3. 绝对不把构建产物写回 src 或 build/configs
rem   4. 构建前后分别做 git status --porcelain 快照并对比
rem      如发现 src/ 或 build/configs/version.json 被修改则立即 FATAL
rem   5. 最终产物命名: seer2-春树登陆器-<version>-<arch>-<variant中文>-<模式中文>.exe
rem   6. unpacked 目录名: <variant中文>-<arch>-<模式中文>-unpacked
rem ---------------------------------------------------------------------------

if "%~1"=="" goto :usage
if "%~2"=="" goto :usage
if "%~3"=="" goto :usage

set "VARIANT=%~1"
set "ARCH=%~2"
set "OBF=%~3"

if /I not "%VARIANT%"=="background" if /I not "%VARIANT%"=="normal" goto :usage
if /I not "%ARCH%"=="x64" if /I not "%ARCH%"=="ia32" goto :usage
if not "%OBF%"=="0" if not "%OBF%"=="1" goto :usage

rem -- Locate repo root (script lives in build/scripts/helpers/) ------------
pushd "%~dp0..\..\..\"
set "REPO_ROOT=%CD%\"
popd

rem -- Compute mode-specific paths & names ----------------------------------
if "%OBF%"=="1" (
    set "MODE=obfuscate"
    set "MODE_ZH=混淆"
) else (
    set "MODE=no-obfuscate"
    set "MODE_ZH=无混淆"
)

if /I "%VARIANT%"=="background" (
    set "VARIANT_ZH=背景版"
    set "VARIANT_TAG=-背景版"
    set "UNPACK_PREFIX=背景版-"
) else (
    set "VARIANT_ZH=无背景版"
    set "VARIANT_TAG="
    set "UNPACK_PREFIX="
)

if /I "%ARCH%"=="x64" (
    set "ARCH_NAME=x64"
    set "ARCH_DISPLAY=x64"
    set "ARCH_FLAG=--x64"
    set "UNPACK_SRC=win-unpacked"
) else (
    set "ARCH_NAME=ia32"
    set "ARCH_DISPLAY=x32"
    set "ARCH_FLAG=--ia32"
    set "UNPACK_SRC=win-ia32-unpacked"
)

set "COMMON_DIR=%REPO_ROOT%src\common"
set "VARIANT_DIR=%REPO_ROOT%src\variants\%VARIANT%"
set "VERSION_FILE=%REPO_ROOT%build\configs\version.json"
set "WS_DIR=%REPO_ROOT%output\%MODE%\workspace\%VARIANT%-%ARCH_NAME%"
set "PKG_DIR=%REPO_ROOT%output\%MODE%\packages"
set "LOG_DIR=%REPO_ROOT%output\%MODE%\workspace\_logs"
set "UNPACK_NAME=%UNPACK_PREFIX%%ARCH_DISPLAY%-unpacked"

for /f "usebackq tokens=*" %%T in (`pwsh.exe -NoLogo -NoProfile -NonInteractive -Command "Get-Date -Format yyyyMMdd-HHmmss"`) do set "TS=%%T"
if not defined TS set "TS=unknown"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul
if not exist "%PKG_DIR%" mkdir "%PKG_DIR%" 2>nul

set "LOG_FILE=%LOG_DIR%\%VARIANT%-%ARCH_NAME%-%MODE%-%TS%.log"
set "TAG=[%VARIANT_ZH%-%ARCH_DISPLAY%-%MODE_ZH%]"

echo %TAG% =============================================================
echo %TAG% 开始构建 @ %TS%
echo %TAG% REPO_ROOT    = %REPO_ROOT%
echo %TAG% WS_DIR       = %WS_DIR%
echo %TAG% PKG_DIR      = %PKG_DIR%
echo %TAG% LOG_FILE     = %LOG_FILE%
echo %TAG% VERSION_FILE = %VERSION_FILE%
echo %TAG% =============================================================
echo %TAG% START %TS% >"%LOG_FILE%"

rem -- 预检查 --------------------------------------------------------------
if not exist "%COMMON_DIR%\main.js" (
    echo %TAG% FATAL: 未找到 %COMMON_DIR%\main.js
    goto :fail
)
if not exist "%VARIANT_DIR%" (
    echo %TAG% FATAL: 未找到变体目录 %VARIANT_DIR%
    goto :fail
)
if not exist "%VERSION_FILE%" (
    echo %TAG% FATAL: 未找到统一版本文件 %VERSION_FILE%
    goto :fail
)
if not exist "%VARIANT_DIR%\package.%VARIANT%.json" (
    echo %TAG% FATAL: 未找到 package.%VARIANT%.json
    goto :fail
)
if /I "%ARCH%"=="ia32" (
    if not exist "%VARIANT_DIR%\package-ia32.%VARIANT%.json" (
        echo %TAG% FATAL: 未找到 package-ia32.%VARIANT%.json
        goto :fail
    )
)

rem -- 构建前 git 快照 (src + build/configs) --------------------------------
set "GIT_SNAP_BEFORE=%LOG_DIR%\%VARIANT%-%ARCH_NAME%-%MODE%-%TS%.git-before.txt"
pushd "%REPO_ROOT%"
git status --porcelain -- src build/configs >"%GIT_SNAP_BEFORE%" 2>&1
popd
echo %TAG% git 快照已记录: %GIT_SNAP_BEFORE%

rem -- 清理 workspace (rmdir + robocopy /MIR fallback) ----------------------
if exist "%WS_DIR%" (
    echo %TAG% 清理旧 workspace...
    rmdir /s /q "%WS_DIR%" >>"%LOG_FILE%" 2>&1
    if exist "%WS_DIR%" (
        set "EMPTY_TMP=%TEMP%\seer2-empty-%RANDOM%"
        mkdir "!EMPTY_TMP!" 2>nul
        robocopy "!EMPTY_TMP!" "%WS_DIR%" /MIR /NP /NFL /NDL /NJH /NJS >nul 2>&1
        rmdir /s /q "!EMPTY_TMP!" 2>nul
        rmdir /s /q "%WS_DIR%" 2>nul
    )
    if exist "%WS_DIR%" (
        echo %TAG% FATAL: 无法清理旧 workspace %WS_DIR%
        goto :fail
    )
)
mkdir "%WS_DIR%" >>"%LOG_FILE%" 2>&1

rem -- Step 1: 复制 common 到 workspace ------------------------------------
echo %TAG% [1/7] 复制 src\common 到 workspace
robocopy "%COMMON_DIR%" "%WS_DIR%" /E /XF "*.log" "*.bak" "*.bak.*" "*.tmp" /XD "%COMMON_DIR%\node_modules" "%COMMON_DIR%\dist-build" /NP /NFL /NDL /NJH /NJS >>"%LOG_FILE%" 2>&1
set "RC=!errorlevel!"
if !RC! GEQ 8 (
    echo %TAG% FATAL: robocopy common 失败 rc=!RC!
    goto :fail
)

rem -- Pre-check: NSIS customRemoveFiles macro file ------------------------
rem Without this, electron-builder won't !include our customRemoveFiles macro,
rem and uninstaller.nsh falls through to RMDir /r $INSTDIR (deletes login-data).
if not exist "%WS_DIR%\build\installer\delete-old-local-res.nsh" (
    echo %TAG% FATAL: 未找到 NSIS 自定义宏文件 build\installer\delete-old-local-res.nsh
    echo %TAG%        重装覆盖时 login-data/Cookies 会被删除!
    echo %TAG%        请确认 src\common\build\installer\delete-old-local-res.nsh 存在且已入库
    goto :fail
)
echo %TAG%      NSIS custom macro OK (delete-old-local-res.nsh 已就绪)

rem -- Step 2: 复制 variant 覆盖文件 (HTML / package / 可选 png) -------------
echo %TAG% [2/7] 应用变体覆盖 (%VARIANT%)
copy /Y "%VARIANT_DIR%\local-game-index.%VARIANT%.html" "%WS_DIR%\local-game-index.html" >>"%LOG_FILE%" 2>&1 || goto :fail_copy
copy /Y "%VARIANT_DIR%\package.%VARIANT%.json"           "%WS_DIR%\package.json"         >>"%LOG_FILE%" 2>&1 || goto :fail_copy
if /I "%ARCH%"=="ia32" (
    copy /Y "%VARIANT_DIR%\package-ia32.%VARIANT%.json"  "%WS_DIR%\package-ia32.json"    >>"%LOG_FILE%" 2>&1 || goto :fail_copy
)
if /I "%VARIANT%"=="background" (
    copy /Y "%VARIANT_DIR%\5bg.%VARIANT%.png"            "%WS_DIR%\5bg.png"              >>"%LOG_FILE%" 2>&1 || goto :fail_copy
)

rem -- Step 3: 复制统一 version.json 到 workspace --------------------------
echo %TAG% [3/7] 应用统一 version.json
copy /Y "%VERSION_FILE%" "%WS_DIR%\version.json" >>"%LOG_FILE%" 2>&1 || goto :fail_copy

rem -- Step 4: 重写 workspace 里的 package.json / package-ia32.json
rem          让 artifactName 变成中文清晰命名, 且此重写只发生在 workspace,
rem          绝不会回写 src。注意: 我们把 arch 硬编码成 ARCH_DISPLAY (x64 / x32),
rem          而不是用 electron-builder 的 ${arch} 占位符 (那会展开成 ia32)。
rem          产物名不再包含 "混淆" / "无背景版" 字样:
rem            background -> seer2-春树登陆器-${version}-<arch>-背景版.exe
rem            normal     -> seer2-春树登陆器-${version}-<arch>.exe
echo %TAG% [4/7] 重写 artifactName = seer2-春树登陆器-^${version}-%ARCH_DISPLAY%%VARIANT_TAG%.^${ext}
set "ARTIFACT_NAME=seer2-春树登陆器-${version}-%ARCH_DISPLAY%%VARIANT_TAG%.${ext}"
call node -e "const fs=require('fs'),p='%WS_DIR:\=/%/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.build.win.artifactName=process.argv[1];fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('rewrote',p,'->',process.argv[1]);" "%ARTIFACT_NAME%" >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo %TAG% FATAL: 重写 package.json 的 artifactName 失败
    goto :fail
)
if /I "%ARCH%"=="ia32" (
    call node -e "const fs=require('fs'),p='%WS_DIR:\=/%/package-ia32.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.win.artifactName=process.argv[1];fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('rewrote',p,'->',process.argv[1]);" "%ARTIFACT_NAME%" >>"%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo %TAG% FATAL: 重写 package-ia32.json 的 artifactName 失败
        goto :fail
    )
)

pushd "%WS_DIR%"

rem -- Step 5: npm install -------------------------------------------------
echo %TAG% [5/7] npm install (arch=%ARCH_NAME%)
set "ELECTRON_ARCH=%ARCH_NAME%"
set "npm_config_arch=%ARCH_NAME%"
set "npm_config_target_arch=%ARCH_NAME%"
set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"
set "npm_config_electron_mirror=https://registry.npmmirror.com/-/binary/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
set "ELECTRON_NO_ATTACH_CONSOLE=true"

call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo %TAG% FATAL: npm install 失败 ^(见 %LOG_FILE%^)
    popd
    goto :fail
)

rem -- Step 6: sync-version / download-flash / [混淆时] build-obfuscate -----
echo %TAG% [6/7] sync-version + download-flash
call node sync-version.js >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo %TAG% FATAL: sync-version 失败
    popd
    goto :fail
)
call node download-flash.js >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo %TAG% FATAL: download-flash 失败
    popd
    goto :fail
)

rem -- Architecture-native runtime gate ---------------------------------------
rem ia32 注入路径由 main.js 走 PowerShell 回退；speedhook\ce_injector.exe 仅为 x64 预编译加速器
if /I "%ARCH%"=="x64" (
    set "EXPECTED_PE_MACHINE=34404"
    set "NATIVE_ARCH_FILES=flash\pepflashplayer64_34_0_0_330.dll scanner-x64.exe speedhook_ce_x64.dll speedhook\ce_injector.exe"
) else (
    set "EXPECTED_PE_MACHINE=332"
    set "NATIVE_ARCH_FILES=flash\pepflashplayer32_34_0_0_330.dll scanner-x86.exe speedhook_ce_ia32.dll"
)
call node -e "const fs=require('fs'),path=require('path'),expected=Number(process.argv[1]),root=process.argv[2];for(const rel of process.argv.slice(3)){const file=path.join(root,rel);if(fs.existsSync(file)===false)throw new Error('missing native runtime: '+file);const b=fs.readFileSync(file);if(b.length<64)throw new Error('invalid PE runtime: '+file);const pe=b.readUInt32LE(60),machine=b.readUInt16LE(pe+4);if(machine===expected)continue;throw new Error('wrong PE machine 0x'+machine.toString(16)+' for '+file);}console.log('native runtime gate OK:',process.argv.slice(3).length,'files');" "%EXPECTED_PE_MACHINE%" "%WS_DIR%" %NATIVE_ARCH_FILES% >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo %TAG% FATAL: %ARCH_DISPLAY% 原生运行组件缺失或位数错误 ^(见 %LOG_FILE%^)
    popd
    goto :fail
)
echo %TAG%      %ARCH_DISPLAY% native runtime gate passed

if "%OBF%"=="1" (
    echo %TAG%      在 workspace 内运行 build-obfuscate.js
    call node build-obfuscate.js >>"%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo %TAG% FATAL: build-obfuscate.js 失败
        popd
        goto :fail
    )
) else (
    echo %TAG%      跳过混淆 (无混淆模式)
)

rem -- Step 7: electron-builder ---------------------------------------------
echo %TAG% [7/7] electron-builder --win nsis %ARCH_FLAG%
if /I "%ARCH%"=="x64" (
    call npm run dist-x64 >>"%LOG_FILE%" 2>&1
) else (
    call npm run dist-x86 >>"%LOG_FILE%" 2>&1
)
rem electron-builder 在无 publish provider 时会以非零退出码结束,
rem 但 exe + blockmap 已正常生成。因此用文件存在性判定成功,
rem 而非依赖 errorlevel。
set "BUILD_OK=0"
for /f "delims=" %%F in ('dir /b "%WS_DIR%\dist-build\*.exe" 2^>nul') do set "BUILD_OK=1"
if "!BUILD_OK!"=="0" (
    echo %TAG% WARN: 首次未产出 exe, 重试一次...
    if /I "%ARCH%"=="x64" (
        call npm run dist-x64 >>"%LOG_FILE%" 2>&1
    ) else (
        call npm run dist-x86 >>"%LOG_FILE%" 2>&1
    )
    set "BUILD_OK=0"
    for /f "delims=" %%F in ('dir /b "%WS_DIR%\dist-build\*.exe" 2^>nul') do set "BUILD_OK=1"
    if "!BUILD_OK!"=="0" (
        echo %TAG% FATAL: electron-builder 连续两次未产出 exe
        popd
        goto :fail
    )
)

popd

rem -- 收集产物: 只把 exe / blockmap + <UNPACK_SRC> 改名拷到 packages -------
echo %TAG% 收集产物到 %PKG_DIR%
set "FOUND_EXE=0"
for /f "delims=" %%F in ('dir /b "%WS_DIR%\dist-build\*.exe" 2^>nul') do (
    set "FOUND_EXE=1"
    copy /Y "%WS_DIR%\dist-build\%%F" "%PKG_DIR%\%%F" >>"%LOG_FILE%" 2>&1
    echo %TAG%   + %%F
)
for /f "delims=" %%F in ('dir /b "%WS_DIR%\dist-build\*.blockmap" 2^>nul') do (
    copy /Y "%WS_DIR%\dist-build\%%F" "%PKG_DIR%\%%F" >>"%LOG_FILE%" 2>&1
)
if "!FOUND_EXE!"=="0" (
    echo %TAG% FATAL: 未在 workspace\dist-build\ 看到任何 .exe 产物
    goto :fail
)

rem Mirror-wipe unpacked, keep login-data dir (Cookies only, never cleaned)
if exist "%WS_DIR%\dist-build\%UNPACK_SRC%" (
    if exist "%PKG_DIR%\%UNPACK_NAME%" (
        set "EMPTY_TMP=%TEMP%\seer2-empty-%RANDOM%"
        mkdir "!EMPTY_TMP!" 2>nul
        rem /XD "login-data" = never wipe the dir that stores Cookies
        robocopy "!EMPTY_TMP!" "%PKG_DIR%\%UNPACK_NAME%" /MIR /XD "login-data" /NP /NFL /NDL /NJH /NJS >nul 2>&1
        rmdir /s /q "!EMPTY_TMP!" 2>nul
    )
    robocopy "%WS_DIR%\dist-build\%UNPACK_SRC%" "%PKG_DIR%\%UNPACK_NAME%" /E /NP /NFL /NDL /NJH /NJS >>"%LOG_FILE%" 2>&1
    echo %TAG%   + %UNPACK_NAME%\
)

rem -- 构建后 git 快照并对比 -----------------------------------------------
set "GIT_SNAP_AFTER=%LOG_DIR%\%VARIANT%-%ARCH_NAME%-%MODE%-%TS%.git-after.txt"
pushd "%REPO_ROOT%"
git status --porcelain -- src build/configs >"%GIT_SNAP_AFTER%" 2>&1
popd

fc "%GIT_SNAP_BEFORE%" "%GIT_SNAP_AFTER%" >nul 2>&1
if errorlevel 1 (
    echo %TAG% FATAL: 防污染检查失败! src\ 或 build\configs\ 在构建期间被修改
    echo %TAG%        对比文件:
    echo %TAG%          before = %GIT_SNAP_BEFORE%
    echo %TAG%          after  = %GIT_SNAP_AFTER%
    echo %TAG%        差异:
    fc "%GIT_SNAP_BEFORE%" "%GIT_SNAP_AFTER%"
    goto :fail
)
echo %TAG% 防污染检查通过 (src\ 与 build\configs\ 未被构建修改)

echo %TAG% SUCCESS (log=%LOG_FILE%)
echo %TAG% SUCCESS >>"%LOG_FILE%"
endlocal
exit /b 0

:fail_copy
echo %TAG% FATAL: 复制变体覆盖文件失败
goto :fail

:usage
echo 用法: build-core.cmd ^<variant=background^|normal^> ^<arch=x64^|ia32^> ^<obfuscate=0^|1^>
exit /b 64

:fail
echo %TAG% FAIL — 详见日志
endlocal
exit /b 1
