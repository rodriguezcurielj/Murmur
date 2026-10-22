// YouTube search through the official YouTube Data API v3.
// The API key is entered by the owner in the app and stored in DATA_DIR/settings.json,
// so it never ships to browsers or GitHub. Results are cached to stay inside the free
// daily quota (a search costs 100 of the 10,000 daily units).
const fs = require('fs');
const { spawn } = require('child_process');
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

  /* How much of today's free YouTube allowance this server has used (10,000 units a day, reset at midnight
     Pacific time; a search costs 100, looking up its videos 1). Lets the player say how many songs it can get now.
     Other servers using the same key also spend it, so this is an estimate; a "limit used up" answer sets it to 0. */
  const DAILY_UNITS = 10000, SEARCH_UNITS = 101;
  const usageFile = path.join(path.dirname(file), 'youtube-usage.json');
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  // Several keys can be added: when one key's searches for the day are used up, the next one is used.
  const keys = () => [settings.youtubeKey, ...(Array.isArray(settings.youtubeKeys) ? settings.youtubeKeys : [])].filter((k, i, a) => k && a.indexOf(k) === i);
  const tail = k => String(k).slice(-4);
  let usage = { day: today(), byKey: {} };   // byKey: last 4 characters of a key -> units used today
  try { const u = JSON.parse(fs.readFileSync(usageFile, 'utf8')); if (u && u.day === today() && u.byKey) usage = u; } catch { /* first run */ }
  function spend(key, units) {
    if (usage.day !== today()) usage = { day: today(), byKey: {} };
    usage.byKey[tail(key)] = Math.min(DAILY_UNITS, (usage.byKey[tail(key)] || 0) + units);
    fsp.writeFile(usageFile, JSON.stringify(usage)).catch(() => {});
  }
  const leftFor = key => usage.day !== today() ? Math.floor(DAILY_UNITS / SEARCH_UNITS) : Math.max(0, Math.floor((DAILY_UNITS - (usage.byKey[tail(key)] || 0)) / SEARCH_UNITS));
  const searchesLeft = () => keys().reduce((a, k) => a + leftFor(k), 0);

  async function call(path, params, key) {
    const url = `${API}/${path}?${new URLSearchParams({ ...params, key })}`;
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (res.ok) spend(key, path === 'search' ? 100 : 1);
    if (!res.ok) {
      const reason = body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason;
      // Google reports the daily search limit as quotaExceeded or (newer) rateLimitExceeded "Search Queries per day".
      const daily = reason === 'quotaExceeded' || (reason === 'rateLimitExceeded' && /per day/i.test((body.error && body.error.message) || ''));
      if (daily) spend(key, DAILY_UNITS);
      const msg = daily ? 'YouTube’s free daily limit is used up. Suggestions come back tomorrow.'
        : reason === 'keyInvalid' || res.status === 400 ? 'YouTube didn’t accept that API key.'
        : reason === 'accessNotConfigured' ? 'The YouTube Data API isn’t turned on for that key’s Google Cloud project.'
        : (body.error && body.error.message) || `YouTube answered ${res.status}.`;
      const err = new Error(msg); err.status = daily ? 429 : 502; err.daily = daily; throw err;
    }
    return body;
  }

  /* Searching with yt-dlp instead of the API: no daily limit, a few seconds slower, used once the API's daily
     searches run out (on servers that have yt-dlp, which all Murmur servers do). Two at a time at most. */
  let ytdlp = null;   // null = not checked yet
  const hasYtdlp = () => ytdlp !== null ? Promise.resolve(ytdlp) : new Promise(ok => {
    const p = spawn('yt-dlp', ['--version']); p.on('error', () => ok(ytdlp = false)); p.on('close', c => ok(ytdlp = c === 0));
  });
  hasYtdlp();
  let running = 0; const waiting = [];
  async function ytdlpSearch(q) {
    if (running >= 2) await new Promise(ok => waiting.push(ok));
    running++;
    try {
      const out = await new Promise((ok, no) => {
        const p = spawn('yt-dlp', ['--flat-playlist', '-J', '--no-warnings', 'ytsearch15:' + q]);
        let d = ''; const t = setTimeout(() => p.kill(), 30e3);
        p.stdout.on('data', c => { d += c; }); p.on('error', no);
        p.on('close', c => { clearTimeout(t); c === 0 ? ok(d) : no(new Error('yt-dlp search failed (' + c + ')')); });
      });
      return (JSON.parse(out).entries || []).filter(e => e && e.id && e.ie_key !== 'YoutubeTab').map(e => ({
        id: e.id,
        title: String(e.title || ''),
        channel: String(e.channel || e.uploader || '').replace(/\s+-\s+Topic$/, ''),
        thumb: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
        duration: Math.round(e.duration || 0)
      })).filter(x => x.duration > 30 && x.duration < 20 * 60);
    } finally { running--; const n = waiting.shift(); if (n) n(); }
  }

  /* YouTube's own web search (what youtube.com uses): no daily limit and about half a second, much faster than
     starting yt-dlp. Its answer format can change, so yt-dlp stays as the next fallback. */
  async function webSearch(q) {
    const r = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en-US' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250925.01.00', hl: 'en', gl: 'US' } }, query: q, params: 'EgIQAQ%3D%3D' }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('YouTube web search answered ' + r.status);
    const found = [];
    const walk = o => { if (!o || typeof o !== 'object') return; if (o.videoRenderer) { found.push(o.videoRenderer); return; } for (const k in o) walk(o[k]); };
    walk((await r.json()).contents);
    const secs = t => String(t || '').split(':').reduce((a, b) => a * 60 + (+b || 0), 0);
    const items = found.filter(v => v.videoId).map(v => ({
      id: v.videoId,
      title: ((v.title && v.title.runs) || []).map(x => x.text).join(''),
      channel: String((((v.ownerText || v.longBylineText || {}).runs) || [{}])[0].text || '').replace(/\s+-\s+Topic$/, ''),
      thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      duration: secs(v.lengthText && v.lengthText.simpleText)
    })).filter(x => x.duration > 30 && x.duration < 20 * 60);
    if (!items.length) throw new Error('YouTube web search found nothing');
    return items;
  }

  async function search(q, key) {
    const hit = cache.get(q);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
    // Daily API searches used up: YouTube's web search, then yt-dlp. Also when the API says it's used up mid-way.
    const fallback = async e => {
      let items;
      try { items = await webSearch(q); }
      catch (we) { if (!(await hasYtdlp())) throw e || we; items = await ytdlpSearch(q); }
      cache.set(q, { at: Date.now(), items }); saveCache();
      return items;
    };
    // Each key with searches left today, in order; a used-up (or broken) key moves on to the next.
    let last = null;
    for (const k of keys()) {
      if (!leftFor(k)) continue;
      try { return await apiSearch(q, k); }
      catch (e) { last = e; if (!e.daily) { console.log(`YouTube key …${tail(k)}: ${e.message}`); if (e.status === 400 || /accept|turned on/i.test(e.message)) spend(k, DAILY_UNITS); } }   // a rejected key rests until tomorrow
    }
    return fallback(last);
  }
  async function apiSearch(q, key) {
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
    if (!items.length) return webSearch(q);   // the API's music-only filters found nothing: ask like youtube.com does
    cache.set(q, { at: Date.now(), items }); saveCache();
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return items;
  }
  /* Picking a song by hand: everything YouTube has for those words (any channel or category, explicit too), like
     searching on youtube.com, plus the regular results after them. Costs no daily quota when the web search works. */
  async function wideSearch(q, key) {
    const hit = cache.get('w:' + q);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
    let items = [];
    try { items = await webSearch(q); } catch (e) { /* try the others */ }
    if (items.length < 8) { try { items = [...items, ...(await search(q, key))]; } catch (e) { if (!items.length && (await hasYtdlp())) items = await ytdlpSearch(q); } }
    items = items.filter((x, i, a) => a.findIndex(y => y.id === x.id) === i);
    if (items.length) { cache.set('w:' + q, { at: Date.now(), items }); saveCache(); }
    return items;
  }

  // For server-to-server sync: the YouTube key and other settings.
  const syncCollection = {
    get: () => (Object.keys(settings).length ? { settings: { ...settings } } : {}),
    set: o => { settings = { ...(o.settings || {}) }; save().catch(err => console.error('Could not save settings.json:', err)); }
  };

  function routes(app) {
    // unlimited: after the API searches run out, YouTube's web search / yt-dlp take over. The owner also sees each key.
    app.get('/api/youtube/status', (req, res) => res.json({ enabled: keys().length > 0, searchesLeft: searchesLeft(), unlimited: true,
      ...(req.user && req.user.role === 'owner' ? { keys: keys().map(k => ({ tail: tail(k), left: leftFor(k) })) } : {}) }));

    app.get('/api/youtube/search', async (req, res) => {
      if (!keys().length && req.query.wide !== '1') return res.status(501).json({ error: 'YouTube isn’t connected yet. The owner can add an API key under People & settings.' });
      const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!q) return res.status(400).json({ error: 'Type something to search for.' });
      try {
        const items = req.query.wide === '1' ? await wideSearch(q.toLowerCase(), settings.youtubeKey) : await search(q.toLowerCase(), settings.youtubeKey);
        res.json({ items });
        // ?prep=2: the player is about to play one of the first results; start getting their audio now.
        const n = Math.min(3, +req.query.prep || 0);
        if (n && req.app.locals.ytAudio) req.app.locals.ytAudio.prep(items.slice(0, n).map(x => x.id));
      }
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
      // The first key, or one more to move on to when the others' searches are used up.
      if (!settings.youtubeKey) settings.youtubeKey = key;
      else if (!keys().includes(key)) settings.youtubeKeys = [...(Array.isArray(settings.youtubeKeys) ? settings.youtubeKeys : []), key];
      await save();
      console.log('YouTube key added (' + keys().length + ' in all)');
      res.json({ enabled: true, keys: keys().length });
    });

    // ?k=<last 4 characters> removes that key; without it, all keys.
    app.delete('/api/settings/youtube', auth.requireOwner, async (req, res) => {
      const k = String(req.query.k || '');
      const left = k ? keys().filter(x => tail(x) !== k) : [];
      settings.youtubeKey = left[0]; settings.youtubeKeys = left.slice(1);
      if (!settings.youtubeKey) delete settings.youtubeKey;
      if (!settings.youtubeKeys.length) delete settings.youtubeKeys;
      await save();
      res.json({ enabled: left.length > 0 });
    });
  }
  return { syncCollection, routes };
};
