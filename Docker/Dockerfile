FROM node:20-alpine

# Install ffmpeg, python, and yt-dlp with the EJS package solver
RUN apk add --no-cache ffmpeg python3 py3-pip && \
    pip install --no-cache-dir --break-system-packages yt-dlp yt-dlp-ejs

# Deno is yt-dlp's preferred JS runtime (see convert.js). Alpine has no Deno for 32-bit ARM; Node is used there.
RUN apk add --no-cache deno || echo "Deno isn't available on this platform; yt-dlp will use Node.js"

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy Murmur core files
COPY server.js auth.js youtube.js ytaudio.js ytworker.py spotify.js discover.js userdata.js sync.js sources.js ./
COPY sources ./sources

# YouTube cookies are NOT built into the image (it's public). Put cookies.txt in the data folder (/data) instead.

# Copy youtube stuff
COPY sources/youtube_stuff ./youtube_stuff

# The web app lives at the repo root; the server serves it from ./public
COPY index.html config.js manifest.webmanifest sw.js ./public/
COPY icons ./public/icons

ENV PORT=8080 DATA_DIR=/data MAX_UPLOAD_MB=2048
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]