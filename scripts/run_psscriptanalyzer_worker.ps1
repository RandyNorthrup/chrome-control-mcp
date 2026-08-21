# Copyright (c) 2026 Randy Northrup. All rights reserved.
# SPDX-License-Identifier: MIT

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $TargetPath,

    [Parameter(Mandatory)]
    [string] $SettingsPath,

    [Parameter(Mandatory)]
    [string] $AnalyzerVersion
)

$ErrorActionPreference = 'Stop'
$maximumAttempts = 5
for ($attempt = 1; $attempt -le $maximumAttempts; $attempt++) {
    try {
        Import-Module PSScriptAnalyzer -RequiredVersion $AnalyzerVersion -Force
        $findings = @(Invoke-ScriptAnalyzer -Path $TargetPath -Settings $SettingsPath)
        break
    }
    catch {
        $isInternalNullReference = $_.Exception.Message -like '*Object reference not set*'
        if (-not $isInternalNullReference -or $attempt -eq $maximumAttempts) {
            throw
        }
        Write-Warning "PSScriptAnalyzer failed internally; retrying ($attempt/$maximumAttempts)."
        Remove-Module PSScriptAnalyzer -Force -ErrorAction SilentlyContinue
    }
}

if ($findings.Count -gt 0) {
    $findings |
        Sort-Object ScriptPath, Line, Column |
        Format-Table -AutoSize |
        Out-String |
        Write-Error
    exit 1
}
