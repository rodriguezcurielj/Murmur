# Murmur

A self-hosted music player. Upload your own audio and video files, build playlists, like songs, and download music to play offline. It runs in Docker and stores your files on your own computer.

## Run it

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```sh
cd Docker
docker compose up -d --build
```

(Run the `docker compose` commands from the `Docker` folder.)

Then open **http://localhost:8080**.

| Task | Command |
| --- | --- |
| Stop | `docker compose down` (your music is kept) |
| Rebuild after changing code | `docker compose up -d --build` |
| See server logs | `docker logs -f murmur` |

## Run a server on any device (PC, Mac, Linux, Raspberry Pi)

GitHub builds a ready-made server image on every push (`.github/workflows/docker.yml`), for 64-bit PCs, Raspberry Pi 4/5 (64-bit) and older 32-bit Raspberry Pi OS: `ghcr.io/rodriguezcurielj/murmur:latest`. A new server needs one command and no copy of this repo.

**Linux, Raspberry Pi or Mac** (installs Docker if needed; on a Mac install Docker Desktop first):

```sh
curl -fsSL https://raw.githubusercontent.com/rodriguezcurielj/Murmur/main/install.sh | sh
```

Add a free public `https://` address (Cloudflare quick tunnel) with `| sh -s -- --tunnel`. Other options: `--dir=PATH`, `--port=NUMBER`.

**Windows** (needs Docker Desktop running), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/rodriguezcurielj/Murmur/main/install.ps1 | iex
```

For a public address, run `$env:MURMUR_TUNNEL = '1'` first.

Either way, Murmur ends up in a `murmur` folder in your home folder with its data in `murmur/music-data`, updates itself every night at 4:00, and prints the addresses to open. Open one to create that server's owner account. To make it selectable in the apps, add its `https://` address to the `servers` list in `config.js`. Each server has its own music and accounts.

By hand: download `Docker/server.yml`, then `docker compose -f server.yml up -d` (add `--profile tunnel` for the public address).

For a Raspberry Pi, use **Raspberry Pi OS (64-bit)** on a Pi 4 or 5, and keep the music on an SSD or a big, fast SD card.

## Keeping two servers in sync

Two or more Murmur servers can hold the same accounts, sign-ins, songs (including the audio files), everyone's libraries, Spotify imports and settings, in both directions (`sync.js`). For each item, the newest change wins; deletions sync too.

1. Put the same secret in a `.env` file next to the compose file on every server: `MURMUR_SYNC_KEY=some-long-random-text`.
2. On the server that can reach the others (for example a laptop on a changing tunnel address), also add `MURMUR_PEERS=https://address-of-the-other-server`. It pushes its changes there and pulls the other server's changes about every 30 seconds, and right after anything changes.
3. Restart Murmur (`docker compose up -d`).

The `.env` file is ignored by git. Without a key, sync is off and the sync endpoints answer 404.

## Sign-in and people

- **First visit:** Murmur asks you to set up the owner account (your name + a 4-digit PIN). Do this right away. Until you do, anyone who can reach the server could claim it.
- **Signing in:** everyone signs in with their name and PIN. After a correct PIN, Murmur asks **"Remember this computer?"**
  - **Yes:** you stay signed in on that device for 90 days. Then Murmur locks and asks for your PIN again.
  - **No:** you're signed out when the browser closes, or after 12 hours.
- **People** (owner only, from the round account button at the top right, then *Manage people*):
  - Add people with a name and a 4-digit PIN.
  - Choose per person whether they **can add, edit and delete music**. The default is listen and download only.
  - See each person's signed-in devices and sign any of them out.
  - Set a new PIN for someone (this signs them out everywhere).
  - Delete people, which stops their PIN and signs them out on every device.
- Everyone can change their own PIN from the account button.
- **Security:** PINs are stored as salted scrypt hashes, and sessions as SHA-256 hashes of random tokens. Five wrong PINs lock that name and address for 1 minute, and the lock doubles up to 15 minutes. All music, covers and API routes require sign-in, and requests from other websites are rejected.
- **Forgot the owner PIN?** Stop Murmur and delete `music-data/auth.json`. Your music is untouched; you'll set up the owner again and re-add people.

## YouTube suggestions

The owner can connect a free YouTube Data API key under **People & settings**. The key is stored in `music-data/settings.json` on the server, never in git. Once it is connected:

- **Home** shows *Because you like …* shelves of YouTube songs, based on the genres and artists of the songs you like and play.
- **Search** gets a *Search YouTube* button (or press Enter).
- YouTube songs play in YouTube's official embedded player, which appears as a small video window while playing. You can like them, add them to playlists and queue them. They can't be downloaded.

The free quota allows about 90 searches a day, so results are cached for 12 hours.

## Discover

Home shows **New songs for you**, and Your Library has a **Discover** list. Murmur takes the artists you like and play most, finds similar artists in Deezer's public music catalog (free, no key), and suggests their top songs that aren't already in your library. Suggestions play from YouTube, and *Bring into Murmur* works on them too. The list refreshes daily, or tap **Get new suggestions**.

## Phone apps

The download page is at **https://rodriguezcurielj.github.io/Murmur/apps/**, and the files live in `apps/`:

- **Android:** `apps/Murmur.apk`. Rebuild it with `powershell -ExecutionPolicy Bypass -File android\build-apk.ps1`, which updates `apps/Murmur.apk`. See `android/README.md`.
- **iPhone:** `apps/Murmur.ipa`, for sideloading with Sideloadly. iPhone apps can only be built on a Mac, so GitHub Actions builds it on GitHub's Macs (`.github/workflows/ios.yml`) whenever `ios/` changes, and commits the new `apps/Murmur.ipa`. To build it by hand, go to the Actions tab, open **Build iPhone app**, and click **Run workflow**. With a free Apple ID, sideloaded apps must be re-installed every 7 days.

Both apps open the GitHub Pages copy, so most Murmur updates reach them without reinstalling.

## Where your music is stored

Everything you upload goes into `music-data/` at the top of this repo. That folder is mounted into the container and isn't committed to git:

- `music-data/music/`: the audio files
- `music-data/covers/`: cover art taken from file tags or video frames
- `music-data/library.json`: titles, artists, albums and other song details
- `music-data/auth.json`: accounts and sign-ins (hashed PINs only)

Back up `music-data/` to keep your library.

## Features

- **Upload** MP3, M4A, FLAC, WAV, OGG, OPUS, MP4, MOV, MKV, WEBM, AVI, WMA, AIFF and more. Video files and formats browsers can't play are converted to MP3 with ffmpeg.
- **Albums are built automatically** from album tags. You can edit the title, artist and album in the app.
- **Multi-select** songs with the Select button, or Ctrl/Shift-click. You can then like them, add them to a playlist or the queue, edit, download or delete them in one go.
- **Delete** songs, albums and playlists. Built-in demo music can be removed and restored later.
- **Download for offline:** use the download button on any album or playlist, or Download in a song's ⋯ menu. Downloaded songs are saved inside the browser on that device and play with no connection. **Save file to device** in the ⋯ menu gives you the actual audio file instead.
- **Install as an app:** an *Install app* button appears in browsers that support it. The installed app opens even when offline.

## Offline and other devices

Offline mode needs a secure page: `http://localhost` on the computer running Docker, or an `https://` address.

From another device on your Wi-Fi (`http://<your-PC's-IP>:8080`), you can stream, upload and use **Save file to device**. Downloads also save there, but phones won't open the app offline from a plain `http://` address. For offline use on a phone, serve Murmur over HTTPS. A free option is [Tailscale](https://tailscale.com/kb/1312/serve) (`tailscale serve 8080`).

## Project layout

```
index.html            The whole player (HTML, CSS, JS in one file). Also served by GitHub Pages as a demo
sw.js                 Service worker that keeps the app available offline
manifest.webmanifest, icons/   Install-as-app metadata
server.js             Express server: upload, edit, delete, file streaming
auth.js               Accounts, PINs, sessions, permissions
youtube.js            YouTube search and suggestions (official API)
config.js             Server address used by the GitHub Pages copy
spotify.js            Spotify playlist import and the shared song-to-source matches
discover.js           New-song suggestions from similar artists (Deezer catalog)
android/              Native Android app (build-apk.ps1 rebuilds apps/Murmur.apk)
ios/                  Native iPhone app (built by GitHub Actions into apps/Murmur.ipa)
extension/            Murmur Ad Blocker browser extension (YouTube ads, desktop browsers)
apps/                 Download page plus the built Murmur.apk and Murmur.ipa
userdata.js           Each person's own library (liked songs, playlists, history) and the owner's admin view
Docker/               Dockerfile, docker-compose.yml (build from this repo) and server.yml (ready-made image)
install.sh, install.ps1   One-command server setup for Linux/Raspberry Pi/Mac and Windows
music-data/           Your music and accounts (not in git)
```

The GitHub Pages copy at https://rodriguezcurielj.github.io/Murmur/ has no server, so it runs as a demo with the built-in songs only. Sign-in, uploads and downloads need the Docker server.

## API

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/api/tracks` | | List all songs |
| POST | `/api/upload` | multipart `file` | Add a song (audio or video) |
| PATCH | `/api/tracks` | `{ ids, title?, artist?, album? }` | Edit one or more songs |
| POST | `/api/tracks/delete` | `{ ids }` | Delete one or more songs |
| DELETE | `/api/tracks/:id` | | Delete one song |
| GET | `/media/:file`, `/covers/:file` | | Stream audio / cover art |
