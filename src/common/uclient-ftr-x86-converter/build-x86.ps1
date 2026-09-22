[CmdletBinding()]
param(
  [string]$ToolchainRoot = 'D:\seer2-toolchains\llvm-mingw-20260616-msvcrt-x86_64',
  [string]$WebpSource = 'D:\seer2-toolchains\libwebp-1.6.0',
  [string]$WebpBuild = 'D:\seer2-toolchains\libwebp-1.6.0-build-i686',
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot 'build'
}
$compiler = Join-Path $ToolchainRoot 'bin\i686-w64-mingw32-clang++.exe'
$library = Join-Path $WebpBuild 'libwebpdecoder.a'
if (-not (Test-Path -LiteralPath $compiler)) { throw "Missing x86 compiler: $compiler" }
if (-not (Test-Path -LiteralPath $library)) { throw "Missing x86 libwebp decoder: $library" }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory 'Seer2UClientFtrAtlasConverter-x86.exe'
& $compiler `
  '-std=c++17' '-O2' '-DNDEBUG' '-DUNICODE' '-D_UNICODE' `
  '-static' '-static-libgcc' '-static-libstdc++' '-municode' `
  (Join-Path $PSScriptRoot 'Seer2UClientFtrAtlasConverter.cpp') `
  (Join-Path $PSScriptRoot 'third_party\texture2ddecoder\bcn.cpp') `
  "-I$WebpSource\src" `
  ("-I" + (Join-Path $PSScriptRoot 'third_party\texture2ddecoder')) `
  $library '-lpsapi' '-lole32' '-lwindowscodecs' '-luuid' '-o' $output
if ($LASTEXITCODE -ne 0) { throw "x86 converter compilation failed: $LASTEXITCODE" }
& (Join-Path $ToolchainRoot 'bin\i686-w64-mingw32-strip.exe') $output
if ($LASTEXITCODE -ne 0) { throw "x86 converter strip failed: $LASTEXITCODE" }
$item = Get-Item -LiteralPath $output
[ordered]@{
  path = $item.FullName
  size = $item.Length
  sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
} | ConvertTo-Json
