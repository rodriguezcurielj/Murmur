// Template for a new download source. Copy this file to sources/<name>.js (no leading underscore),
// fill in the three parts, and restart Murmur. It then shows up under People & settings → Download sources.
//
// Only connect services that give you the right to keep the file: a store you buy songs from, a licensed
// catalog you have an agreement with, or free/Creative Commons music. See sources/README.md.

module.exports = {
  id: 'example',                        // short, unique, lowercase
  name: 'Example Store',                // shown to people
  site: 'https://example.com',
  about: 'One sentence about what this source has.',
  license: 'Purchased download',        // shown next to results unless a result has its own
  paid: true,                           // true: results cost money, Murmur asks before buying

  // Remove "key" if the service needs no key. Otherwise the owner pastes it in People & settings,
  // and it arrives as cfg.key below. (Need more than one value? Ask for them joined, e.g. "id:secret".)
  key: { label: 'Example API key', url: 'https://example.com/developers', help: 'Where to get the key, in one sentence.' },

  // Optional: "paste a link". Which links this source understands, and how to turn one into an id for download().
  // People paste these in Download… → From a link, and get the audio file back.
  links: [/^https:\/\/(www\.)?example\.com\/track\/\w+/i],
  linkExample: 'https://example.com/track/abc123',
  async idFromLink(link, cfg) {
    const m = link.match(/\/track\/(\w+)/);
    return m ? m[1] : null;           // or ask the service's API to look the link up
  },

  // 1. Search. Return up to ~15 songs that can actually be downloaded.
  async search(q, cfg) {
    const r = await fetch('https://api.example.com/search?q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + cfg.key } });
    if (!r.ok) throw new Error('Example answered ' + r.status);
    const j = await r.json();
    return j.tracks.map(t => ({
      id: String(t.id),                 // passed back to download()
      title: t.title,
      artist: t.artist,
      album: t.album || '',
      duration: t.seconds || 0,
      cover: t.image || '',             // https:// image, optional
      price: t.price || 0,              // a number in your currency; 0 = free
      priceLabel: t.priceText || '',    // e.g. "$1.29" (shown on the button)
      license: t.license || '',         // optional, overrides the source's license text
      licenseUrl: '',                   // optional link to the license
      page: t.url || ''                 // optional link to the song on the service
    }));
  },

  // 2. Get the file. For a store, this is where you buy it (the service charges the account behind cfg.key)
  //    and then ask for the download link. Return a URL Murmur can fetch (plus any headers it needs).
  async download(id, cfg) {
    const buy = await fetch('https://api.example.com/purchase', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId: id, format: 'mp3' }) });
    if (!buy.ok) throw new Error('The purchase didn’t go through (' + buy.status + ').');
    const j = await buy.json();
    return {
      url: j.downloadUrl,               // https:// link to the audio file (MP3, M4A, FLAC, WAV, OGG...)
      headers: { Authorization: 'Bearer ' + cfg.key },   // optional
      filename: `${j.artist} - ${j.title}.mp3`,
      title: j.title, artist: j.artist, album: j.album || '', cover: j.image || '',
      license: 'Purchased download', page: j.url || ''
    };
  }
};
