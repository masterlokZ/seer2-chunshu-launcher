$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function New-UClient4000MotionWindow {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][double]$StartSeconds,
        [Parameter(Mandatory = $true)][double]$EndSeconds,
        [int]$MinimumTransitions = 2,
        [int]$MinimumDistinctHashes = 3
    )

    return [pscustomobject][ordered]@{
        name = $Name
        startSeconds = $StartSeconds
        endSeconds = $EndSeconds
        minimumTransitions = $MinimumTransitions
        minimumDistinctHashes = $MinimumDistinctHashes
    }
}

function Get-UClient4000MotionGateDefinition {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('appear', 'attack', 'cp', 'sa', 'hidemove')][string]$Action,
        [Parameter(Mandatory = $true)][double]$DurationSeconds,
        [Nullable[double]]$ImpactSeconds = $null
    )

    if (-not [double]::IsFinite($DurationSeconds) -or $DurationSeconds -le 0) {
        throw "Invalid duration for $Action`: $DurationSeconds"
    }

    $windows = [System.Collections.Generic.List[object]]::new()

    # Every official action must keep evolving outside its opening frames.  The
    # deliberately overlapping broad windows make an early burst followed by a
    # frozen backbuffer impossible to pass while allowing brief hold frames.
    $windows.Add((New-UClient4000MotionWindow -Name 'middle' `
        -StartSeconds ($DurationSeconds * 0.25) -EndSeconds ($DurationSeconds * 0.60)))
    $windows.Add((New-UClient4000MotionWindow -Name 'late' `
        -StartSeconds ($DurationSeconds * 0.60) -EndSeconds ($DurationSeconds * 0.92)))

    if ($Action -eq 'appear') {
        $windows.Add((New-UClient4000MotionWindow -Name 'ending' `
            -StartSeconds ($DurationSeconds * 0.75) -EndSeconds ($DurationSeconds * 0.98) `
            -MinimumTransitions 1 -MinimumDistinctHashes 2))
        return [pscustomobject][ordered]@{
            action = $Action
            impactSeconds = $null
            maximumStaticTailRatio = 0.35
            windows = @($windows)
        }
    }

    if ($null -eq $ImpactSeconds) {
        throw "Official Signal impact time is required for $Action; refusing an owner-specific default."
    }
    $resolvedImpactSeconds = [double]$ImpactSeconds
    if (-not [double]::IsFinite($resolvedImpactSeconds) -or $resolvedImpactSeconds -lt 0) {
        throw "Invalid impact time for $Action`: $resolvedImpactSeconds"
    }
    if ($DurationSeconds -lt ($resolvedImpactSeconds + 0.20)) {
        throw ("Capture duration for {0} ({1:N3}s) does not reach the official impact/post-impact point ({2:N3}s)." -f
            $Action, $DurationSeconds, $resolvedImpactSeconds)
    }

    $windows.Add((New-UClient4000MotionWindow -Name 'pre-impact' `
        -StartSeconds ([Math]::Max(0.0, $resolvedImpactSeconds - 0.75)) -EndSeconds $resolvedImpactSeconds))
    $windows.Add((New-UClient4000MotionWindow -Name 'impact' `
        -StartSeconds ([Math]::Max(0.0, $resolvedImpactSeconds - 0.20)) `
        -EndSeconds ([Math]::Min($DurationSeconds, $resolvedImpactSeconds + 0.35))))
    $windows.Add((New-UClient4000MotionWindow -Name 'post-impact' `
        -StartSeconds ($resolvedImpactSeconds + 0.05) `
        -EndSeconds ([Math]::Min($DurationSeconds, $resolvedImpactSeconds + 0.90))))

    return [pscustomobject][ordered]@{
        action = $Action
        impactSeconds = $resolvedImpactSeconds
        maximumStaticTailRatio = 0.35
        windows = @($windows)
    }
}

function Test-UClient4000CaptureMotion {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('appear', 'attack', 'cp', 'sa', 'hidemove')][string]$Action,
        [Parameter(Mandatory = $true)][string[]]$FrameSha256s,
        [Parameter(Mandatory = $true)][double]$DurationSeconds,
        [Parameter(Mandatory = $true)][int]$FrameRate,
        [Nullable[double]]$ImpactSeconds = $null
    )

    if ($FrameRate -le 0 -or $FrameSha256s.Count -lt 2) {
        throw "Invalid frame evidence for $Action."
    }

    $definition = Get-UClient4000MotionGateDefinition -Action $Action `
        -DurationSeconds $DurationSeconds -ImpactSeconds $ImpactSeconds
    $errors = [System.Collections.Generic.List[string]]::new()
    $windowReports = [System.Collections.Generic.List[object]]::new()
    $transitionIndexes = [System.Collections.Generic.List[int]]::new()
    for ($index = 1; $index -lt $FrameSha256s.Count; $index++) {
        if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals(
                $FrameSha256s[$index - 1], $FrameSha256s[$index])) {
            $transitionIndexes.Add($index)
        }
    }

    foreach ($window in $definition.windows) {
        $startIndex = [Math]::Max(0, [int][Math]::Floor($window.startSeconds * $FrameRate))
        $endIndex = [Math]::Min($FrameSha256s.Count - 1, [int][Math]::Ceiling($window.endSeconds * $FrameRate))
        if ($endIndex -le $startIndex) {
            $errors.Add("Motion window '$($window.name)' is empty ($startIndex..$endIndex).")
            continue
        }

        $windowHashes = @($FrameSha256s[$startIndex..$endIndex])
        $distinctCount = @($windowHashes | Sort-Object -Unique).Count
        $transitionCount = @($transitionIndexes | Where-Object {
            $_ -gt $startIndex -and $_ -le $endIndex
        }).Count
        $passed = $transitionCount -ge [int]$window.minimumTransitions -and
            $distinctCount -ge [int]$window.minimumDistinctHashes
        if (-not $passed) {
            $errors.Add(("Motion window '{0}' failed: frames={1}..{2}, transitions={3} (required>={4}), distinctHashes={5} (required>={6})." -f
                $window.name, $startIndex, $endIndex, $transitionCount,
                $window.minimumTransitions, $distinctCount, $window.minimumDistinctHashes))
        }
        $windowReports.Add([pscustomobject][ordered]@{
            name = $window.name
            startSeconds = $window.startSeconds
            endSeconds = $window.endSeconds
            startFrame = $startIndex
            endFrame = $endIndex
            transitions = $transitionCount
            distinctHashes = $distinctCount
            minimumTransitions = [int]$window.minimumTransitions
            minimumDistinctHashes = [int]$window.minimumDistinctHashes
            passed = $passed
        })
    }

    $lastTransitionIndex = if ($transitionIndexes.Count -gt 0) { $transitionIndexes[-1] } else { 0 }
    $staticTailFrames = ($FrameSha256s.Count - 1) - $lastTransitionIndex
    $staticTailRatio = $staticTailFrames / [double][Math]::Max(1, $FrameSha256s.Count - 1)
    if ($staticTailRatio -gt [double]$definition.maximumStaticTailRatio) {
        $errors.Add(("Static tail is too long: {0} frames ({1:P1}), maximum allowed is {2:P1}; last transition is frame {3}." -f
            $staticTailFrames, $staticTailRatio, $definition.maximumStaticTailRatio, $lastTransitionIndex))
    }

    return [pscustomobject][ordered]@{
        schema = 'seer2-uclient-4000-motion-evidence-v1'
        action = $Action
        passed = ($errors.Count -eq 0)
        errors = @($errors)
        impactSeconds = $definition.impactSeconds
        transitionCount = $transitionIndexes.Count
        lastTransitionFrame = $lastTransitionIndex
        staticTailFrames = $staticTailFrames
        staticTailRatio = $staticTailRatio
        maximumStaticTailRatio = $definition.maximumStaticTailRatio
        windows = @($windowReports)
    }
}
