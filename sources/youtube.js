// Murmur custom source plugin: sources/youtube.js
// Natively extracts audio streams via plain text keywords search or direct links
const ytDlpModule = require('ytdlp-nodejs');
const YouTube = require('youtube-sr').default;

// Robustly fallback across varying npm module export schemas
const YTDlpClass = ytDlpModule.YTDlp || ytDlpModule || Object.values(ytDlpModule)[0];

module.exports = {
  id: 'youtube-local',
  name: 'YouTube Downloader (Local)',
  site: 'https://github.com',
  about: 'Extracts audio natively from direct video links or via plain text keywords search.',
  license: 'Open Source',
  paid: false,
  key: null, // Removes the credential input boxes from your dashboard screen

  // 1. Search. Intercepts text keywords and automatically finds the top YouTube video link.
  async search(q, cfg) {
    if (!q || typeof q !== 'string' || q.trim() === '') {
      throw new Error('Search query cannot be empty.');
    }

    let targetUrl = q.trim();

    // Check if the query is a plain text search or a direct video link
    if (!targetUrl.includes('://youtube.com') && !targetUrl.includes('youtu.be/')) {
      try {
        const videoResult = await YouTube.searchOne(targetUrl, 'video');
        if (!videoResult || !videoResult.id) {
          throw new Error('No video match discovered on YouTube for those keywords.');
        }
        targetUrl = `https://www.://youtube.comwatch?v=${videoResult.id}`;
      } catch (searchErr) {
        throw new Error(`YouTube search lookup failed: ${searchErr.message}`);
      }
    }

    try {
      const ytdlp = new YTDlpClass();
      const info = await ytdlp.getInfoAsync(targetUrl);

      if (!info) throw new Error('Video metadata could not be fetched.');

      return [{
        id: targetUrl, // Sends the validated video link forward to the download function
        title: info.title || 'YouTube Audio',
        artist: info.uploader || info.artist || 'YouTube Video',
        album: 'Local Extraction',
        duration: parseInt(info.duration, 10) || 0,
        cover: info.thumbnail || info.thumbnails?.[0]?.url || '', 
        price: 0, 
        priceLabel: 'DOWNLOAD', // Creates your brand new DOWNLOAD button inline
        license: 'Local Server Copy',
        page: targetUrl
      }];
    } catch (err) {
      throw new Error(`Failed to parse video assets: ${err.message}`);
    }
  },

  // 2. Download. Tells Murmur's download manager exactly where to fetch the raw file stream.
  async download(id, cfg) {
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid or missing source video ID/URL.');
    }

    try {
      const ytdlp = new YTDlpClass();
      
      // Fetch metadata parallel to getting direct streaming formats to speed up resolution
      const [info, directFormats] = await Promise.all([
        ytdlp.getInfoAsync(id).catch(() => ({})),
        ytdlp.getDirectUrlsAsync(id, { filter: 'audioonly' }).catch(() => null)
      ]);
      
      let streamUrl = '';

      // Normalize different format structures returned by varying platform wrappers
      if (directFormats) {
        if (typeof directFormats === 'string') {
          streamUrl = directFormats;
        } else if (directFormats.url) {
          streamUrl = directFormats.url;
        } else if (Array.isArray(directFormats) && directFormats.length > 0) {
          // Look for explicit audio streams first, fallback to the top element
          const audioFormat = directFormats.find(f => f.format_note?.includes('audio') || f.ext === 'm4a' || f.ext === 'webm');
          streamUrl = audioFormat?.url || directFormats[0]?.url || directFormats[0];
        }
      }

      // If the specific audio-only utility failed, extract from raw video info formats array
      if (!streamUrl && info?.formats && Array.isArray(info.formats)) {
        const fallbackAudio = info.formats.find(f => f.vcodec === 'none' && f.acodec !== 'none') || info.formats[0];
        streamUrl = fallbackAudio?.url;
      }

      if (!streamUrl || typeof streamUrl !== 'string') {
        throw new Error('No compatible audio stream link could be found or decrypted.');
      }

      // Sanitize the filename to eliminate character issues across storage filesystems
      const cleanTitle = (info.title || 'Track').replace(/[\\/:*?"<>|]/g, '');
      const cleanArtist = (info.uploader || 'Audio').replace(/[\\/:*?"<>|]/g, '');
      const finalFilename = `${cleanArtist} - ${cleanTitle}.mp3`;

      return {
        url: streamUrl.trim(), // Direct, validated link to the audio stream payload
        filename: finalFilename,
        title: info.title || 'YouTube Audio', 
        artist: info.uploader || 'YouTube Video', 
        album: 'Local Extraction', 
        cover: info.thumbnail || info.thumbnails?.[0]?.url || '',
        license: 'Local Server Copy', 
        page: id
      };
    } catch (err) {
      throw new Error(`Direct stream extraction failed: ${err.message}`);
    }
  }
};
