// Murmur integration for downloading audio via YouTube URL searching
// Uses the YouTube MP3 API from RapidAPI

module.exports = {
  id: 'youtube',                        
  name: 'YouTube Downloader',                
  site: 'https://rapidapi.com',
  about: 'Extracts and downloads MP3 audio directly from a YouTube video URL.',
  license: 'Personal Offline Use',        
  paid: false, // Set to false so Murmur doesn't try to handle a credit card check internally

  // Instructs the user to paste their RapidAPI key in the Murmur dashboard
  key: { 
    label: 'RapidAPI Key', 
    url: 'https://rapidapi.com', 
    help: 'Sign up on RapidAPI, subscribe to the YouTube MP3 API, and paste your API key here.' 
  },

  // 1. Search. Treats the search query 'q' as the YouTube URL to extract.
  async search(q, cfg) {
    // Basic verification to make sure the user inputted a video link
    if (!q.includes('youtube.com') && !q.includes('youtu.be')) {
      throw new Error('Please enter a valid YouTube video URL into the search bar.');
    }

    // Call the RapidAPI endpoint to analyze the video and fetch conversion details
    const r = await fetch('https://rapidapi.com' + encodeURIComponent(q), {
      headers: {
        'x-rapidapi-key': cfg.key,
        'x-rapidapi-host': '://rapidapi.com'
      }
    });

    if (!r.ok) throw new Error('Downloader API answered HTTP ' + r.status);
    const j = await r.json();

    if (j.status !== 'ok') {
      throw new Error(j.msg || 'Failed to process the YouTube video link.');
    }

    // Map the response object into Murmur's expected result list format
    return [{
      id: q, // Pass the original URL forward to the download function
      title: j.title || 'YouTube Audio',
      artist: 'YouTube Video',
      album: 'YouTube Download',
      duration: j.duration || 0,
      cover: '', 
      price: 0, 
      priceLabel: 'FREE',
      license: 'Personal Offline Use',
      page: q
    }];
  },

  // 2. Get the file. Directly fetches the secure converted download link.
  async download(id, cfg) {
    const r = await fetch('https://rapidapi.com' + encodeURIComponent(id), {
      headers: {
        'x-rapidapi-key': cfg.key,
        'x-rapidapi-host': '://rapidapi.com'
      }
    });

    if (!r.ok) throw new Error('Could not fetch the download link (' + r.status + ').');
    const j = await r.json();

    if (j.status !== 'ok' || !j.link) {
      throw new Error('The download link was not generated successfully.');
    }

    return {
      url: j.link, // The direct HTTPS download link to the audio file
      headers: {},   
      filename: `${j.title || 'audio'}.mp3`,
      title: j.title || 'YouTube Audio', 
      artist: 'YouTube Video', 
      album: 'YouTube Download', 
      cover: '',
      license: 'Personal Offline Use', 
      page: id
    };
  }
};
