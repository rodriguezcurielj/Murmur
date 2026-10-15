// "Discover": new song suggestions from artists similar to the ones you listen to.
// Uses Deezer's public catalog API (free, no key): search artist -> related artists -> their top songs.
// Answers are cached for a day to stay well inside Deezer's rate limit.
const CACHE_MS = 24 * 3600e3;
const fs = require('fs');
const path = require('path');

// Deezer's genre names, made friendlier. Anything not listed keeps Deezer's name.
const GENRE_LABEL = { 'Rap/Hip Hop': 'Hip-Hop', 'Latin Music': 'Latin', 'Traditional Mexicano': 'Regional Mexican', 'Electro': 'Electronic',
  'Films/Games': 'Soundtrack', 'African Music': 'African', 'Asian Music': 'Asian', 'Brazilian Music': 'Brazilian', 'Indian Music': 'Indian' };
const label = name => GENRE_LABEL[name] || name;

module.exports = function createDiscover(dataDir) {
  const cache = new Map();
  // Song genres found so far ("artist|title" -> genre, or '' when Deezer has none), shared by everyone and kept across restarts.
  const genreFile = dataDir ? path.join(dataDir, 'genres.json') : null;
  let songGenres = {};
  try { songGenres = JSON.parse(fs.readFileSync(genreFile, 'utf8')); } catch { songGenres = {}; }
  let genreSave = null;
  const saveGenres = () => {
    if (!genreFile || genreSave) return;
    genreSave = setTimeout(() => {
      genreSave = null;
      fs.promises.writeFile(genreFile + '.tmp', JSON.stringify(songGenres)).then(() => fs.promises.rename(genreFile + '.tmp', genreFile))
        .catch(err => console.error('Could not save genres.json:', err));
    }, 2000);
  };

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
  // An album's main genre, or '' if Deezer doesn't say.
  async function albumGenre(id) {
    const a = await dz('album/' + id).catch(() => null);
    const g = a && a.genres && a.genres.data && a.genres.data[0];
    return g ? label(g.name) : '';
  }
  // Guess a song's genre from its album on Deezer; if that album has none, from the artist's other albums.
  async function guessGenre(artist, title) {
    const k = norm(artist) + '|' + norm(title);
    if (k in songGenres) return songGenres[k];
    const found = await dz('search?limit=5&q=' + encodeURIComponent(`${artist} ${title}`.toLowerCase()));
    const hits = (found.data || []).filter(t => t.album && t.artist);
    const same = hits.filter(t => norm(t.artist.name) === norm(artist));
    let g = '';
    for (const t of (same.length ? same : hits).slice(0, 3)) { g = await albumGenre(t.album.id); if (g) break; }
    if (!g && (same[0] || hits[0])) {
      const top = await dz(`artist/${(same[0] || hits[0]).artist.id}/top?limit=5`).catch(() => ({ data: [] }));
      for (const t of (top.data || []).slice(0, 3)) { if (t.album) { g = await albumGenre(t.album.id); if (g) break; } }
    }
    songGenres[k] = g; saveGenres();
    return g;
  }
  // Fresh songs in one genre: artists similar to the person's own favourites in it and to the genre's
  // current chart-toppers, topped up from the genre chart itself.
  async function genreSuggestions(name, seeds, exclude, want = 40) {
    const genres = (await dz('genre')).data || [];
    const simple = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const g = genres.find(x => x.id !== 0 && (simple(label(x.name)) === simple(name) || simple(x.name) === simple(name)));
    if (!g) return (await freshSuggestions(seeds, exclude, want, ['search?limit=50&q=' + encodeURIComponent(name.toLowerCase())])).map(t => ({ ...t, genre: name }));
    const chart = ((await dz(`chart/${g.id}/tracks?limit=100`).catch(() => ({ data: [] }))).data || []);
    const charted = shuffle([...new Set(chart.map(t => t.artist && t.artist.name).filter(Boolean))]).slice(0, Math.max(2, 5 - seeds.length));
    const items = await freshSuggestions([...seeds.slice(0, 3), ...charted], exclude, want, [`chart/${g.id}/tracks?limit=100`]);
    return items.map(t => ({ ...t, genre: label(g.name) }));
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

  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9|]+/g, '');
  const keyOf = t => norm(t.artist + '|' + t.title);
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  async function freshSuggestions(seeds, exclude, want = 40, fallback = ['chart/0/tracks?limit=100', 'chart/116/tracks?limit=50', 'chart/132/tracks?limit=50', 'chart/165/tracks?limit=50']) {
    const known = new Set(seeds.map(s => s.toLowerCase()));
    const groups = [];
    for (const name of seeds) {
      const found = await dz('search/artist?limit=1&q=' + encodeURIComponent(name));
      const a = found.data && found.data[0];
      if (!a) continue;
      // A random handful of up to 20 similar artists, and a few of their top 10 songs each.
      const related = shuffle(((await dz(`artist/${a.id}/related?limit=20`)).data || []).filter(r => !known.has(r.name.toLowerCase()))).slice(0, 6);
      related.forEach(r => known.add(r.name.toLowerCase()));
      const tops = await Promise.all(related.map(r => dz(`artist/${r.id}/top?limit=10`).catch(() => ({ data: [] }))));
      groups.push(shuffle(tops.flatMap(t => shuffle((t.data || []).map(x => toTrack(x, a.name)).filter(x => !exclude.has(keyOf(x)))).slice(0, 3))));   // mixed, so one artist doesn't play back to back
    }
    let items = [];
    // Interleave so one seed artist doesn't fill the whole list.
    for (let i = 0; groups.some(g => i < g.length); i++) groups.forEach(g => { if (g[i]) items.push(g[i]); });
    // Not enough (or nothing liked yet): top songs right now, overall and in a few genres.
    if (items.length < want) {
      const charts = await Promise.all(fallback.map(p => dz(p).catch(() => ({ data: [] }))));
      items.push(...shuffle(charts.flatMap(c => (c.data || []).map(x => toTrack(x, '')))));
    }
    const seen = new Set();
    return items.filter(t => { const k = keyOf(t); if (!t.title || seen.has(k) || exclude.has(k)) return false; seen.add(k); return true; }).slice(0, want);
  }

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

    // Suggestions. POST { artists: [...], exclude: ["artist|title", ...] } skips songs the person already saw
    // or removed and reaches further into similar artists, so "Get new suggestions" always finds new ones.
    app.post('/api/discover', async (req, res) => {
      const b = req.body || {};
      const seeds = (Array.isArray(b.artists) ? b.artists : []).map(s => String(s).trim()).filter(Boolean).slice(0, 5);
      const exclude = new Set((Array.isArray(b.exclude) ? b.exclude : []).slice(0, 5000).map(k => norm(k)));
      const genre = String(b.genre || '').trim().slice(0, 40);
      try { res.json({ items: genre ? await genreSuggestions(genre, seeds, exclude) : await freshSuggestions(seeds, exclude), seeds, genre }); }
      catch (e) { res.status(502).json({ error: 'Couldn’t reach the music catalog for suggestions. Try again later.' }); }
    });

    // Genre guesses for songs. POST { items: [{ artist, title }] } -> { genres: { "artist|title": "Hip-Hop" or "" } }.
    // A few at a time so Deezer's rate limit is never hit; songs looked up before answer straight away.
    app.post('/api/genres', async (req, res) => {
      const items = (Array.isArray(req.body && req.body.items) ? req.body.items : []).slice(0, 60)
        .map(x => ({ artist: String((x && x.artist) || '').trim().slice(0, 200), title: String((x && x.title) || '').trim().slice(0, 200) }))
        .filter(x => x.artist && x.title);
      const genres = {};
      let i = 0;
      const worker = async () => {
        while (i < items.length) {
          const x = items[i++];
          try { genres[x.artist + '|' + x.title] = await guessGenre(x.artist, x.title); } catch { /* try again another time */ }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      res.json({ genres });
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
