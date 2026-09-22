@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ---------------------------------------------------------------------------
rem clean-mode.cmd
rem
rem 用法: clean-mode.cmd ^<obfuscate=0^|1^>
rem
rem 在每个中文构建入口脚本调用 build-core 之前调用一次:
rem   清空 output\<mode>\packages\
rem   清空 output\<mode>\workspace\
rem   清空 output\<mode>\release-exe\
rem 然后重建空目录 (含 workspace\_logs)。
rem
rem 重要约束:
rem   * 只清对应 mode, 不会误删另一个 mode (见 MODE 推导逻辑)。
rem   * 只在入口脚本最前面调用一次。同一个入口脚本里多次调用 build-core
rem     不能把这个 helper 重复调一遍, 否则前面架构的产物会被吃掉。
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

set "MODE_ROOT=%REPO_ROOT%output\%MODE%"
set "PKG_DIR=%MODE_ROOT%\packages"
set "WS_ROOT=%MODE_ROOT%\workspace"
set "REL_DIR=%MODE_ROOT%\release-exe"

echo [clean-mode] mode=%MODE% wiping packages / workspace / release-exe

call :wipe_dir "%PKG_DIR%"
call :wipe_dir "%WS_ROOT%"
call :wipe_dir "%REL_DIR%"

if not exist "%PKG_DIR%"        mkdir "%PKG_DIR%"        2>nul
if not exist "%WS_ROOT%"        mkdir "%WS_ROOT%"        2>nul
if not exist "%WS_ROOT%\_logs"  mkdir "%WS_ROOT%\_logs"  2>nul
if not exist "%REL_DIR%"        mkdir "%REL_DIR%"        2>nul

echo [clean-mode] mode=%MODE% done
endlocal
exit /b 0

rem ── 顽固目录擦除: rmdir + robocopy /MIR 兜底 (与 build-core 内部一致) ──
:wipe_dir
if "%~1"=="" exit /b 0
if not exist "%~1" exit /b 0
rmdir /s /q "%~1" 2>nul
if exist "%~1" (
    set "EMPTY_TMP=%TEMP%\seer2-empty-%RANDOM%"
    mkdir "!EMPTY_TMP!" 2>nul
    robocopy "!EMPTY_TMP!" "%~1" /MIR /NP /NFL /NDL /NJH /NJS >nul 2>&1
    rmdir /s /q "!EMPTY_TMP!" 2>nul
    rmdir /s /q "%~1" 2>nul
)
exit /b 0

:usage
echo usage: clean-mode.cmd ^<obfuscate=0^|1^>
exit /b 64
