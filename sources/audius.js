// Audius: a music platform where each artist decides whether a track can be downloaded.
// Murmur only offers tracks the artist made freely downloadable (no "follow me first" or other conditions).
// No key needed. API: https://docs.audius.org
const APP = 'Murmur';
let host = null, hostAt = 0;
async function api(p) {
  if (!host || Date.now() - hostAt > 3600e3) {
    try { const j = await (await fetch('https://api.audius.co', { signal: AbortSignal.timeout(8000) })).json(); host = (j.data || [])[0] || 'https://api.audius.co'; }
    catch { host = 'https://api.audius.co'; }
    hostAt = Date.now();
  }
  const r = await fetch(`${host}/v1/${p}${p.includes('?') ? '&' : '?'}app_name=${APP}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Audius answered ${r.status}`);
  return (await r.json()).data;
}
const open = t => t && t.is_downloadable && !t.download_conditions && !t.is_unlisted;
const toItem = t => ({
  id: t.id, title: t.title, artist: (t.user && t.user.name) || '', album: '', duration: t.duration || 0,
  cover: (t.artwork && (t.artwork['480x480'] || t.artwork['150x150'])) || '',
  // The artist switched on free downloads; their own license line (often "All rights reserved") still applies to anything beyond listening.
  license: 'Free download from the artist' + (t.license && !/all rights reserved/i.test(t.license) ? ' · ' + t.license : ''),
  page: t.permalink ? 'https://audius.co' + t.permalink : '', price: 0
});

module.exports = {
  id: 'audius',
  name: 'Audius',
  site: 'https://audius.co',
  about: 'Independent artists. Only tracks the artist made free to download are offered.',
  license: 'Free download allowed by the artist',
  async search(q) {
    const list = await api('tracks/search?limit=50&query=' + encodeURIComponent(q));
    return (list || []).filter(open).map(toItem);
  },
  async download(id) {
    if (!/^[A-Za-z0-9]{3,20}$/.test(id)) throw new Error('Unknown track.');
    const t = await api('tracks/' + id);
    if (!open(t)) throw Object.assign(new Error('The artist doesn’t allow downloading this track.'), { status: 403 });
    const it = toItem(t);
    return { url: `${host}/v1/tracks/${id}/download?app_name=${APP}`, filename: t.orig_filename || `${it.artist} - ${it.title}.mp3`,
      title: it.title, artist: it.artist, cover: it.cover, license: it.license, page: it.page };
  }
};
