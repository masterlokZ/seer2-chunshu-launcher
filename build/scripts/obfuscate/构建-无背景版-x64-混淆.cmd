@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
echo [构建-无背景版-x64-混淆] 清理对应 mode 输出
call "%~dp0..\helpers\clean-mode.cmd" 1
if errorlevel 1 exit /b 9
call "%~dp0..\helpers\build-core.cmd" normal x64 1
if errorlevel 1 exit /b 10
call "%~dp0..\helpers\finalize-release-exe.cmd" 1
exit /b %errorlevel%
