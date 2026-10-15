FROM node:20-alpine

# Install ffmpeg and python3/py3-pip to install yt-dlp
RUN apk add --no-cache ffmpeg python3 py3-pip && \
    pip install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy Murmur core files
COPY server.js auth.js youtube.js spotify.js discover.js userdata.js sync.js sources.js ./
COPY sources ./sources

# Copy your yt2audio converter files into the container
COPY youtube_stuff ./youtube_stuff

# The web app lives at the repo root; the server serves it from ./public
COPY index.html config.js manifest.webmanifest sw.js ./public/
COPY icons ./public/icons

ENV PORT=8080 DATA_DIR=/data MAX_UPLOAD_MB=2048
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]