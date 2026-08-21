# Copyright (c) 2026 Randy Northrup. All rights reserved.
# SPDX-License-Identifier: MIT

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$analyzerVersion = '1.24.0'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$settingsPath = Join-Path $repoRoot 'PSScriptAnalyzerSettings.psd1'
$workerPath = Join-Path $PSScriptRoot 'run_psscriptanalyzer_worker.ps1'
$powerShellPath = (Get-Process -Id $PID).Path
$relativeFiles = @(& git -C $repoRoot ls-files -- '*.ps1' '*.psm1' '*.psd1')
if ($LASTEXITCODE -ne 0) {
    throw "Could not enumerate tracked PowerShell files (git exit $LASTEXITCODE)."
}

foreach ($relativeFile in $relativeFiles) {
    $path = Join-Path $repoRoot $relativeFile
    # A fresh process per file isolates an upstream analyzer null-reference caused by shared
    # module state while keeping the complete ruleset and tracked-file scope.
    & $powerShellPath -NoProfile -File $workerPath `
        -TargetPath $path `
        -SettingsPath $settingsPath `
        -AnalyzerVersion $analyzerVersion
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

Write-Output "PSScriptAnalyzer passed for $($relativeFiles.Count) tracked files."
