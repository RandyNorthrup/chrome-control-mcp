[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [ValidateSet('status', 'install', 'uninstall')]
    [string]$Operation = 'status',
    [string]$Executable = ''
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

if ($Operation -ne 'status') {
    $detail = if ($Operation -eq 'install') {
        'register the Chrome Control MCP native messaging host for this user'
    }
    else {
        'remove the Chrome Control MCP native messaging host registration from this user'
    }
    if (-not $PSCmdlet.ShouldProcess('Current user Chrome configuration', $detail)) { return }
}

$toolName = "browser_extension_$Operation"
$request = @{
    jsonrpc = '2.0'; id = 1; method = 'tools/call';
    params = @{ name = $toolName; arguments = @{} }
} | ConvertTo-Json -Compress -Depth 8

$responseText = $request | & $Executable
if ($LASTEXITCODE -ne 0) { throw "MCP server exited with code $LASTEXITCODE." }
$response = $responseText | ConvertFrom-Json
if ($response.error) { throw $response.error.message }
if ($response.result.isError) { throw $response.result.content[0].text }
$response.result.content[0].text | ConvertFrom-Json
