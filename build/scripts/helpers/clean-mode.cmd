@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ---------------------------------------------------------------------------
rem clean-mode.cmd
rem Wipe output\<mode>\packages, workspace, release-exe
rem user-data protection is handled in build-core.cmd (single source of truth)
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

echo [clean-mode] mode=%MODE% wiping workspace / release-exe (keep packages, build-core handles it)

call :wipe_dir "%WS_ROOT%"
call :wipe_dir "%REL_DIR%"

if not exist "%PKG_DIR%"        mkdir "%PKG_DIR%"        2>nul
if not exist "%WS_ROOT%"        mkdir "%WS_ROOT%"        2>nul
if not exist "%WS_ROOT%\_logs"  mkdir "%WS_ROOT%\_logs"  2>nul
if not exist "%REL_DIR%"        mkdir "%REL_DIR%"        2>nul

echo [clean-mode] mode=%MODE% done
endlocal
exit /b 0

rem -- rmdir + robocopy /MIR fallback --
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
