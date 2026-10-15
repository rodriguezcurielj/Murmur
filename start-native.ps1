# start-native.ps1 — runs Murmur natively on Windows (no Docker), mirroring Docker/Dockerfile.
# Usage: .\start-native.ps1 [-Port 8081]
param([int]$Port = 8081)

Set-Location $PSScriptRoot

# Same front-end files the Dockerfile copies into ./public
New-Item -ItemType Directory -Force public | Out-Null
Copy-Item index.html, config.js, manifest.webmanifest, sw.js public -Force
Copy-Item icons public -Recurse -Force

$env:PORT = $Port
# Own data folder so it never writes to the Docker container's music-data.
# First run seeds it with a copy of music-data.
$env:DATA_DIR = Join-Path $PSScriptRoot 'native-data'
if (-not (Test-Path $env:DATA_DIR)) { Copy-Item music-data $env:DATA_DIR -Recurse }
$env:MAX_UPLOAD_MB = 2048

node server.js
