[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('appear', 'attack', 'cp', 'sa', 'hidemove')]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$OwnerId,
    [string]$Runtime,
    [ValidateRange(0, 900)]
    [int]$TimeoutSeconds = 0,
    [string]$TimelineSummary = '',
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$legacy = Join-Path $PSScriptRoot 'Run-1400837CaptureOffscreen.ps1'
if (-not (Test-Path -LiteralPath $legacy -PathType Leaf)) { throw "offscreen capture implementation is missing: $legacy" }
$forward = @{
    Action = $Action
    OwnerId = $OwnerId
    TimeoutSeconds = $TimeoutSeconds
    Python = $Python
}
if (-not [string]::IsNullOrWhiteSpace($Runtime)) { $forward.Runtime = $Runtime }
if (-not [string]::IsNullOrWhiteSpace($TimelineSummary)) { $forward.TimelineSummary = $TimelineSummary }
& $legacy @forward
