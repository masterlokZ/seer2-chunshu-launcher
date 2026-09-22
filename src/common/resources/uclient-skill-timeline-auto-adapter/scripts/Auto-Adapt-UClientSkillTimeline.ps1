[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$OwnerId,

    [string]$WorkRoot = '',
    [string]$SourceRoot = '',
    [string]$Runtime = 'D:\swf-work-622\4000-full-action-cinematics-v2-20260816\uclient-capture-runtime',
    [Parameter(Mandatory = $true)]
    [string]$SpineSkeleton,
    [hashtable]$ImpactSecondsByAction = @{},
    [switch]$SkipCapture,
    [switch]$SkipProfileRegistration,
    [string]$Node = 'node',
    [string]$Python = 'python',
    [string]$ProfileFile = '',
    [string]$PluginSource = '',
    [string]$Ffmpeg = '',
    [string]$Mxmlc = 'D:\swf-work-622\downloads\apache-flex-sdk-4.16.1\bin\mxmlc.bat',
    [string]$JavaHome = 'D:\swf-work-622\downloads\temurin8-jre\runtime\jdk8u502-b07-jre',
    [string]$PlayerGlobalHome = 'D:\swf-work-622\downloads\apache-flex-sdk-4.16.1\frameworks\libs\player'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lib\UClientCaptureOfficialTimeline.ps1')

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    $WorkRoot = Join-Path 'D:\swf-work-622' ("auto-uclient-skill-timeline\{0}" -f $OwnerId)
}
$resolvedWorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)
if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Join-Path $resolvedWorkRoot 'official-skill-timeline'
}
$resolvedSourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
$resolvedRuntime = [System.IO.Path]::GetFullPath($Runtime)
if ([string]::IsNullOrWhiteSpace($ProfileFile)) {
    $ProfileFile = Join-Path $repoRoot 'src\common\resources\uclient-skill-timeline-overlays.json'
}
$resolvedProfile = [System.IO.Path]::GetFullPath($ProfileFile)
$resolvedSkeleton = [System.IO.Path]::GetFullPath($SpineSkeleton)

foreach ($directory in @($resolvedWorkRoot,$resolvedSourceRoot,$resolvedRuntime)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $resolvedSkeleton -PathType Leaf)) {
    throw "Spine skeleton is missing: $resolvedSkeleton"
}

$bundleIndex = Join-Path $resolvedSourceRoot ("{0}-skill-timeline-bundles.json" -f $OwnerId)
$fetchScript = Join-Path $PSScriptRoot 'Fetch-UClientSkillTimelineBundles.js'
if (-not (Test-Path -LiteralPath $bundleIndex -PathType Leaf)) {
    $fetchArgs = @($fetchScript, ('--owner={0}' -f $OwnerId), ('--output={0}' -f $resolvedSourceRoot))
    & $Node @fetchArgs
    $fetchExitCode = $LASTEXITCODE
    if ($fetchExitCode -ne 0) { throw "official SkillTimeline closure fetch failed: $fetchExitCode" }
}
if (-not (Test-Path -LiteralPath $bundleIndex -PathType Leaf)) {
    throw "official SkillTimeline bundle index was not produced: $bundleIndex"
}

# Resolve the selected owner's official Signal clock before capture.  Both the
# per-action capture gate and the later overlay builder consume this same audited
# summary, so no owner can inherit 4000's historical timing defaults.
$summaryFile = Join-Path $resolvedWorkRoot ("{0}-timeline-summary.json" -f $OwnerId)
$summaryScript = Join-Path $PSScriptRoot 'Summarize-UClientPlayableTimelines.py'
$summaryArgs = @($summaryScript,'--owner',[string]$OwnerId,'--index',$bundleIndex,'--output',$summaryFile)
& $Python @summaryArgs
$summaryExitCode = $LASTEXITCODE
if ($summaryExitCode -ne 0) { throw "owner $OwnerId official Timeline summary failed: $summaryExitCode" }
$officialImpactSeconds = Get-UClientCaptureOfficialImpactSeconds `
    -TimelineSummary $summaryFile -ExpectedOwnerId $OwnerId
foreach ($action in @('attack','cp','sa','hidemove')) {
    if ($ImpactSecondsByAction.ContainsKey($action) -and
        [Math]::Abs([double]$ImpactSecondsByAction[$action] - [double]$officialImpactSeconds[$action]) -gt 0.0000001) {
        throw "owner $OwnerId explicit impact time disagrees with the official Signal for $action"
    }
    $ImpactSecondsByAction[$action] = [double]$officialImpactSeconds[$action]
}

# A runtime lock prevents two owner captures from racing on the shared Unity
# process selectors and BepInEx log.  The lock is released even on failure.
$lockPath = Join-Path $resolvedRuntime 'auto-adapt.lock'
$lockStream = $null
try {
    if (-not $SkipCapture) {
        try {
            $lockStream = [System.IO.File]::Open($lockPath,[System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
            $lockBytes = [System.Text.Encoding]::UTF8.GetBytes(("owner={0};pid={1}`n" -f $OwnerId,$PID))
            $lockStream.Write($lockBytes,0,$lockBytes.Length)
            $lockStream.Flush($true)
        } catch [System.IO.IOException] {
            throw "another U-client owner capture is already running: $resolvedRuntime"
        }

        $stageScript = Join-Path $PSScriptRoot 'Stage-UClientSkillTimelineCaptureRuntime.ps1'
        $stageArgs = @('-OwnerId',$OwnerId,'-Runtime',$resolvedRuntime,'-SourceRoot',$resolvedSourceRoot,
            '-TimelineSummary',$summaryFile,'-Python',$Python)
        if (-not [string]::IsNullOrWhiteSpace($PluginSource)) {
            $stageArgs += @('-PluginSource',[System.IO.Path]::GetFullPath($PluginSource))
        }
        & $stageScript @stageArgs
        $stageExitCode = $LASTEXITCODE
        if ($stageExitCode -ne 0) { throw "capture runtime staging failed: $stageExitCode" }

        foreach ($action in @('appear','attack','cp','sa','hidemove')) {
            $runScript = Join-Path $PSScriptRoot 'Run-UClientSkillTimelineCaptureOffscreen.ps1'
            $runArgs = @('-Action',$action,'-OwnerId',$OwnerId,'-Runtime',$resolvedRuntime,
                '-TimelineSummary',$summaryFile,'-Python',$Python)
            & $runScript @runArgs
            $runExitCode = $LASTEXITCODE
            if ($runExitCode -ne 0) { throw "owner $OwnerId capture failed for $action`: $runExitCode" }
        }
    }

    $captureRoot = Join-Path $resolvedRuntime ("{0}-capture-output" -f $OwnerId)
    $captureFiles = @($captureRoot | ForEach-Object {
        Join-Path $_ 'appear\capture.json'
        Join-Path $_ 'attack\capture.json'
        Join-Path $_ 'cp\capture.json'
        Join-Path $_ 'sa\capture.json'
        Join-Path $_ 'hidemove\capture.json'
    })
    if (@($captureFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0) {
        throw "owner $OwnerId capture output is incomplete: $captureRoot"
    }

    $deriveBackdropScript = Join-Path $PSScriptRoot 'Derive-UClientBackdropWindows.py'
    if (-not (Test-Path -LiteralPath $deriveBackdropScript -PathType Leaf)) {
        throw "Generic U-client backdrop-window derivation script is missing: $deriveBackdropScript"
    }
    $backdropWindowsFile = Join-Path $resolvedRuntime ("{0}-backdrop-windows-v2.json" -f $OwnerId)
    $backdropArgs = @($deriveBackdropScript,'--capture-root',$captureRoot,'--output',$backdropWindowsFile)
    & $Python @backdropArgs
    $backdropExitCode = $LASTEXITCODE
    if ($backdropExitCode -ne 0) { throw "owner $OwnerId backdrop-window derivation failed: $backdropExitCode" }

	    $buildScript = Join-Path $PSScriptRoot 'Build-4000SkillTimelineOverlay.ps1'
	    $buildArgs = @('-SourceId',$OwnerId,'-WorkRoot',$resolvedWorkRoot,'-CaptureRoot',$captureRoot,
	        '-TimelineSummary',$summaryFile,'-BackdropWindowsFile',$backdropWindowsFile,'-Python',$Python)
    if ($ImpactSecondsByAction.Count -gt 0) { $buildArgs += @('-ImpactSecondsByAction',$ImpactSecondsByAction) }
    if (-not [string]::IsNullOrWhiteSpace($Ffmpeg)) { $buildArgs += @('-Ffmpeg',$Ffmpeg) }
    $buildArgs += @('-Mxmlc',$Mxmlc,'-JavaHome',$JavaHome,'-PlayerGlobalHome',$PlayerGlobalHome)
    & $buildScript @buildArgs
    $buildExitCode = $LASTEXITCODE
    if ($buildExitCode -ne 0) { throw "owner $OwnerId overlay build failed: $buildExitCode" }

    $nativeSwf = Join-Path $resolvedWorkRoot 'uclient-skill-timeline.swf'
    $nativeEvidence = Join-Path $resolvedWorkRoot 'uclient-skill-timeline.json'
    $profileCount = 0
    if (-not $SkipProfileRegistration) {
        $skeletonSha = (Get-FileHash -LiteralPath $resolvedSkeleton -Algorithm SHA256).Hash
        $stageProfileScript = Join-Path $PSScriptRoot 'Stage-UClientSkillTimelineProfile.ps1'
        $profileArgs = @('-SourceId',$OwnerId,'-BundleIndex',$bundleIndex,'-TimelineSummary',$summaryFile,
            '-NativeSwf',$nativeSwf,'-NativeEvidence',$nativeEvidence,
            '-SpineSkeletonSha256',$skeletonSha,'-ProfileFile',$resolvedProfile)
        & $stageProfileScript @profileArgs
        $profileExitCode = $LASTEXITCODE
        if ($profileExitCode -ne 0) { throw "owner $OwnerId profile registration failed: $profileExitCode" }
        $profileCount = @((Get-Content -LiteralPath $resolvedProfile -Raw -Encoding utf8 |
            ConvertFrom-Json).profiles).Count
    }

    [pscustomobject][ordered]@{
        ok = $true
        ownerId = $OwnerId
        bundleIndex = $bundleIndex
        captureRoot = $captureRoot
        nativeSwf = $nativeSwf
        nativeEvidence = $nativeEvidence
        profileRegistrationSkipped = [bool]$SkipProfileRegistration
        profileFile = if ($SkipProfileRegistration) { '' } else { $resolvedProfile }
        profileCount = $profileCount
    } | ConvertTo-Json -Depth 8
}
finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
