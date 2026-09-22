@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
echo [构建-无背景版-双架构-无混淆] 清理对应 mode 输出
call "%~dp0..\helpers\clean-mode.cmd" 0
if errorlevel 1 exit /b 9
echo [构建-无背景版-双架构-无混淆] 步骤 1/2: 无背景版 x64
call "%~dp0..\helpers\build-core.cmd" normal x64 0
if errorlevel 1 exit /b 11
echo [构建-无背景版-双架构-无混淆] 步骤 2/2: 无背景版 x32
call "%~dp0..\helpers\build-core.cmd" normal ia32 0
if errorlevel 1 exit /b 12
call "%~dp0..\helpers\finalize-release-exe.cmd" 0
exit /b %errorlevel%
