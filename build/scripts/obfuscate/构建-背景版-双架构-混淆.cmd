@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
echo [构建-背景版-双架构-混淆] 清理对应 mode 输出
call "%~dp0..\helpers\clean-mode.cmd" 1
if errorlevel 1 exit /b 9
echo [构建-背景版-双架构-混淆] 步骤 1/2: 背景版 x64
call "%~dp0..\helpers\build-core.cmd" background x64 1
if errorlevel 1 exit /b 11
echo [构建-背景版-双架构-混淆] 步骤 2/2: 背景版 x32
call "%~dp0..\helpers\build-core.cmd" background ia32 1
if errorlevel 1 exit /b 12
call "%~dp0..\helpers\finalize-release-exe.cmd" 1
echo [构建-背景版-双架构-混淆] 完成
exit /b 0
