@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

for /f "usebackq tokens=*" %%T in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) do set "TS=%%T"
echo [构建-全部版本-双架构-混淆] 开始 @ %TS%
echo [构建-全部版本-双架构-混淆] 清理对应 mode 输出
call "%~dp0..\helpers\clean-mode.cmd" 1
if errorlevel 1 exit /b 9

echo.
echo [构建-全部版本-双架构-混淆] 步骤 1/4: 背景版 x64
call "%~dp0..\helpers\build-core.cmd" background x64 1
if errorlevel 1 exit /b 11

echo.
echo [构建-全部版本-双架构-混淆] 步骤 2/4: 背景版 x32
call "%~dp0..\helpers\build-core.cmd" background ia32 1
if errorlevel 1 exit /b 12

echo.
echo [构建-全部版本-双架构-混淆] 步骤 3/4: 无背景版 x64
call "%~dp0..\helpers\build-core.cmd" normal x64 1
if errorlevel 1 exit /b 13

echo.
echo [构建-全部版本-双架构-混淆] 步骤 4/4: 无背景版 x32
call "%~dp0..\helpers\build-core.cmd" normal ia32 1
if errorlevel 1 exit /b 14

echo.
call "%~dp0..\helpers\finalize-release-exe.cmd" 1
echo.
echo [构建-全部版本-双架构-混淆] =======================================================
echo [构建-全部版本-双架构-混淆] 全部 4 个混淆产物已就绪
echo [构建-全部版本-双架构-混淆] =======================================================
exit /b 0
