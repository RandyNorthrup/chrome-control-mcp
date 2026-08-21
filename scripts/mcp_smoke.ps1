[CmdletBinding()]
param(
    [string]$Executable = '',
    [switch]$ReadOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $Executable) {
    $isWindowsPlatform = [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [Runtime.InteropServices.OSPlatform]::Windows
    )
    $relativeExecutable = if ($isWindowsPlatform) {
        'build\Release\chrome_control_mcp.exe'
    }
    else {
        'build/chrome_control_mcp'
    }
    $Executable = Join-Path $repoRoot $relativeExecutable
}
$Executable = (Resolve-Path -LiteralPath $Executable).Path

$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $Executable
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.CreateNoWindow = $true
$start.Environment['CHROME_CONTROL_MCP_REDACT_SENSITIVE_OUTPUT'] = 'true'
if ($ReadOnly) {
    $start.Environment['CHROME_CONTROL_MCP_SECURITY_PROFILE'] = 'read_only'
}
else {
    $null = $start.Environment.Remove('CHROME_CONTROL_MCP_SECURITY_PROFILE')
}

$requests = @(
    @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{
            protocolVersion = '2024-11-05'; capabilities = @{};
            clientInfo = @{ name = 'chrome-control-mcp-smoke'; version = '1' }
        }
    },
    @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} },
    @{ jsonrpc = '2.0'; id = 3; method = 'tools/call'; params = @{
            name = 'browser_extension_status'; arguments = @{}
        }
    }
)

$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
if (-not $process.Start()) { throw 'Could not start MCP server.' }
foreach ($request in $requests) {
    $process.StandardInput.WriteLine(($request | ConvertTo-Json -Compress -Depth 10))
}
$process.StandardInput.Close()
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) {
    throw "MCP server exited $($process.ExitCode): $stderr"
}

$responses = @($stdout -split "`r?`n" | Where-Object { $_ } | ForEach-Object {
        $_ | ConvertFrom-Json
    })
if ($responses.Count -ne 3) { throw "Expected 3 MCP responses; received $($responses.Count)." }

$initialize = $responses | Where-Object id -EQ 1
if ($initialize.result.serverInfo.name -ne 'chrome-control-mcp') {
    throw 'Initialize response has wrong server identity.'
}

$catalog = $responses | Where-Object id -EQ 2
$expectedTools = if ($ReadOnly) { 10 } else { 43 }
if (@($catalog.result.tools).Count -ne $expectedTools) {
    throw "Expected $expectedTools tools; received $(@($catalog.result.tools).Count)."
}

$statusResponse = $responses | Where-Object id -EQ 3
if ($statusResponse.result.isError) { throw 'browser_extension_status returned an MCP error.' }
$status = $statusResponse.result.content[0].text | ConvertFrom-Json
if ($status.extension_id -ne 'iojehhmnaigcejfcpmilpclmeljhlkaa') {
    throw 'Extension status returned wrong pinned extension id.'
}
if (-not $status.extension_present) { throw 'Unpacked extension files are not staged beside the server.' }

[pscustomobject]@{
    server = $initialize.result.serverInfo.name
    protocol = $initialize.result.protocolVersion
    security_profile = if ($ReadOnly) { 'read_only' } else { 'full' }
    tool_count = @($catalog.result.tools).Count
    extension_state = $status.state
    extension_present = $status.extension_present
}
