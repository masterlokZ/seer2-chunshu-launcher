@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion

rem ---------------------------------------------------------------------------
rem compile-scanner.bat
rem
rem 把 src/common/scanner_src.cs 编译成 scanner-x64.exe + scanner-x86.exe
rem 用 .NET Framework 4.x csc.exe (Win10/11 自带, 无需额外工具)。
rem
rem 输出位置: src/common/scanner-x64.exe / scanner-x86.exe
rem 这两个文件随 src/common 一起被构建脚本拷到 workspace,
rem 然后 electron-builder 通过 asarUnpack 解到 app.asar.unpacked/。
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

echo [scanner-build] 编译 scanner-x64.exe + scanner-x86.exe ...

set CSC=
for %%d in (
  "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319"
  "%WINDIR%\Microsoft.NET\Framework64\v3.5"
  "%WINDIR%\Microsoft.NET\Framework\v4.0.30319"
  "%WINDIR%\Microsoft.NET\Framework\v3.5"
) do (
  if exist "%%~d\csc.exe" if not defined CSC set CSC=%%~d\csc.exe
)

if not defined CSC (
  echo [ERROR] 未找到 csc.exe ^(需要 .NET Framework 4.x^)
  exit /b 1
)
echo [INFO] 使用编译器: !CSC!

rem ── 64 位版 (供 x64 启动器使用) ────────────────────────────────────────────
"!CSC!" /target:exe /out:"%~dp0scanner-x64.exe" /platform:x64 /optimize+ /nologo /reference:System.dll /reference:System.Core.dll "%~dp0scanner_src.cs"
if errorlevel 1 (
  echo [ERROR] x64 编译失败
  exit /b 2
)
echo [OK] scanner-x64.exe

rem ── 32 位版 (供 ia32 启动器使用; 必须能读取 32 位 Flash PPAPI 进程的 PEB) ──
"!CSC!" /target:exe /out:"%~dp0scanner-x86.exe" /platform:x86 /optimize+ /nologo /reference:System.dll /reference:System.Core.dll "%~dp0scanner_src.cs"
if errorlevel 1 (
  echo [ERROR] x86 编译失败
  exit /b 3
)
echo [OK] scanner-x86.exe

echo [scanner-build] 完成
endlocal
exit /b 0
