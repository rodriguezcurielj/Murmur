// sources/youtubeCreativeCommons.js
const { convert } = require('./youtube_stuff/convert');
const path = require('path');

module.exports = {
    id: 'youtube', // <--- Change this from 'youtube-cc' to 'youtube'
    name: 'YouTube Creative Commons',
    site: 'https://youtube.com',
    about: 'Extracts audio from YouTube videos using yt2audio core.',
    license: 'Creative Commons Attribution',
    paid: false,

    links: [/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/.+/i],
    linkExample: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',

    async idFromLink(link, cfg) {
        return link.trim();
    },

    async search(q, cfg) {
        return [];
    },

    async download(id, cfg) {
        return new Promise((resolve, reject) => {
            let finalPath = '';

            convert([id], 'mp3',
                (line) => {
                    if (line.includes('Destination:')) {
                        finalPath = line.split('Destination: ')[1]?.trim();
                    }
                },
                (code) => {
                    if (code === 0) {
                        resolve({
                            url: id,
                            filename: finalPath ? path.basename(finalPath) : 'YouTube Audio.mp3',
                            title: 'YouTube Track',
                            artist: 'Unknown Artist',
                            license: 'Creative Commons Attribution',
                            page: id
                        });
                    } else {
                        reject(new Error(`Conversion failed with exit code ${code}`));
                    }
                }
            );
        });
    }
};