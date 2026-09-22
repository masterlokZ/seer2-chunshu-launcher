[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$SourceId,

    [Parameter(Mandatory = $true)]
    [string]$BundleIndex,

    [Parameter(Mandatory = $true)]
    [string]$TimelineSummary,

    [Parameter(Mandatory = $true)]
    [string]$NativeSwf,

    [Parameter(Mandatory = $true)]
    [string]$NativeEvidence,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{64}$')]
    [string]$SpineSkeletonSha256,

    [string]$ProfileFile = (Join-Path $PSScriptRoot '..\src\common\resources\uclient-skill-timeline-overlays.json'),

    [string]$NativeRoot = (Join-Path $PSScriptRoot '..\src\common\resources\uclient-skill-timeline')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$actions = @('appear', 'attack', 'cp', 'sa', 'hidemove')
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Resolve-RequiredLeaf {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        throw "Required file is missing: $LiteralPath"
    }
    return (Resolve-Path -LiteralPath $LiteralPath).Path
}

function Write-AtomicUtf8 {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Text
    )
    $directory = [System.IO.Path]::GetDirectoryName($LiteralPath)
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "Atomic target directory is missing: $directory"
    }
    $temporary = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($LiteralPath) +
        '.part-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllText($temporary, $Text, $utf8NoBom)
        [System.IO.File]::Move($temporary, $LiteralPath, $true)
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Copy-AtomicFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $directory = [System.IO.Path]::GetDirectoryName($Target)
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "Atomic target directory is missing: $directory"
    }
    $temporary = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($Target) +
        '.part-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
    try {
        Copy-Item -LiteralPath $Source -Destination $temporary
        if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -cne
            (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash) {
            throw "Atomic copy hash mismatch: $Source"
        }
        [System.IO.File]::Move($temporary, $Target, $true)
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

$resolvedIndex = Resolve-RequiredLeaf -LiteralPath $BundleIndex
$resolvedSummary = Resolve-RequiredLeaf -LiteralPath $TimelineSummary
$resolvedNativeSwf = Resolve-RequiredLeaf -LiteralPath $NativeSwf
$resolvedNativeEvidence = Resolve-RequiredLeaf -LiteralPath $NativeEvidence
$resolvedProfile = Resolve-RequiredLeaf -LiteralPath $ProfileFile
$resolvedNativeRoot = [System.IO.Path]::GetFullPath($NativeRoot)
New-Item -ItemType Directory -Path $resolvedNativeRoot -Force | Out-Null

$index = [System.IO.File]::ReadAllText($resolvedIndex, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$summary = [System.IO.File]::ReadAllText($resolvedSummary, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$native = [System.IO.File]::ReadAllText($resolvedNativeEvidence, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$document = [System.IO.File]::ReadAllText($resolvedProfile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

if ([int]$index.ownerId -ne $SourceId -or @($index.assets).Count -lt 11) {
    throw 'Bundle index owner/asset-count contract failed.'
}
if ([int]$native.sourceId -ne $SourceId -or $native.enabled -ne $true -or
    [string]$native.conversionPolicy -cne 'transparent-png-black-flatten-flv1-avm2-screen-wrapper-v2' -or
    [string]$native.blendMode -cne 'screen' -or @($native.actions).Count -ne 5) {
    throw 'Native SkillTimeline evidence contract failed.'
}
if ([int]$document.schemaVersion -ne 1 -or
    [string]$document.policy -cne 'official-unity-skilltimeline-black-screen-overlay-v1') {
    throw 'SkillTimeline profile document contract failed.'
}

$timelineResources = [System.Collections.Generic.List[object]]::new()
$effectResources = [System.Collections.Generic.List[object]]::new()
$videoPaths = [System.Collections.Generic.List[string]]::new()
foreach ($asset in @($index.assets)) {
    $resource = [ordered]@{
        assetPath = [string]$asset.assetPath
        packageKey = [string]$asset.packageKey
        fileHash = ([string]$asset.bundle.fileHash).ToLowerInvariant()
        bytes = [long]$asset.bundle.fileSize
        dependencies = @($asset.dependencies | ForEach-Object {
            [ordered]@{
                packageKey = [string]$_.packageKey
                fileHash = ([string]$_.fileHash).ToLowerInvariant()
                bytes = [long]$_.fileSize
            }
        })
    }
    if ([string]$asset.assetPath -match '/Timelines/') {
        $timelineResources.Add([pscustomobject]$resource)
    }
    elseif ([string]$asset.assetPath -match '/Effects/') {
        $effectResources.Add([pscustomobject]$resource)
    }
    elseif ([string]$asset.assetPath -match '/Videos/') {
        $videoPaths.Add([string]$asset.assetPath)
    }
}
if ($timelineResources.Count -ne 5 -or $effectResources.Count -ne 5 -or $videoPaths.Count -lt 1) {
    throw 'SkillTimeline resource family is incomplete.'
}

$timingActions = [ordered]@{}
foreach ($action in $actions) {
    $record = $summary.$action
    if ($null -eq $record) { throw "Timeline summary is missing action: $action" }
    $duration = [double]$record.computedDuration
    if (-not [double]::IsFinite($duration) -or $duration -le 0) {
        throw "Timeline duration is invalid: $action"
    }
    $timing = [ordered]@{ durationSeconds = $duration }
    $videoWindowProperty = $record.PSObject.Properties['videoWindow']
    if ($null -ne $videoWindowProperty -and $null -ne $videoWindowProperty.Value) {
        $videoWindow = $videoWindowProperty.Value
        $videoStart = [double]$videoWindow.startSeconds
        $videoEnd = [double]$videoWindow.endSeconds
        $videoDuration = if ($null -eq $videoWindow.durationSeconds) { $videoEnd - $videoStart } else { [double]$videoWindow.durationSeconds }
        if (-not [double]::IsFinite($videoStart) -or -not [double]::IsFinite($videoEnd) -or
            -not [double]::IsFinite($videoDuration) -or $videoStart -lt 0 -or $videoEnd -le $videoStart -or
            $videoEnd -gt ($duration + 0.05) -or [math]::Abs($videoDuration - ($videoEnd - $videoStart)) -gt 0.05) {
            throw "Timeline Video Track window is invalid: $action"
        }
        $timing.videoWindow = [ordered]@{ source = 'official Video Track'; startSeconds = $videoStart; endSeconds = $videoEnd; durationSeconds = $videoDuration }
    }
    $signals = @($record.signalMarkers)
    if ($action -ne 'appear') {
        if ($signals.Count -lt 1 -or $null -eq $record.hitSignal) {
            throw "Timeline resolution signal is missing: $action"
        }
        $hitSeconds = [double]$record.hitSignal.time
        if (-not [double]::IsFinite($hitSeconds) -or $hitSeconds -lt 0 -or $hitSeconds -gt $duration) {
            throw "Timeline signal time is invalid: $action"
        }
        $timing.hitSeconds = $hitSeconds
    }
    # Preserve official camera evidence without applying it a second time to
    # the already camera-baked overlay. Optional for old summary compatibility.
    $transformMetadataProperty = $record.PSObject.Properties['transformMetadata']
    if ($null -ne $transformMetadataProperty -and $null -ne $transformMetadataProperty.Value) {
        $transformMetadata = $transformMetadataProperty.Value
        if ([int]$transformMetadata.schemaVersion -ne 1 -or
            [string]$transformMetadata.clock -cne 'official-timeline-seconds' -or
            [string]$transformMetadata.coordinateSpace -cne 'unity-transform-override' -or
            $transformMetadata.cameraBakedIntoOverlay -ne $true -or
            $null -eq $transformMetadata.composition -or
            [double]$transformMetadata.composition.x -ne 0 -or
            [double]$transformMetadata.composition.y -ne 0 -or
            [double]$transformMetadata.composition.scaleX -ne 1 -or
            [double]$transformMetadata.composition.scaleY -ne 1 -or
            [double]$transformMetadata.composition.rotationDegrees -ne 0 -or
            @($transformMetadata.framingSamples).Count -ne 3 -or
            $null -eq $transformMetadata.tracks) {
            throw "Timeline transform metadata is invalid: $action"
        }
        $timing.transformMetadata = $transformMetadata
    }
    # New summaries expose renderer channels, but this remains optional so
    # previously generated manifests/profiles continue to stage unchanged.
    $layerMetadataProperty = $record.PSObject.Properties['layerMetadata']
    if ($null -ne $layerMetadataProperty -and $null -ne $layerMetadataProperty.Value) {
        $layerMetadata = $layerMetadataProperty.Value
        $capturePlan = $layerMetadata.capturePlan
        if ([int]$layerMetadata.schemaVersion -ne 1 -or
            [string]$layerMetadata.policy -cne 'official-pet-sorting-plane-v1' -or
            [string]$layerMetadata.action -cne $action -or
            $null -eq $layerMetadata.renderers -or $null -eq $capturePlan -or
            $null -eq $capturePlan.backgroundRendererPathIds -or
            $null -eq $capturePlan.foregroundRendererPathIds -or
            $null -eq $capturePlan.petPlaneRendererPathIds -or
            $null -eq $capturePlan.unclassifiedRendererPathIds) {
            throw "Timeline layer metadata is invalid: $action"
        }
        $timing.layerMetadata = $layerMetadata
    }
    $timingActions[$action] = $timing
}

$nativeInfo = Get-Item -LiteralPath $resolvedNativeSwf
$nativeSha256 = (Get-FileHash -LiteralPath $resolvedNativeSwf -Algorithm SHA256).Hash
if ([long]$native.bytes -ne [long]$nativeInfo.Length -or [string]$native.sha256 -cne $nativeSha256) {
    throw 'Native SkillTimeline SWF/evidence identity mismatch.'
}

$profile = [pscustomobject][ordered]@{
    ownerId = $SourceId
    native = [pscustomobject][ordered]@{
        file = "$SourceId.swf"
        evidenceFile = "$SourceId.json"
        bytes = [long]$nativeInfo.Length
        sha256 = $nativeSha256
    }
    resources = [pscustomobject][ordered]@{
        timelines = @($timelineResources | Sort-Object assetPath)
        effects = @($effectResources | Sort-Object assetPath)
        videos = @($videoPaths | Sort-Object)
    }
    actionTiming = [pscustomobject][ordered]@{
        source = 'official U-client Timeline playable and signal tracks'
        durationToleranceSeconds = 0.05
        returnMixSeconds = 0.1
        actions = [pscustomobject]$timingActions
    }
    spineSkeletonSha256 = $SpineSkeletonSha256.ToUpperInvariant()
}

$profiles = @($document.profiles | Where-Object { [int]$_.ownerId -ne $SourceId }) + @($profile)
$document.profiles = @($profiles | Sort-Object ownerId)
$profileJson = ($document | ConvertTo-Json -Depth 100) + "`n"

$targetSwf = Join-Path $resolvedNativeRoot "$SourceId.swf"
$targetEvidence = Join-Path $resolvedNativeRoot "$SourceId.json"
Copy-AtomicFile -Source $resolvedNativeSwf -Target $targetSwf
Copy-AtomicFile -Source $resolvedNativeEvidence -Target $targetEvidence
Write-AtomicUtf8 -LiteralPath $resolvedProfile -Text $profileJson

[pscustomobject][ordered]@{
    sourceId = $SourceId
    profileFile = $resolvedProfile
    profileCount = @($document.profiles).Count
    nativeSwf = $targetSwf
    nativeBytes = (Get-Item -LiteralPath $targetSwf).Length
    nativeSha256 = (Get-FileHash -LiteralPath $targetSwf -Algorithm SHA256).Hash
    nativeEvidence = $targetEvidence
    timelines = $timelineResources.Count
    effects = $effectResources.Count
    videos = $videoPaths.Count
    actionTiming = $timingActions
} | ConvertTo-Json -Depth 8
