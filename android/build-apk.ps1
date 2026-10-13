# Builds the Android app and puts it at apps/Murmur.apk in the repo.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"

if (-not (Test-Path "$here\keystore.properties")) {
    Write-Warning 'No keystore.properties: building with the debug key. See android\README.md to make a release key.'
}

Push-Location $here
try {
    & .\gradlew.bat assembleRelease --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'The Android build failed (see the messages above).' }
} finally { Pop-Location }

$apk = Join-Path $here 'app\build\outputs\apk\release\app-release.apk'
$out = Join-Path (Split-Path -Parent $here) 'apps\Murmur.apk'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
Copy-Item $apk $out -Force
Write-Host "Saved $out ($([math]::Round((Get-Item $out).Length / 1KB)) KB). Commit and push it to update the download page."
