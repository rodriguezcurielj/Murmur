// YouTube search through the official YouTube Data API v3.
// The API key is entered by the owner in the app and stored in DATA_DIR/settings.json,
// so it never ships to browsers or GitHub. Results are cached to stay inside the free
// daily quota (a search costs 100 of the 10,000 daily units).
const fs = require('fs');
const fsp = fs.promises;

const path = require('path');

const API = 'https://www.googleapis.com/youtube/v3';
const CACHE_MS = 14 * 24 * 3600e3;   // a search is remembered for two weeks, for everyone
const MAX_CACHE = 3000;

module.exports = function createYouTube(file, auth) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { settings = {}; }
  const save = async () => { await fsp.writeFile(file + '.tmp', JSON.stringify(settings, null, 2), { mode: 0o600 }); await fsp.rename(file + '.tmp', file); };

  // The search memory is saved to disk so it survives restarts (each saved search is one less from the daily limit).
  const cacheFile = path.join(path.dirname(file), 'youtube-cache.json');
  const cache = new Map();
  try { for (const [q, v] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))) if (Date.now() - v.at < CACHE_MS) cache.set(q, v); } catch { /* first run */ }
  let cacheTimer = null;
  function saveCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      fsp.writeFile(cacheFile + '.tmp', JSON.stringify(Object.fromEntries(cache)))
        .then(() => fsp.rename(cacheFile + '.tmp', cacheFile))
        .catch(err => console.error('Could not save youtube-cache.json:', err));
    }, 2000);
  }

  // "PT4M13S" -> 253
  function seconds(iso = '') {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
    return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  }
  const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  async function call(path, params, key) {
    const url = `${API}/${path}?${new URLSearchParams({ ...params, key })}`;
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason;
      const msg = reason === 'quotaExceeded' ? 'YouTube’s free daily limit is used up. Suggestions come back tomorrow.'
        : reason === 'keyInvalid' || res.status === 400 ? 'YouTube didn’t accept that API key.'
        : reason === 'accessNotConfigured' ? 'The YouTube Data API isn’t turned on for that key’s Google Cloud project.'
        : (body.error && body.error.message) || `YouTube answered ${res.status}.`;
      const err = new Error(msg); err.status = reason === 'quotaExceeded' ? 429 : 502; throw err;
    }
    return body;
  }

  async function search(q, key) {
    const hit = cache.get(q);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
    const s = await call('search', { part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', videoSyndicated: 'true', safeSearch: 'moderate', maxResults: '20', q }, key);
    const ids = (s.items || []).map(i => i.id && i.id.videoId).filter(Boolean);
    let items = [];
    if (ids.length) {
      const v = await call('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') }, key);
      items = (v.items || []).filter(x => !x.status || x.status.embeddable !== false).map(x => ({
        id: x.id,
        title: decode(x.snippet.title),
        channel: decode(x.snippet.channelTitle).replace(/\s+-\s+Topic$/, ''),
        thumb: ((x.snippet.thumbnails || {}).high || (x.snippet.thumbnails || {}).medium || (x.snippet.thumbnails || {}).default || {}).url || '',
        duration: seconds(x.contentDetails && x.contentDetails.duration)
      })).filter(x => x.duration > 30 && x.duration < 20 * 60);   // skip shorts and hour-long mixes
    }
    cache.set(q, { at: Date.now(), items }); saveCache();
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return items;
  }

  // For server-to-server sync: the YouTube key and other settings.
  const syncCollection = {
    get: () => (Object.keys(settings).length ? { settings: { ...settings } } : {}),
    set: o => { settings = { ...(o.settings || {}) }; save().catch(err => console.error('Could not save settings.json:', err)); }
  };

  function routes(app) {
    app.get('/api/youtube/status', (req, res) => res.json({ enabled: !!settings.youtubeKey }));

    app.get('/api/youtube/search', async (req, res) => {
      if (!settings.youtubeKey) return res.status(501).json({ error: 'YouTube isn’t connected yet. The owner can add an API key under People & settings.' });
      const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!q) return res.status(400).json({ error: 'Type something to search for.' });
      try { res.json({ items: await search(q.toLowerCase(), settings.youtubeKey) }); }
      catch (e) { res.status(e.status || 502).json({ error: e.message }); }
    });

    // Search-as-you-type previews: YouTube's autocomplete phrases. Free, and doesn't use the API quota.
    const sugCache = new Map();
    app.get('/api/youtube/suggest', async (req, res) => {
      const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
      if (!q) return res.json({ items: [] });
      const hit = sugCache.get(q);
      if (hit && Date.now() - hit.at < 3600e3) return res.json({ items: hit.items });
      try {
        const r = await fetch('https://suggestqueries.google.com/complete/search?' + new URLSearchParams({ client: 'firefox', ds: 'yt', hl: 'en', q }), { signal: AbortSignal.timeout(3000) });
        const j = await r.json();
        const items = Array.isArray(j[1]) ? j[1].slice(0, 8).map(String) : [];
        sugCache.set(q, { at: Date.now(), items });
        if (sugCache.size > 500) sugCache.delete(sugCache.keys().next().value);
        res.json({ items });
      } catch { res.json({ items: [] }); }
    });

    app.put('/api/settings/youtube', auth.requireOwner, async (req, res) => {
      const key = String((req.body && req.body.key) || '').trim();
      if (!/^[\w-]{20,60}$/.test(key)) return res.status(400).json({ error: 'That doesn’t look like a YouTube API key. It should be one long code with no spaces.' });
      try { await call('search', { part: 'snippet', type: 'video', maxResults: '1', q: 'music' }, key); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      settings.youtubeKey = key; await save();
      console.log('YouTube connected');
      res.json({ enabled: true });
    });

    app.delete('/api/settings/youtube', auth.requireOwner, async (req, res) => {
      delete settings.youtubeKey; await save();
      res.json({ enabled: false });
    });
  }
  return { syncCollection, routes };
};
