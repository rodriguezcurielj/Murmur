# Murmur server installer for Windows (uses Docker Desktop).
#
#   irm https://raw.githubusercontent.com/rodriguezcurielj/Murmur/main/install.ps1 | iex
#
# Options, set before running:
#   $env:MURMUR_TUNNEL = '1'          also start a free public https:// address (Cloudflare quick tunnel)
#   $env:MURMUR_DIR = 'D:\murmur'     where Murmur keeps its files (default: your user folder\murmur)
#   $env:MURMUR_PORT = '8080'         port on this computer
#
# Running it again updates Murmur and keeps your music and accounts.
$ErrorActionPreference = 'Stop'
$Dir = if ($env:MURMUR_DIR) { $env:MURMUR_DIR } else { Join-Path $HOME 'murmur' }
$Port = if ($env:MURMUR_PORT) { $env:MURMUR_PORT } else { '8080' }
$Tunnel = $env:MURMUR_TUNNEL -eq '1'
$Raw = 'https://raw.githubusercontent.com/rodriguezcurielj/Murmur/main'
function Say($m) { Write-Host "`n==> $m" -ForegroundColor Yellow }

# 1. Docker Desktop
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker Desktop is needed. Install it with:  winget install Docker.DockerDesktop'
  Write-Host 'Then open Docker Desktop once, wait until it says it is running, and run this again.'
  return
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'Docker Desktop is installed but not running. Open it, wait until it is ready, then run this again.'; return }

# 2. Murmur
Say "Setting up Murmur in $Dir"
New-Item -ItemType Directory -Force (Join-Path $Dir 'music-data') | Out-Null
$yml = Join-Path $Dir 'server.yml'
Invoke-WebRequest "$Raw/Docker/server.yml" -OutFile $yml -UseBasicParsing
if ($Port -ne '8080') { (Get-Content $yml) -replace '"8080:8080"', "`"${Port}:8080`"" | Set-Content $yml -Encoding utf8 }
$profileArgs = if ($Tunnel) { @('--profile', 'tunnel') } else { @() }
Push-Location $Dir
try {
  docker compose -f server.yml @profileArgs pull
  docker compose -f server.yml @profileArgs up -d
} finally { Pop-Location }

# 3. Updates: every night at 4:00 get the newest Murmur (your music and accounts are kept).
$profileText = if ($Tunnel) { ' --profile tunnel' } else { '' }
$cmd = "Set-Location '$Dir'; docker compose -f server.yml$profileText pull -q; docker compose -f server.yml$profileText up -d"
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
  $trigger = New-ScheduledTaskTrigger -Daily -At 4am
  Register-ScheduledTask -TaskName 'Murmur update' -Action $action -Trigger $trigger -Force | Out-Null
  $auto = 'Murmur updates itself every night at 4:00 (while this computer is on).'
} catch { $auto = "To update Murmur later, run:  $cmd" }

# 4. Where to find it
$url = ''
if ($Tunnel) {
  Say 'Waiting for the public address'
  for ($i = 0; $i -lt 30 -and -not $url; $i++) {
    $m = (docker logs murmur-tunnel 2>&1 | Out-String) | Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches
    if ($m) { $url = $m.Matches[-1].Value } else { Start-Sleep 2 }
  }
}
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress

Say 'Murmur is running'
Write-Host "  On this computer:      http://localhost:$Port"
if ($ip) { Write-Host "  On your home network:  http://${ip}:$Port" }
if ($url) { Write-Host "  From anywhere:         $url   (changes if the tunnel restarts; see: docker logs murmur-tunnel)" }
Write-Host "  Your music and accounts: $Dir\music-data"
Write-Host "  $auto"
Write-Host ''
Write-Host 'Open one of those addresses to create the owner account. To list this server in the apps,'
Write-Host 'add its https:// address to the servers list in config.js on GitHub.'
