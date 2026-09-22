[CmdletBinding()]
param(
  [string]$ToolchainRoot = 'D:\seer2-toolchains\llvm-mingw-20260616-msvcrt-x86_64',
  [string]$WebpSource = 'D:\seer2-toolchains\libwebp-1.6.0',
  [string]$WebpBuild = 'D:\seer2-toolchains\libwebp-1.6.0-build-x86_64',
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot 'build'
}
$compiler = Join-Path $ToolchainRoot 'bin\x86_64-w64-mingw32-clang++.exe'
$stripper = Join-Path $ToolchainRoot 'bin\x86_64-w64-mingw32-strip.exe'
$library = Join-Path $WebpBuild 'libwebpdecoder.a'
foreach ($required in @($compiler, $stripper, $library)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing x64 converter build dependency: $required"
  }
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory 'Seer2UClientFtrAtlasConverter-x64.exe'
$source = Join-Path $PSScriptRoot 'Seer2UClientFtrAtlasConverter.cpp'
$bcn = Join-Path $PSScriptRoot 'third_party\texture2ddecoder\bcn.cpp'
$nativeArgs = @(
  '-std=c++17', '-O2', '-DNDEBUG', '-DUNICODE', '-D_UNICODE',
  '-DSEER_CONVERTER_ARCH_X64', '-static', '-static-libgcc', '-static-libstdc++', '-municode',
  $source, $bcn,
  "-I$WebpSource\src",
  ('-I' + (Join-Path $PSScriptRoot 'third_party\texture2ddecoder')),
  $library, '-lpsapi', '-lole32', '-lwindowscodecs', '-luuid', '-o', $output
)
& $compiler @nativeArgs
if ($LASTEXITCODE -ne 0) { throw "x64 converter compilation failed: $LASTEXITCODE" }
& $stripper $output
if ($LASTEXITCODE -ne 0) { throw "x64 converter strip failed: $LASTEXITCODE" }
$item = Get-Item -LiteralPath $output
$bytes = [IO.File]::ReadAllBytes($output)
$peOffset = [BitConverter]::ToInt32($bytes, 60)
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
if ($machine -ne 0x8664) { throw ('x64 converter is not PE32+: 0x{0:X4}' -f $machine) }
[ordered]@{
  path = $item.FullName
  size = $item.Length
  sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
  peMachine = ('0x{0:X4}' -f $machine)
} | ConvertTo-Json
