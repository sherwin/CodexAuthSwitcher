$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$latestRoot = Join-Path $env:LOCALAPPDATA 'Programs\Codex Auth Switcher Latest'
$outputRoot = Join-Path $latestRoot 'new-build'

Write-Host "Codex Auth Switcher build" -ForegroundColor Cyan
Write-Host "Source: $sourceRoot"
Write-Host "Output: $outputRoot"

Set-Location $sourceRoot
if (-not (Test-Path (Join-Path $sourceRoot 'node_modules'))) {
  Write-Host 'Installing dependencies...'
  npm install
}

if (Test-Path $outputRoot) {
  Remove-Item -LiteralPath $outputRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

npm exec electron-builder -- --win dir --config.directories.output="$outputRoot"

$builtDir = Join-Path $outputRoot 'win-unpacked'
$builtExe = Join-Path $builtDir 'Codex Auth Switcher.exe'
if (-not (Test-Path $builtExe)) {
  throw "Build completed but executable was not found: $builtExe"
}

Write-Host ''
Write-Host 'Build completed successfully.' -ForegroundColor Green
Write-Host "Executable: $builtExe" -ForegroundColor Green
Write-Host ''
Write-Host 'Press Enter to close this window.'
[void](Read-Host)
