$ErrorActionPreference = 'Stop'

function Commit-AtomicFilePair {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][hashtable[]]$Pairs,
        [switch]$TestFailAfterFirstCommit
    )

    if ($Pairs.Count -ne 2) {
        throw 'Atomic file-pair transaction requires exactly two files.'
    }
    $transactionId = "$PID-$([Guid]::NewGuid().ToString('N'))"
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($pair in $Pairs) {
        $staged = [IO.Path]::GetFullPath([string]$pair.Staged)
        $target = [IO.Path]::GetFullPath([string]$pair.Target)
        if (-not (Test-Path -LiteralPath $staged -PathType Leaf)) {
            throw "Atomic pair staged file is missing: $staged"
        }
        if ([string]::Equals($staged, $target, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Atomic pair staged and target paths are identical: $target"
        }
        if (-not (Test-Path -LiteralPath (Split-Path -Parent $target) -PathType Container)) {
            throw "Atomic pair target directory is missing: $target"
        }
        $records.Add([pscustomobject]@{
            Staged = $staged
            Target = $target
            Backup = $target + '.pair-backup-' + $transactionId
            HadOriginal = Test-Path -LiteralPath $target -PathType Leaf
            Committed = $false
        })
    }

    try {
        foreach ($record in $records) {
            if ($record.HadOriginal) {
                Move-Item -LiteralPath $record.Target -Destination $record.Backup
            }
        }
        $commitCount = 0
        foreach ($record in $records) {
            Move-Item -LiteralPath $record.Staged -Destination $record.Target
            $record.Committed = $true
            $commitCount++
            if ($TestFailAfterFirstCommit -and $commitCount -eq 1) {
                throw 'Injected atomic pair failure after first commit.'
            }
        }
    }
    catch {
        foreach ($record in $records) {
            if ($record.Committed -and (Test-Path -LiteralPath $record.Target -PathType Leaf)) {
                Remove-Item -LiteralPath $record.Target -Force
            }
        }
        foreach ($record in $records) {
            if ($record.HadOriginal -and (Test-Path -LiteralPath $record.Backup -PathType Leaf)) {
                Move-Item -LiteralPath $record.Backup -Destination $record.Target
            }
        }
        throw
    }

    foreach ($record in $records) {
        if ($record.HadOriginal -and (Test-Path -LiteralPath $record.Backup -PathType Leaf)) {
            Remove-Item -LiteralPath $record.Backup -Force
        }
    }
}
