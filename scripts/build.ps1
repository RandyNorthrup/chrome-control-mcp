[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release', 'RelWithDebInfo')]
    [string]$Configuration = 'Release',
    [string]$BuildDirectory = 'build',
    [string]$QtRoot = '',
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$buildPath = Join-Path $repoRoot $BuildDirectory

if (-not $QtRoot) {
    if ($env:QTDIR) {
        $QtRoot = $env:QTDIR
    }
    else {
        $candidates = Get-ChildItem -LiteralPath 'C:\Qt' -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'msvc2022_64' } |
            Where-Object { Test-Path -LiteralPath (Join-Path $_ 'lib\cmake\Qt6\Qt6Config.cmake') }
        $QtRoot = $candidates | Select-Object -First 1
    }
}

if (-not $QtRoot -or
    -not (Test-Path -LiteralPath (Join-Path $QtRoot 'lib\cmake\Qt6\Qt6Config.cmake'))) {
    throw 'Qt 6 MSVC 2022 x64 not found. Pass -QtRoot C:\path\to\Qt\<version>\msvc2022_64.'
}

& cmake -S $repoRoot -B $buildPath -G 'Visual Studio 17 2022' -A x64 `
    "-DCMAKE_PREFIX_PATH=$QtRoot" '-DBUILD_TESTING=ON'
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed with exit code $LASTEXITCODE." }

& cmake --build $buildPath --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }

if (-not $SkipTests) {
    & ctest --test-dir $buildPath -C $Configuration --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw "Tests failed with exit code $LASTEXITCODE." }
}

$executable = Join-Path $buildPath "$Configuration\chrome_control_mcp.exe"
Write-Output "MCP server: $executable"
