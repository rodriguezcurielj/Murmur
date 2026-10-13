FROM node:20-alpine

# ffmpeg reads tags and cover art, and pulls audio out of video files
RUN apk add --no-cache ffmpeg

WORKDIR /app
# Build context is the repo root (see docker-compose.yml), so paths here are relative to it.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js auth.js youtube.js spotify.js ./
# The web app lives at the repo root (for GitHub Pages); the server serves it from ./public
COPY index.html config.js manifest.webmanifest sw.js ./public/
COPY icons ./public/icons

ENV PORT=8080 DATA_DIR=/data MAX_UPLOAD_MB=2048
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
