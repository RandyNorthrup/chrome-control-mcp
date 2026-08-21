# Copyright (c) 2026 Randy Northrup. All rights reserved.
# SPDX-License-Identifier: MIT

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$analyzerVersion = '1.24.0'
Import-Module PSScriptAnalyzer -RequiredVersion $analyzerVersion -Force
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$settingsPath = Join-Path $repoRoot 'PSScriptAnalyzerSettings.psd1'
$relativeFiles = @(& git -C $repoRoot ls-files -- '*.ps1' '*.psm1' '*.psd1')
if ($LASTEXITCODE -ne 0) {
    throw "Could not enumerate tracked PowerShell files (git exit $LASTEXITCODE)."
}

$findings = @()
foreach ($relativeFile in $relativeFiles) {
    $path = Join-Path $repoRoot $relativeFile
    # Materialize each result before appending it. PSScriptAnalyzer 1.25 has a nondeterministic
    # null-reference regression in this multi-file pattern, so tooling is pinned to 1.24.0.
    $fileFindings = @(Invoke-ScriptAnalyzer -Path $path -Settings $settingsPath)
    $findings += $fileFindings
}

if ($findings.Count -gt 0) {
    $findings |
        Sort-Object ScriptPath, Line, Column |
        Format-Table -AutoSize |
        Out-String |
        Write-Error
    exit 1
}

Write-Output "PSScriptAnalyzer passed for $($relativeFiles.Count) tracked files."
