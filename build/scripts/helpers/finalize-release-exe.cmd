@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ---------------------------------------------------------------------------
rem finalize-release-exe.cmd
rem
rem 用法: finalize-release-exe.cmd ^<obfuscate=0^|1^>
rem
rem 在所有 build-core 调用结束后调用一次:
rem   把 output\<mode>\packages\seer2-春树登陆器-*.exe 全部复制到
rem   output\<mode>\release-exe\, 不带 .blockmap, 不带 unpacked 目录。
rem
rem 设计约定:
rem   * release-exe 是一个干净的发布目录, 仅 .exe 文件
rem   * 单架构入口 -> 1 个 exe, 双架构入口 -> 2 个 exe, 全量入口 -> 4 个 exe
rem   * 旧 release-exe 在 clean-mode.cmd 调用时已被擦除, 这里只做 copy
rem ---------------------------------------------------------------------------

if "%~1"=="" goto :usage
set "OBF=%~1"
if not "%OBF%"=="0" if not "%OBF%"=="1" goto :usage

if "%OBF%"=="1" (
    set "MODE=obfuscate"
) else (
    set "MODE=no-obfuscate"
)

pushd "%~dp0..\..\..\"
set "REPO_ROOT=%CD%\"
popd

set "PKG_DIR=%REPO_ROOT%output\%MODE%\packages"
set "REL_DIR=%REPO_ROOT%output\%MODE%\release-exe"

if not exist "%REL_DIR%" mkdir "%REL_DIR%" 2>nul

echo [release-exe] mode=%MODE% copying seer2-春树登陆器-*.exe -^> release-exe\
set "FOUND=0"
for /f "delims=" %%F in ('dir /b "%PKG_DIR%\seer2-春树登陆器-*.exe" 2^>nul') do (
    copy /Y "%PKG_DIR%\%%F" "%REL_DIR%\%%F" >nul && (
        set "FOUND=1"
        echo    + %%F
    )
)
if "!FOUND!"=="0" (
    echo [release-exe] WARN: 在 %PKG_DIR% 未发现 seer2-春树登陆器-*.exe
    endlocal
    exit /b 1
)
echo [release-exe] mode=%MODE% done
endlocal
exit /b 0

:usage
echo usage: finalize-release-exe.cmd ^<obfuscate=0^|1^>
exit /b 64
