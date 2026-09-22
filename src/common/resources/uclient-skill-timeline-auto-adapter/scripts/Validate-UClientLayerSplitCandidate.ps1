[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CaptureRoot,
    [switch]$WriteReport,
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$policy = 'classified-background-underlay-v1'
$reportSchema = 'seer2-uclient-layer-split-candidate-v2'
$channelManifestSchema = 'seer2-uclient-derived-channel-manifest-v1'
$rootIdentitySchema = 'seer2-uclient-layer-split-capture-root-identity-v1'
$exactSchema = 'seer2-uclient-action-specific-compensated-screen-v1'
$exactCompositor = 'action-specific-compensated-underlay-then-foreground-screen-v1'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash
}

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][string]$Text)

    $bytes = $utf8NoBom.GetBytes($Text)
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes))
}

function Get-OptionalPropertyValue {
    param(
        [AllowNull()]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function New-ChannelManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ActionRoot,
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][bool]$Required
    )

    $channelRoot = if ($Directory -ceq '.') { $ActionRoot } else { Join-Path $ActionRoot $Directory }
    if (-not (Test-Path -LiteralPath $channelRoot -PathType Container)) {
        if ($Required) { throw "Required derived channel directory is missing: $channelRoot" }
        $files = @()
    }
    else {
        $files = @(Get-ChildItem -LiteralPath $channelRoot -File -Filter 'frame-*.png' | Sort-Object Name)
    }

    $frames = [System.Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $files.Count; $index++) {
        $expectedName = 'frame-{0:D4}.png' -f $index
        if ($files[$index].Name -cne $expectedName) {
            throw "Derived channel frame sequence mismatch in $channelRoot at $expectedName"
        }
        if ($files[$index].Length -le 0) {
            throw "Derived channel frame is empty: $($files[$index].FullName)"
        }
        $frames.Add([ordered]@{
            fileName = $files[$index].Name
            bytes = [long]$files[$index].Length
            sha256 = Get-FileSha256 -LiteralPath $files[$index].FullName
        })
    }

    # Hash the exact ordered JSON identity (UTF-8 without BOM). The sha256 field
    # itself is excluded so Build can independently reproduce the identity.
    $identity = [ordered]@{
        schema = $channelManifestSchema
        directory = $Directory
        frameCount = $frames.Count
        frames = @($frames)
    }
    $canonicalJson = $identity | ConvertTo-Json -Depth 8 -Compress
    return [ordered]@{
        schema = $identity.schema
        directory = $identity.directory
        frameCount = $identity.frameCount
        frames = $identity.frames
        sha256 = Get-TextSha256 -Text $canonicalJson
    }
}

function Write-AtomicReport {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)]$Value
    )

    $directory = [System.IO.Path]::GetDirectoryName($LiteralPath)
    if ([string]::IsNullOrWhiteSpace($directory) -or
        -not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "Report directory is missing: $directory"
    }
    $temporary = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($LiteralPath) +
        '.part-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
    try {
        $json = $Value | ConvertTo-Json -Depth 20
        [System.IO.File]::WriteAllText($temporary, $json + "`n", $utf8NoBom)
        [System.IO.File]::Move($temporary, $LiteralPath, $true)
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

$resolvedRoot = [System.IO.Path]::GetFullPath($CaptureRoot)
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw "Capture root is missing: $resolvedRoot"
}

$actions = @(Get-ChildItem -LiteralPath $resolvedRoot -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'capture.json') } |
    Sort-Object Name)
if ($actions.Count -eq 0) { throw "No action capture directories found: $resolvedRoot" }

$dualGatePath = Join-Path $PSScriptRoot 'Validate-UClientDualChannelGate.py'
if (-not (Test-Path -LiteralPath $dualGatePath -PathType Leaf)) {
    throw "Exact dual-channel gate is missing: $dualGatePath"
}
$resolvedPython = if (Test-Path -LiteralPath $Python -PathType Leaf) {
    (Resolve-Path -LiteralPath $Python).Path
}
else {
    [string](@(Get-Command $Python -CommandType Application -ErrorAction Stop)[0].Source)
}
$dualGateArguments = @($dualGatePath, $resolvedRoot)
$dualGateText = (& $resolvedPython @dualGateArguments | Out-String)
$dualGateExitCode = $LASTEXITCODE
if ($dualGateExitCode -notin @(0, 2)) {
    throw "Exact dual-channel gate process failed with exit code $dualGateExitCode."
}
try {
    $dualGate = $dualGateText | ConvertFrom-Json -DateKind String
}
catch {
    throw "Exact dual-channel gate returned invalid JSON: $($_.Exception.Message)"
}
if ([string]$dualGate.schema -cne 'seer2-uclient-dual-channel-gate-v1' -or
    [string]$dualGate.captureRoot -cne $resolvedRoot) {
    throw 'Exact dual-channel gate report does not bind the requested capture root/schema.'
}

$gateByAction = @{}
foreach ($gateAction in @($dualGate.actions)) {
    $name = [string]$gateAction.action
    if ([string]::IsNullOrWhiteSpace($name) -or $gateByAction.ContainsKey($name)) {
        throw "Exact dual-channel gate contains an invalid/duplicate action: $name"
    }
    $gateByAction[$name] = $gateAction
}

$results = [System.Collections.Generic.List[object]]::new()
$validationErrors = [System.Collections.Generic.List[string]]::new()
foreach ($actionDir in $actions) {
    $action = $actionDir.Name
    $captureJson = Join-Path $actionDir.FullName 'capture.json'
    $capture = [System.IO.File]::ReadAllText($captureJson, [System.Text.Encoding]::UTF8) |
        ConvertFrom-Json -DateKind String
    if ($null -eq $capture.PSObject.Properties['layerSplit']) {
        throw "layerSplit metadata is missing for action $action"
    }
    $split = $capture.layerSplit
    if ([string]$split.policy -cne $policy) {
        throw "Unexpected layerSplit policy for action $action"
    }
    $enabled = $split.enabled -eq $true
    $foreground = New-ChannelManifest -ActionRoot $actionDir.FullName -Directory '.' -Required $true
    $underlay = New-ChannelManifest -ActionRoot $actionDir.FullName -Directory 'underlay' -Required $enabled
    if ([int]$capture.frameCount -ne [int]$foreground.frameCount) {
        throw "Foreground frame count does not match capture.json for action $action"
    }
    if ($enabled) {
        if ([int]$underlay.frameCount -ne [int]$capture.frameCount -or
            [int]$split.underlayFrameCount -ne [int]$underlay.frameCount) {
            throw "Underlay frame count does not match capture.json for action $action"
        }
    }
    elseif ([int]$underlay.frameCount -ne 0 -or [int]$split.underlayFrameCount -ne 0) {
        throw "Disabled layerSplit action contains derived underlay frames: $action"
    }

    if (-not $gateByAction.ContainsKey($action)) {
        throw "Exact dual-channel gate returned no action evidence for $action"
    }
    $gateAction = $gateByAction[$action]
    if (($gateAction.enabled -eq $true) -ne $enabled) {
        throw "Exact dual-channel gate enabled state differs from capture.json for $action"
    }
    $gateExact = $gateAction.officialFullEquivalence
    $exactProof = [ordered]@{
        required = $enabled
        passed = (Get-OptionalPropertyValue -Object $gateExact -Name 'passed') -eq $true
        schema = [string](Get-OptionalPropertyValue -Object $gateExact -Name 'schema')
        compositor = [string](Get-OptionalPropertyValue -Object $gateExact -Name 'compositor')
        frameCount = Get-OptionalPropertyValue -Object $gateExact -Name 'frameCount'
        verifiedFrameCount = Get-OptionalPropertyValue -Object $gateExact -Name 'verifiedFrameCount'
        mismatchedFrameCount = Get-OptionalPropertyValue -Object $gateExact -Name 'mismatchedFrameCount'
        exactMismatchPixelCount = Get-OptionalPropertyValue -Object $gateExact -Name 'exactMismatchPixelCount'
        maximumChannelDelta = Get-OptionalPropertyValue -Object $gateExact -Name 'maximumChannelDelta'
        clampedPixelCount = Get-OptionalPropertyValue -Object $gateExact -Name 'clampedPixelCount'
        clampedChannelCount = Get-OptionalPropertyValue -Object $gateExact -Name 'clampedChannelCount'
        derivedForegroundFrameCount = Get-OptionalPropertyValue -Object $gateExact -Name 'derivedForegroundFrameCount'
        derivedUnderlayFrameCount = Get-OptionalPropertyValue -Object $gateExact -Name 'derivedUnderlayFrameCount'
        rawForegroundFrameCount = Get-OptionalPropertyValue -Object $gateExact -Name 'rawForegroundFrameCount'
        rawUnderlayFrameCount = Get-OptionalPropertyValue -Object $gateExact -Name 'rawUnderlayFrameCount'
        officialFullFrameCount = Get-OptionalPropertyValue -Object $gateExact -Name 'officialFullFrameCount'
        activeWindowsSha256 = [string](Get-OptionalPropertyValue -Object $gateExact -Name 'activeWindowsSha256')
    }
    if ($enabled) {
        $exactPassed = $gateAction.passed -eq $true -and
            $exactProof.required -eq $true -and $exactProof.passed -eq $true -and
            [string]$exactProof.schema -ceq $exactSchema -and
            [string]$exactProof.compositor -ceq $exactCompositor -and
            [int]$exactProof.frameCount -eq [int]$capture.frameCount -and
            [int]$exactProof.verifiedFrameCount -eq [int]$capture.frameCount -and
            [int]$exactProof.mismatchedFrameCount -eq 0 -and
            [int]$exactProof.exactMismatchPixelCount -eq 0 -and
            [int]$exactProof.maximumChannelDelta -eq 0 -and
            [int]$exactProof.derivedForegroundFrameCount -eq [int]$capture.frameCount -and
            [int]$exactProof.derivedUnderlayFrameCount -eq [int]$capture.frameCount -and
            [int]$exactProof.rawForegroundFrameCount -eq [int]$capture.frameCount -and
            [int]$exactProof.rawUnderlayFrameCount -eq [int]$capture.frameCount -and
            [int]$exactProof.officialFullFrameCount -eq [int]$capture.frameCount
        if (-not $exactPassed) {
            $validationErrors.Add("[$action] enabled split did not pass the complete exact compensated SCREEN gate")
        }
    }
    elseif ($gateAction.passed -ne $true) {
        $validationErrors.Add("[$action] single-channel action failed the dual-channel safety gate")
    }

    $results.Add([ordered]@{
        action = $action
        enabled = $enabled
        captureJson = $captureJson
        captureJsonSha256 = Get-FileSha256 -LiteralPath $captureJson
        foregroundFrameCount = [int]$foreground.frameCount
        underlayFrameCount = [int]$underlay.frameCount
        foregroundDirectory = '.'
        underlayDirectory = if ($enabled) { 'underlay' } else { '' }
        foregroundManifest = $foreground
        underlayManifest = $underlay
        exactProof = $exactProof
    })
}

$captureActionNames = @($actions | ForEach-Object Name)
$unknownGateActions = @($gateByAction.Keys | Where-Object { $_ -cnotin $captureActionNames })
if ($unknownGateActions.Count -gt 0) {
    throw "Exact dual-channel gate contains actions outside the capture set: $($unknownGateActions -join ', ')"
}

# Root identity is canonical ordered JSON, UTF-8 without BOM. It binds the
# resolved root and every action's capture/channel/exact proof identity while
# excluding diagnostics and the hash field itself.
$rootIdentityActions = @($results | ForEach-Object {
    [ordered]@{
        action = [string]$_.action
        enabled = [bool]$_.enabled
        captureJsonSha256 = [string]$_.captureJsonSha256
        foregroundManifestSha256 = [string]$_.foregroundManifest.sha256
        underlayManifestSha256 = [string]$_.underlayManifest.sha256
        exactSchema = [string]$_.exactProof.schema
        exactPassed = [bool]$_.exactProof.passed
    }
})
$rootIdentity = [ordered]@{
    schema = $rootIdentitySchema
    captureRoot = $resolvedRoot
    actions = $rootIdentityActions
}
$rootIdentityJson = $rootIdentity | ConvertTo-Json -Depth 10 -Compress
$passed = $dualGateExitCode -eq 0 -and $dualGate.passed -eq $true -and
    $validationErrors.Count -eq 0
$report = [ordered]@{
    schema = $reportSchema
    captureRoot = $resolvedRoot
    root = $resolvedRoot
    captureRootIdentitySchema = $rootIdentitySchema
    captureRootSha256 = Get-TextSha256 -Text $rootIdentityJson
    policy = $policy
    exactSchema = $exactSchema
    exactCompositor = $exactCompositor
    channelManifestSchema = $channelManifestSchema
    dualChannelGateSchema = [string]$dualGate.schema
    dualChannelGatePassed = $dualGate.passed -eq $true
    actions = @($results)
    errors = @($validationErrors)
    passed = $passed
}

if ($WriteReport) {
    $reportPath = Join-Path $resolvedRoot 'layer-split-validation-report.json'
    Write-AtomicReport -LiteralPath $reportPath -Value $report
    $report.report = $reportPath
    $report.reportSha256 = Get-FileSha256 -LiteralPath $reportPath
}
if (-not $passed) {
    $gateCodes = @($dualGate.errors | ForEach-Object { [string]$_.code } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    $detail = if ($gateCodes.Count -gt 0) { $gateCodes -join ', ' } else { 'exact gate denied candidate' }
    throw "LayerSplit exact validation failed: $detail"
}
$report | ConvertTo-Json -Depth 20
