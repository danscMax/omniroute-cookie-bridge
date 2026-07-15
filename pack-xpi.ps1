# Pack the Firefox build into an .xpi (a zip with manifest.json at the ROOT).
# Run `node build.mjs` first, then `pwsh -File pack-xpi.ps1`.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $dir 'build\firefox\*'
$zip = Join-Path $dir 'build\omniroute-bridge-firefox.zip'
$xpi = Join-Path $dir 'build\omniroute-bridge-firefox.xpi'
if (-not (Test-Path (Join-Path $dir 'build\firefox\manifest.json'))) { throw 'build/firefox missing — run `node build.mjs` first' }
foreach ($f in @($zip, $xpi)) { if (Test-Path $f) { Remove-Item $f -Force } }
Compress-Archive -Path $src -DestinationPath $zip -Force
Move-Item $zip $xpi
Write-Host "XPI built: $xpi"
