FROM node:20-alpine

# ffmpeg reads tags and cover art, and pulls audio out of video files
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js auth.js ./
COPY public ./public

ENV PORT=8080 DATA_DIR=/data MAX_UPLOAD_MB=2048
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
