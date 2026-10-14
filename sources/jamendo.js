// Jamendo: independent artists who publish under Creative Commons licenses. Free to download for
// personal listening. Needs a free Client ID from https://devportal.jamendo.com (Create an app).
// API: https://developer.jamendo.com/v3.0
const BASE = 'https://api.jamendo.com/v3.0';
async function api(p, key) {
  const r = await fetch(`${BASE}/${p}&client_id=${encodeURIComponent(key)}&format=json`, { signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!j.headers || j.headers.status !== 'success') throw new Error((j.headers && j.headers.error_message) || `Jamendo answered ${r.status}`);
  return j.results || [];
}
// "http://creativecommons.org/licenses/by-nc-sa/3.0/" -> "CC BY-NC-SA 3.0"
const ccName = url => { const m = String(url || '').match(/licenses\/([a-z-]+)\/([\d.]+)/i); return m ? `CC ${m[1].toUpperCase()} ${m[2]}` : 'Creative Commons'; };
const toItem = t => ({
  id: String(t.id), title: t.name, artist: t.artist_name, album: t.album_name || '', duration: t.duration || 0,
  cover: t.image || t.album_image || '', license: ccName(t.license_ccurl), licenseUrl: t.license_ccurl || '', page: t.shareurl || '', price: 0
});

module.exports = {
  id: 'jamendo',
  name: 'Jamendo',
  site: 'https://www.jamendo.com',
  about: 'Over 600,000 Creative Commons songs from independent artists, free to download for personal listening.',
  license: 'Creative Commons',
  key: { label: 'Jamendo Client ID', url: 'https://devportal.jamendo.com', help: 'Free: sign up at devportal.jamendo.com, click Create an app, and copy its Client ID.' },
  async search(q, cfg) {
    const list = await api('tracks/?limit=20&audiodownload_allowed=true&search=' + encodeURIComponent(q), cfg.key);
    return list.filter(t => t.audiodownload_allowed && t.audiodownload).map(toItem);
  },
  async download(id, cfg) {
    if (!/^\d{1,12}$/.test(id)) throw new Error('Unknown track.');
    const t = (await api('tracks/?audioformat=mp32&id=' + id, cfg.key))[0];
    if (!t || !t.audiodownload_allowed || !t.audiodownload) throw Object.assign(new Error('Jamendo doesn’t allow downloading this track.'), { status: 403 });
    const it = toItem(t);
    return { url: t.audiodownload, filename: `${it.artist} - ${it.title}.mp3`, title: it.title, artist: it.artist, album: it.album,
      cover: it.cover, license: it.license, licenseUrl: it.licenseUrl, page: it.page };
  }
};
