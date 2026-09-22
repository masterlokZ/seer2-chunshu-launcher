function Read-CaptureLogTextShared {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $stream = [System.IO.File]::Open(
        $LiteralPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    try {
        $reader = [System.IO.StreamReader]::new(
            $stream,
            [System.Text.Encoding]::UTF8,
            $true,
            4096,
            $true)
        try {
            return $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function New-CaptureLogBaseline {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        return [pscustomobject][ordered]@{
            exists = $false
            content = ''
            lastWriteTimeUtcTicks = 0L
        }
    }

    $item = Get-Item -LiteralPath $LiteralPath
    return [pscustomobject][ordered]@{
        exists = $true
        content = Read-CaptureLogTextShared -LiteralPath $LiteralPath
        lastWriteTimeUtcTicks = $item.LastWriteTimeUtc.Ticks
    }
}

function Get-FreshCaptureLogText {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)]$Baseline,
        [Parameter(Mandatory = $true)][DateTime]$ProcessStartedAtUtc
    )

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        return ''
    }

    try {
        $item = Get-Item -LiteralPath $LiteralPath
        $content = Read-CaptureLogTextShared -LiteralPath $LiteralPath
    }
    catch [System.IO.IOException] {
        return ''
    }

    if ($item.LastWriteTimeUtc -lt $ProcessStartedAtUtc) {
        return ''
    }

    $baselineContent = [string]$Baseline.content
    if ([bool]$Baseline.exists -and
        $content.Length -gt $baselineContent.Length -and
        $content.StartsWith($baselineContent, [System.StringComparison]::Ordinal)) {
        return $content.Substring($baselineContent.Length)
    }

    if ([bool]$Baseline.exists -and
        $content -ceq $baselineContent -and
        $item.LastWriteTimeUtc.Ticks -le [long]$Baseline.lastWriteTimeUtcTicks) {
        return ''
    }

    # BepInEx normally truncates LogOutput.log on launch.  A post-launch write time
    # plus content that is not the unchanged baseline therefore identifies this run.
    if (-not [bool]$Baseline.exists -or
        $item.LastWriteTimeUtc.Ticks -gt [long]$Baseline.lastWriteTimeUtcTicks -or
        $content -cne $baselineContent) {
        return $content
    }

    return ''
}

function Test-QuickCompletePng {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

    if ($File.Length -lt 33) {
        return $false
    }

    try {
        $stream = [System.IO.File]::Open(
            $File.FullName,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read)
        try {
            $stream.Position = $stream.Length - 12
            $tail = [byte[]]::new(12)
            if ($stream.Read($tail, 0, $tail.Length) -ne $tail.Length) {
                return $false
            }
            return $tail[4] -eq [byte][char]'I' -and
                $tail[5] -eq [byte][char]'E' -and
                $tail[6] -eq [byte][char]'N' -and
                $tail[7] -eq [byte][char]'D'
        }
        finally {
            $stream.Dispose()
        }
    }
    catch [System.IO.IOException] {
        return $false
    }
}

function Test-CaptureReadyForValidation {
    param(
        [Parameter(Mandatory = $true)][string]$ActionRoot,
        [Parameter(Mandatory = $true)][string]$Action,
        [Parameter(Mandatory = $true)][string]$LogPath,
        [Parameter(Mandatory = $true)]$LogBaseline,
        [Parameter(Mandatory = $true)][DateTime]$ProcessStartedAtUtc,
        [Parameter(Mandatory = $true)][string]$CapturePolicy,
        [Parameter(Mandatory = $true)][string]$CaptureNormalization
    )

    $freshLog = Get-FreshCaptureLogText `
        -LiteralPath $LogPath `
        -Baseline $LogBaseline `
        -ProcessStartedAtUtc $ProcessStartedAtUtc
    if (-not $freshLog.Contains("SEER4000_CAPTURE_ACTION_SELECTED action=$Action", [System.StringComparison]::Ordinal) -or
        -not $freshLog.Contains('SEER4000_CAPTURE_FRAMES_DONE', [System.StringComparison]::Ordinal)) {
        return [pscustomobject][ordered]@{ ready = $false; reason = 'fresh completion log is not present'; frameCount = 0 }
    }

    $captureJson = Join-Path $ActionRoot 'capture.json'
    if (-not (Test-Path -LiteralPath $captureJson -PathType Leaf)) {
        return [pscustomobject][ordered]@{ ready = $false; reason = 'capture metadata is missing'; frameCount = 0 }
    }

    try {
        $metadata = [System.IO.File]::ReadAllText($captureJson, [System.Text.Encoding]::UTF8) |
            ConvertFrom-Json -DateKind String
    }
    catch {
        return [pscustomobject][ordered]@{ ready = $false; reason = 'capture metadata is not readable yet'; frameCount = 0 }
    }

    $frameCount = [int]$metadata.frameCount
    if ([string]$metadata.action -cne $Action -or
        [string]$metadata.capturePolicy -cne $CapturePolicy -or
        [string]$metadata.normalization -cne $CaptureNormalization -or
        [int]$metadata.width -ne 1200 -or
        [int]$metadata.height -ne 660 -or
        [int]$metadata.frameRate -ne 30 -or
        $frameCount -lt 2) {
        return [pscustomobject][ordered]@{ ready = $false; reason = 'capture metadata does not match this v3 action'; frameCount = $frameCount }
    }

    $frames = @(Get-ChildItem -LiteralPath $ActionRoot -File -Filter 'frame-*.png' | Sort-Object Name)
    if ($frames.Count -ne $frameCount) {
        return [pscustomobject][ordered]@{ ready = $false; reason = "frame count is $($frames.Count), expected $frameCount"; frameCount = $frameCount }
    }

    for ($index = 0; $index -lt $frameCount; $index++) {
        $expectedName = 'frame-{0:D4}.png' -f $index
        if ($frames[$index].Name -cne $expectedName -or -not (Test-QuickCompletePng -File $frames[$index])) {
            return [pscustomobject][ordered]@{ ready = $false; reason = "frame $expectedName is missing or incomplete"; frameCount = $frameCount }
        }
    }

    return [pscustomobject][ordered]@{ ready = $true; reason = 'fresh done log, metadata, and complete frame set are present'; frameCount = $frameCount }
}

function New-CaptureProcessIdentity {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable
    )

    $resolvedExpected = [System.IO.Path]::GetFullPath($ExpectedExecutable)
    $resolvedActual = $null
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw 'Capture process exited before its identity could be recorded.'
        }
        try {
            $module = $Process.MainModule
            if ($null -ne $module -and -not [string]::IsNullOrWhiteSpace($module.FileName)) {
                $resolvedActual = [System.IO.Path]::GetFullPath($module.FileName)
                break
            }
        }
        catch [System.ComponentModel.Win32Exception] {
            # The process has started but Windows has not exposed its main module yet.
        }
        Start-Sleep -Milliseconds 20
    }
    if ([string]::IsNullOrWhiteSpace($resolvedActual)) {
        throw 'Capture process main-module identity was unavailable after the bounded startup wait.'
    }
    if (-not $resolvedActual.Equals($resolvedExpected, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Started capture executable is '$resolvedActual', expected '$resolvedExpected'."
    }

    return [pscustomobject][ordered]@{
        processId = $Process.Id
        startTimeUtcTicks = $Process.StartTime.ToUniversalTime().Ticks
        executable = $resolvedActual
    }
}

function Test-CaptureProcessIdentity {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]$Identity
    )

    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $Process.Refresh()
            if ($Process.HasExited -or $Process.Id -ne [int]$Identity.processId) {
                return $false
            }
            if ($Process.StartTime.ToUniversalTime().Ticks -ne [long]$Identity.startTimeUtcTicks) {
                return $false
            }
            $module = $Process.MainModule
            if ($null -ne $module -and -not [string]::IsNullOrWhiteSpace($module.FileName)) {
                $actualExecutable = [System.IO.Path]::GetFullPath($module.FileName)
                return $actualExecutable.Equals([string]$Identity.executable, [System.StringComparison]::OrdinalIgnoreCase)
            }
        }
        catch [System.ComponentModel.Win32Exception] {
            # Retry a transient module lookup, but never fall back to a name-only kill.
        }
        catch {
            return $false
        }
        Start-Sleep -Milliseconds 20
    }
    return $false
}

function Stop-OwnedCaptureProcess {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]$Identity,
        [ValidateRange(1, 60000)][int]$WaitMilliseconds = 10000
    )

    if (-not (Test-CaptureProcessIdentity -Process $Process -Identity $Identity)) {
        throw 'Refusing to terminate a process whose capture identity no longer matches.'
    }
    $Process.Kill($true)
    if (-not $Process.WaitForExit($WaitMilliseconds)) {
        throw "Owned capture process $($Identity.processId) did not exit after termination."
    }
}
