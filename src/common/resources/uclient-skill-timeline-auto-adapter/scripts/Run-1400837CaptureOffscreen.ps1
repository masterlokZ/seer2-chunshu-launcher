[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('appear', 'attack', 'cp', 'sa', 'hidemove')]
    [string]$Action,
    [ValidateRange(1, 2147483647)]
    [int]$OwnerId = 1400837,
    [ValidateRange(0, 900)]
    [int]$TimeoutSeconds = 0,
    [string]$Runtime = 'D:\swf-work-622\4000-full-action-cinematics-v2-20260816\uclient-capture-runtime',
    [string]$TimelineSummary = '',
    [string]$Python = 'python',
    [switch]$AllowOfficialClient
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $AllowOfficialClient) {
    throw 'Official Seer.exe capture is disabled by default. Pass -AllowOfficialClient only for an explicit Unity client capture task.'
}
. (Join-Path $PSScriptRoot 'lib\UClient4000CaptureProcessGuard.ps1')
. (Join-Path $PSScriptRoot 'lib\UClientCaptureOfficialTimeline.ps1')

$capturePolicy = 'official-playable-manual-graph-step-rendertexture-bg-classified-v5'
$captureNormalization = 'native-rendertexture-1200x660-two-pass-renderer-background-classification-v2'
$backgroundPolicy = 'owner-independent-pixel-evidence-two-pass-v2'
$allActions = @('appear', 'attack', 'cp', 'sa', 'hidemove')
# The exact split producer renders official-full, derived foreground and derived
# underlay passes for every formal frame.  Let the generic wrapper forward zero
# so these action-aware bounds apply instead of silently forcing the old
# two-pass 180-second limit.  Hidemove is deliberately highest because it owns
# the longest 336-frame sequence.
$defaultTimeoutByAction = @{ appear = 240; attack = 300; cp = 300; sa = 360; hidemove = 600 }
if ($TimeoutSeconds -eq 0) { $TimeoutSeconds = [int]$defaultTimeoutByAction[$Action] }

$runtime = [System.IO.Path]::GetFullPath($Runtime).TrimEnd('\')
$executable = Join-Path $runtime 'Seer.exe'
$ownerSelector = Join-Path $runtime 'capture-owner-id.txt'
$actionSelector = Join-Path $runtime 'capture-action.txt'
$captureRoot = Join-Path $runtime ("{0}-capture-output" -f $OwnerId)
$actionRoot = Join-Path $captureRoot $Action
$validator = Join-Path $PSScriptRoot 'Validate-4000CaptureEvidence.ps1'
$timelineSummaryPath = if ([string]::IsNullOrWhiteSpace($TimelineSummary)) {
    Join-Path $runtime 'capture-timeline-summary.json'
} else { [System.IO.Path]::GetFullPath($TimelineSummary) }
$logPath = Join-Path $runtime 'BepInEx\LogOutput.log'
foreach ($required in @($executable, $validator, $ownerSelector, $timelineSummaryPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required capture file is missing: $required" }
}
$selectedOwner = [System.IO.File]::ReadAllText($ownerSelector, [System.Text.Encoding]::UTF8).Trim()
if ($selectedOwner -cne [string]$OwnerId) {
    throw "Capture runtime owner selector is $selectedOwner, expected $OwnerId. Stage this owner first."
}
$officialImpactSeconds = Get-UClientCaptureOfficialImpactSeconds `
    -TimelineSummary $timelineSummaryPath -ExpectedOwnerId $OwnerId
if (-not $actionRoot.StartsWith($captureRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
    -not $captureRoot.StartsWith($runtime + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Capture cleanup path escaped the isolated runtime.'
}

New-Item -ItemType Directory -Path $captureRoot -Force | Out-Null
Remove-Item -LiteralPath (Join-Path $captureRoot 'capture-complete.txt') -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $actionRoot -PathType Container) {
    Remove-Item -LiteralPath $actionRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $actionRoot -Force | Out-Null
$selectorTemporary = $actionSelector + '.part-' + $PID + '-' + [Guid]::NewGuid().ToString('N')
try {
    [System.IO.File]::WriteAllText($selectorTemporary, $Action + "`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Move($selectorTemporary, $actionSelector, $true)
}
finally { Remove-Item -LiteralPath $selectorTemporary -Force -ErrorAction SilentlyContinue }

if ($null -eq ('OffscreenWindows' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OffscreenWindows {
  private delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] private static extern bool GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  public static int Move(int target) { var moved=0; EnumWindows((h,p)=>{GetWindowThreadProcessId(h,out var pid); if(pid==(uint)target){SetWindowPos(h,IntPtr.Zero,-32000,-32000,1200,660,0x0010|0x0004); moved++;} return true;},IntPtr.Zero); return moved; }
}
'@
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $executable
$startInfo.WorkingDirectory = $runtime
$startInfo.UseShellExecute = $false
$logBaseline = New-CaptureLogBaseline -LiteralPath $logPath
$process = [System.Diagnostics.Process]::Start($startInfo)
$identity = New-CaptureProcessIdentity -Process $process -ExpectedExecutable $executable
$startedAt = [DateTime]::new([long]$identity.startTimeUtcTicks, [DateTimeKind]::Utc)
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$ready = $false
$terminatedAfterCapture = $false
$maximumWindows = 0
$observation = [pscustomobject]@{ ready = $false; reason = 'not checked'; frameCount = 0 }
try {
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        $maximumWindows = [Math]::Max($maximumWindows, [OffscreenWindows]::Move($process.Id))
        $observation = Test-CaptureReadyForValidation -ActionRoot $actionRoot -Action $Action `
            -LogPath $logPath -LogBaseline $logBaseline -ProcessStartedAtUtc $startedAt `
            -CapturePolicy $capturePolicy -CaptureNormalization $captureNormalization
        if ($observation.ready) {
            $ready = $true
            if (-not $process.WaitForExit(2000)) {
                Stop-OwnedCaptureProcess -Process $process -Identity $identity -WaitMilliseconds 10000
                $terminatedAfterCapture = $true
            }
            break
        }
        Start-Sleep -Milliseconds 20
        $process.Refresh()
    }
    if (-not $process.HasExited) {
        Stop-OwnedCaptureProcess -Process $process -Identity $identity -WaitMilliseconds 10000
        throw "Owner $OwnerId capture timed out for $Action after $TimeoutSeconds seconds."
    }
    if (-not $terminatedAfterCapture -and $process.ExitCode -ne 0) {
        throw "Owner $OwnerId capture failed for $Action with exit code $($process.ExitCode)."
    }

    & $validator -CaptureRoot $captureRoot -Actions @($Action) -ExpectedOwnerId $OwnerId `
        -ImpactSecondsByAction $officialImpactSeconds -Python $Python | Out-Null
    $allMetadataCurrent = $true
    foreach ($candidateAction in $allActions) {
        $captureJson = Join-Path (Join-Path $captureRoot $candidateAction) 'capture.json'
        if (-not (Test-Path -LiteralPath $captureJson -PathType Leaf)) { $allMetadataCurrent = $false; break }
        try {
            $metadata = [System.IO.File]::ReadAllText($captureJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -DateKind String
            if ([int]$metadata.ownerId -ne $OwnerId -or
                [string]$metadata.action -cne $candidateAction -or
                [string]$metadata.capturePolicy -cne $capturePolicy -or
                [string]$metadata.normalization -cne $captureNormalization -or
                [string]$metadata.backgroundPolicy -cne $backgroundPolicy -or
                [int]$metadata.width -ne 1200 -or [int]$metadata.height -ne 660 -or
                [int]$metadata.frameRate -ne 30) { $allMetadataCurrent = $false; break }
        }
        catch { $allMetadataCurrent = $false; break }
    }
    if ($allMetadataCurrent) {
        & $validator -CaptureRoot $captureRoot -ExpectedOwnerId $OwnerId `
            -ImpactSecondsByAction $officialImpactSeconds -Python $Python | Out-Null
    }

    [pscustomobject][ordered]@{
        action = $Action; ownerId = $OwnerId; processId = $process.Id; exitCode = $process.ExitCode
        timeoutSeconds = $TimeoutSeconds; maximumWindowsMoved = $maximumWindows
        captureReadyObserved = $ready; completionReason = $observation.reason
        completionFrameCount = $observation.frameCount; terminatedAfterCapture = $terminatedAfterCapture
        actionMarker = Join-Path $actionRoot 'capture-complete.txt'
        completeRoot = Test-Path -LiteralPath (Join-Path $captureRoot 'capture-complete.txt') -PathType Leaf
        capturePolicy = $capturePolicy; normalization = $captureNormalization; backgroundPolicy = $backgroundPolicy
        officialImpactSeconds = if ($Action -eq 'appear') { $null } else { [double]$officialImpactSeconds[$Action] }
        timelineSummary = $timelineSummaryPath
    }
}
catch {
    Remove-Item -LiteralPath (Join-Path $actionRoot 'capture-complete.txt') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $captureRoot 'capture-complete.txt') -Force -ErrorAction SilentlyContinue
    throw
}
finally {
    if (-not $process.HasExited -and (Test-CaptureProcessIdentity -Process $process -Identity $identity)) {
        Stop-OwnedCaptureProcess -Process $process -Identity $identity -WaitMilliseconds 10000
    }
    $process.Dispose()
}
