FROM node:20-alpine

# Install ffmpeg, python, and yt-dlp
RUN apk add --no-cache ffmpeg python3 py3-pip && \
    pip install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy Murmur core files
COPY server.js auth.js youtube.js spotify.js discover.js userdata.js sync.js sources.js ./
COPY sources ./sources

# Copy cookies file from the parent project directory
COPY cookies.txt ./cookies.txt

# FIX: Copy from sources/youtube_stuff since that's where it lives in your repo structure
COPY sources/youtube_stuff ./youtube_stuff

# The web app lives at the repo root; the server serves it from ./public
COPY index.html config.js manifest.webmanifest sw.js ./public/
COPY icons ./public/icons

ENV PORT=8080 DATA_DIR=/data MAX_UPLOAD_MB=2048
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]