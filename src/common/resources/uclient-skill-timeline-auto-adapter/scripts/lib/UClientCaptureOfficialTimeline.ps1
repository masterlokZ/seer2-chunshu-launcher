$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-UClientCaptureOfficialImpactSeconds {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$TimelineSummary,

        [ValidateRange(0, 2147483647)]
        [int]$ExpectedOwnerId = 0
    )

    $resolvedSummary = [System.IO.Path]::GetFullPath($TimelineSummary)
    if (-not (Test-Path -LiteralPath $resolvedSummary -PathType Leaf)) {
        throw "Official Timeline summary is missing: $resolvedSummary"
    }
    $summary = [System.IO.File]::ReadAllText(
        $resolvedSummary, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -DateKind String

    $metadataProperty = $summary.PSObject.Properties['_metadata']
    if ($null -eq $metadataProperty -or $null -eq $metadataProperty.Value) {
        throw "Official Timeline summary metadata is missing: $resolvedSummary"
    }
    $metadata = $metadataProperty.Value
    if ([int]$metadata.schemaVersion -ne 1 -or
        [string]$metadata.policy -cne 'official-unity-playable-signal-clock-v1' -or
        [string]$metadata.hitSignalPolicy -cne 'final-official-signal-marker-v1' -or
        [int]$metadata.ownerId -le 0) {
        throw "Official Timeline summary metadata is invalid: $resolvedSummary"
    }
    if ($ExpectedOwnerId -gt 0 -and [int]$metadata.ownerId -ne $ExpectedOwnerId) {
        throw "Official Timeline summary owner is $($metadata.ownerId), expected $ExpectedOwnerId."
    }

    $appearProperty = $summary.PSObject.Properties['appear']
    if ($null -eq $appearProperty -or $null -eq $appearProperty.Value) {
        throw 'Official Timeline summary is missing action: appear'
    }
    $appearHitProperty = $appearProperty.Value.PSObject.Properties['hitSignal']
    if ($null -ne $appearHitProperty -and $null -ne $appearHitProperty.Value) {
        throw 'Official Timeline appear action must not contain a battle-resolution Signal.'
    }
    $appearSignalsProperty = $appearProperty.Value.PSObject.Properties['signalMarkers']
    if ($null -eq $appearSignalsProperty -or @($appearSignalsProperty.Value).Count -ne 0) {
        throw 'Official Timeline appear action must contain an empty signalMarkers array.'
    }

    $result = @{}
    foreach ($action in @('attack', 'cp', 'sa', 'hidemove')) {
        $actionProperty = $summary.PSObject.Properties[$action]
        if ($null -eq $actionProperty -or $null -eq $actionProperty.Value) {
            throw "Official Timeline summary is missing action: $action"
        }
        $record = $actionProperty.Value
        $duration = [double]$record.computedDuration
        if (-not [double]::IsFinite($duration) -or $duration -le 0) {
            throw "Official Timeline duration is invalid for $action`: $duration"
        }

        $signalMarkersProperty = $record.PSObject.Properties['signalMarkers']
        if ($null -eq $signalMarkersProperty) {
            throw "Official Timeline signalMarkers is missing for $action."
        }
        $officialSignals = @($signalMarkersProperty.Value)
        $hitProperty = $record.PSObject.Properties['hitSignal']
        if ($officialSignals.Count -lt 1 -or $null -eq $hitProperty -or $null -eq $hitProperty.Value) {
            throw "Official Timeline has no battle-resolution Signal for $action."
        }
        foreach ($signal in $officialSignals) {
            $trackProperty = $signal.PSObject.Properties['track']
            $timeProperty = $signal.PSObject.Properties['time']
            if ($null -eq $trackProperty -or [string]$trackProperty.Value -notmatch '(?i)signal' -or
                $null -eq $timeProperty) {
                throw "Official Timeline contains an invalid Signal marker for $action."
            }
            $signalSeconds = [double]$timeProperty.Value
            if (-not [double]::IsFinite($signalSeconds) -or $signalSeconds -le 0 -or $signalSeconds -gt $duration) {
                throw "Official Timeline contains an out-of-range Signal marker for $action`: $signalSeconds"
            }
        }
        $officialSignals = @($officialSignals | Sort-Object { [double]$_.time })
        $hitSignal = $hitProperty.Value
        if ([string]$hitSignal.track -notmatch '(?i)signal') {
            throw "Official Timeline hitSignal is not a Signal track for $action."
        }
        $hitSeconds = [double]$hitSignal.time
        $finalSignalSeconds = [double]$officialSignals[-1].time
        if (-not [double]::IsFinite($hitSeconds) -or $hitSeconds -le 0 -or $hitSeconds -gt $duration) {
            throw "Official Timeline hitSignal time is invalid for $action`: $hitSeconds"
        }
        if ([Math]::Abs($hitSeconds - $finalSignalSeconds) -gt 0.0000001) {
            throw "Official Timeline hitSignal is not the final Signal for $action."
        }
        $result[$action] = $hitSeconds
    }

    return $result
}
