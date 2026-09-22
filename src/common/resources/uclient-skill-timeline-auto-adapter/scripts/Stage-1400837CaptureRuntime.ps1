[CmdletBinding()]
param(
    [ValidateRange(1, 2147483647)]
    [int]$OwnerId = 1400837,
    [string]$Runtime = 'D:\swf-work-622\4000-full-action-cinematics-v2-20260816\uclient-capture-runtime',
    [string]$SourceRoot = '',
    [string]$PluginSource = 'D:\git仓库\chunshu-personal\log_chunshu2\tools\4000-uclient-capture-plugin\bin\Release\net6.0\Seer4000TimelineCapture.dll',
    [string]$TimelineSummary = '',
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lib\UClientCaptureOfficialTimeline.ps1')

$resolvedSourceRoot = if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    throw 'SourceRoot is required for a generic owner capture.'
} else { [System.IO.Path]::GetFullPath($SourceRoot) }
$indexPath = Join-Path $resolvedSourceRoot ("{0}-skill-timeline-bundles.json" -f $OwnerId)
$bundleRoot = Join-Path $Runtime ("{0}-capture-bundles" -f $OwnerId)
if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) { throw "Missing bundle index: $indexPath" }
$index = Get-Content -LiteralPath $indexPath -Raw -Encoding utf8 | ConvertFrom-Json
$timelineCount = @($index.assets | Where-Object { [string]$_.assetPath -match '(?i)/Timelines/' }).Count
$effectCount = @($index.assets | Where-Object { [string]$_.assetPath -match '(?i)/Effects/' }).Count
$videoCount = @($index.assets | Where-Object { [string]$_.assetPath -match '(?i)/Videos/' }).Count
$ownerMatches = @($index.assets | Where-Object { [string]$_.assetPath -match ("/(?i:{0})/" -f $OwnerId) }).Count
$ownerProperty = $index.PSObject.Properties['ownerId']
$assetCountProperty = $index.PSObject.Properties['assetCount']
$declaredOwner = if ($null -ne $ownerProperty -and $null -ne $ownerProperty.Value) { [int]$ownerProperty.Value } else { $OwnerId }
$declaredAssetCount = if ($null -ne $assetCountProperty -and $null -ne $assetCountProperty.Value) { [int]$assetCountProperty.Value } else { @($index.assets).Count }
if ($declaredOwner -ne $OwnerId -or $ownerMatches -lt 1 -or $timelineCount -ne 5 -or $effectCount -ne 5 -or
    $videoCount -lt 1 -or $declaredAssetCount -ne @($index.assets).Count) {
    throw ("{0} bundle index identity/family contract failed." -f $OwnerId)
}

# The motion gate must use the selected owner's official Signal tracks.  Stage
# the audited summary beside the owner/action selectors so a later direct Run
# invocation cannot silently fall back to another owner's clock.
New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
$summaryTarget = Join-Path $Runtime 'capture-timeline-summary.json'
$generatedSummary = $false
$summarySource = if ([string]::IsNullOrWhiteSpace($TimelineSummary)) {
    $generatedSummary = $true
    $summaryScript = Join-Path $PSScriptRoot 'Summarize-UClientPlayableTimelines.py'
    if (-not (Test-Path -LiteralPath $summaryScript -PathType Leaf)) {
        throw "Timeline summarizer is missing: $summaryScript"
    }
    $temporarySummary = $summaryTarget + '.generated-' + $PID + '-' + [Guid]::NewGuid().ToString('N')
    $summaryArgs = @($summaryScript, '--owner', [string]$OwnerId, '--index', $indexPath, '--output', $temporarySummary)
    # This branch is itself assigned to $summarySource.  Discard the
    # summarizer's diagnostic stdout so PowerShell does not turn the result into
    # an Object[] containing both stdout and the generated file path.
    $null = & $Python @summaryArgs
    $summaryExitCode = $LASTEXITCODE
    if ($summaryExitCode -ne 0) {
        Remove-Item -LiteralPath $temporarySummary -Force -ErrorAction SilentlyContinue
        throw "owner $OwnerId official Timeline summary failed: $summaryExitCode"
    }
    $temporarySummary
}
else {
    [System.IO.Path]::GetFullPath($TimelineSummary)
}
try {
    $officialImpactSeconds = Get-UClientCaptureOfficialImpactSeconds `
        -TimelineSummary $summarySource -ExpectedOwnerId $OwnerId
    $summaryPart = $summaryTarget + '.part-' + $PID + '-' + [Guid]::NewGuid().ToString('N')
    try {
        Copy-Item -LiteralPath $summarySource -Destination $summaryPart -Force
        [System.IO.File]::Move($summaryPart, $summaryTarget, $true)
    }
    finally {
        Remove-Item -LiteralPath $summaryPart -Force -ErrorAction SilentlyContinue
    }
}
finally {
    if ($generatedSummary) {
        Remove-Item -LiteralPath $summarySource -Force -ErrorAction SilentlyContinue
    }
}
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
# The owner directory is an exact, isolated closure.  Remove stale hardlinks
# before staging so a previous owner/run can never be loaded into this capture.
# The resolved target is verified to stay inside the selected runtime root.
$resolvedRuntime = [System.IO.Path]::GetFullPath($Runtime).TrimEnd('\')
$resolvedBundleRoot = [System.IO.Path]::GetFullPath($bundleRoot).TrimEnd('\')
if (-not $resolvedBundleRoot.StartsWith($resolvedRuntime + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Capture bundle cleanup escaped runtime root: $resolvedBundleRoot"
}
Get-ChildItem -LiteralPath $resolvedBundleRoot -Force -ErrorAction SilentlyContinue |
    Remove-Item -LiteralPath { $_.FullName } -Force -Recurse -ErrorAction Stop
foreach ($bundle in $index.bundles) {
    $source = [string]$bundle.file
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing verified bundle: $source" }
    $target = Join-Path $bundleRoot ([string]$bundle.fileHash)
    if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
    New-Item -ItemType HardLink -Path $target -Target $source | Out-Null
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $Runtime 'capture-owner-id.txt'), ("{0}`n" -f $OwnerId), $utf8)
[System.IO.File]::WriteAllText((Join-Path $Runtime 'capture-action.txt'), "attack`n", $utf8)
$pluginTarget = Join-Path $Runtime 'BepInEx\plugins\Seer4000TimelineCapture.dll'
$pluginSource = [System.IO.Path]::GetFullPath($PluginSource)
$baseline = Join-Path $Runtime 'Seer4000TimelineCapture.dll.baseline-20260828'
if (-not (Test-Path -LiteralPath $baseline -PathType Leaf)) {
    Copy-Item -LiteralPath $pluginTarget -Destination $baseline -Force
}
Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Force
[pscustomobject]@{
    ownerId = $OwnerId
    bundleCount = @(Get-ChildItem -LiteralPath $bundleRoot -File).Count
    bundleRoot = $bundleRoot
    plugin = $pluginTarget
    pluginBytes = (Get-Item -LiteralPath $pluginTarget).Length
    timelineSummary = $summaryTarget
    officialImpactSeconds = $officialImpactSeconds
} | ConvertTo-Json -Compress
