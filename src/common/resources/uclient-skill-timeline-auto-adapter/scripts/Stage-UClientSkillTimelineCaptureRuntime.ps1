[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$OwnerId,
    [Parameter(Mandatory = $true)]
    [string]$Runtime,
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [string]$PluginSource = 'D:\git仓库\chunshu-personal\log_chunshu2\tools\4000-uclient-capture-plugin\bin\Release\net6.0\Seer4000TimelineCapture.dll',
    [string]$TimelineSummary = '',
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$legacy = Join-Path $PSScriptRoot 'Stage-1400837CaptureRuntime.ps1'
if (-not (Test-Path -LiteralPath $legacy -PathType Leaf)) { throw "capture staging implementation is missing: $legacy" }
& $legacy @PSBoundParameters
