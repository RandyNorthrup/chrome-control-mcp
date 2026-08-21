[CmdletBinding()]
param(
    [string]$Executable = '',
    [uri]$Site = 'http://uitestingplayground.com/',
    [ValidateRange(1, 30)]
    [int]$ConnectWaitSeconds = 3,
    [ValidateRange(0, 60)]
    [int]$HoldSeconds = 0,
    [string]$ScreenshotPath = '',
    [switch]$IncludeControlOverlay
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $Executable) {
    $Executable = Join-Path $repoRoot 'dist\chrome_control_mcp.exe'
}
$Executable = (Resolve-Path -LiteralPath $Executable).Path

$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $Executable
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.CreateNoWindow = $true

$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
if (-not $process.Start()) {
    throw 'Could not start MCP server.'
}

function Send-McpRequest {
    param([hashtable]$Request)

    $process.StandardInput.WriteLine(($Request | ConvertTo-Json -Compress -Depth 12))
    $process.StandardInput.Flush()
    $line = $process.StandardOutput.ReadLine()
    if (-not $line) {
        throw 'MCP server returned no response.'
    }
    $response = $line | ConvertFrom-Json
    if ($response.PSObject.Properties.Name -contains 'error') {
        throw "MCP error: $($response.error.message)"
    }
    $response.result
}

function Invoke-BrowserTool {
    param(
        [int]$Id,
        [string]$Name,
        [hashtable]$Arguments
    )

    $result = Send-McpRequest @{
        jsonrpc = '2.0'
        id = $Id
        method = 'tools/call'
        params = @{ name = $Name; arguments = $Arguments }
    }
    if ($result.isError) {
        throw "$Name failed: $($result.content[0].text)"
    }
    $result
}

function Find-Ref {
    param(
        [string]$Snapshot,
        [string]$Pattern,
        [string]$Description
    )

    $match = [regex]::Match($Snapshot, $Pattern)
    if (-not $match.Success) {
        throw "Could not find $Description in browser snapshot."
    }
    $match.Groups[1].Value
}

$temporaryTabOpen = $false
try {
    $null = Send-McpRequest @{
        jsonrpc = '2.0'
        id = 1
        method = 'initialize'
        params = @{
            protocolVersion = '2024-11-05'
            capabilities = @{}
            clientInfo = @{ name = 'chrome-control-mcp-live-verifier'; version = '1' }
        }
    }

    Start-Sleep -Seconds $ConnectWaitSeconds

    $null = Invoke-BrowserTool -Id 2 -Name 'browser_new_tab' -Arguments @{ url = $Site.AbsoluteUri }
    $temporaryTabOpen = $true
    Start-Sleep -Milliseconds 500

    $homeSnapshot = Invoke-BrowserTool -Id 3 -Name 'browser_snapshot' -Arguments @{}
    $homeSnapshotText = $homeSnapshot.content[0].text
    if ($homeSnapshotText -notmatch [regex]::Escape($Site.Host)) {
        throw "Snapshot did not report requested host $($Site.Host)."
    }
    $textInputLink = Find-Ref -Snapshot $homeSnapshotText `
        -Pattern '(?im)^\s*-\s+link\s+"Text Input"\s+\[ref=(e\d+)\]' `
        -Description 'Text Input link'

    $null = Invoke-BrowserTool -Id 4 -Name 'browser_click' -Arguments @{ ref = $textInputLink }
    Start-Sleep -Milliseconds 500

    $form = Invoke-BrowserTool -Id 5 -Name 'browser_snapshot' -Arguments @{}
    $formText = $form.content[0].text
    $textbox = Find-Ref -Snapshot $formText `
        -Pattern '(?im)^\s*-\s+(?:textbox|searchbox).*\[ref=(e\d+)\]' `
        -Description 'text input'
    $button = Find-Ref -Snapshot $formText `
        -Pattern '(?im)^\s*-\s+button.*\[ref=(e\d+)\]' `
        -Description 'update button'

    $probe = 'Chrome Control MCP live verification'
    $null = Invoke-BrowserTool -Id 6 -Name 'browser_type' -Arguments @{
        ref = $textbox
        text = $probe
    }
    $value = Invoke-BrowserTool -Id 7 -Name 'browser_get_value' -Arguments @{ ref = $textbox }
    if ($value.content[0].text -notmatch [regex]::Escape($probe)) {
        throw "Typed value read-back mismatch: $($value.content[0].text)"
    }

    $null = Invoke-BrowserTool -Id 8 -Name 'browser_click' -Arguments @{ ref = $button }
    $updated = Invoke-BrowserTool -Id 9 -Name 'browser_snapshot' -Arguments @{}
    if ($updated.content[0].text -notmatch [regex]::Escape($probe)) {
        throw 'Button text did not update after click.'
    }

    $screenshot = Invoke-BrowserTool -Id 10 -Name 'browser_screenshot' -Arguments @{
        full_page = $false
        include_control_overlay = [bool]$IncludeControlOverlay
    }
    $image = @($screenshot.content | Where-Object type -EQ 'image')[0]
    if (-not $image -or $image.mimeType -ne 'image/png' -or $image.data.Length -lt 100) {
        throw 'Screenshot did not return valid PNG image content.'
    }
    $savedScreenshot = ''
    if ($ScreenshotPath) {
        $savedScreenshot = if ([IO.Path]::IsPathRooted($ScreenshotPath)) {
            [IO.Path]::GetFullPath($ScreenshotPath)
        }
        else {
            [IO.Path]::GetFullPath((Join-Path $repoRoot $ScreenshotPath))
        }
        $screenshotDirectory = Split-Path -Parent $savedScreenshot
        if ($screenshotDirectory -and -not (Test-Path -LiteralPath $screenshotDirectory)) {
            $null = New-Item -ItemType Directory -Path $screenshotDirectory -Force
        }
        [IO.File]::WriteAllBytes($savedScreenshot, [Convert]::FromBase64String($image.data))
    }

    if ($HoldSeconds -gt 0) {
        Start-Sleep -Seconds $HoldSeconds
    }

    $null = Invoke-BrowserTool -Id 11 -Name 'browser_close_tab' -Arguments @{}
    $temporaryTabOpen = $false

    [pscustomobject]@{
        site = $Site.AbsoluteUri
        navigation = 'passed'
        snapshot = 'passed'
        typed_value_readback = 'passed'
        click_result = 'passed'
        screenshot_mime = $image.mimeType
        screenshot_base64_length = $image.data.Length
        screenshot_path = $savedScreenshot
        control_overlay_included = [bool]$IncludeControlOverlay
        visible_control_hold_seconds = $HoldSeconds
        temporary_tab_closed = $true
    }
}
finally {
    if ($temporaryTabOpen -and -not $process.HasExited) {
        try {
            $null = Invoke-BrowserTool -Id 99 -Name 'browser_close_tab' -Arguments @{}
        }
        catch {
            Write-Warning "Could not close temporary verification tab: $($_.Exception.Message)"
        }
    }
    if (-not $process.HasExited) {
        $process.StandardInput.Close()
        $null = $process.WaitForExit(5000)
    }
    if (-not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit()
    }
    $stderr = $process.StandardError.ReadToEnd()
    if ($stderr) {
        Write-Warning $stderr
    }
    $process.Dispose()
}
