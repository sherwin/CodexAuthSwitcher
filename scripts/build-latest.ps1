$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$latestRoot = Join-Path $env:LOCALAPPDATA 'Programs\Codex Auth Switcher Latest'
$stagingRoot = Join-Path $env:TEMP ("codex-auth-switcher-build-" + [guid]::NewGuid().ToString('N'))
$outputRoot = Join-Path $stagingRoot 'electron-builder'

Write-Host "Codex Auth Switcher build" -ForegroundColor Cyan
Write-Host "Source: $sourceRoot"
Write-Host "Build staging: $outputRoot"
Write-Host "Final output: $latestRoot"

Set-Location $sourceRoot
if (-not (Test-Path (Join-Path $sourceRoot 'node_modules'))) {
  Write-Host 'Installing dependencies...'
  npm install
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

npm exec electron-builder -- --win dir --config.directories.output="$outputRoot"

$builtDir = Join-Path $outputRoot 'win-unpacked'
$builtExe = Join-Path $builtDir 'Codex Auth Switcher.exe'
if (-not (Test-Path $builtExe)) {
  throw "Build completed but executable was not found: $builtExe"
}

$running = Get-Process -Name 'Codex Auth Switcher' -ErrorAction SilentlyContinue
if ($running) {
  throw 'Codex Auth Switcher is running. Close the existing window, then run this shortcut again so the final directory can be replaced safely.'
}

New-Item -ItemType Directory -Path $latestRoot -Force | Out-Null
& robocopy $builtDir $latestRoot /MIR /R:2 /W:1 /XJ | Out-Host
if ($LASTEXITCODE -ge 8) {
  throw "Failed to replace the final output directory. robocopy exit code: $LASTEXITCODE"
}

Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
$builtExe = Join-Path $latestRoot 'Codex Auth Switcher.exe'

Write-Host ''
Write-Host 'Build completed successfully.' -ForegroundColor Green
Write-Host "Executable: $builtExe" -ForegroundColor Green
Write-Host ''
Write-Host 'Press Enter to close this window.'
[void](Read-Host)
