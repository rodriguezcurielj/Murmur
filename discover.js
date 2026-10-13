// "Discover": new song suggestions from artists similar to the ones you listen to.
// Uses Deezer's public catalog API (free, no key): search artist -> related artists -> their top songs.
// Answers are cached for a day to stay well inside Deezer's rate limit.
const CACHE_MS = 24 * 3600e3;

module.exports = function createDiscover() {
  const cache = new Map();

  async function dz(path) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const r = await fetch('https://api.deezer.com/' + path, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    if (data && data.error) throw new Error(data.error.message || 'Deezer error');
    cache.set(path, { at: Date.now(), data });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return data;
  }
  const toTrack = (t, because) => ({
    title: t.title_short || t.title || '',
    artist: (t.artist && t.artist.name) || '',
    album: (t.album && t.album.title) || '',
    cover: (t.album && (t.album.cover_medium || t.album.cover)) || '',
    duration: t.duration || 0,
    isrc: t.isrc || '',
    url: t.link || '',
    because
  });

  function routes(app) {
    // Song search for the search bar (free; YouTube is only used when a song is first played).
    app.get('/api/catalog/search', async (req, res) => {
      const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!q) return res.json({ items: [] });
      try {
        const r = await dz('search?limit=30&q=' + encodeURIComponent(q.toLowerCase()));
        res.json({ items: (r.data || []).filter(t => t.type === 'track' || !t.type).map(t => toTrack(t, '')) });
      } catch (e) { res.status(502).json({ error: 'Couldn’t reach the song catalog. Try again in a moment.' }); }
    });

    // Popular songs for a genre name (for the "Because you like …" shelves on Home).
    app.get('/api/catalog/genre', async (req, res) => {
      const name = String(req.query.name || '').trim().toLowerCase().slice(0, 60);
      if (!name) return res.json({ items: [] });
      const simple = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
      try {
        const genres = (await dz('genre')).data || [];
        const want = simple(name);
        const g = genres.find(x => x.id !== 0 && (simple(x.name) === want || simple(x.name).includes(want) || want.includes(simple(x.name))));
        const r = g ? await dz(`chart/${g.id}/tracks?limit=30`) : await dz('search?limit=30&q=' + encodeURIComponent(name));
        res.json({ items: (r.data || []).map(t => toTrack(t, '')), genre: g ? g.name : name });
      } catch (e) { res.status(502).json({ error: 'Couldn’t reach the song catalog.' }); }
    });

    app.get('/api/discover', async (req, res) => {
      const seeds = String(req.query.artists || '').split('|').map(s => s.trim()).filter(Boolean).slice(0, 5);
      const known = new Set(seeds.map(s => s.toLowerCase()));
      const groups = [];
      try {
        for (const name of seeds) {
          const found = await dz('search/artist?limit=1&q=' + encodeURIComponent(name));
          const a = found.data && found.data[0];
          if (!a) continue;
          const related = await dz(`artist/${a.id}/related?limit=8`);
          const picks = (related.data || []).filter(r => !known.has(r.name.toLowerCase())).slice(0, 5);
          picks.forEach(r => known.add(r.name.toLowerCase()));
          const tops = await Promise.all(picks.map(r => dz(`artist/${r.id}/top?limit=3`).catch(() => ({ data: [] }))));
          groups.push(tops.flatMap(t => (t.data || []).map(x => toTrack(x, a.name))));
        }
        let items = [];
        // Interleave so one seed artist doesn't fill the whole list.
        for (let i = 0; groups.some(g => i < g.length); i++) groups.forEach(g => { if (g[i]) items.push(g[i]); });
        if (!items.length) {
          const chart = await dz('chart/0/tracks?limit=40');
          items = (chart.data || []).map(x => toTrack(x, ''));
        }
        const seen = new Set();
        items = items.filter(t => { const k = (t.artist + '|' + t.title).toLowerCase(); if (!t.title || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 80);
        res.json({ items, seeds });
      } catch (e) {
        res.status(502).json({ error: 'Couldn’t reach the music catalog for suggestions. Try again later.' });
      }
    });
  }
  return { routes };
};
