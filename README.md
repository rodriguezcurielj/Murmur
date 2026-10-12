# Murmur

A self-hosted music player. Upload your own audio and video files, build playlists, like songs, and download music to play offline. It runs in Docker and stores your files on your own computer.

## Run it

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```sh
docker compose up -d --build
```

Then open **http://localhost:8080**.

| Task | Command |
| --- | --- |
| Stop | `docker compose down` (your music is kept) |
| Rebuild after changing code | `docker compose up -d --build` |
| See server logs | `docker logs -f murmur` |

## Where your music is stored

Everything you upload goes into `music-data/` in this folder. That folder is mounted into the container and isn't committed to git:

- `music-data/music/`: the audio files
- `music-data/covers/`: cover art taken from file tags or video frames
- `music-data/library.json`: titles, artists, albums and other song details

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
server.js            Express server: upload, edit, delete, file streaming
public/index.html    The whole player (HTML, CSS, JS in one file)
public/sw.js         Service worker that keeps the app available offline
public/manifest.webmanifest, public/icons/   Install-as-app metadata
Dockerfile, docker-compose.yml
```

## API

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/api/tracks` | | List all songs |
| POST | `/api/upload` | multipart `file` | Add a song (audio or video) |
| PATCH | `/api/tracks` | `{ ids, title?, artist?, album? }` | Edit one or more songs |
| POST | `/api/tracks/delete` | `{ ids }` | Delete one or more songs |
| DELETE | `/api/tracks/:id` | | Delete one song |
| GET | `/media/:file`, `/covers/:file` | | Stream audio / cover art |
