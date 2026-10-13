#!/bin/sh
# Murmur server installer for Linux, Raspberry Pi and Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/rodriguezcurielj/Murmur/main/install.sh | sh
#
# Options (add after "sh -s --"):
#   --tunnel        also start a free public https:// address (Cloudflare quick tunnel)
#   --dir=PATH      where Murmur keeps its files (default: ~/murmur)
#   --port=NUMBER   port on this computer (default: 8080)
#
# Example:  curl -fsSL https://raw.githubusercontent.com/rodriguezcurielj/Murmur/main/install.sh | sh -s -- --tunnel
#
# Running it again updates Murmur and keeps your music and accounts.
set -e

DIR="${MURMUR_DIR:-$HOME/murmur}"
PORT=8080
TUNNEL=0
for a in "$@"; do
  case "$a" in
    --tunnel) TUNNEL=1 ;;
    --dir=*) DIR="${a#--dir=}" ;;
    --port=*) PORT="${a#--port=}" ;;
    *) echo "Unknown option: $a"; exit 1 ;;
  esac
done
RAW=https://raw.githubusercontent.com/rodriguezcurielj/Murmur/main
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO=sudo
say() { printf '\n\033[1;33m==>\033[0m %s\n' "$1"; }

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  if [ "$(uname)" = "Darwin" ]; then
    echo "Install Docker Desktop for Mac first (https://www.docker.com/products/docker-desktop/), open it once, then run this again."
    exit 1
  fi
  say "Installing Docker (this takes a few minutes the first time)"
  curl -fsSL https://get.docker.com | $SUDO sh
fi
$SUDO systemctl enable --now docker >/dev/null 2>&1 || true
if docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="$SUDO docker"; fi
if ! $DOCKER compose version >/dev/null 2>&1; then
  echo "Docker Compose is missing. Install the docker-compose-plugin package, then run this again."
  exit 1
fi
# Let this user run Docker without sudo from now on (takes effect after signing in again).
if [ -n "$SUDO" ] && [ "$(uname)" != "Darwin" ]; then $SUDO usermod -aG docker "$(id -un)" 2>/dev/null || true; fi

# 2. Murmur
say "Setting up Murmur in $DIR"
mkdir -p "$DIR/music-data"
curl -fsSL "$RAW/Docker/server.yml" -o "$DIR/server.yml"
if [ "$PORT" != "8080" ]; then sed -i.bak "s/\"8080:8080\"/\"$PORT:8080\"/" "$DIR/server.yml" && rm -f "$DIR/server.yml.bak"; fi
PROFILE=""; [ "$TUNNEL" = 1 ] && PROFILE="--profile tunnel"
cd "$DIR"
$DOCKER compose -f server.yml $PROFILE pull
$DOCKER compose -f server.yml $PROFILE up -d

# 3. Updates: every night at 4:00 get the newest Murmur (your music and accounts are kept).
UPDATE="cd $DIR && docker compose -f server.yml $PROFILE pull -q && docker compose -f server.yml $PROFILE up -d"
if command -v crontab >/dev/null 2>&1; then
  if [ "$DOCKER" = "docker" ]; then CRONTAB="crontab"; else CRONTAB="$SUDO crontab"; fi
  ( $CRONTAB -l 2>/dev/null | grep -v 'murmur.*server.yml' ; echo "0 4 * * * $UPDATE >/dev/null 2>&1 # murmur" ) | $CRONTAB -
  AUTO="Murmur updates itself every night at 4:00."
else
  AUTO="To update Murmur later, run:  $UPDATE"
fi

# 4. Where to find it
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$IP" ] && IP=$(ipconfig getifaddr en0 2>/dev/null || true)
URL=""
if [ "$TUNNEL" = 1 ]; then
  say "Waiting for the public address"
  i=0
  while [ $i -lt 30 ] && [ -z "$URL" ]; do
    URL=$($DOCKER logs murmur-tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)
    [ -z "$URL" ] && sleep 2
    i=$((i + 1))
  done
fi

say "Murmur is running"
echo "  On this computer:      http://localhost:$PORT"
[ -n "$IP" ] && echo "  On your home network:  http://$IP:$PORT"
[ -n "$URL" ] && echo "  From anywhere:         $URL   (changes if the tunnel restarts; see: docker logs murmur-tunnel)"
echo "  Your music and accounts: $DIR/music-data"
echo "  $AUTO"
echo
echo "Open one of those addresses to create the owner account. To list this server in the apps,"
echo "add its https:// address to the servers list in config.js on GitHub."
