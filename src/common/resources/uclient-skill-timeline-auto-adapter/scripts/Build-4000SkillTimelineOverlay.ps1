[CmdletBinding()]
	param(
    [ValidateRange(0, 2147483647)]
	    [int]$SourceId = 0,
	    [string]$WorkRoot = '',
	    [string]$CaptureRoot = '',
	    # The Unity Timeline summary is the authoritative action clock.  Capture
	    # metadata describes the sampled PNG envelope and may end one frame early.
	    [string]$TimelineSummary = '',
	    [string]$BackdropWindowsFile = '',
	    # Optional layer-split validation report produced by
	    # Validate-UClientLayerSplitCandidate.ps1.  A missing report keeps the
	    # historical single-channel build unchanged; it never guesses a split.
	    [string]$LayerSplitEvidenceFile = '',
    # Explicitly disable split-channel output while retaining capture metadata
    # validation. This is used when the official renderer graph has genuine
    # foreground/underlay ordering overlap and a safe single-channel candidate
    # is required.
    [switch]$DisableLayerSplit,
    # Disable split-channel output only for the named actions.  The remaining
    # actions retain their validated underlay channels, producing the mixed
    # split schema consumed by the auto adapter.
    [string[]]$DisableLayerSplitActions = @(),
    [hashtable]$ImpactSecondsByAction = @{},
    [string]$Python = 'python',
    [string]$Ffmpeg = '',
    [string]$Mxmlc = 'D:\swf-work-622\downloads\apache-flex-sdk-4.16.1\bin\mxmlc.bat',
    [string]$JavaHome = 'D:\swf-work-622\downloads\temurin8-jre\runtime\jdk8u502-b07-jre',
    [string]$PlayerGlobalHome = 'D:\swf-work-622\downloads\apache-flex-sdk-4.16.1\frameworks\libs\player'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lib\AtomicFilePair.ps1')
. (Join-Path $PSScriptRoot 'lib\UClient4000CaptureMotionGate.ps1')

$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$capturePolicy = ''
$captureNormalization = ''
$captureBackgroundPolicy = ''
	$captureRootMarkerSchema = 'seer2-uclient-capture-complete-v3'
	$conversionPolicy = 'transparent-png-black-flatten-flv1-avm2-screen-wrapper-v2'
		$minimumUniqueFrameSha256Count = 11
		$layerSplitPolicy = 'classified-background-underlay-v1'
		$exactScreenSchema = 'seer2-uclient-action-specific-compensated-screen-v1'
		$exactScreenCompositor = 'action-specific-compensated-underlay-then-foreground-screen-v1'
		$exactScreenTransport = 'flv1-black-flattened-rgb'
		$exactUnderlaySemantics = 'action-specific-compensated-underlay'
		$derivedChannelManifestSchema = 'seer2-uclient-derived-channel-manifest-v1'

function Resolve-RequiredLeaf {
    param(
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][string[]]$Candidates
    )
    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "Required $Description is missing. Checked: $($Candidates -join '; ')"
}

function Assert-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$Description
    )
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $resolvedTarget = [System.IO.Path]::GetFullPath($Target)
    $prefix = $resolvedRoot + '\'
    if (-not $resolvedTarget.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description escaped the managed work root: $resolvedTarget"
    }
}

function Commit-File {
    param(
        [Parameter(Mandatory = $true)][string]$Temporary,
        [Parameter(Mandatory = $true)][string]$Target
    )
    if (-not (Test-Path -LiteralPath $Temporary -PathType Leaf)) {
        throw "Commit source is missing: $Temporary"
    }
    if (Test-Path -LiteralPath $Target -PathType Leaf) {
        $backup = $Temporary + '.replace-backup'
        try {
            [System.IO.File]::Replace($Temporary, $Target, $backup, $true)
        }
        finally {
            Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
        }
    }
    else {
        [System.IO.File]::Move($Temporary, $Target)
    }
}

function Get-SwfSignature {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $header = [byte[]]::new(3)
        if ($stream.Read($header, 0, $header.Length) -ne 3) { return '' }
        return [System.Text.Encoding]::ASCII.GetString($header)
    }
    finally {
        $stream.Dispose()
    }
}

function New-DerivedChannelManifestIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$ActionRoot,
        [Parameter(Mandatory = $true)][string]$Directory
    )
    $channelRoot = if ($Directory -ceq '.') { $ActionRoot } else { Join-Path $ActionRoot $Directory }
    # Force an array even when the channel directory is absent/empty.  In
    # PowerShell an empty `@()` branch otherwise collapses to `$null`, and
    # strict mode then rejects `$files.Count` for disabled split actions.
    $files = if (Test-Path -LiteralPath $channelRoot -PathType Container) {
        @(Get-ChildItem -LiteralPath $channelRoot -File -Filter 'frame-*.png' | Sort-Object Name)
    } else { ,([System.IO.FileInfo[]]@()) }
    $frames = [System.Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $files.Count; $index++) {
        $expectedName = 'frame-{0:D4}.png' -f $index
        if ($files[$index].Name -cne $expectedName -or $files[$index].Length -le 0) {
            throw "Derived channel sequence is invalid in $channelRoot at $expectedName"
        }
        $frames.Add([ordered]@{
            fileName = $files[$index].Name
            bytes = [long]$files[$index].Length
            sha256 = (Get-FileHash -LiteralPath $files[$index].FullName -Algorithm SHA256).Hash
        })
    }
    $identity = [ordered]@{
        schema = $derivedChannelManifestSchema
        directory = $Directory
        frameCount = $frames.Count
        frames = @($frames)
    }
    $canonicalJson = $identity | ConvertTo-Json -Depth 8 -Compress
    return [pscustomobject]@{
        schema = $identity.schema
        directory = $identity.directory
        frameCount = $identity.frameCount
        frames = $identity.frames
        sha256 = [Convert]::ToHexString(
            [System.Security.Cryptography.SHA256]::HashData($utf8NoBom.GetBytes($canonicalJson)))
    }
}

function New-EmptyDerivedChannelManifestIdentity {
    param([Parameter(Mandatory = $true)][string]$Directory)
    # A forced legacy action deliberately does not consume its optional
    # underlay/raw/reference directories.  Use the canonical empty manifest
    # identity instead of probing those directories (which may be stale or
    # intentionally absent).
    $identity = [ordered]@{
        schema = $derivedChannelManifestSchema
        directory = $Directory
        frameCount = 0
        frames = @()
    }
    $canonicalJson = $identity | ConvertTo-Json -Depth 8 -Compress
    return [pscustomobject]@{
        schema = $identity.schema
        directory = $identity.directory
        frameCount = 0
        frames = @()
        sha256 = [Convert]::ToHexString(
            [System.Security.Cryptography.SHA256]::HashData($utf8NoBom.GetBytes($canonicalJson)))
    }
}

function Get-ActionBackgroundMode {
    param(
        [AllowNull()][object]$AuthoredViewport,
        [AllowNull()][object]$AuthoredFullscreen,
        [Parameter(Mandatory = $true)][string]$Action
    )
    $viewportEnabledProperty = if ($null -eq $AuthoredViewport) { $null } else {
        $AuthoredViewport.PSObject.Properties['enabled']
    }
    $fullscreenEnabledProperty = if ($null -eq $AuthoredFullscreen) { $null } else {
        $AuthoredFullscreen.PSObject.Properties['enabled']
    }
    $viewportEnabled = $null -ne $viewportEnabledProperty -and $viewportEnabledProperty.Value -eq $true
    $fullscreenEnabled = $null -ne $fullscreenEnabledProperty -and $fullscreenEnabledProperty.Value -eq $true
    if ($viewportEnabled -and $fullscreenEnabled) {
        throw "Capture metadata enables both authored viewport and fullscreen backgrounds for action $Action"
    }
    if ($fullscreenEnabled) { return 'fullscreen' }
    if ($viewportEnabled) { return 'viewport' }
    return 'none'
}

function New-BackgroundBounds {
    param(
        [Parameter(Mandatory = $true)][int]$X,
        [Parameter(Mandatory = $true)][int]$Y,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Height
    )
    return [ordered]@{ x = $X; y = $Y; width = $Width; height = $Height }
}

function Get-ActionBackgroundMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$Mode,
        [AllowNull()][object]$AuthoredViewport,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Height,
        [Parameter(Mandatory = $true)][double]$DurationSeconds,
        [Parameter(Mandatory = $true)][double]$FrameRate,
        [Parameter(Mandatory = $true)][int]$FrameCount,
        [Parameter(Mandatory = $true)][object]$WindowEvidence,
        [Parameter(Mandatory = $true)][string]$Action
    )
    if ([string]$WindowEvidence.action -cne $Action -or
        [string]$WindowEvidence.actionDirectory -cne $Action -or
        [string]$WindowEvidence.backgroundMode -cne $Mode -or
        [double]$WindowEvidence.frameRate -ne $FrameRate -or
        [int]$WindowEvidence.frameCount -ne $FrameCount -or
        [int]$WindowEvidence.captureFrameCount -ne $FrameCount -or
        [Math]::Abs([double]$WindowEvidence.durationSeconds - $DurationSeconds) -gt 0.0001) {
        throw "Backdrop-window evidence does not match capture metadata for action $Action"
    }

    $geometry = $null
    if ($Mode -ceq 'viewport') {
        if ($null -eq $AuthoredViewport -or $AuthoredViewport.enabled -ne $true) {
            throw "Viewport background has no authored viewport evidence for action $Action"
        }
        $authored = New-BackgroundBounds -X ([int]$AuthoredViewport.x) -Y ([int]$AuthoredViewport.y) `
            -Width ([int]$AuthoredViewport.width) -Height ([int]$AuthoredViewport.height)
        if ($authored.x -lt 0 -or $authored.y -lt 0 -or $authored.width -lt 1 -or $authored.height -lt 1 -or
            $authored.x + $authored.width -gt $Width -or $authored.y + $authored.height -gt $Height) {
            throw "Authored viewport bounds are invalid for action $Action"
        }
        # The converter crops authoredBounds and scales the result to the complete
        # overlay canvas.  renderBounds therefore must not be confused with the
        # authored source rectangle by a runtime consumer.
        $geometry = [ordered]@{
            renderPolicy = 'crop-scale-to-canvas-v1'
            sourceSize = [ordered]@{ width = $Width; height = $Height }
            authoredBounds = $authored
            renderBounds = New-BackgroundBounds -X 0 -Y 0 -Width $Width -Height $Height
        }
    }
    elseif ($Mode -ceq 'fullscreen') {
        $canvas = New-BackgroundBounds -X 0 -Y 0 -Width $Width -Height $Height
        $geometry = [ordered]@{
            renderPolicy = 'full-canvas-v1'
            sourceSize = [ordered]@{ width = $Width; height = $Height }
            authoredBounds = $canvas
            renderBounds = $canvas
        }
    }

    $inputWindows = @($WindowEvidence.backgroundWindows)
    if (($Mode -ceq 'none' -and $inputWindows.Count -ne 0) -or
        ($Mode -cne 'none' -and $inputWindows.Count -eq 0) -or
        [bool]$WindowEvidence.authoredBackgroundEnabled -ne ($Mode -cne 'none') -or
        [bool]$WindowEvidence.requiresOpaqueBackdrop -ne ($Mode -cne 'none')) {
        throw "Backdrop-window enablement is inconsistent for action $Action"
    }
    $windows = [System.Collections.Generic.List[object]]::new()
    $previousEnd = -1.0
    foreach ($window in $inputWindows) {
        $startFrame = [int]$window.startFrame
        $endFrame = [int]$window.endFrame
        $startSeconds = [double]$window.startSeconds
        $endSeconds = [double]$window.endSeconds
        if ($startFrame -lt 0 -or $endFrame -lt $startFrame -or $endFrame -ge $FrameCount -or
            -not [double]::IsFinite($startSeconds) -or -not [double]::IsFinite($endSeconds) -or
            $startSeconds -lt 0 -or $endSeconds -le $startSeconds -or
            $endSeconds -gt $DurationSeconds + (1.0 / $FrameRate) -or $startSeconds -lt $previousEnd) {
            throw "Backdrop window is invalid or overlapping for action $Action"
        }
        $entry = [ordered]@{
            startFrame = $startFrame
            endFrame = $endFrame
            startSeconds = $startSeconds
            endSeconds = $endSeconds
            mode = $Mode
            backgroundGeometry = $geometry
        }
        $windows.Add($entry)
        $previousEnd = $endSeconds
    }
    return [pscustomobject]@{ geometry = $geometry; windows = @($windows) }
}

function Get-OfficialVideoWindow {
    param(
        [AllowNull()][object]$Record,
        [Parameter(Mandatory = $true)][string]$Action,
        [Parameter(Mandatory = $true)][double]$DurationSeconds
    )
    if ($null -eq $Record) { return $null }
    # New summaries expose videoWindow directly.  Keep a compatibility fallback
    # for older summaries that only retained the official Video Track clip list.
    $property = $Record.PSObject.Properties['videoWindow']
    $candidate = if ($null -ne $property -and $null -ne $property.Value) {
        $property.Value
    } else {
        $clips = @($Record.clips | Where-Object {
            [string]$_.track -match '(?i)^video\s*track$'
        })
        if ($clips.Count -gt 1) {
            throw "Official Timeline contains multiple Video Track clips for action $Action"
        }
        if ($clips.Count -eq 1) {
            [pscustomobject]@{
                startSeconds = $clips[0].start
                endSeconds = $clips[0].end
                durationSeconds = $clips[0].duration
            }
        } else { $null }
    }
    if ($null -eq $candidate) { return $null }
    $start = [double]$candidate.startSeconds
    $end = [double]$candidate.endSeconds
    $durationProperty = $candidate.PSObject.Properties['durationSeconds']
    $windowDuration = if ($null -eq $durationProperty -or $null -eq $durationProperty.Value) {
        $end - $start
    } else { [double]$durationProperty.Value }
    if (-not [double]::IsFinite($start) -or -not [double]::IsFinite($end) -or
        -not [double]::IsFinite($windowDuration) -or $start -lt 0 -or $end -le $start -or
        $windowDuration -le 0 -or $end -gt ($DurationSeconds + 0.05) -or
        [math]::Abs($windowDuration - ($end - $start)) -gt 0.05) {
        throw "Official Timeline Video Track window is invalid for action $Action"
    }
    return [ordered]@{
        source = 'official Video Track'
        startSeconds = $start
        endSeconds = $end
        durationSeconds = $windowDuration
    }
}

$resolvedWorkRoot = if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    if ([string]::IsNullOrWhiteSpace($CaptureRoot)) {
        throw 'WorkRoot or CaptureRoot is required.'
    }
    [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $CaptureRoot)))
} else { [System.IO.Path]::GetFullPath($WorkRoot) }
if ([string]::IsNullOrWhiteSpace($CaptureRoot)) {
    $CaptureRoot = Join-Path $resolvedWorkRoot ("uclient-capture-runtime\$SourceId-capture-output")
}
$resolvedCaptureRoot = [System.IO.Path]::GetFullPath($CaptureRoot)
if (-not (Test-Path -LiteralPath $resolvedWorkRoot -PathType Container)) {
    throw "$SourceId work root is missing: $resolvedWorkRoot"
}
if (-not (Test-Path -LiteralPath $resolvedCaptureRoot -PathType Container)) {
    throw "$SourceId capture output is missing: $resolvedCaptureRoot"
}
$actionRoots = @(Get-ChildItem -LiteralPath $resolvedCaptureRoot -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'capture.json') } |
    Sort-Object Name)
if ($actionRoots.Count -eq 0) {
    throw "Capture root contains no action capture directories: $resolvedCaptureRoot"
}
$actions = @($actionRoots | ForEach-Object { [string]$_.Name })
if (@($actions | Sort-Object -Unique).Count -ne $actions.Count) {
    throw 'Capture action directories must have unique names.'
}
# Resolve the optional per-action disable list once the capture action set is
# authoritative.  Names are case-insensitive but are retained in the actual
# capture-directory spelling for deterministic manifest output.  Rejecting
# unknown/duplicate names prevents a typo from silently leaving an unsafe split
# action enabled.
$disableLayerSplitActionSet = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase)
$disableLayerSplitActionNames = [System.Collections.Generic.List[string]]::new()
foreach ($requestedAction in @($DisableLayerSplitActions)) {
    $requestedName = ([string]$requestedAction).Trim()
    if ([string]::IsNullOrWhiteSpace($requestedName)) {
        throw 'DisableLayerSplitActions cannot contain an empty action name.'
    }
    $matchingAction = @($actions | Where-Object {
        $_ -ceq $requestedName -or $_.Equals($requestedName, [System.StringComparison]::OrdinalIgnoreCase)
    }) | Select-Object -First 1
    if ($null -eq $matchingAction) {
        throw "DisableLayerSplitActions contains an action outside the capture set: $requestedName"
    }
    if (-not $disableLayerSplitActionSet.Add([string]$matchingAction)) {
        throw "DisableLayerSplitActions contains a duplicate action: $requestedName"
    }
    $disableLayerSplitActionNames.Add([string]$matchingAction)
}
$captureOwnerIds = @($actionRoots | ForEach-Object {
    $value = Get-Content -LiteralPath (Join-Path $_.FullName 'capture.json') -Raw -Encoding utf8 | ConvertFrom-Json
    [int]$value.ownerId
} | Sort-Object -Unique)
if ($captureOwnerIds.Count -ne 1 -or $captureOwnerIds[0] -lt 1) {
    throw 'Capture actions must all identify one positive ownerId.'
}
if ($SourceId -eq 0) { $SourceId = $captureOwnerIds[0] }
if ($SourceId -ne $captureOwnerIds[0]) {
    throw "Capture ownerId $($captureOwnerIds[0]) does not match requested SourceId $SourceId"
}
$firstCapture = Get-Content -LiteralPath (Join-Path $actionRoots[0].FullName 'capture.json') -Raw -Encoding utf8 | ConvertFrom-Json
$expectedWidth = [int]$firstCapture.width
$expectedHeight = [int]$firstCapture.height
$expectedFrameRate = [double]$firstCapture.frameRate
$capturePolicy = [string]$firstCapture.capturePolicy
$captureNormalization = [string]$firstCapture.normalization
$captureBackgroundPolicy = [string]$firstCapture.backgroundPolicy
if ([string]::IsNullOrWhiteSpace($capturePolicy) -or [string]::IsNullOrWhiteSpace($captureNormalization) -or
    [string]::IsNullOrWhiteSpace($captureBackgroundPolicy)) {
    throw 'Capture metadata policies must be present and non-empty.'
}

# Resolve the official Timeline clock before converting any sampled frames.
# capture.json describes the PNG envelope and can be one frame shorter than the
# playable's computedDuration.  The latter must drive the generated wrapper and
# action evidence; capture duration remains limited to validating the samples.
$resolvedTimelineSummary = if ([string]::IsNullOrWhiteSpace($TimelineSummary)) {
    Join-Path $resolvedWorkRoot ("$SourceId-timeline-summary.json")
} else { [System.IO.Path]::GetFullPath($TimelineSummary) }
if (-not (Test-Path -LiteralPath $resolvedTimelineSummary -PathType Leaf)) {
    throw "Official Timeline summary is missing: $resolvedTimelineSummary"
}
$officialTimelineSummary = [System.IO.File]::ReadAllText(
    $resolvedTimelineSummary, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -DateKind String
$officialTimelineActions = [ordered]@{}
foreach ($timelineAction in $actions) {
    $summaryProperty = $officialTimelineSummary.PSObject.Properties[$timelineAction]
    if ($null -eq $summaryProperty -or $null -eq $summaryProperty.Value) {
        throw "Official Timeline summary is missing action: $timelineAction"
    }
    $summaryRecord = $summaryProperty.Value
    $officialDuration = [double]$summaryRecord.computedDuration
    if (-not [double]::IsFinite($officialDuration) -or $officialDuration -le 0) {
        throw "Official Timeline duration is invalid: $timelineAction"
    }
    $officialVideoWindow = Get-OfficialVideoWindow -Record $summaryRecord `
        -Action $timelineAction -DurationSeconds $officialDuration
    $officialTimelineActions[$timelineAction] = [pscustomobject]@{
        durationSeconds = $officialDuration
        videoWindow = $officialVideoWindow
    }
}
$timelineSummarySha256 = (Get-FileHash -LiteralPath $resolvedTimelineSummary -Algorithm SHA256).Hash
if ([string]::IsNullOrWhiteSpace($BackdropWindowsFile)) {
    $backdropDirectory = Split-Path -Parent $resolvedCaptureRoot
    $BackdropWindowsFile = @(
        (Join-Path $backdropDirectory 'backdrop-windows-v2.json'),
        (Join-Path $backdropDirectory ("$SourceId-backdrop-windows-v2.json"))
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
$resolvedBackdropWindowsFile = [System.IO.Path]::GetFullPath($BackdropWindowsFile)
if (-not (Test-Path -LiteralPath $resolvedBackdropWindowsFile -PathType Leaf)) {
    throw "$SourceId backdrop-window evidence is missing: $resolvedBackdropWindowsFile"
}
$backdropWindowsDocument = [System.IO.File]::ReadAllText(
    $resolvedBackdropWindowsFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -DateKind String
$backdropWindowActions = @($backdropWindowsDocument.actions)
$backdropWindowNames = @($backdropWindowActions | ForEach-Object { [string]$_.action })
$backdropCaptureEvidence = $backdropWindowsDocument.captureEvidence
$backdropCaptureActions = @($backdropCaptureEvidence.actions)
if ([string]$backdropWindowsDocument.schema -cne 'seer2-uclient-backdrop-windows-v2' -or
    [string]$backdropWindowsDocument.policy -cne 'authored-viewport-fullscreen-pixel-evidence-v2' -or
    $backdropWindowsDocument.ownerIndependent -ne $true -or
    $backdropWindowsDocument.actionNameIndependent -ne $true -or
    [int]$backdropCaptureEvidence.ownerId -ne $SourceId -or
    [string]$backdropCaptureEvidence.fingerprintSha256 -notmatch '^[0-9A-F]{64}$' -or
    $backdropCaptureActions.Count -ne $actions.Count -or
    $backdropWindowActions.Count -ne $actions.Count -or
    @($backdropWindowNames | Sort-Object -Unique).Count -ne $actions.Count -or
    @(Compare-Object -ReferenceObject $actions -DifferenceObject $backdropWindowNames).Count -ne 0) {
    throw "$SourceId backdrop-window evidence document is invalid or incomplete."
}
$canonicalBackdropActions = [System.Collections.Generic.List[object]]::new()
foreach ($action in $actions) {
    $captureFile = Join-Path (Join-Path $resolvedCaptureRoot $action) 'capture.json'
    $capture = [System.IO.File]::ReadAllText($captureFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -DateKind String
    $captureEvidence = $backdropCaptureActions |
        Where-Object { [string]$_.action -ceq $action } |
        Select-Object -First 1
    if ($null -eq $captureEvidence -or [string]$captureEvidence.actionDirectory -cne $action -or
        [string]$captureEvidence.captureJsonSha256 -cne
            (Get-FileHash -LiteralPath $captureFile -Algorithm SHA256).Hash -or
        [double]$captureEvidence.frameRate -ne [double]$capture.frameRate -or
        [int]$captureEvidence.frameCount -ne [int]$capture.frameCount -or
        [Math]::Abs([double]$captureEvidence.durationSeconds - [double]$capture.durationSeconds) -gt 0.0001) {
        throw "Backdrop-window capture identity is stale for action $action"
    }
    $canonicalBackdropActions.Add([ordered]@{
        action = $action
        actionDirectory = $action
        captureJsonSha256 = [string]$captureEvidence.captureJsonSha256
        durationSeconds = [double]$captureEvidence.durationSeconds
        frameCount = [int]$captureEvidence.frameCount
        frameRate = [double]$captureEvidence.frameRate
    })
}
$canonicalBackdropEvidence = [ordered]@{
    actions = @($canonicalBackdropActions)
    ownerId = $SourceId
}
$canonicalBackdropJson = $canonicalBackdropEvidence | ConvertTo-Json -Depth 8 -Compress
$canonicalBackdropSha = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData(
        [System.Text.Encoding]::UTF8.GetBytes($canonicalBackdropJson)))
if ($canonicalBackdropSha -cne [string]$backdropCaptureEvidence.fingerprintSha256) {
    throw "$SourceId backdrop-window capture fingerprint is invalid."
}
$completionMarker = Join-Path $resolvedCaptureRoot 'capture-complete.txt'
$captureValidator = Join-Path $PSScriptRoot 'Validate-4000CaptureEvidence.ps1'
if (-not (Test-Path -LiteralPath $captureValidator -PathType Leaf)) {
    throw "4000 capture validator is missing: $captureValidator"
}
# Never consume a marker merely because it exists.  A fresh full validation first
# invalidates any stale root marker, validates all five v3 actions, and commits a
# new root marker only after every action and motion gate passes.
& $captureValidator -CaptureRoot $resolvedCaptureRoot -ImpactSecondsByAction $ImpactSecondsByAction -Python $Python | Out-Null
if (-not (Test-Path -LiteralPath $completionMarker -PathType Leaf)) {
    throw "$SourceId capture is not complete yet: $completionMarker"
}
$completion = [System.IO.File]::ReadAllText($completionMarker, [System.Text.Encoding]::UTF8) |
    ConvertFrom-Json -DateKind String
$completionActions = @($completion.actions)
$completionActionNames = @($completionActions | ForEach-Object { [string]$_.action })
$validationReportPath = Join-Path $resolvedCaptureRoot ([string]$completion.validationReport)
if ([string]$completion.schema -cne $captureRootMarkerSchema -or
    [string]$completion.capturePolicy -cne $capturePolicy -or
    [string]$completion.normalization -cne $captureNormalization -or
    [string]$completion.backgroundPolicy -cne $captureBackgroundPolicy -or
    [int]$completion.dimensions.width -ne $expectedWidth -or
    [int]$completion.dimensions.height -ne $expectedHeight -or
    [double]$completion.frameRate -ne $expectedFrameRate -or
    $completionActions.Count -ne $actions.Count -or
    @($completionActionNames | Sort-Object -Unique).Count -ne $actions.Count -or
    @(Compare-Object -ReferenceObject $actions -DifferenceObject $completionActionNames).Count -ne 0 -or
    -not (Test-Path -LiteralPath $validationReportPath -PathType Leaf) -or
    (Get-FileHash -LiteralPath $validationReportPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
        ([string]$completion.validationReportSha256).ToLowerInvariant()) {
    throw "$SourceId capture root marker is not a complete current v3 validation result."
}
foreach ($completionAction in $completionActions) {
    $completionActionName = [string]$completionAction.action
    $actionMarkerPath = Join-Path (Join-Path $resolvedCaptureRoot $completionActionName) 'capture-complete.txt'
    if (-not (Test-Path -LiteralPath $actionMarkerPath -PathType Leaf) -or
        (Get-FileHash -LiteralPath $actionMarkerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
            ([string]$completionAction.actionMarkerSha256).ToLowerInvariant()) {
        throw "$SourceId capture action marker is stale or missing: $completionActionName"
    }
    if ($null -eq $completionAction.backgroundEvidence -or
        $completionAction.backgroundEvidence.passed -ne $true -or
        @($completionAction.backgroundEvidence.errors).Count -ne 0) {
        throw "$SourceId capture action has no passing background contamination evidence: $completionActionName"
    }
}

if ([string]::IsNullOrWhiteSpace($Ffmpeg)) {
    $ffmpegCandidates = @(
        $env:SEER_FFMPEG,
        'D:\seer2-development-kit\tools\ffmpeg\bin\ffmpeg.exe',
        'D:\seer2-development-kit\downloads\ffmpeg-release-essentials-20260812\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe'
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
}
else {
    $ffmpegCandidates = @($Ffmpeg)
}
$resolvedFfmpeg = Resolve-RequiredLeaf -Description 'local ffmpeg executable' -Candidates $ffmpegCandidates
$resolvedMxmlc = Resolve-RequiredLeaf -Description 'Apache Flex mxmlc compiler' -Candidates @($Mxmlc)
if (-not (Test-Path -LiteralPath $JavaHome -PathType Container)) {
    throw "Java 8 runtime is missing: $JavaHome"
}
if (-not (Test-Path -LiteralPath $PlayerGlobalHome -PathType Container)) {
    throw "Flex playerglobal directory is missing: $PlayerGlobalHome"
}

$buildRoot = Join-Path $resolvedWorkRoot 'skill-timeline-build'
$nativeRoot = Join-Path $buildRoot 'native'
$wrapperSource = Join-Path $buildRoot 'UClientSkillTimelineOverlay.as'
$wrapperTarget = Join-Path $resolvedWorkRoot 'uclient-skill-timeline.swf'
$manifestTarget = Join-Path $resolvedWorkRoot 'uclient-skill-timeline.json'
foreach ($managedPath in @($buildRoot, $nativeRoot, $wrapperSource, $wrapperTarget, $manifestTarget)) {
    Assert-PathInside -Root $resolvedWorkRoot -Target $managedPath -Description 'SkillTimeline build path'
}
New-Item -ItemType Directory -Path $nativeRoot -Force | Out-Null
$stagingRoot = Join-Path $buildRoot ('staging-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
Assert-PathInside -Root $buildRoot -Target $stagingRoot -Description 'SkillTimeline staging directory'

$captureRecords = [System.Collections.Generic.List[object]]::new()
$layerSplitRecords = [System.Collections.Generic.List[object]]::new()
$layerSplitObserved = 0
$layerSplitEnabled = 0
$commonWidth = 0
$commonHeight = 0
$commonFrameRate = 0
foreach ($action in $actions) {
    $actionRoot = Join-Path $resolvedCaptureRoot $action
    $captureFile = Join-Path $actionRoot 'capture.json'
    if (-not (Test-Path -LiteralPath $captureFile -PathType Leaf)) {
        throw "Capture metadata is missing for action $action`: $captureFile"
    }
	    $capture = Get-Content -LiteralPath $captureFile -Raw -Encoding utf8 | ConvertFrom-Json
	    $captureJsonSha256 = (Get-FileHash -LiteralPath $captureFile -Algorithm SHA256).Hash
    $width = [int]$capture.width
    $height = [int]$capture.height
	    $frameRate = [int]$capture.frameRate
	    $frameCount = [int]$capture.frameCount
	    $captureDurationSeconds = [double]$capture.durationSeconds
	    $officialTiming = $officialTimelineActions[$action]
	    $durationSeconds = [double]$officialTiming.durationSeconds
    $authoredViewportProperty = $capture.PSObject.Properties['authoredViewport']
    $authoredViewport = if ($null -eq $authoredViewportProperty) {
        $null
    } else {
        $authoredViewportProperty.Value
    }
    $authoredFullscreenProperty = $capture.PSObject.Properties['authoredFullscreen']
    $authoredFullscreen = if ($null -eq $authoredFullscreenProperty) {
        $null
    } else {
        $authoredFullscreenProperty.Value
    }
    $windowEvidence = $backdropWindowActions |
        Where-Object { [string]$_.action -ceq $action } |
        Select-Object -First 1
    if ($null -eq $windowEvidence) {
        throw "Backdrop-window evidence is missing for action $action"
    }
    # The capture's authored flags describe renderer observations, while the
    # backdrop document is the authoritative, independently reviewed host
    # mode.  In particular, transient fullscreen probes must not be promoted
    # to an opaque host and stable official fullscreen actions must not be
    # reduced to a short pixel window.  Fall back to the flags only for legacy
    # documents that predate the explicit mode field.
    $declaredWindowMode = [string]$windowEvidence.backgroundMode
    $backgroundMode = if ($declaredWindowMode -in @('none','viewport','fullscreen')) {
        $declaredWindowMode
    } else { Get-ActionBackgroundMode `
        -AuthoredViewport $authoredViewport `
        -AuthoredFullscreen $authoredFullscreen `
        -Action $action }
    if ([int]$capture.ownerId -ne $SourceId -or
        [string]$capture.action -cne $action -or $width -lt 2 -or $height -lt 2 -or
        $frameRate -lt 1 -or $frameRate -gt 60 -or $frameCount -lt 2 -or
	        -not [double]::IsFinite($captureDurationSeconds) -or $captureDurationSeconds -le 0 -or
	        -not [double]::IsFinite($durationSeconds) -or $durationSeconds -le 0 -or
        [string]$capture.capturePolicy -cne $capturePolicy -or
        [string]$capture.normalization -cne $captureNormalization -or
        [string]$capture.backgroundPolicy -cne $captureBackgroundPolicy -or
        [int]$capture.backgroundRendererCount -ne @($capture.backgroundRendererPaths).Count -or
        $width -lt 1 -or $height -lt 1 -or $frameRate -le 0) {
        throw "Capture metadata is invalid for action $action"
    }
	    $expectedFrameCount = [int][Math]::Ceiling($captureDurationSeconds * $frameRate) + 1
    if ($frameCount -ne $expectedFrameCount) {
        throw "Capture frame contract mismatch for $action`: metadata=$frameCount expected=$expectedFrameCount"
    }
	$backgroundMetadata = Get-ActionBackgroundMetadata -Mode $backgroundMode `
	        -AuthoredViewport $authoredViewport -Width $width -Height $height `
	        -DurationSeconds $captureDurationSeconds -FrameRate $frameRate -FrameCount $frameCount `
	        -WindowEvidence $windowEvidence -Action $action

	    # Layer split is strictly opt-in. Legacy captures did not emit a
	    # layerSplit field and remain the historical single foreground channel.
	    # An enabled split is an exact, action/frame-bound encoding rather than two
	    # independently authored layers. Fail closed unless the producer retained
	    # both raw channels, the official reference, and a complete zero-error proof.
	    $layerSplitProperty = $capture.PSObject.Properties['layerSplit']
	    $split = if ($null -eq $layerSplitProperty) { $null } else { $layerSplitProperty.Value }
	    if ($null -ne $split) {
	        $layerSplitObserved++
	        if ([string]$split.policy -cne $layerSplitPolicy -or
	            [string]$split.foregroundDirectory -cne '.' -or
	            $null -eq $split.enabled) {
	            throw "Capture layerSplit evidence is invalid for action $action"
	        }
	        $disableRequested = $disableLayerSplitActionSet.Contains($action)
	        # A per-action disable is an explicit request to use the historical
	        # foreground-only channel, even when capture.json still contains the
	        # producer's split/raw/reference artifacts.  Keep the source metadata
	        # untouched; all downstream decisions use this effective state.
	        $splitEnabled = $split.enabled -eq $true -and -not $disableRequested
	        $underlayDirectory = [string]$split.underlayDirectory
	        $underlayRoot = Join-Path $actionRoot 'underlay'
	        $rawForegroundRoot = Join-Path $actionRoot 'foreground-raw'
	        $rawUnderlayRoot = Join-Path $actionRoot 'underlay-raw'
	        $officialFullRoot = Join-Path $actionRoot 'official-full'
	        $derivedForegroundFrames = @(
	            Get-ChildItem -LiteralPath $actionRoot -Filter 'frame-*.png' -File | Sort-Object Name)
	        $underlayFrames = if ($splitEnabled) {
	            if ($underlayDirectory -cne 'underlay' -or -not (Test-Path -LiteralPath $underlayRoot -PathType Container)) {
	                throw "Enabled layerSplit underlay directory is missing for action $action"
	            }
	            @(Get-ChildItem -LiteralPath $underlayRoot -Filter 'frame-*.png' -File | Sort-Object Name)
	        } elseif ($disableRequested) {
	            # Do not inspect or hash underlay/raw/official-full artifacts for a
	            # forced legacy action.  Foreground frame validation below remains
	            # mandatory and is the only channel consumed for this action.
	            @()
	        } else {
            $disabledUnderlayCount = if (Test-Path -LiteralPath $underlayRoot -PathType Container) {
                @(Get-ChildItem -LiteralPath $underlayRoot -Filter 'frame-*.png' -File).Count
            } else { 0 }
            if ($underlayDirectory -cne '' -or $disabledUnderlayCount -ne 0) {
                throw "Disabled layerSplit action contains underlay frames: $action"
            }
	            @()
	        }
	        $rawForegroundFrames = @()
	        $rawUnderlayFrames = @()
	        $officialFullFrames = @()
	        $derivedForegroundSha256s = @()
	        $derivedUnderlaySha256s = @()
	        $rawForegroundSha256s = @()
	        $rawUnderlaySha256s = @()
	        $officialFullSha256s = @()
	        $exact = $null
	        if ($splitEnabled) {
	            $layerSplitEnabled++
	            # A validated dual-channel action may also carry authored backdrop
	            # metadata.  The backdrop windows remain a host-side blackout and
	            # timing contract, while the exact foreground/underlay pair is
	            # encoded on the complete capture canvas (see the native conversion
	            # branch below).  Do not reject this valid combination.
	            if ([string]$split.rawForegroundDirectory -cne 'foreground-raw' -or
	                [string]$split.rawUnderlayDirectory -cne 'underlay-raw' -or
	                -not (Test-Path -LiteralPath $rawForegroundRoot -PathType Container) -or
	                -not (Test-Path -LiteralPath $rawUnderlayRoot -PathType Container) -or
	                -not (Test-Path -LiteralPath $officialFullRoot -PathType Container)) {
	                throw "Exact layerSplit raw/reference directories are missing or invalid for action $action"
	            }
	            $rawForegroundFrames = @(
	                Get-ChildItem -LiteralPath $rawForegroundRoot -Filter 'frame-*.png' -File | Sort-Object Name)
	            $rawUnderlayFrames = @(
	                Get-ChildItem -LiteralPath $rawUnderlayRoot -Filter 'frame-*.png' -File | Sort-Object Name)
	            $officialFullFrames = @(
	                Get-ChildItem -LiteralPath $officialFullRoot -Filter 'frame-*.png' -File | Sort-Object Name)
	            $exactProperty = $capture.PSObject.Properties['officialFullEquivalence']
	            $exact = if ($null -eq $exactProperty) { $null } else { $exactProperty.Value }
	            $channelOrder = if ($null -eq $exact) { @() } else {
	                @($exact.channelOrder | ForEach-Object { [string]$_ })
	            }
	            if ($null -eq $exact -or
	                [string]$exact.schema -cne $exactScreenSchema -or
	                [string]$exact.compositor -cne $exactScreenCompositor -or
	                [string]$exact.foregroundDirectory -cne '.' -or
	                [string]$exact.underlayDirectory -cne 'underlay' -or
	                [string]$exact.rawForegroundDirectory -cne 'foreground-raw' -or
	                [string]$exact.rawUnderlayDirectory -cne 'underlay-raw' -or
	                [string]$exact.officialFullDirectory -cne 'official-full' -or
	                [string]$exact.underlaySemantics -cne $exactUnderlaySemantics -or
	                [string]$exact.hostBlendMode -cne 'screen' -or
	                [string]$exact.screenInverse -cne 'minimum-foreground-byte-v1' -or
	                $channelOrder.Count -ne 2 -or $channelOrder[0] -cne 'underlay' -or
	                $channelOrder[1] -cne 'foreground' -or
	                [string]$exact.transport -cne $exactScreenTransport -or
	                $exact.complete -ne $true -or
	                [int]$exact.frameCount -ne $frameCount -or
	                [int]$exact.verifiedFrameCount -ne $frameCount -or
	                [int]$exact.mismatchedFrameCount -ne 0 -or
	                [long]$exact.exactMismatchPixelCount -ne 0 -or
	                [int]$exact.maximumChannelDelta -ne 0 -or
	                [int]$exact.unexpectedRendererCount -ne 0 -or
	                [string]$exact.activeWindowsSha256 -notmatch '^[0-9A-F]{64}$') {
	                throw "Exact compensated SCREEN evidence is incomplete for action $action"
	            }
	            $rendererStateProperty = $split.PSObject.Properties['rendererState']
	            $rendererState = if ($null -eq $rendererStateProperty) { $null } else { $rendererStateProperty.Value }
	            if ($null -eq $rendererState -or $rendererState.restored -ne $true -or
	                [int]$rendererState.snapshotCount -lt $frameCount -or
	                [int]$rendererState.mismatchCount -ne 0) {
	                throw "Exact layerSplit renderer state was not restored for action $action"
	            }
	            if ([int]$split.underlayFrameCount -ne $frameCount -or
	                $derivedForegroundFrames.Count -ne $frameCount -or
	                $underlayFrames.Count -ne $frameCount -or
	                $rawForegroundFrames.Count -ne $frameCount -or
	                $rawUnderlayFrames.Count -ne $frameCount -or
	                $officialFullFrames.Count -ne $frameCount -or
	                @($exact.frames).Count -ne $frameCount) {
	                throw "LayerSplit underlay frame count mismatch for action $action"
	            }
	            $derivedForegroundSha256s = [string[]]::new($frameCount)
	            $derivedUnderlaySha256s = [string[]]::new($frameCount)
	            $rawForegroundSha256s = [string[]]::new($frameCount)
	            $rawUnderlaySha256s = [string[]]::new($frameCount)
	            $officialFullSha256s = [string[]]::new($frameCount)
	            [long]$clampedPixelTotal = 0
	            [long]$clampedChannelTotal = 0
	            for ($underlayIndex = 0; $underlayIndex -lt $frameCount; $underlayIndex++) {
	                $expectedUnderlayName = 'frame-{0:D4}.png' -f $underlayIndex
	                $frameEvidence = @($exact.frames)[$underlayIndex]
	                $requiredFrameHashes = @(
	                    [string]$frameEvidence.derivedForegroundSha256,
	                    [string]$frameEvidence.derivedUnderlaySha256,
	                    [string]$frameEvidence.rawForegroundSha256,
	                    [string]$frameEvidence.rawUnderlaySha256,
	                    [string]$frameEvidence.officialFullSha256,
	                    [string]$frameEvidence.derivedForegroundRgbSha256,
	                    [string]$frameEvidence.derivedUnderlayRgbSha256,
	                    [string]$frameEvidence.rawForegroundRgbSha256,
	                    [string]$frameEvidence.rawUnderlayRgbSha256,
	                    [string]$frameEvidence.compositeRgbSha256,
	                    [string]$frameEvidence.officialFullRgbSha256)
	                if ($derivedForegroundFrames[$underlayIndex].Name -cne $expectedUnderlayName -or
	                    $underlayFrames[$underlayIndex].Name -cne $expectedUnderlayName -or
	                    $rawForegroundFrames[$underlayIndex].Name -cne $expectedUnderlayName -or
	                    $rawUnderlayFrames[$underlayIndex].Name -cne $expectedUnderlayName -or
	                    $officialFullFrames[$underlayIndex].Name -cne $expectedUnderlayName -or
	                    $derivedForegroundFrames[$underlayIndex].Length -le 0 -or
	                    $underlayFrames[$underlayIndex].Length -le 0 -or
	                    $rawForegroundFrames[$underlayIndex].Length -le 0 -or
	                    $rawUnderlayFrames[$underlayIndex].Length -le 0 -or
	                    $officialFullFrames[$underlayIndex].Length -le 0 -or
	                    [int]$frameEvidence.frameIndex -ne $underlayIndex -or
	                    [string]$frameEvidence.fileName -cne $expectedUnderlayName -or
	                    @($requiredFrameHashes | Where-Object { $_ -notmatch '^[0-9A-F]{64}$' }).Count -ne 0 -or
	                    [int]$frameEvidence.mismatchedPixelCount -ne 0 -or
	                    [int]$frameEvidence.maximumChannelDelta -ne 0 -or
	                    [string]$frameEvidence.compositeRgbSha256 -cne
	                        [string]$frameEvidence.officialFullRgbSha256) {
	                    throw "Exact layerSplit frame sequence/proof is incomplete for action $action at $expectedUnderlayName"
	                }
	                $derivedForegroundSha256s[$underlayIndex] =
	                    (Get-FileHash -LiteralPath $derivedForegroundFrames[$underlayIndex].FullName -Algorithm SHA256).Hash
	                $derivedUnderlaySha256s[$underlayIndex] =
	                    (Get-FileHash -LiteralPath $underlayFrames[$underlayIndex].FullName -Algorithm SHA256).Hash
	                $rawForegroundSha256s[$underlayIndex] =
	                    (Get-FileHash -LiteralPath $rawForegroundFrames[$underlayIndex].FullName -Algorithm SHA256).Hash
	                $rawUnderlaySha256s[$underlayIndex] =
	                    (Get-FileHash -LiteralPath $rawUnderlayFrames[$underlayIndex].FullName -Algorithm SHA256).Hash
	                $officialFullSha256s[$underlayIndex] =
	                    (Get-FileHash -LiteralPath $officialFullFrames[$underlayIndex].FullName -Algorithm SHA256).Hash
	                if ($derivedForegroundSha256s[$underlayIndex] -cne [string]$frameEvidence.derivedForegroundSha256 -or
	                    $derivedUnderlaySha256s[$underlayIndex] -cne [string]$frameEvidence.derivedUnderlaySha256 -or
	                    $rawForegroundSha256s[$underlayIndex] -cne [string]$frameEvidence.rawForegroundSha256 -or
	                    $rawUnderlaySha256s[$underlayIndex] -cne [string]$frameEvidence.rawUnderlaySha256 -or
	                    $officialFullSha256s[$underlayIndex] -cne [string]$frameEvidence.officialFullSha256) {
	                    throw "Exact layerSplit frame hashes are stale for action $action at $expectedUnderlayName"
	                }
	                $clampedPixelTotal += [long]$frameEvidence.clampedPixelCount
	                $clampedChannelTotal += [long]$frameEvidence.clampedChannelCount
	            }
	            if ($clampedPixelTotal -ne [long]$exact.clampedPixelCount -or
	                $clampedChannelTotal -ne [long]$exact.clampedChannelCount) {
	                throw "Exact layerSplit clamp totals do not match frame evidence for action $action"
	            }
	            $splitSignatures = @($split.underlayRendererSignatures | ForEach-Object { [string]$_ })
	            $captureSignatures = @($capture.backgroundRendererSignatures | ForEach-Object { [string]$_ })
            if ($splitSignatures.Count -eq 0 -or
                @(Compare-Object -ReferenceObject ($captureSignatures | Sort-Object -Unique) -DifferenceObject ($splitSignatures | Sort-Object -Unique)).Count -ne 0) {
                throw "LayerSplit renderer evidence does not match capture metadata for action $action"
            }
		        } elseif (-not $disableRequested) {
		            $disabledRawOrOfficialCount = 0
		            $rawForegroundDirectoryValue = if ($null -eq $split.PSObject.Properties['rawForegroundDirectory']) {
		                ''
		            } else {
		                [string]$split.rawForegroundDirectory
		            }
		            $rawUnderlayDirectoryValue = if ($null -eq $split.PSObject.Properties['rawUnderlayDirectory']) {
		                ''
		            } else {
		                [string]$split.rawUnderlayDirectory
		            }
		            foreach ($disabledRoot in @($rawForegroundRoot, $rawUnderlayRoot, $officialFullRoot)) {
		                if (Test-Path -LiteralPath $disabledRoot -PathType Container) {
		                    $disabledRawOrOfficialCount += @(
	                        Get-ChildItem -LiteralPath $disabledRoot -Filter 'frame-*.png' -File).Count
	                }
	            }
		            $exactProperty = $capture.PSObject.Properties['officialFullEquivalence']
		            if ([int]$split.underlayFrameCount -ne 0 -or
		                -not [string]::IsNullOrEmpty($rawForegroundDirectoryValue) -or
		                -not [string]::IsNullOrEmpty($rawUnderlayDirectoryValue) -or
	                $disabledRawOrOfficialCount -ne 0 -or
	                ($null -ne $exactProperty -and $null -ne $exactProperty.Value)) {
	                throw "Disabled layerSplit action has derived/raw exact evidence: $action"
	            }
	        }
	        $layerSplitRecords.Add([pscustomobject]@{
	            action = $action
	            enabled = $splitEnabled
	            captureJsonSha256 = $captureJsonSha256
	            foregroundRoot = $actionRoot
	            foregroundFrames = @($derivedForegroundFrames)
	            foregroundFrameSha256s = @($derivedForegroundSha256s)
	            underlayRoot = $underlayRoot
	            underlayFrames = @($underlayFrames)
	            underlayFrameSha256s = @($derivedUnderlaySha256s)
	            rawForegroundRoot = $rawForegroundRoot
	            rawForegroundFrames = @($rawForegroundFrames)
	            rawForegroundFrameSha256s = @($rawForegroundSha256s)
	            rawUnderlayRoot = $rawUnderlayRoot
	            rawUnderlayFrames = @($rawUnderlayFrames)
	            rawUnderlayFrameSha256s = @($rawUnderlaySha256s)
	            officialFullRoot = $officialFullRoot
	            officialFullFrames = @($officialFullFrames)
	            officialFullFrameSha256s = @($officialFullSha256s)
	            exact = $exact
	            underlayRendererSignatures = @($split.underlayRendererSignatures | ForEach-Object { [string]$_ })
	            activeWindows = @($split.activeWindows)
	        })
    } else {
        $layerSplitRecords.Add([pscustomobject]@{
            action = $action
            enabled = $false
            underlayRoot = (Join-Path $actionRoot 'underlay')
            underlayFrames = @()
            underlayRendererSignatures = @()
            activeWindows = @()
        })
    }
    if ($commonWidth -eq 0) {
        $commonWidth = $width
        $commonHeight = $height
        $commonFrameRate = $frameRate
    }
    elseif ($width -ne $commonWidth -or $height -ne $commonHeight -or $frameRate -ne $commonFrameRate) {
        throw "Capture geometry or frame rate differs for action $action"
    }
    $frames = @(Get-ChildItem -LiteralPath $actionRoot -Filter 'frame-*.png' -File | Sort-Object Name)
    if ($frames.Count -ne $frameCount) {
        throw "Capture frame count mismatch for $action`: files=$($frames.Count) metadata=$frameCount"
    }
    $frameSha256s = [string[]]::new($frameCount)
    $uniqueFrameSha256s = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase)
    for ($frameIndex = 0; $frameIndex -lt $frameCount; $frameIndex++) {
        $expectedName = 'frame-{0:D4}.png' -f $frameIndex
        if ($frames[$frameIndex].Name -cne $expectedName -or $frames[$frameIndex].Length -le 0) {
            throw "Capture frame sequence is incomplete for $action at $expectedName"
        }
        $frameSha256 = (Get-FileHash -LiteralPath $frames[$frameIndex].FullName -Algorithm SHA256).Hash
        $frameSha256s[$frameIndex] = $frameSha256
        [void]$uniqueFrameSha256s.Add($frameSha256)
    }
    $middleFrameIndex = [int][Math]::Floor(($frameCount - 1) / 2)
    $firstFrameSha256 = $frameSha256s[0]
    $middleFrameSha256 = $frameSha256s[$middleFrameIndex]
    $lastFrameSha256 = $frameSha256s[$frameCount - 1]
    $firstMiddleLastAllSame =
        [System.StringComparer]::OrdinalIgnoreCase.Equals($firstFrameSha256, $middleFrameSha256) -and
        [System.StringComparer]::OrdinalIgnoreCase.Equals($middleFrameSha256, $lastFrameSha256)
    if ($uniqueFrameSha256s.Count -lt $minimumUniqueFrameSha256Count) {
        throw (('Capture motion gate rejected action {0}: uniqueFrameSha256Count={1}, required>={2}, ' +
            'firstMiddleLastAllSame={3}. No SWF output was written.') -f
            $action, $uniqueFrameSha256s.Count, $minimumUniqueFrameSha256Count, $firstMiddleLastAllSame)
    }
    # The fresh validator invoked above owns the motion/background decision and
    # binds it to the current frame/capture hashes in the root marker.  Consume
    # that evidence here instead of re-running a hash-only motion gate that cannot
    # distinguish an intentional transparent hold from a frozen visible frame.
    $completionActionEvidence = $completionActions |
        Where-Object { [string]$_.action -ceq $action } |
        Select-Object -First 1
    $motionEvidence = $completionActionEvidence.motionEvidence
    if ($null -eq $motionEvidence -or $motionEvidence.passed -ne $true) {
        throw (('Capture segmented motion gate rejected action {0}: {1} No SWF output was written.') -f
            $action, (@($motionEvidence.errors) -join ' '))
    }
    $captureRecords.Add([pscustomobject]@{
        action = $action
        root = $actionRoot
        captureFile = $captureFile
	        captureJsonSha256 = $captureJsonSha256
        authoredViewport = $authoredViewport
        authoredFullscreen = $authoredFullscreen
        backgroundMode = $backgroundMode
        backgroundGeometry = $backgroundMetadata.geometry
        backgroundWindows = @($backgroundMetadata.windows)
        width = $width
        height = $height
	        frameRate = $frameRate
	        frameCount = $frameCount
	        durationSeconds = $durationSeconds
	        captureDurationSeconds = $captureDurationSeconds
	        videoWindow = $officialTiming.videoWindow
	        uniqueFrameSha256Count = $uniqueFrameSha256s.Count
	        frameSha256s = @($frameSha256s)
        firstFrameSha256 = $firstFrameSha256
        middleFrameIndex = $middleFrameIndex
        middleFrameSha256 = $middleFrameSha256
        lastFrameSha256 = $lastFrameSha256
        motionEvidence = $motionEvidence
        backgroundEvidence = ($completionActions |
            Where-Object { [string]$_.action -ceq $action } |
            Select-Object -First 1).backgroundEvidence
        layerSplit = $split
        layerSplitRecord = ($layerSplitRecords | Where-Object { $_.action -ceq $action } |
            Select-Object -First 1)
    })
}

$layerSplitEnabledActions = @($layerSplitRecords | Where-Object { $_.enabled })
if ($layerSplitObserved -ne 0 -and $layerSplitObserved -ne $actions.Count) {
    throw 'LayerSplit evidence is incomplete: every action must emit layerSplit metadata once split capture is present.'
}
# A skill may legitimately use a separable scene backdrop only for a subset of
# actions.  Keep the per-action enabled state instead of forcing a stale/black
# underlay into actions whose renderer graph has no classified backdrop.
$layerSplitBuildEnabled = -not $DisableLayerSplit -and
    $layerSplitObserved -eq $actions.Count -and
    $layerSplitEnabledActions.Count -gt 0
$layerSplitValidation = $null
if ($layerSplitBuildEnabled) {
    if (-not [string]::IsNullOrWhiteSpace($LayerSplitEvidenceFile)) {
        $resolvedLayerSplitEvidenceFile = [System.IO.Path]::GetFullPath($LayerSplitEvidenceFile)
        if (-not (Test-Path -LiteralPath $resolvedLayerSplitEvidenceFile -PathType Leaf)) {
            throw "LayerSplit validation report is missing: $resolvedLayerSplitEvidenceFile"
        }
        $layerSplitValidation = [System.IO.File]::ReadAllText(
            $resolvedLayerSplitEvidenceFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -DateKind String
    }
    else {
        $layerSplitValidator = Join-Path $PSScriptRoot 'Validate-UClientLayerSplitCandidate.ps1'
        if (-not (Test-Path -LiteralPath $layerSplitValidator -PathType Leaf)) {
            throw "LayerSplit validator is missing: $layerSplitValidator"
        }
        $layerSplitValidation = (& $layerSplitValidator -CaptureRoot $resolvedCaptureRoot | Out-String) |
            ConvertFrom-Json -DateKind String
    }
	    $validatedSplitActions = @($layerSplitValidation.actions)
	    $validatedSplitNames = @($validatedSplitActions | ForEach-Object { [string]$_.action })
	    if ([string]$layerSplitValidation.schema -cne 'seer2-uclient-layer-split-candidate-v2' -or
	        [string]$layerSplitValidation.captureRoot -cne $resolvedCaptureRoot -or
	        [string]$layerSplitValidation.root -cne $resolvedCaptureRoot -or
	        [string]$layerSplitValidation.captureRootIdentitySchema -cne
	            'seer2-uclient-layer-split-capture-root-identity-v1' -or
	        [string]$layerSplitValidation.captureRootSha256 -notmatch '^[0-9A-F]{64}$' -or
	        [string]$layerSplitValidation.policy -cne $layerSplitPolicy -or
	        [string]$layerSplitValidation.exactSchema -cne $exactScreenSchema -or
	        [string]$layerSplitValidation.exactCompositor -cne $exactScreenCompositor -or
	        [string]$layerSplitValidation.channelManifestSchema -cne $derivedChannelManifestSchema -or
	        [string]$layerSplitValidation.dualChannelGateSchema -cne 'seer2-uclient-dual-channel-gate-v1' -or
	        $layerSplitValidation.dualChannelGatePassed -ne $true -or
	        $layerSplitValidation.passed -ne $true -or
	        @($layerSplitValidation.errors).Count -ne 0 -or
	        $validatedSplitActions.Count -ne $actions.Count -or
	        @(Compare-Object -ReferenceObject $actions -DifferenceObject $validatedSplitNames).Count -ne 0) {
	        throw 'LayerSplit validation evidence is incomplete or does not match the capture action set.'
	    }
	    $rootIdentityActions = [System.Collections.Generic.List[object]]::new()
	    foreach ($validated in $validatedSplitActions) {
	        $expected = $layerSplitRecords | Where-Object { $_.action -ceq [string]$validated.action } | Select-Object -First 1
	        $captureRecord = $captureRecords | Where-Object { $_.action -ceq [string]$validated.action } | Select-Object -First 1
	        if ($null -eq $expected -or $null -eq $captureRecord -or
	            $validated.enabled -ne [bool]$expected.enabled -or
	            [string]$validated.captureJson -cne [string]$captureRecord.captureFile -or
	            [string]$validated.captureJsonSha256 -cne [string]$captureRecord.captureJsonSha256) {
	            throw "LayerSplit validation enabled state does not match capture metadata: $($validated.action)"
	        }
	        $expectedForegroundManifest = New-DerivedChannelManifestIdentity `
	            -ActionRoot ([string]$captureRecord.root) -Directory '.'
                $expectedUnderlayManifest = New-DerivedChannelManifestIdentity `
                    -ActionRoot ([string]$captureRecord.root) -Directory 'underlay'
	        $foregroundManifest = $validated.foregroundManifest
	        $underlayManifest = $validated.underlayManifest
	        if ([string]$validated.foregroundDirectory -cne '.' -or
	            [string]$foregroundManifest.schema -cne $derivedChannelManifestSchema -or
	            [string]$foregroundManifest.directory -cne '.' -or
	            [int]$foregroundManifest.frameCount -ne [int]$captureRecord.frameCount -or
	            [string]$foregroundManifest.sha256 -cne [string]$expectedForegroundManifest.sha256 -or
	            @($foregroundManifest.frames).Count -ne [int]$captureRecord.frameCount) {
	            throw "LayerSplit foreground manifest is stale for action $($validated.action)"
	        }
	        if ([string]$underlayManifest.schema -cne $derivedChannelManifestSchema -or
	            [string]$underlayManifest.directory -cne 'underlay' -or
	            [string]$underlayManifest.sha256 -cne [string]$expectedUnderlayManifest.sha256) {
	            throw "LayerSplit underlay manifest is stale for action $($validated.action)"
	        }
	        $exactProof = $validated.exactProof
	        if ($expected.enabled) {
	            if ([string]$validated.underlayDirectory -cne 'underlay' -or
	                [int]$validated.foregroundFrameCount -ne [int]$captureRecord.frameCount -or
	                [int]$validated.underlayFrameCount -ne [int]$captureRecord.frameCount -or
	                [int]$underlayManifest.frameCount -ne [int]$captureRecord.frameCount -or
	                @($underlayManifest.frames).Count -ne [int]$captureRecord.frameCount -or
	                $exactProof.required -ne $true -or $exactProof.passed -ne $true -or
	                [string]$exactProof.schema -cne $exactScreenSchema -or
	                [string]$exactProof.compositor -cne $exactScreenCompositor -or
	                [int]$exactProof.frameCount -ne [int]$captureRecord.frameCount -or
	                [int]$exactProof.verifiedFrameCount -ne [int]$captureRecord.frameCount -or
	                [int]$exactProof.mismatchedFrameCount -ne 0 -or
                # Hex digests are case-insensitive; the validator emits this
                # identity in lowercase while capture.json uses uppercase.
                [string]$exactProof.activeWindowsSha256 -ine [string]$expected.exact.activeWindowsSha256) {
	                throw "LayerSplit exact validation proof is incomplete for action $($validated.action)"
	            }
	        }
	        elseif ([string]$validated.underlayDirectory -cne '' -or
	            [int]$validated.foregroundFrameCount -ne [int]$captureRecord.frameCount -or
	            [int]$validated.underlayFrameCount -ne 0 -or
	            [int]$underlayManifest.frameCount -ne 0 -or
	            @($underlayManifest.frames).Count -ne 0 -or
	            $exactProof.required -ne $false) {
	            throw "Disabled LayerSplit validation contains underlay/exact evidence for action $($validated.action)"
	        }
	        $rootIdentityActions.Add([ordered]@{
	            action = [string]$validated.action
	            enabled = [bool]$validated.enabled
	            captureJsonSha256 = [string]$validated.captureJsonSha256
	            foregroundManifestSha256 = [string]$expectedForegroundManifest.sha256
	            underlayManifestSha256 = [string]$expectedUnderlayManifest.sha256
	            exactSchema = [string]$exactProof.schema
	            exactPassed = [bool]$exactProof.passed
	        })
	    }
	    $rootIdentity = [ordered]@{
	        schema = 'seer2-uclient-layer-split-capture-root-identity-v1'
	        captureRoot = $resolvedCaptureRoot
	        actions = @($rootIdentityActions | Sort-Object { [string]$_.action })
	    }
	    $rootIdentityJson = $rootIdentity | ConvertTo-Json -Depth 10 -Compress
	    $rootIdentitySha256 = [Convert]::ToHexString(
	        [System.Security.Cryptography.SHA256]::HashData($utf8NoBom.GetBytes($rootIdentityJson)))
	    if ($rootIdentitySha256 -cne [string]$layerSplitValidation.captureRootSha256) {
	        throw 'LayerSplit validation capture-root identity is stale.'
	    }
	}

$ffmpegSha256 = (Get-FileHash -LiteralPath $resolvedFfmpeg -Algorithm SHA256).Hash
$nativeBuilds = [System.Collections.Generic.List[object]]::new()
$underlayNativeBuilds = [System.Collections.Generic.List[object]]::new()
$underlayNativeRoot = Join-Path $nativeRoot 'underlay'
Assert-PathInside -Root $resolvedWorkRoot -Target $underlayNativeRoot -Description 'Native underlay build path'
if ($layerSplitBuildEnabled) {
    New-Item -ItemType Directory -Path $underlayNativeRoot -Force | Out-Null
}
else {
    # Do not let a prior candidate leak into a legacy rebuild's staging tree.
    Remove-Item -LiteralPath $underlayNativeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($capture in $captureRecords) {
    $nativeTarget = Join-Path $nativeRoot ($capture.action + '.swf')
    $nativeTemporary = $nativeTarget + '.part-' + $PID
    Assert-PathInside -Root $resolvedWorkRoot -Target $nativeTarget -Description 'Native action SWF'
    Remove-Item -LiteralPath $nativeTemporary -Force -ErrorAction SilentlyContinue
    $framePattern = Join-Path $capture.root 'frame-%04d.png'
    # FFmpeg's AVM2 muxer uses FLV1/Sorenson Spark, which has no alpha channel.
    # Keep the validated capture sequence RGBA until this final boundary, then
    # flatten over true black deliberately for the Flash SCREEN wrapper.  The
    # v5 background gate above prevents a non-black Timeline scene layer from
    # being mistaken for transparency before this irreversible conversion.
	    $viewport = $capture.authoredViewport
	    $hasViewport = $null -ne $viewport -and $viewport.enabled -eq $true -and
        [int]$viewport.x -ge 0 -and [int]$viewport.y -ge 0 -and
        [int]$viewport.width -gt 1 -and [int]$viewport.height -gt 1 -and
	        [int]$viewport.x + [int]$viewport.width -le [int]$capture.width -and
	        [int]$viewport.y + [int]$viewport.height -le [int]$capture.height
	    $captureSplitRecord = $layerSplitRecords |
	        Where-Object { $_.action -ceq [string]$capture.action } | Select-Object -First 1
	    # Exact split captures are already aligned on the complete canvas.  Keep
	    # authored viewport/fullscreen metadata for the host backdrop contract, but
	    # never crop only the foreground while its underlay remains full-canvas.
	    # Legacy (non-split) actions retain their authored viewport crop behavior.
	    $hasLayerSplit = $null -ne $captureSplitRecord -and $captureSplitRecord.enabled -and
	        $layerSplitBuildEnabled
	    if ($hasLayerSplit) { $hasViewport = $false }
	    if ([string]$capture.backgroundMode -ceq 'viewport' -and -not $hasViewport) {
	        if (-not $hasLayerSplit) {
            throw "Capture metadata enables authored viewport background with invalid bounds for action $($capture.action)"
	        }
	    }
    if ($hasViewport) {
        # The official action is authored inside this stable viewport.  Crop that
        # exact authored rectangle (the user's red-box region) and scale it to the
        # Flash stage.  This removes outer scene-shell pollution while making the
        # intended starfield cover the complete preview.
        $filterGraph = [string]::Format($invariant,
            '[0:v]format=rgba,crop={0}:{1}:{2}:{3},scale={4}:{5}:flags=lanczos,format=yuv420p,setsar=1[video]',
            [int]$viewport.width, [int]$viewport.height, [int]$viewport.x,
            [int]$viewport.y, $capture.width, $capture.height)
    }
    else {
        $filterGraph = [string]::Format($invariant,
            'color=c=black:s={0}x{1}:r={2}[background];[0:v]format=rgba[foreground];[background][foreground]overlay=shortest=1:format=auto,format=yuv420p,setsar=1[video]',
            $capture.width, $capture.height, $capture.frameRate)
    }
    $ffmpegArguments = @(
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-framerate', [string]$capture.frameRate,
        '-start_number', '0',
        '-i', $framePattern,
        '-filter_complex', $filterGraph,
        '-map', '[video]',
        '-frames:v', [string]$capture.frameCount,
        '-r', [string]$capture.frameRate,
        '-fps_mode', 'cfr',
        '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        '-c:v', 'flv', '-q:v', '1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
        '-f', 'avm2', '-y', $nativeTemporary
    )
    try {
        & $resolvedFfmpeg @ffmpegArguments
        $ffmpegExitCode = $LASTEXITCODE
        if ($ffmpegExitCode -ne 0) {
            throw "ffmpeg AVM2 conversion failed for $($capture.action): $ffmpegExitCode"
        }
        $nativeInfo = Get-Item -LiteralPath $nativeTemporary
        $nativeSignature = Get-SwfSignature -Path $nativeTemporary
        if ($nativeInfo.Length -lt 256 -or $nativeInfo.Length -gt 256MB -or
            $nativeSignature -notin @('FWS', 'CWS', 'ZWS')) {
            throw "ffmpeg returned an invalid native SWF for $($capture.action)"
        }
        Commit-File -Temporary $nativeTemporary -Target $nativeTarget
    }
    finally {
        Remove-Item -LiteralPath $nativeTemporary -Force -ErrorAction SilentlyContinue
    }
    $committedNative = Get-Item -LiteralPath $nativeTarget
    $nativeBuilds.Add([pscustomobject]@{
        action = $capture.action
        file = $nativeTarget
        relativeFile = ('skill-timeline-build/native/' + $capture.action + '.swf')
        bytes = [long]$committedNative.Length
        sha256 = (Get-FileHash -LiteralPath $nativeTarget -Algorithm SHA256).Hash
        width = $capture.width
        height = $capture.height
	        frameRate = $capture.frameRate
	        frameCount = $capture.frameCount
	        durationSeconds = $capture.durationSeconds
	        captureDurationSeconds = $capture.captureDurationSeconds
	        videoWindow = $capture.videoWindow
	        uniqueFrameSha256Count = $capture.uniqueFrameSha256Count
        firstFrameSha256 = $capture.firstFrameSha256
        middleFrameIndex = $capture.middleFrameIndex
        middleFrameSha256 = $capture.middleFrameSha256
        lastFrameSha256 = $capture.lastFrameSha256
        motionEvidence = $capture.motionEvidence
        backgroundEvidence = $capture.backgroundEvidence
        backgroundMode = $capture.backgroundMode
        backgroundGeometry = $capture.backgroundGeometry
        backgroundWindows = @($capture.backgroundWindows)
        captureJson = $capture.captureFile
        captureJsonSha256 = $capture.captureJsonSha256
        ffmpegArgv = @($ffmpegArguments[0..($ffmpegArguments.Count - 2)] + '<native-action.swf>')
    })
}

if ($layerSplitBuildEnabled) {
    foreach ($splitRecord in $layerSplitRecords) {
        if (-not $splitRecord.enabled) { continue }
        if (@($splitRecord.underlayFrames).Count -ne $splitRecord.underlayFrames.Count) {
            throw "LayerSplit build record is incomplete for action $($splitRecord.action)"
        }
        $underlayTarget = Join-Path $underlayNativeRoot ($splitRecord.action + '.swf')
        $underlayTemporary = $underlayTarget + '.part-' + $PID
        Assert-PathInside -Root $resolvedWorkRoot -Target $underlayTarget -Description 'Native underlay action SWF'
        Remove-Item -LiteralPath $underlayTemporary -Force -ErrorAction SilentlyContinue
        $underlayFramePattern = Join-Path $splitRecord.underlayRoot 'frame-%04d.png'
        # Keep the underlay channel a deterministic black-flattened AVM2 clip,
        # exactly like the legacy foreground path.  Its separate display root
        # is inserted below Spine by pet.as; it never replaces frame-*.png.
        $underlayFilterGraph = [System.String]::Format($invariant,
            'color=c=black:s={0}x{1}:r={2}[background];[0:v]format=rgba[foreground];[background][foreground]overlay=shortest=1:format=auto,format=yuv420p,setsar=1[video]',
            $commonWidth, $commonHeight, $commonFrameRate)
        $underlayFfmpegArguments = @(
            '-hide_banner', '-nostdin', '-loglevel', 'error',
            '-framerate', [string]$commonFrameRate,
            '-start_number', '0',
            '-i', $underlayFramePattern,
            '-filter_complex', $underlayFilterGraph,
            '-map', '[video]',
            '-frames:v', [string]$splitRecord.underlayFrames.Count,
            '-r', [string]$commonFrameRate,
            '-fps_mode', 'cfr',
            '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
            '-c:v', 'flv', '-q:v', '1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
            '-f', 'avm2', '-y', $underlayTemporary
        )
        try {
            & $resolvedFfmpeg @underlayFfmpegArguments
            $underlayExitCode = $LASTEXITCODE
            if ($underlayExitCode -ne 0) {
                throw "ffmpeg AVM2 underlay conversion failed for $($splitRecord.action): $underlayExitCode"
            }
            $underlayInfo = Get-Item -LiteralPath $underlayTemporary
            $underlaySignature = Get-SwfSignature -Path $underlayTemporary
            if ($underlayInfo.Length -lt 256 -or $underlayInfo.Length -gt 256MB -or
                $underlaySignature -notin @('FWS', 'CWS', 'ZWS')) {
                throw "ffmpeg returned an invalid native underlay SWF for $($splitRecord.action)"
            }
            Commit-File -Temporary $underlayTemporary -Target $underlayTarget
        }
        finally {
            Remove-Item -LiteralPath $underlayTemporary -Force -ErrorAction SilentlyContinue
        }
        $committedUnderlay = Get-Item -LiteralPath $underlayTarget
        $underlayHashes = @($splitRecord.underlayFrames | ForEach-Object {
            (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        })
        $underlayCapture = $captureRecords |
            Where-Object { $_.action -ceq $splitRecord.action } | Select-Object -First 1
        $underlayNativeBuilds.Add([pscustomobject]@{
            action = $splitRecord.action
            file = $underlayTarget
            relativeFile = ('skill-timeline-build/native/underlay/' + $splitRecord.action + '.swf')
            bytes = [long]$committedUnderlay.Length
            sha256 = (Get-FileHash -LiteralPath $underlayTarget -Algorithm SHA256).Hash
	            frameCount = $splitRecord.underlayFrames.Count
	            frameRate = $commonFrameRate
	            durationSeconds = [double]$underlayCapture.durationSeconds
	            captureDurationSeconds = [double]$underlayCapture.captureDurationSeconds
	            videoWindow = $underlayCapture.videoWindow
            frameSha256s = $underlayHashes
            captureJsonSha256 = [string](($captureRecords | Where-Object { $_.action -ceq $splitRecord.action } | Select-Object -First 1).captureJsonSha256)
            ffmpegArgv = @($underlayFfmpegArguments[0..($underlayFfmpegArguments.Count - 2)] + '<native-underlay-action.swf>')
        })
    }
}

$embedLines = [System.Collections.Generic.List[string]]::new()
$definitionLines = [System.Collections.Generic.List[string]]::new()
$underlayEmbedLines = [System.Collections.Generic.List[string]]::new()
$underlayDefinitionLines = [System.Collections.Generic.List[string]]::new()
foreach ($native in $nativeBuilds) {
    $className = $invariant.TextInfo.ToTitleCase([string]$native.action) + 'Bytes'
    $embedLines.Add('      [Embed(source="native/' + $native.action + '.swf", mimeType="application/octet-stream")]')
    $embedLines.Add('      private static const ' + $className + ':Class;')
    $duration = [System.Convert]::ToString([double]$native.durationSeconds, $invariant)
    $geometryLiteral = if ($null -eq $native.backgroundGeometry) { 'null' } else {
        $native.backgroundGeometry | ConvertTo-Json -Depth 8 -Compress
    }
    # ConvertTo-Json emits an empty string for a zero-length pipeline.  The
    # generated AS3 object must carry an explicit empty array for actions that
    # do not declare a backdrop (appear/attack), otherwise the wrapper source
    # becomes `backgroundWindows: }` and fails to compile.
    $windows = @($native.backgroundWindows)
    $windowsLiteral = if ($windows.Count -eq 0) { '[]' } else {
        $windows | ConvertTo-Json -Depth 10 -Compress -AsArray
    }
    $splitRecord = $layerSplitRecords | Where-Object { $_.action -ceq $native.action } | Select-Object -First 1
    $activeWindows = @()
    if ($null -ne $splitRecord -and @($splitRecord.activeWindows).Count -gt 0) {
        $activeWindows = @($splitRecord.activeWindows)
    }
    elseif ($null -ne $splitRecord -and $splitRecord.enabled -and $layerSplitBuildEnabled -and $native.backgroundMode -eq 'none') {
        $activeWindows = @([ordered]@{ startSeconds = 0; endSeconds = [double]$native.durationSeconds })
    }
    $activeWindowsLiteral = if ($activeWindows.Count -eq 0) { '[]' } else { $activeWindows | ConvertTo-Json -Depth 10 -Compress -AsArray }
    $definitionLines.Add('         "' + $native.action + '":{ bytes:' + $className +
        ', frameCount:' + $native.frameCount + ', frameRate:' + $native.frameRate +
        ', durationSeconds:' + $duration + ', backgroundMode:"' +
        [string]$native.backgroundMode + '", backgroundGeometry:' + $geometryLiteral +
        ', backgroundWindows:' + $windowsLiteral + ', activeWindows:' + $activeWindowsLiteral + ' }')
}
foreach ($native in $underlayNativeBuilds) {
    $className = $invariant.TextInfo.ToTitleCase([string]$native.action) + 'UnderlayBytes'
    $underlayEmbedLines.Add('      [Embed(source="native/underlay/' + $native.action + '.swf", mimeType="application/octet-stream")]')
    $underlayEmbedLines.Add('      private static const ' + $className + ':Class;')
    $underlayDefinitionLines.Add('         "' + $native.action + '":' + $className)
}
$underlayDefinitionsSource = if ($underlayDefinitionLines.Count -eq 0) { '' } else {
    ($underlayDefinitionLines -join (',' + [Environment]::NewLine))
}

$as3Template = @'
package
{
   import flash.display.BlendMode;
   import flash.display.Loader;
   import flash.display.LoaderInfo;
   import flash.display.MovieClip;
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.events.SecurityErrorEvent;
   import flash.system.ApplicationDomain;
   import flash.system.LoaderContext;
   import flash.utils.ByteArray;
   import flash.utils.Dictionary;

      [SWF(width="__WIDTH__",height="__HEIGHT__",frameRate="__FRAME_RATE__",backgroundColor="#000000")]
      public class __CLASS_NAME__ extends Sprite
      {
__EMBEDS__

      private static const ACTIONS:Array = [__ACTIONS__];
      private static const UNDERLAY_CLASSES:Object = { __UNDERLAY_DEFINITIONS__ };
      private var _definitions:Object;
      private var _loaders:Object = {};
      private var _clips:Object = {};
      private var _ready:Object = {};
      private var _errors:Object = {};
      private var _loaderActions:Dictionary = new Dictionary(true);
      private var _underlayLoaders:Object = {};
      private var _underlayClips:Object = {};
      private var _underlayReady:Object = {};
      private var _underlayErrors:Object = {};
      private var _underlayLoaderActions:Dictionary = new Dictionary(true);
      private var _underlayContainer:Sprite = new Sprite();
      private var _configuration:Object;
      private var _action:String = "";
      private var _elapsed:Number = 0;
      private var _active:Boolean = false;
      private var _disposed:Boolean = false;

      public function __CLASS_NAME__()
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;
         _definitions = {
__DEFINITIONS__
         };
         _underlayContainer.name = "timeline-underlay";
         _underlayContainer.mouseEnabled = false;
         _underlayContainer.mouseChildren = false;
         _underlayContainer.visible = false;
         for each(var action:String in ACTIONS)
         {
            loadAction(action);
            if(UNDERLAY_CLASSES[action]) loadUnderlayAction(action);
         }
      }

      private function loadAction(action:String):void
      {
         var definition:Object = _definitions[action];
         var bytesClass:Class = definition.bytes as Class;
         var payload:ByteArray = new bytesClass() as ByteArray;
         var loader:Loader = new Loader();
         loader.name = "timeline-" + action;
         loader.mouseEnabled = false;
         loader.visible = false;
         loader.blendMode = BlendMode.__BLEND_MODE__;
         _loaders[action] = loader;
         _loaderActions[loader.contentLoaderInfo] = action;
         loader.contentLoaderInfo.addEventListener(Event.COMPLETE,onActionLoaded,false,0,true);
         loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,onActionLoadError,false,0,true);
         loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,onActionLoadError,false,0,true);
         addChild(loader);
         loader.loadBytes(payload,
            new LoaderContext(false,new ApplicationDomain(ApplicationDomain.currentDomain)));
      }

      private function onActionLoaded(event:Event):void
      {
         var info:LoaderInfo = event.currentTarget as LoaderInfo;
         var action:String = String(_loaderActions[info] || "");
         var loader:Loader = _loaders[action] as Loader;
         var clip:MovieClip = loader ? loader.content as MovieClip : null;
         if(!clip)
         {
            _errors[action] = "native AVM2 action did not expose a MovieClip root";
            return;
         }
         clip.stop();
         clip.gotoAndStop(1);
         _clips[action] = clip;
         _ready[action] = true;
         if(_active && _action == action) applySeek(action,_elapsed);
      }

      private function onActionLoadError(event:Event):void
      {
         var info:LoaderInfo = event.currentTarget as LoaderInfo;
         var action:String = String(_loaderActions[info] || "");
         _errors[action] = event.toString();
      }

      private function loadUnderlayAction(action:String):void
      {
         var bytesClass:Class = UNDERLAY_CLASSES[action] as Class;
         if(!bytesClass) return;
         var payload:ByteArray = new bytesClass() as ByteArray;
         var loader:Loader = new Loader();
         loader.name = "timeline-underlay-" + action;
         loader.mouseEnabled = false;
         loader.visible = false;
         loader.blendMode = BlendMode.SCREEN;
         _underlayLoaders[action] = loader;
         _underlayLoaderActions[loader.contentLoaderInfo] = action;
         loader.contentLoaderInfo.addEventListener(Event.COMPLETE,onUnderlayLoaded,false,0,true);
         loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,onUnderlayLoadError,false,0,true);
         loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,onUnderlayLoadError,false,0,true);
         _underlayContainer.addChild(loader);
         loader.loadBytes(payload,
            new LoaderContext(false,new ApplicationDomain(ApplicationDomain.currentDomain)));
      }

      private function onUnderlayLoaded(event:Event):void
      {
         var info:LoaderInfo = event.currentTarget as LoaderInfo;
         var action:String = String(_underlayLoaderActions[info] || "");
         var loader:Loader = _underlayLoaders[action] as Loader;
         var clip:MovieClip = loader ? loader.content as MovieClip : null;
         if(!clip)
         {
            _underlayErrors[action] = "native AVM2 underlay did not expose a MovieClip root";
            return;
         }
         clip.stop();
         clip.gotoAndStop(1);
         _underlayClips[action] = clip;
         _underlayReady[action] = true;
         if(_active && _action == action) applyUnderlaySeek(action,_elapsed);
      }

      private function onUnderlayLoadError(event:Event):void
      {
         var info:LoaderInfo = event.currentTarget as LoaderInfo;
         var action:String = String(_underlayLoaderActions[info] || "");
         _underlayErrors[action] = event.toString();
      }

      public function configureTimeline(value:Object):Boolean
      {
         if(_disposed) return false;
         _configuration = value;
         return true;
      }

      public function selectTimelineAction(value:String):Boolean
      {
         if(_disposed) return false;
         hideAll();
         _action = String(value || "").toLowerCase();
         _elapsed = 0;
         if(!_definitions[_action])
         {
            _active = false;
            return false;
         }
         _active = true;
         var loader:Loader = _loaders[_action] as Loader;
         if(loader) loader.visible = true;
         if(_ready[_action] === true) applySeek(_action,0);
         if(_underlayReady[_action] === true) applyUnderlaySeek(_action,0);
         return true;
      }

      public function seekTimelineSeconds(value:Number):Boolean
      {
         if(_disposed || !_active || !_definitions[_action]) return false;
         _elapsed = Math.max(0,Number(value) || 0);
         var definition:Object = _definitions[_action];
         if(_elapsed >= Number(definition.durationSeconds))
         {
            hideAll();
            _active = false;
            return false;
         }
         if(_ready[_action] === true) applySeek(_action,_elapsed);
         if(_underlayReady[_action] === true) applyUnderlaySeek(_action,_elapsed);
         return true;
      }

      private function applySeek(action:String,elapsed:Number):void
      {
         var definition:Object = _definitions[action];
         var clip:MovieClip = _clips[action] as MovieClip;
         var loader:Loader = _loaders[action] as Loader;
         if(!clip || !loader) return;
         var frame:int = 1 + int(Math.max(0,elapsed) * Number(definition.frameRate));
         frame = Math.max(1,Math.min(int(definition.frameCount),frame));
         loader.visible = _active && _action == action;
         clip.gotoAndStop(frame);
      }

      private function hideAll():void
      {
         for each(var action:String in ACTIONS)
         {
            var loader:Loader = _loaders[action] as Loader;
            if(loader) loader.visible = false;
            var underlay:Loader = _underlayLoaders[action] as Loader;
            if(underlay) underlay.visible = false;
         }
         _underlayContainer.visible = false;
         if(_underlayContainer.parent) _underlayContainer.parent.removeChild(_underlayContainer);
      }

      private function applyUnderlaySeek(action:String,elapsed:Number):void
      {
         var definition:Object = _definitions[action];
         var clip:MovieClip = _underlayClips[action] as MovieClip;
         var loader:Loader = _underlayLoaders[action] as Loader;
         if(!definition || !clip || !loader) return;
         var frame:int = 1 + int(Math.max(0,elapsed) * Number(definition.frameRate));
         frame = Math.max(1,Math.min(int(definition.frameCount),frame));
         loader.visible = _active && _action == action && underlayWindowActive(definition,elapsed);
         _underlayContainer.visible = loader.visible;
         if(!loader.visible) detachTimelineUnderlay();
         clip.gotoAndStop(frame);
      }

      private function underlayWindowActive(definition:Object,elapsed:Number):Boolean
      {
         // The underlay renderer clock is captured independently from the
         // foreground backdrop metadata.  Reading backgroundWindows here made a
         // valid split disappear whenever the foreground correctly declared
         // backgroundMode=none (the 4000 cp/sa/hidemove case).
         var windows:Array = definition && definition.activeWindows is Array ?
            definition.activeWindows as Array : [];
         for each(var window:Object in windows)
         {
            var start:Number = Number(window && window.startSeconds);
            var end:Number = Number(window && window.endSeconds);
            if(!isNaN(start) && isFinite(start) && !isNaN(end) && isFinite(end) &&
               start >= 0 && end > start && elapsed >= start && elapsed < end) return true;
         }
         return false;
      }

      public function getTimelineUnderlayDisplay():Object
      {
         var definition:Object = _definitions[_action];
         if(_disposed || !_active || !UNDERLAY_CLASSES[_action] ||
            _underlayReady[_action] !== true || !underlayWindowActive(definition,_elapsed))
            return null;
         _underlayContainer.visible = true;
         return _underlayContainer;
      }

      public function detachTimelineUnderlay():void
      {
         _underlayContainer.visible = false;
         if(_underlayContainer.parent) _underlayContainer.parent.removeChild(_underlayContainer);
      }

      private function loadedActions():Array
      {
         var result:Array = [];
         for each(var action:String in ACTIONS) if(_ready[action] === true) result.push(action);
         return result;
      }

      public function getTimelineState():Object
      {
         var definition:Object = _definitions[_action];
         var clip:MovieClip = _clips[_action] as MovieClip;
         return {
            ready:loadedActions().length == ACTIONS.length,
            active:_active,
            action:_action,
            elapsed:_elapsed,
            frame:clip ? clip.currentFrame : 0,
	            total:definition ? int(definition.frameCount) : 0,
	            durationSeconds:definition ? Number(definition.durationSeconds) : 0,
	            backgroundMode:definition ? String(definition.backgroundMode || "none") : "none",
	            backgroundGeometry:definition ? definition.backgroundGeometry : null,
            backgroundWindows:definition ? definition.backgroundWindows : [],
            activeWindows:definition ? definition.activeWindows : [],
	            underlayEnabled:definition ? UNDERLAY_CLASSES[_action] != null : false,
	            underlayReady:_underlayReady[_action] === true,
	            underlayError:_action ? String(_underlayErrors[_action] || "") : "",
	            loadedActions:loadedActions(),
            error:_action ? String(_errors[_action] || "") : "",
            blendModePolicy:"__BLEND_POLICY__",
            disposed:_disposed
         };
      }

      public function disposeTimeline():void
      {
         if(_disposed) return;
         _disposed = true;
         _active = false;
         hideAll();
         detachTimelineUnderlay();
         for each(var action:String in ACTIONS)
         {
            var loader:Loader = _loaders[action] as Loader;
            if(!loader) continue;
            try
            {
               loader.contentLoaderInfo.removeEventListener(Event.COMPLETE,onActionLoaded);
               loader.contentLoaderInfo.removeEventListener(IOErrorEvent.IO_ERROR,onActionLoadError);
               loader.contentLoaderInfo.removeEventListener(SecurityErrorEvent.SECURITY_ERROR,onActionLoadError);
               loader.close();
            }
            catch(ignoredClose:*) {}
            try { loader.unloadAndStop(true); } catch(ignoredUnload:*) {}
            if(loader.parent) loader.parent.removeChild(loader);
            var underlay:Loader = _underlayLoaders[action] as Loader;
            if(underlay)
            {
               try
               {
                  underlay.contentLoaderInfo.removeEventListener(Event.COMPLETE,onUnderlayLoaded);
                  underlay.contentLoaderInfo.removeEventListener(IOErrorEvent.IO_ERROR,onUnderlayLoadError);
                  underlay.contentLoaderInfo.removeEventListener(SecurityErrorEvent.SECURITY_ERROR,onUnderlayLoadError);
                  underlay.close();
               }
               catch(ignoredUnderlayClose:*) {}
               try { underlay.unloadAndStop(true); } catch(ignoredUnderlayUnload:*) {}
               if(underlay.parent) underlay.parent.removeChild(underlay);
            }
         }
         _loaders = {};
         _clips = {};
         _ready = {};
         _underlayLoaders = {};
         _underlayClips = {};
         _underlayReady = {};
      }
   }
}
'@

function New-WrapperSource {
    param(
        [Parameter(Mandatory = $true)][string]$ClassName,
        [Parameter(Mandatory = $true)][string]$Embeds,
        [Parameter(Mandatory = $true)][string]$Definitions,
        [string]$UnderlayDefinitions = '',
        [Parameter(Mandatory = $true)][string[]]$WrapperActions,
        [Parameter(Mandatory = $true)][string]$BlendMode,
        [Parameter(Mandatory = $true)][string]$BlendPolicy
    )
    $actionLiteral = ($WrapperActions | ForEach-Object { '"' + $_ + '"' }) -join ','
    return $as3Template.Replace('__WIDTH__', [string]$commonWidth).
        Replace('__HEIGHT__', [string]$commonHeight).
        Replace('__FRAME_RATE__', [string]$commonFrameRate).
        Replace('__CLASS_NAME__', $ClassName).
        Replace('__ACTIONS__', $actionLiteral).
        Replace('__EMBEDS__', $Embeds).
        Replace('__DEFINITIONS__', $Definitions).
        Replace('__UNDERLAY_DEFINITIONS__', $UnderlayDefinitions).
        Replace('__BLEND_MODE__', $BlendMode).
        Replace('__BLEND_POLICY__', $BlendPolicy)
}

$allEmbedLines = @($embedLines) + @($underlayEmbedLines)
$as3Source = New-WrapperSource -ClassName 'UClientSkillTimelineOverlay' `
    -Embeds ($allEmbedLines -join [Environment]::NewLine) `
    -Definitions (($definitionLines -join (',' + [Environment]::NewLine))) `
    -UnderlayDefinitions $underlayDefinitionsSource `
    -WrapperActions $actions -BlendMode 'SCREEN' -BlendPolicy 'screen'
[System.IO.File]::WriteAllText($wrapperSource, $as3Source, $utf8NoBom)

New-Item -ItemType Directory -Path $stagingRoot | Out-Null
$wrapperTemporary = Join-Path $stagingRoot ([System.IO.Path]::GetFileName($wrapperTarget))
$manifestTemporary = Join-Path $stagingRoot ([System.IO.Path]::GetFileName($manifestTarget))
foreach ($stagedOutput in @($wrapperTemporary, $manifestTemporary)) {
    Assert-PathInside -Root $stagingRoot -Target $stagedOutput -Description 'SkillTimeline staged output'
}
$wrapperReady = $false
$previousJavaHome = $env:JAVA_HOME
$previousPlayerGlobalHome = $env:PLAYERGLOBAL_HOME
$previousPath = $env:Path
try {
    $env:JAVA_HOME = [System.IO.Path]::GetFullPath($JavaHome)
    $env:PLAYERGLOBAL_HOME = [System.IO.Path]::GetFullPath($PlayerGlobalHome)
    $env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $previousPath
    $compilerArguments = @(
        '-target-player=32.1',
        '-swf-version=43',
        '-debug=false',
        '-optimize=true',
        '-static-link-runtime-shared-libraries=true',
        "-output=$wrapperTemporary",
        $wrapperSource
    )
    & $resolvedMxmlc @compilerArguments
    $compilerExitCode = $LASTEXITCODE
    if ($compilerExitCode -ne 0) {
        throw "mxmlc failed for the $SourceId SkillTimeline wrapper: $compilerExitCode"
    }
    $wrapperInfo = Get-Item -LiteralPath $wrapperTemporary
    $wrapperSignature = Get-SwfSignature -Path $wrapperTemporary
    if ($wrapperInfo.Length -lt 1024 -or $wrapperInfo.Length -gt 512MB -or
        $wrapperSignature -notin @('FWS', 'CWS', 'ZWS')) {
        throw "mxmlc returned an invalid $SourceId SkillTimeline wrapper SWF"
    }
    $wrapperReady = $true
}
finally {
    $env:JAVA_HOME = $previousJavaHome
    $env:PLAYERGLOBAL_HOME = $previousPlayerGlobalHome
    $env:Path = $previousPath
    if (-not $wrapperReady) {
        Remove-Item -LiteralPath $wrapperTemporary -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$wrapper = Get-Item -LiteralPath $wrapperTemporary
$layerSplitManifest = if ($layerSplitBuildEnabled) {
    [ordered]@{
        enabled = $true
        policy = $layerSplitPolicy
        hostPlacement = 'behind-spine'
        blendMode = 'screen'
        channel = 'embedded-underlay'
        native = [ordered]@{
            file = 'uclient-skill-timeline.swf'
            channel = 'embedded-underlay'
            wrapperBytes = [long]$wrapper.Length
            wrapperSha256 = (Get-FileHash -LiteralPath $wrapperTemporary -Algorithm SHA256).Hash
            actions = @($underlayNativeBuilds | ForEach-Object {
                [ordered]@{
                    action = $_.action
                    relativeFile = $_.relativeFile
                    bytes = $_.bytes
                    sha256 = $_.sha256
                    frameCount = $_.frameCount
                    frameRate = $_.frameRate
                    durationSeconds = $_.durationSeconds
                    frameSha256s = @($_.frameSha256s)
                    captureJsonSha256 = $_.captureJsonSha256
                }
            })
        }
        actions = @($layerSplitRecords | ForEach-Object {
            $recordAction = [string]$_.action
            $captureRecord = $captureRecords |
                Where-Object { $_.action -ceq $recordAction } | Select-Object -First 1
            if (-not $_.enabled) {
                [ordered]@{
                    action = $recordAction
                    enabled = $false
                    channel = 'none'
                    frameCount = 0
                    frameRate = $commonFrameRate
                    captureJsonSha256 = [string]$captureRecord.captureJsonSha256
                    frameSha256s = @()
                }
                return
            }
            $underlayNative = $underlayNativeBuilds |
                Where-Object { $_.action -ceq $recordAction } | Select-Object -First 1
            [ordered]@{
                action = $recordAction
                enabled = $true
                channel = 'embedded-underlay'
                frameCount = @($_.underlayFrames).Count
                frameRate = $commonFrameRate
                durationSeconds = [double]$underlayNative.durationSeconds
                captureJsonSha256 = [string]$captureRecord.captureJsonSha256
                # Keep the historical frameSha256s alias for the auto-adapter
                # contract while exposing the explicit underlay name consumed by
                # the runtime overlay normalizer.  Both arrays are derived from
                # the same validated frame sequence and must stay in lockstep.
                underlayFrameSha256s = @($_.underlayFrameSha256s)
                frameSha256s = @($_.underlayFrameSha256s)
                nativeSwf = $underlayNative.relativeFile
                nativeSwfBytes = $underlayNative.bytes
                nativeSwfSha256 = $underlayNative.sha256
            }
        })
    }
} else { $null }

$manifest = [ordered]@{
    schemaVersion = 1
    sourceId = $SourceId
    generatedAt = [DateTime]::UtcNow.ToString('o')
    enabled = $true
    conversionPolicy = $conversionPolicy
    capture = [ordered]@{
        root = $resolvedCaptureRoot
        completionMarker = $completionMarker
        completionMarkerSha256 = (Get-FileHash -LiteralPath $completionMarker -Algorithm SHA256).Hash
        policy = $capturePolicy
        normalization = $captureNormalization
        backgroundPolicy = $captureBackgroundPolicy
        backdropWindows = [ordered]@{
            file = $resolvedBackdropWindowsFile
            sha256 = (Get-FileHash -LiteralPath $resolvedBackdropWindowsFile -Algorithm SHA256).Hash
            schema = [string]$backdropWindowsDocument.schema
            policy = [string]$backdropWindowsDocument.policy
        }
    }
	    width = $commonWidth
	    height = $commonHeight
	    frameRate = $commonFrameRate
	    timelineSummary = [ordered]@{
	        file = $resolvedTimelineSummary
	        sha256 = $timelineSummarySha256
	    }
	    file = [System.IO.Path]::GetFileName($wrapperTarget)
    bytes = [long]$wrapper.Length
    sha256 = (Get-FileHash -LiteralPath $wrapperTemporary -Algorithm SHA256).Hash
    selfContained = $true
    blendMode = 'screen'
    api = @(
        'configureTimeline',
        'selectTimelineAction',
        'seekTimelineSeconds',
        'getTimelineState',
        'disposeTimeline',
        'getTimelineUnderlayDisplay',
        'detachTimelineUnderlay'
    )
    actions = @($nativeBuilds | ForEach-Object {
        $recordAction = [string]$_.action
        $actionManifest = [ordered]@{
            action = $_.action
	            frameRate = $_.frameRate
	            frameCount = $_.frameCount
	            durationSeconds = $_.durationSeconds
	            captureDurationSeconds = $_.captureDurationSeconds
	            videoWindow = $_.videoWindow
	            backgroundMode = $_.backgroundMode
            backgroundGeometry = $_.backgroundGeometry
            backgroundWindows = @($_.backgroundWindows)
            uniqueFrameSha256Count = $_.uniqueFrameSha256Count
            frameSha256Evidence = [ordered]@{
                first = $_.firstFrameSha256
                middleIndex = $_.middleFrameIndex
                middle = $_.middleFrameSha256
                last = $_.lastFrameSha256
            }
            motionEvidence = $_.motionEvidence
            backgroundEvidence = $_.backgroundEvidence
            nativeSwf = $_.relativeFile
            nativeSwfBytes = $_.bytes
            nativeSwfSha256 = $_.sha256
            captureJson = $_.captureJson
            captureJsonSha256 = $_.captureJsonSha256
            ffmpegArgv = $_.ffmpegArgv
        }
        $splitRecord = $layerSplitRecords |
            Where-Object { $_.action -ceq $recordAction } | Select-Object -First 1
        if ($layerSplitBuildEnabled -and $null -ne $splitRecord -and $splitRecord.enabled) {
            $underlayNative = $underlayNativeBuilds |
                Where-Object { $_.action -ceq $recordAction } | Select-Object -First 1
            $actionManifest.underlay = [ordered]@{
                enabled = $true
                channel = 'embedded-underlay'
                frameCount = $underlayNative.frameCount
                frameRate = $underlayNative.frameRate
                nativeSwf = $underlayNative.relativeFile
                nativeSwfBytes = $underlayNative.bytes
                nativeSwfSha256 = $underlayNative.sha256
                frameSha256s = @($underlayNative.frameSha256s)
            }
        }
        $actionManifest
    })
    toolchain = [ordered]@{
        ffmpeg = $resolvedFfmpeg
        ffmpegSha256 = $ffmpegSha256
        mxmlc = $resolvedMxmlc
        mxmlcSha256 = (Get-FileHash -LiteralPath $resolvedMxmlc -Algorithm SHA256).Hash
        javaHome = [System.IO.Path]::GetFullPath($JavaHome)
        playerGlobalHome = [System.IO.Path]::GetFullPath($PlayerGlobalHome)
        targetPlayer = '32.1'
        swfVersion = 43
    }
}
if ($layerSplitBuildEnabled) {
    $manifest.layerSplit = $layerSplitManifest
}

try {
    $manifestJson = $manifest | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($manifestTemporary, $manifestJson + [Environment]::NewLine, $utf8NoBom)
    $roundTrip = Get-Content -LiteralPath $manifestTemporary -Raw -Encoding utf8 | ConvertFrom-Json
    $manifestActions = @($roundTrip.actions)
    $stagedWrapperSha256 = (Get-FileHash -LiteralPath $wrapperTemporary -Algorithm SHA256).Hash
    if ($manifestActions.Count -ne 5 -or [long]$roundTrip.bytes -ne [long]$wrapper.Length -or
        [string]$roundTrip.file -cne [System.IO.Path]::GetFileName($wrapperTarget) -or
        [string]$roundTrip.sha256 -cne $stagedWrapperSha256) {
        throw 'SkillTimeline staged SWF/manifest pair identity is invalid.'
    }
    if ($layerSplitBuildEnabled) {
        $roundTripLayerSplit = $roundTrip.PSObject.Properties['layerSplit']
        $roundTripNativeSplit = if ($null -eq $roundTripLayerSplit) { $null } else {
            $roundTripLayerSplit.Value.native
        }
        if ($null -eq $roundTripLayerSplit -or $roundTripLayerSplit.Value.enabled -ne $true -or
            [string]$roundTripLayerSplit.Value.policy -cne $layerSplitPolicy -or
            [string]$roundTripLayerSplit.Value.hostPlacement -cne 'behind-spine' -or
            [string]$roundTripLayerSplit.Value.channel -cne 'embedded-underlay' -or
            $null -eq $roundTripNativeSplit -or
            [long]$roundTripNativeSplit.wrapperBytes -ne [long]$wrapper.Length -or
            [string]$roundTripNativeSplit.wrapperSha256 -cne $stagedWrapperSha256 -or
            @($roundTripLayerSplit.Value.actions).Count -ne $actions.Count -or
            @($roundTripNativeSplit.actions).Count -ne $layerSplitEnabledActions.Count) {
            throw 'SkillTimeline staged layerSplit wrapper identity is invalid.'
        }
    } elseif ($null -ne $roundTrip.PSObject.Properties['layerSplit']) {
        throw 'Legacy SkillTimeline manifest unexpectedly carries layerSplit evidence.'
    }
    $manifestActionNames = @($manifestActions | ForEach-Object { [string]$_.action })
    if (@($manifestActionNames | Sort-Object -Unique).Count -ne $actions.Count -or
        @(Compare-Object -ReferenceObject $actions -DifferenceObject $manifestActionNames).Count -ne 0) {
        throw 'SkillTimeline staged manifest action set is incomplete or duplicated.'
    }
    foreach ($actionEvidence in $manifestActions) {
        $nativeEvidence = $nativeBuilds |
            Where-Object { $_.action -ceq [string]$actionEvidence.action } |
            Select-Object -First 1
        $officialEvidenceTiming = $officialTimelineActions[[string]$actionEvidence.action]
        $actualVideoWindowProperty = $actionEvidence.PSObject.Properties['videoWindow']
        $actualVideoWindow = if ($null -eq $actualVideoWindowProperty) {
            $null
        } else { $actualVideoWindowProperty.Value }
        $expectedVideoWindow = if ($null -eq $officialEvidenceTiming) {
            $null
        } else { $officialEvidenceTiming.videoWindow }
        $videoWindowMismatch = ($null -eq $expectedVideoWindow -and $null -ne $actualVideoWindow) -or
            ($null -ne $expectedVideoWindow -and $null -eq $actualVideoWindow)
        if (-not $videoWindowMismatch -and $null -ne $expectedVideoWindow) {
            $videoWindowMismatch =
                [math]::Abs([double]$actualVideoWindow.startSeconds - [double]$expectedVideoWindow.startSeconds) -gt 0.0001 -or
                [math]::Abs([double]$actualVideoWindow.endSeconds - [double]$expectedVideoWindow.endSeconds) -gt 0.0001 -or
                [math]::Abs([double]$actualVideoWindow.durationSeconds - [double]$expectedVideoWindow.durationSeconds) -gt 0.0001 -or
                [string]$actualVideoWindow.source -cne 'official Video Track'
        }
        if ([int]$actionEvidence.uniqueFrameSha256Count -lt $minimumUniqueFrameSha256Count -or
            [string]$actionEvidence.backgroundMode -notin @('none', 'viewport', 'fullscreen') -or
            [string]$actionEvidence.frameSha256Evidence.first -notmatch '^[0-9A-F]{64}$' -or
            [string]$actionEvidence.frameSha256Evidence.middle -notmatch '^[0-9A-F]{64}$' -or
            [string]$actionEvidence.frameSha256Evidence.last -notmatch '^[0-9A-F]{64}$' -or
            $null -eq $actionEvidence.motionEvidence -or
            $actionEvidence.motionEvidence.passed -ne $true -or
            @($actionEvidence.motionEvidence.windows | Where-Object { $_.passed -ne $true }).Count -ne 0 -or
            $null -eq $actionEvidence.backgroundEvidence -or
            $actionEvidence.backgroundEvidence.passed -ne $true -or
            @($actionEvidence.backgroundEvidence.errors).Count -ne 0 -or
            -not $nativeEvidence -or
            [string]$actionEvidence.backgroundMode -cne [string]$nativeEvidence.backgroundMode -or
	            $null -eq $officialEvidenceTiming -or
	            [math]::Abs([double]$actionEvidence.durationSeconds - [double]$officialEvidenceTiming.durationSeconds) -gt 0.0001 -or
	            $videoWindowMismatch -or
            ($actionEvidence.backgroundMode -ceq 'none' -and
                ($null -ne $actionEvidence.backgroundGeometry -or @($actionEvidence.backgroundWindows).Count -ne 0)) -or
            ($actionEvidence.backgroundMode -cne 'none' -and
                ($null -eq $actionEvidence.backgroundGeometry -or @($actionEvidence.backgroundWindows).Count -eq 0)) -or
            [long]$actionEvidence.nativeSwfBytes -ne [long]$nativeEvidence.bytes -or
            [string]$actionEvidence.nativeSwfSha256 -cne [string]$nativeEvidence.sha256 -or
            [int]$actionEvidence.frameSha256Evidence.middleIndex -lt 0 -or
            [int]$actionEvidence.frameSha256Evidence.middleIndex -ge [int]$actionEvidence.frameCount) {
            throw "SkillTimeline staged frame evidence is incomplete for action $($actionEvidence.action)."
        }
        $underlayEvidenceProperty = $actionEvidence.PSObject.Properties['underlay']
        if ($layerSplitBuildEnabled) {
            $underlayEvidence = if ($null -eq $underlayEvidenceProperty) { $null } else { $underlayEvidenceProperty.Value }
            $underlayNativeEvidence = $underlayNativeBuilds |
                Where-Object { $_.action -ceq [string]$actionEvidence.action } | Select-Object -First 1
            $expectedSplit = $layerSplitRecords |
                Where-Object { $_.action -ceq [string]$actionEvidence.action } | Select-Object -First 1
            if ($null -eq $expectedSplit) {
                throw "SkillTimeline staged layerSplit record is missing for action $($actionEvidence.action)."
            }
            if ($expectedSplit.enabled) {
                if ($null -eq $underlayEvidence -or $null -eq $underlayNativeEvidence -or
                    $underlayEvidence.enabled -ne $true -or
                    [string]$underlayEvidence.channel -cne 'embedded-underlay' -or
                    [int]$underlayEvidence.frameCount -ne [int]$underlayNativeEvidence.frameCount -or
                    [int]$underlayEvidence.frameRate -ne [int]$underlayNativeEvidence.frameRate -or
                    [long]$underlayEvidence.nativeSwfBytes -ne [long]$underlayNativeEvidence.bytes -or
                    [string]$underlayEvidence.nativeSwfSha256 -cne [string]$underlayNativeEvidence.sha256 -or
                    @($underlayEvidence.frameSha256s).Count -ne [int]$underlayNativeEvidence.frameCount) {
                    throw "SkillTimeline staged underlay evidence is incomplete for action $($actionEvidence.action)."
                }
            } elseif ($null -ne $underlayEvidenceProperty) {
                throw "Disabled SkillTimeline action unexpectedly carries underlay evidence: $($actionEvidence.action)"
            }
        } elseif ($null -ne $underlayEvidenceProperty) {
            throw "Legacy SkillTimeline action unexpectedly carries underlay evidence: $($actionEvidence.action)"
        }
        $first = [string]$actionEvidence.frameSha256Evidence.first
        $middle = [string]$actionEvidence.frameSha256Evidence.middle
        $last = [string]$actionEvidence.frameSha256Evidence.last
        # Full-sequence distinct hashes plus segmented motion evidence are already
        # required above.  Some long official actions are transparent at all three
        # coarse probes, so equality here is evidence, not a freeze verdict.
    }
    Commit-AtomicFilePair -Pairs @(
        @{ Staged = $wrapperTemporary; Target = $wrapperTarget }
        @{ Staged = $manifestTemporary; Target = $manifestTarget }
    )
}
finally {
    foreach ($stagedOutput in @($wrapperTemporary, $manifestTemporary)) {
        Remove-Item -LiteralPath $stagedOutput -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $stagingRoot -PathType Container) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$manifest | ConvertTo-Json -Depth 12
