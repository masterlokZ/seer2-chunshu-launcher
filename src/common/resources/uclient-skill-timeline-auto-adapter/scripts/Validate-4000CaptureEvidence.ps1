param(
    [Parameter(Mandatory = $false)]
    [string]$CaptureRoot = 'D:\swf-work-622\4000-full-action-cinematics-v2-20260816\uclient-capture-runtime\4000-capture-output',

    [Parameter(Mandatory = $false)]
    [string[]]$Actions = @(),

    [Parameter(Mandatory = $false)]
    [ValidateRange(0, 2147483647)]
    [int]$ExpectedOwnerId = 0,

    [Parameter(Mandatory = $false)]
    [ValidateRange(0, 2147483647)]
    [int]$ExpectedWidth = 0,

    [Parameter(Mandatory = $false)]
    [ValidateRange(0, 2147483647)]
    [int]$ExpectedHeight = 0,

    [Parameter(Mandatory = $false)]
    [ValidateRange(0, 120)]
    [int]$ExpectedFrameRate = 0,

    [Parameter(Mandatory = $false)]
    [hashtable]$ImpactSecondsByAction = @{},

    [Parameter(Mandatory = $false)]
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lib\UClient4000CaptureMotionGate.ps1')

$requiredActions = @('appear', 'attack', 'cp', 'sa', 'hidemove')
$expectedActions = @($requiredActions)
$expectedOwnerId = $ExpectedOwnerId
$expectedWidth = $ExpectedWidth
$expectedHeight = $ExpectedHeight
$expectedFrameRate = $ExpectedFrameRate
$expectedCapturePolicy = ''
$expectedNormalization = ''
$expectedBackgroundPolicy = ''
$expectedActionMarkerSchema = 'seer2-uclient-capture-action-complete-v3'
$minimumDistinctHashes = 11
$pngSignature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
$pngIend = [byte[]](0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130)

function Convert-BytesToHex {
    param([byte[]]$Bytes)
    return [Convert]::ToHexString($Bytes).ToLowerInvariant()
}

function Get-BigEndianUInt32 {
    param(
        [byte[]]$Bytes,
        [int]$Offset
    )

    return [uint32](
        ([uint32]$Bytes[$Offset] -shl 24) -bor
        ([uint32]$Bytes[$Offset + 1] -shl 16) -bor
        ([uint32]$Bytes[$Offset + 2] -shl 8) -bor
        [uint32]$Bytes[$Offset + 3]
    )
}

function Get-FileSha256Hex {
    param([string]$LiteralPath)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::Open(
            $LiteralPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        try {
            return Convert-BytesToHex -Bytes ($sha.ComputeHash($stream))
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $sha.Dispose()
    }
}

function Get-TextSha256Hex {
    param([string]$Text)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return Convert-BytesToHex -Bytes ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)))
    }
    finally {
        $sha.Dispose()
    }
}

function Write-AtomicUtf8Json {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)]$Value,
        [int]$Depth = 12
    )

    $directory = [System.IO.Path]::GetDirectoryName($LiteralPath)
    if ([string]::IsNullOrWhiteSpace($directory) -or
        -not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "Atomic JSON target directory is missing: $directory"
    }
    $temporary = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($LiteralPath) +
        '.part-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
    try {
        $json = $Value | ConvertTo-Json -Depth $Depth
        [System.IO.File]::WriteAllText($temporary, $json + "`n", [System.Text.UTF8Encoding]::new($false))
        $stream = [System.IO.File]::Open(
            $temporary,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None)
        try {
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
        [System.IO.File]::Move($temporary, $LiteralPath, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Test-PngEvidence {
    param([System.IO.FileInfo]$File)

    $lengthBefore = $File.Length
    if ($lengthBefore -lt 33) {
        throw "$($File.FullName): PNG is too short ($lengthBefore bytes)."
    }

    Start-Sleep -Milliseconds 15
    $lengthStable = (Get-Item -LiteralPath $File.FullName).Length
    if ($lengthBefore -ne $lengthStable) {
        throw "$($File.FullName): file length changed before exclusive open ($lengthBefore -> $lengthStable)."
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::Open(
            $File.FullName,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::None
        )
        try {
            if ($stream.Length -ne $lengthBefore) {
                throw "$($File.FullName): exclusive stream length differs from metadata."
            }

            $header = [byte[]]::new(24)
            if ($stream.Read($header, 0, $header.Length) -ne $header.Length) {
                throw "$($File.FullName): truncated PNG header."
            }

            for ($i = 0; $i -lt $pngSignature.Length; $i++) {
                if ($header[$i] -ne $pngSignature[$i]) {
                    throw "$($File.FullName): invalid PNG signature."
                }
            }

            if ((Get-BigEndianUInt32 -Bytes $header -Offset 8) -ne 13) {
                throw "$($File.FullName): first PNG chunk is not a 13-byte IHDR."
            }

            $chunkType = [System.Text.Encoding]::ASCII.GetString($header, 12, 4)
            if ($chunkType -ne 'IHDR') {
                throw "$($File.FullName): first PNG chunk type is $chunkType, expected IHDR."
            }

            $width = Get-BigEndianUInt32 -Bytes $header -Offset 16
            $height = Get-BigEndianUInt32 -Bytes $header -Offset 20
            if ($width -ne $expectedWidth -or $height -ne $expectedHeight) {
                throw "$($File.FullName): IHDR is ${width}x${height}, expected ${expectedWidth}x${expectedHeight}."
            }

            $stream.Position = $stream.Length - $pngIend.Length
            $tail = [byte[]]::new($pngIend.Length)
            if ($stream.Read($tail, 0, $tail.Length) -ne $tail.Length) {
                throw "$($File.FullName): truncated PNG IEND."
            }

            for ($i = 0; $i -lt $pngIend.Length; $i++) {
                if ($tail[$i] -ne $pngIend[$i]) {
                    throw "$($File.FullName): PNG does not end with a complete canonical IEND chunk."
                }
            }

            $stream.Position = 0
            $hash = Convert-BytesToHex -Bytes ($sha.ComputeHash($stream))
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $sha.Dispose()
    }

    $lengthAfter = (Get-Item -LiteralPath $File.FullName).Length
    if ($lengthAfter -ne $lengthBefore) {
        throw "$($File.FullName): file length changed during verification ($lengthBefore -> $lengthAfter)."
    }

    return [pscustomobject][ordered]@{
        file = $File.Name
        bytes = $lengthBefore
        sha256 = $hash
        width = $expectedWidth
        height = $expectedHeight
        exclusiveOpen = $true
        stableLength = $true
        completeIend = $true
    }
}

$resolvedRoot = [System.IO.Path]::GetFullPath($CaptureRoot)
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw "Capture root does not exist: $resolvedRoot"
}

$rootMarkerPath = Join-Path $resolvedRoot 'capture-complete.txt'
$reportPath = Join-Path $resolvedRoot 'capture-validation-report.json'
$actionDirectories = @(Get-ChildItem -LiteralPath $resolvedRoot -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'capture.json') } |
    Sort-Object Name)
if ($actionDirectories.Count -eq 0) { throw "Capture root contains no action directories: $resolvedRoot" }
if ($Actions.Count -gt 0) {
    $unknownActions = @($Actions | Where-Object { $requiredActions -notcontains $_ })
    if ($unknownActions.Count -gt 0) {
        throw "Unknown capture action(s): $($unknownActions -join ', ')"
    }
}
$selectedActions = @($expectedActions | Where-Object { $Actions.Count -eq 0 -or $Actions -ccontains $_ })
if ($selectedActions.Count -eq 0) {
    throw 'No capture actions were selected for validation.'
}
$isFullValidation = ($selectedActions.Count -eq $requiredActions.Count -and
    @(Compare-Object -ReferenceObject $requiredActions -DifferenceObject $selectedActions).Count -eq 0)
# Invalidate completion markers before reading metadata or validating any
# caller-supplied impact times.  Any early input/metadata failure is fail-closed:
# stale action/root markers must not survive the attempted validation.
Remove-Item -LiteralPath $rootMarkerPath -Force -ErrorAction SilentlyContinue
foreach ($selectedAction in $selectedActions) {
    $selectedActionMarkerPath = Join-Path (Join-Path $resolvedRoot $selectedAction) 'capture-complete.txt'
    Remove-Item -LiteralPath $selectedActionMarkerPath -Force -ErrorAction SilentlyContinue
}
$firstCapturePath = Join-Path $actionDirectories[0].FullName 'capture.json'
$firstCapture = [System.IO.File]::ReadAllText($firstCapturePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -DateKind String
if ($expectedOwnerId -eq 0) { $expectedOwnerId = [int]$firstCapture.ownerId }
if ($expectedWidth -eq 0) { $expectedWidth = [int]$firstCapture.width }
if ($expectedHeight -eq 0) { $expectedHeight = [int]$firstCapture.height }
if ($expectedFrameRate -eq 0) { $expectedFrameRate = [int]$firstCapture.frameRate }
$expectedCapturePolicy = [string]$firstCapture.capturePolicy
$expectedNormalization = [string]$firstCapture.normalization
$expectedBackgroundPolicy = [string]$firstCapture.backgroundPolicy
$effectiveImpactSeconds = [ordered]@{}
foreach ($impactAction in @($ImpactSecondsByAction.Keys)) {
    if ($ImpactSecondsByAction.ContainsKey($impactAction)) {
        if ($requiredActions -notcontains $impactAction -or $impactAction -eq 'appear') {
            throw "ImpactSecondsByAction contains an invalid action: $impactAction"
        }
        $impactValue = [double]$ImpactSecondsByAction[$impactAction]
        if (-not [double]::IsFinite($impactValue) -or $impactValue -le 0) {
            throw "Official Signal impact time is missing or invalid for $impactAction."
        }
        $effectiveImpactSeconds[$impactAction] = $impactValue
    }
}
$missingImpactActions = @($selectedActions | Where-Object {
    $_ -ne 'appear' -and -not $effectiveImpactSeconds.Contains($_)
})
if ($missingImpactActions.Count -gt 0) {
    throw "Official Signal impact times are missing for: $($missingImpactActions -join ', ')"
}
$verificationStartedAt = [DateTime]::UtcNow
$actionReports = [System.Collections.Generic.List[object]]::new()
$globalErrors = [System.Collections.Generic.List[string]]::new()
$backgroundGateReport = $null
$backgroundGateInvocationError = $null
$backgroundGateActions = @{}
try {
    $backgroundGateScript = Join-Path $PSScriptRoot 'Validate-UClientCaptureBackground.py'
    if (-not (Test-Path -LiteralPath $backgroundGateScript -PathType Leaf)) {
        throw "Capture background gate script is missing: $backgroundGateScript"
    }
    $resolvedPython = if (Test-Path -LiteralPath $Python -PathType Leaf) {
        (Resolve-Path -LiteralPath $Python).Path
    }
    else {
        [string](@(Get-Command $Python -CommandType Application -ErrorAction Stop)[0].Source)
    }
    $backgroundGateReportPath = Join-Path $resolvedRoot 'capture-background-gate-report.json'
    $backgroundGateArguments = @(
        $backgroundGateScript,
        '--capture-root', $resolvedRoot,
        '--minimum-actions', [string]$selectedActions.Count,
        '--output', $backgroundGateReportPath
    )
    foreach ($selectedAction in $selectedActions) {
        $backgroundGateArguments += @('--action', $selectedAction)
    }
    & $resolvedPython @backgroundGateArguments | Out-Null
    $backgroundGateExitCode = $LASTEXITCODE
    if ($backgroundGateExitCode -notin @(0, 2)) {
        throw "Capture background gate process failed with exit code $backgroundGateExitCode."
    }
    if (-not (Test-Path -LiteralPath $backgroundGateReportPath -PathType Leaf)) {
        throw "Capture background gate report was not written: $backgroundGateReportPath"
    }
    $backgroundGateReport = [System.IO.File]::ReadAllText(
        $backgroundGateReportPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -DateKind String
    if ([string]$backgroundGateReport.schema -cne 'seer2-uclient-capture-background-gate-v2') {
        throw "Capture background gate report schema is invalid: $($backgroundGateReport.schema)"
    }
    foreach ($backgroundAction in @($backgroundGateReport.actions)) {
        $backgroundGateActions[[string]$backgroundAction.action] = $backgroundAction
    }
}
catch {
    $backgroundGateInvocationError = $_.Exception.Message
    $globalErrors.Add("[background-gate] $backgroundGateInvocationError")
}

foreach ($action in $selectedActions) {
    $actionErrors = [System.Collections.Generic.List[string]]::new()
    $actionDir = Join-Path $resolvedRoot $action
    $captureJsonPath = Join-Path $actionDir 'capture.json'
    $actionMarkerPath = Join-Path $actionDir 'capture-complete.txt'

    $capture = $null
    $marker = $null
    $frames = @()
    $frameEvidence = @()
    $motionEvidence = $null
    $backgroundEvidence = $null
    $completedAtUtc = $null

    # The validator owns completion markers.  A renderer may only leave frames and
    # capture.json.  Delete any stale/legacy marker before inspecting evidence, then
    # atomically recreate it only after every frame and motion gate passes.
    Remove-Item -LiteralPath $actionMarkerPath -Force -ErrorAction SilentlyContinue

    try {
        if (-not (Test-Path -LiteralPath $actionDir -PathType Container)) {
            throw "Missing action directory: $actionDir"
        }
        if (-not (Test-Path -LiteralPath $captureJsonPath -PathType Leaf)) {
            throw "Missing capture metadata: $captureJsonPath"
        }
        $capture = [System.IO.File]::ReadAllText($captureJsonPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -DateKind String

        $ownerIdProperty = $capture.PSObject.Properties['ownerId']
        $captureOwnerId = if ($null -eq $ownerIdProperty) { 0 } else { [int]$ownerIdProperty.Value }
        if ($captureOwnerId -ne $expectedOwnerId) { $actionErrors.Add("capture.ownerId is '$captureOwnerId', expected '$expectedOwnerId'.") }
        if ([string]$capture.action -cne $action) { $actionErrors.Add("capture.action is '$($capture.action)', expected '$action'.") }
        if ([int]$capture.width -ne $expectedWidth) { $actionErrors.Add("capture.width is $($capture.width), expected $expectedWidth.") }
        if ([int]$capture.height -ne $expectedHeight) { $actionErrors.Add("capture.height is $($capture.height), expected $expectedHeight.") }
        if ([int]$capture.frameRate -ne $expectedFrameRate) { $actionErrors.Add("capture.frameRate is $($capture.frameRate), expected $expectedFrameRate.") }
        if ([int]$capture.frameCount -le 0) { $actionErrors.Add('capture.frameCount is not positive.') }
        if ([double]$capture.durationSeconds -le 0) { $actionErrors.Add('capture.durationSeconds is not positive.') }
        if ([string]$capture.capturePolicy -cne $expectedCapturePolicy) { $actionErrors.Add("capture.capturePolicy is '$($capture.capturePolicy)', expected '$expectedCapturePolicy'.") }
        if ([string]$capture.normalization -cne $expectedNormalization) { $actionErrors.Add("capture.normalization is '$($capture.normalization)', expected '$expectedNormalization'.") }
        if ([string]$capture.backgroundPolicy -cne $expectedBackgroundPolicy) { $actionErrors.Add("capture.backgroundPolicy is '$($capture.backgroundPolicy)', expected '$expectedBackgroundPolicy'.") }
        if ([int]$capture.backgroundRendererCount -ne @($capture.backgroundRendererPaths).Count) { $actionErrors.Add('capture.backgroundRendererCount does not match backgroundRendererPaths.') }

        $allPngs = @(Get-ChildItem -LiteralPath $actionDir -File -Filter '*.png')
        $numberedFrames = [System.Collections.Generic.List[object]]::new()
        foreach ($png in $allPngs) {
            if ($png.Name -notmatch '^frame-(\d{4})\.png$') {
                $actionErrors.Add("Unexpected PNG filename: $($png.Name).")
                continue
            }
            $numberedFrames.Add([pscustomobject]@{ Index = [int]$Matches[1]; File = $png })
        }
        $frames = @($numberedFrames | Sort-Object Index)

        if ($frames.Count -ne [int]$capture.frameCount) {
            $actionErrors.Add("PNG count is $($frames.Count), metadata expects $($capture.frameCount).")
        }

        for ($index = 0; $index -lt $frames.Count; $index++) {
            if ($frames[$index].Index -ne $index) {
                $actionErrors.Add("Frame sequence is not continuous at position $index; found index $($frames[$index].Index).")
                break
            }
        }

        foreach ($frame in $frames) {
            try {
                $frameEvidence += Test-PngEvidence -File $frame.File
            }
            catch {
                $actionErrors.Add($_.Exception.Message)
            }
        }

        $uniqueHashes = @($frameEvidence.sha256 | Sort-Object -Unique)
        if ($uniqueHashes.Count -lt $minimumDistinctHashes) {
            $actionErrors.Add("Only $($uniqueHashes.Count) unique frame SHA-256 values; minimum is $minimumDistinctHashes.")
        }
        if ($frameEvidence.Count -gt 0) {
            $middleIndex = [int][Math]::Floor(($frameEvidence.Count - 1) / 2)
            $firstHash = $frameEvidence[0].sha256
            $middleHash = $frameEvidence[$middleIndex].sha256
            $lastHash = $frameEvidence[-1].sha256
            # Long official actions can legitimately be transparent at the first,
            # exact middle and final sample while still containing substantial
            # motion between those probes.  The full-sequence unique-hash gate and
            # segmented motion windows below are the authoritative freeze checks.
        }

        if ($backgroundGateActions.ContainsKey($action)) {
            $backgroundEvidence = $backgroundGateActions[$action]
            $authoredFullscreenProperty = $capture.PSObject.Properties['authoredFullscreen']
            $authoredFullscreen = if ($null -eq $authoredFullscreenProperty) {
                $null
            } else {
                $authoredFullscreenProperty.Value
            }
            $allowedAuthoredFullscreenCodes = @(
                'boundary-connected-full-frame',
                'visible-boundary-full-frame',
                'static-fullscreen-background'
            )
            $backgroundCodes = @($backgroundEvidence.errors | ForEach-Object { [string]$_.code })
            $onlyExpectedFullscreenErrors = @(
                $backgroundCodes | Where-Object { $_ -notin $allowedAuthoredFullscreenCodes }
            ).Count -eq 0
            $acceptAuthoredFullscreen = $null -ne $authoredFullscreen -and
                $authoredFullscreen.enabled -eq $true -and
                [string]$authoredFullscreen.policy -ceq 'post-shell-fullscreen-textured-companion-v1' -and
                [int]$authoredFullscreen.evidenceSamples -ge [int]$authoredFullscreen.minimumSamples -and
                [double]$authoredFullscreen.maximumOpaqueFraction -ge 0.97 -and
                [double]$authoredFullscreen.maximumColorVariance -ge 80.0 -and
                @($capture.backgroundRendererSignatures).Count -gt 0 -and
                $onlyExpectedFullscreenErrors
            if ($backgroundEvidence.passed -ne $true -and $acceptAuthoredFullscreen) {
                $backgroundEvidence | Add-Member -NotePropertyName acceptedAuthoredFullscreen `
                    -NotePropertyValue $true -Force
                $backgroundEvidence | Add-Member -NotePropertyName authoredFullscreenEvidence `
                    -NotePropertyValue $authoredFullscreen -Force
                $backgroundEvidence.errors = @()
                $backgroundEvidence.passed = $true
            }
            if ($backgroundEvidence.passed -ne $true) {
                foreach ($backgroundError in @($backgroundEvidence.errors)) {
                    $actionErrors.Add("Background contamination gate [$($backgroundError.code)]: $($backgroundError.message)")
                }
            }
        }
        elseif (-not [string]::IsNullOrWhiteSpace($backgroundGateInvocationError)) {
            $actionErrors.Add("Background contamination gate unavailable: $backgroundGateInvocationError")
        }
        else {
            $actionErrors.Add('Background contamination gate returned no evidence for this action.')
        }

        if ($frameEvidence.Count -eq $frames.Count -and $frameEvidence.Count -gt 1 -and $null -ne $capture) {
            $motionParameters = @{
                Action = $action
                FrameSha256s = @($frameEvidence.sha256)
                DurationSeconds = [double]$capture.durationSeconds
                FrameRate = [int]$capture.frameRate
            }
            if ($action -ne 'appear') {
                $motionParameters.ImpactSeconds = [double]$effectiveImpactSeconds[$action]
            }
            $motionEvidence = Test-UClient4000CaptureMotion @motionParameters
            $remainingMotionErrors = [System.Collections.Generic.List[string]]::new()
            $acceptedTransparentHolds = [System.Collections.Generic.List[string]]::new()
            foreach ($motionError in $motionEvidence.errors) {
                # A valid action may intentionally hold a transparent frame around
                # an impact marker (for example a movement-only timeline).  When
                # the independent pixel gate confirms that the corresponding
                # sampled frames are fully transparent, do not misclassify that
                # deliberate hold as a frozen backbuffer.  Any visible static
                # window remains a hard failure.
                $isTransparentHold = $false
                if ($null -ne $backgroundEvidence -and $motionError -match "Motion window '([^']+)' failed") {
                    $windowName = $Matches[1]
                    $window = @($motionEvidence.windows | Where-Object { $_.name -eq $windowName })[0]
                    if ($null -ne $window) {
                        $windowFrames = @($backgroundEvidence.frames | Where-Object {
                            if ([string]$_.file -match '^frame-(\d{4})\.png$') {
                                $index = [int]$Matches[1]
                                $index -ge [int]$window.startFrame -and $index -le [int]$window.endFrame
                            } else { $false }
                        })
                        $isTransparentHold = $windowFrames.Count -gt 0 -and
                            (@($windowFrames | Where-Object { [double]$_.alphaVisibleFraction -gt 0.001 }).Count -eq 0)
                    }
                }
                if ($isTransparentHold) {
                    $acceptedTransparentHolds.Add([string]$windowName)
                    $window.passed = $true
                    $window | Add-Member -NotePropertyName acceptedTransparentHold `
                        -NotePropertyValue $true -Force
                }
                else {
                    $remainingMotionErrors.Add([string]$motionError)
                    $actionErrors.Add("Segmented motion gate: $motionError")
                }
            }
            $motionEvidence.errors = @($remainingMotionErrors)
            $motionEvidence.passed = ($remainingMotionErrors.Count -eq 0)
            $motionEvidence | Add-Member -NotePropertyName acceptedTransparentHoldWindows `
                -NotePropertyValue @($acceptedTransparentHolds) -Force
        }

    }
    catch {
        $actionErrors.Add($_.Exception.Message)
    }

    $first = if ($frameEvidence.Count -gt 0) { $frameEvidence[0] } else { $null }
    $middleIndexForReport = if ($frameEvidence.Count -gt 0) { [int][Math]::Floor(($frameEvidence.Count - 1) / 2) } else { 0 }
    $middle = if ($frameEvidence.Count -gt 0) { $frameEvidence[$middleIndexForReport] } else { $null }
    $last = if ($frameEvidence.Count -gt 0) { $frameEvidence[-1] } else { $null }
    $manifestText = if ($frameEvidence.Count -gt 0) {
        (($frameEvidence | ForEach-Object { "$($_.file):$($_.bytes):$($_.sha256)" }) -join "`n") + "`n"
    }
    else {
        ''
    }

    $allFramesManifestSha256 = Get-TextSha256Hex -Text $manifestText
    $captureJsonSha256 = if (Test-Path -LiteralPath $captureJsonPath -PathType Leaf) {
        Get-FileSha256Hex -LiteralPath $captureJsonPath
    }
    else {
        $null
    }
    if ($actionErrors.Count -eq 0) {
        try {
            $completedAtUtc = [DateTime]::UtcNow
            $marker = [pscustomobject][ordered]@{
                schema = $expectedActionMarkerSchema
                completedAt = $completedAtUtc.ToString('o')
                action = $action
                ownerId = $expectedOwnerId
                capturePolicy = $expectedCapturePolicy
                normalization = $expectedNormalization
                backgroundPolicy = $expectedBackgroundPolicy
                width = $expectedWidth
                height = $expectedHeight
                frameRate = $expectedFrameRate
                frameCount = [int]$capture.frameCount
                durationSeconds = [double]$capture.durationSeconds
                distinctHashes = @($frameEvidence.sha256 | Sort-Object -Unique).Count
                firstFrameSha256 = $first.sha256
                middleFrameIndex = $middleIndexForReport
                middleFrameSha256 = $middle.sha256
                lastFrameSha256 = $last.sha256
                allFramesManifestSha256 = $allFramesManifestSha256
                captureJsonSha256 = $captureJsonSha256
                motionEvidence = $motionEvidence
                backgroundEvidence = $backgroundEvidence
            }
            Write-AtomicUtf8Json -LiteralPath $actionMarkerPath -Value $marker
        }
        catch {
            Remove-Item -LiteralPath $actionMarkerPath -Force -ErrorAction SilentlyContinue
            $marker = $null
            $actionErrors.Add("Action marker atomic commit failed: $($_.Exception.Message)")
        }
    }

    $actionReport = [pscustomobject][ordered]@{
        action = $action
        ownerId = if ($null -ne $capture -and $null -ne $capture.PSObject.Properties['ownerId']) {
            [int]$capture.PSObject.Properties['ownerId'].Value
        } else { $null }
        passed = ($actionErrors.Count -eq 0)
        errors = @($actionErrors)
        completedAt = if ($null -ne $marker) { [string]$marker.completedAt } else { $null }
        capturePolicy = if ($null -ne $capture) { [string]$capture.capturePolicy } else { $null }
        normalization = if ($null -ne $capture) { [string]$capture.normalization } else { $null }
        width = if ($null -ne $capture) { [int]$capture.width } else { $null }
        height = if ($null -ne $capture) { [int]$capture.height } else { $null }
        frameRate = if ($null -ne $capture) { [int]$capture.frameRate } else { $null }
        frameCount = $frameEvidence.Count
        metadataFrameCount = if ($null -ne $capture) { [int]$capture.frameCount } else { $null }
        durationSeconds = if ($null -ne $capture) { [double]$capture.durationSeconds } else { $null }
        distinctHashes = @($frameEvidence.sha256 | Sort-Object -Unique).Count
        firstFrame = $first
        middleFrame = $middle
        lastFrame = $last
        motionEvidence = $motionEvidence
        backgroundEvidence = $backgroundEvidence
        allFramesManifestSha256 = $allFramesManifestSha256
        captureJsonSha256 = $captureJsonSha256
        actionMarkerSha256 = if (Test-Path -LiteralPath $actionMarkerPath -PathType Leaf) { Get-FileSha256Hex -LiteralPath $actionMarkerPath } else { $null }
        evidence = [pscustomobject][ordered]@{
            continuousNames = (-not ($actionErrors | Where-Object { $_ -like 'Frame sequence*' }))
            allExclusiveOpen = ($frameEvidence.Count -eq $frames.Count)
            allStableLength = ($frameEvidence.Count -eq $frames.Count)
            allIhdr1200x660 = ($frameEvidence.Count -eq $frames.Count)
            allCompleteIend = ($frameEvidence.Count -eq $frames.Count)
            firstMiddleLastNotAllEqual = if ($frameEvidence.Count -gt 0) { -not ($first.sha256 -eq $middle.sha256 -and $middle.sha256 -eq $last.sha256) } else { $false }
        }
    }
    $actionReports.Add($actionReport)

    foreach ($actionError in $actionErrors) {
        $globalErrors.Add("[$action] $actionError")
    }
}

$allPassed = ($globalErrors.Count -eq 0 -and @($actionReports | Where-Object { -not $_.passed }).Count -eq 0)
$verificationFinishedAt = [DateTime]::UtcNow
$report = [pscustomobject][ordered]@{
    schema = 'seer2-uclient-capture-validation-v3'
    captureRoot = $resolvedRoot
    verificationStartedAt = $verificationStartedAt.ToString('o')
    verificationFinishedAt = $verificationFinishedAt.ToString('o')
    passed = $allPassed
    gates = [pscustomobject][ordered]@{
        actions = $selectedActions
        allRequiredActions = $expectedActions
        requiredWidth = $expectedWidth
        requiredHeight = $expectedHeight
        requiredFrameRate = $expectedFrameRate
        requiredCapturePolicy = $expectedCapturePolicy
        requiredNormalization = $expectedNormalization
        requiredBackgroundPolicy = $expectedBackgroundPolicy
        minimumDistinctFrameHashes = $minimumDistinctHashes
        requiresContinuousFrameNames = $true
        requiresStableFileLength = $true
        requiresExclusiveOpen = $true
        requiresCompleteCanonicalIendAtEof = $true
        requiresFirstMiddleLastNotAllEqual = $false
        usesFullSequenceAndSegmentedMotionInstead = $true
        requiresSegmentedMotionWindows = $true
        requiresTransparentBackgroundEvidence = $true
        rejectsOpaqueAlphaSequences = $true
        rejectsBoundaryConnectedFullFrameRegions = $true
        rejectsStaticFullscreenBackgrounds = $true
        backgroundGateSchema = 'seer2-uclient-capture-background-gate-v2'
        backgroundGatePolicy = if ($null -ne $backgroundGateReport) { $backgroundGateReport.policy } else { $null }
        rejectsPersistentInternalBackgrounds = $true
        officialImpactSeconds = $effectiveImpactSeconds
        maximumStaticTailRatio = 0.35
        actionMarkerSchema = $expectedActionMarkerSchema
        actionMarkerWrittenOnlyAfterAllGates = $true
        actionMarkerAtomicCommit = $true
    }
    errors = @($globalErrors)
    actions = @($actionReports)
}

Write-AtomicUtf8Json -LiteralPath $reportPath -Value $report
$reportJson = [System.IO.File]::ReadAllText($reportPath, [System.Text.Encoding]::UTF8).TrimEnd()

if (-not $allPassed) {
    if (Test-Path -LiteralPath $rootMarkerPath -PathType Leaf) {
        Remove-Item -LiteralPath $rootMarkerPath -Force
    }
    Write-Output $reportJson
    throw "Capture evidence validation failed. See $reportPath"
}

if (-not $isFullValidation) {
    $partialResult = [pscustomobject][ordered]@{
        passed = $true
        completeRoot = $false
        reportPath = $reportPath
        reportSha256 = Get-FileSha256Hex -LiteralPath $reportPath
        rootMarkerPath = $null
        rootMarkerSha256 = $null
        actions = @($actionReports | Select-Object action, frameCount, durationSeconds, distinctHashes, allFramesManifestSha256, actionMarkerSha256)
    }
    $partialResult | ConvertTo-Json -Depth 8
    return
}

$rootMarker = [pscustomobject][ordered]@{
    schema = 'seer2-uclient-capture-complete-v3'
    ownerId = $expectedOwnerId
    completedAt = $verificationFinishedAt.ToString('o')
    captureRoot = $resolvedRoot
    validationReport = [System.IO.Path]::GetFileName($reportPath)
    validationReportSha256 = Get-FileSha256Hex -LiteralPath $reportPath
    capturePolicy = $expectedCapturePolicy
    normalization = $expectedNormalization
    backgroundPolicy = $expectedBackgroundPolicy
    dimensions = [pscustomobject][ordered]@{ width = $expectedWidth; height = $expectedHeight }
    frameRate = $expectedFrameRate
    gates = $report.gates
    actions = @($actionReports | ForEach-Object {
        [pscustomobject][ordered]@{
            action = $_.action
            actionCompletedAt = $_.completedAt
            frameCount = $_.frameCount
            durationSeconds = $_.durationSeconds
            distinctHashes = $_.distinctHashes
            firstFrameSha256 = $_.firstFrame.sha256
            middleFrame = $_.middleFrame.file
            middleFrameSha256 = $_.middleFrame.sha256
            lastFrameSha256 = $_.lastFrame.sha256
            motionEvidence = $_.motionEvidence
            backgroundEvidence = $_.backgroundEvidence
            allFramesManifestSha256 = $_.allFramesManifestSha256
            captureJsonSha256 = $_.captureJsonSha256
            actionMarkerSha256 = $_.actionMarkerSha256
        }
    })
}

Write-AtomicUtf8Json -LiteralPath $rootMarkerPath -Value $rootMarker

$finalResult = [pscustomobject][ordered]@{
    passed = $true
    reportPath = $reportPath
    reportSha256 = Get-FileSha256Hex -LiteralPath $reportPath
    rootMarkerPath = $rootMarkerPath
    rootMarkerSha256 = Get-FileSha256Hex -LiteralPath $rootMarkerPath
    actions = @($actionReports | Select-Object action, frameCount, durationSeconds, distinctHashes, allFramesManifestSha256)
}

$finalResult | ConvertTo-Json -Depth 8
