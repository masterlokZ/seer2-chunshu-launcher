@echo off
chcp 65001 >nul
echo [变速注入器] 编译 ce_injector.exe (x64)...

REM 优先找 64位 csc
set CSC=
for %%d in (
  "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319"
  "%WINDIR%\Microsoft.NET\Framework64\v3.5"
  "%WINDIR%\Microsoft.NET\Framework\v4.0.30319"
  "%WINDIR%\Microsoft.NET\Framework\v3.5"
) do (
  if exist "%%~d\csc.exe" if not defined CSC (
    set CSC=%%~d\csc.exe
  )
)

if not defined CSC (
  echo [ERROR] 未找到 csc.exe（需要 .NET Framework 4.x）
  pause & exit /b 1
)
echo [INFO] 编译器: %CSC%

"%CSC%" /target:exe /out:"%~dp0ce_injector.exe" /platform:x64 "%~dp0injector_src.cs"
if errorlevel 1 ( echo [ERROR] 编译失败 & pause & exit /b 1 )

echo [OK] 编译完成: ce_injector.exe
echo 此后变速切换无需等待编译，速度更新延迟 ^< 10ms。
pause
