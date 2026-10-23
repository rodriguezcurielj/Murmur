// Spotify import: each person's imported playlists (song lists only, no audio), plus a shared
// table that remembers how each song is played in Murmur (an uploaded file or a YouTube video).
// Anyone can import a public playlist or album by pasting its link: no Spotify sign-in and no developer
// setup. Murmur reads the song list from Spotify's public embed page (up to 100 songs). If the owner adds
// their Spotify app's Client ID and Secret, links use Spotify's Web API instead and get every song.
// The older "sign in to Spotify" import still happens in the browser (PKCE).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

module.exports = function createSpotify(dir, auth, opts = {}) {
  const files = { cfg: path.join(dir, 'spotify.json'), imports: path.join(dir, 'imports.json'), matches: path.join(dir, 'matches.json') };
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const cfg = read(files.cfg, {}), imports = read(files.imports, {}), matches = read(files.matches, {});
  const queues = {};
  function save(name, data) {
    const f = files[name];
    queues[name] = (queues[name] || Promise.resolve())
      .then(async () => { await fsp.writeFile(f + '.tmp', JSON.stringify(data)); await fsp.rename(f + '.tmp', f); })
      .catch(err => console.error(`Could not save ${path.basename(f)}:`, err));
    return queues[name];
  }
  const str = (v, max = 300) => String(v == null ? '' : v).slice(0, max);
  const canEdit = u => u.role === 'owner' || !!u.canEdit;
  // A plain user agent gets Spotify's server-rendered pages, which include the song count.
  const UA = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' };

  // Playlist or album link (also spotify: URIs and spotify.link short links) -> { kind, id }.
  async function parseLink(link) {
    link = str(link, 500).trim();
    let m = link.match(/^spotify:(playlist|album):([A-Za-z0-9]{10,40})$/);
    if (m) return { kind: m[1], id: m[2] };
    if (/^https:\/\/(spotify\.link|spotify\.app\.link)\//.test(link)) {
      try { const r = await fetch(link, { headers: UA, redirect: 'follow' }); link = r.url; } catch { /* fall through */ }
    }
    m = link.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{10,40})/);
    return m ? { kind: m[1], id: m[2] } : null;
  }

  // Spotify Web API with the app's own key (Client Credentials). Only used when the owner added a secret.
  let appToken = null;
  async function apiGet(url) {
    if (!appToken || appToken.exp < Date.now()) {
      const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64') },
        body: 'grant_type=client_credentials' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new Error('Spotify didn’t accept the Client ID and Secret.');
      appToken = { value: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
    }
    const r = await fetch(url.startsWith('https:') ? url : 'https://api.spotify.com/v1/' + url, { headers: { Authorization: 'Bearer ' + appToken.value } });
    if (!r.ok) throw Object.assign(new Error('Spotify said ' + r.status), { status: r.status });
    return r.json();
  }
  const fromApiTrack = (tr, album) => {
    const al = tr.album || album || {}, imgs = al.images || [];
    return { title: tr.name, artist: (tr.artists || []).map(a => a.name).filter(Boolean).join(', '), album: al.name || '',
      cover: (imgs[1] || imgs[0] || {}).url || '', duration: Math.round((tr.duration_ms || 0) / 1000),
      isrc: (tr.external_ids && tr.external_ids.isrc) || '', url: (tr.external_urls && tr.external_urls.spotify) || '' };
  };
  async function viaApi({ kind, id }) {
    if (kind === 'album') {
      const a = await apiGet('albums/' + id);
      const tracks = []; let page = a.tracks;
      while (page) { tracks.push(...(page.items || []).map(t => fromApiTrack(t, a))); page = page.next && tracks.length < 10000 ? await apiGet(page.next) : null; }
      return { name: a.name, cover: ((a.images || [])[0] || {}).url || '', owner: (a.artists || []).map(x => x.name).join(', '), tracks, total: tracks.length };
    }
    const p = await apiGet('playlists/' + id + '?fields=name,images,owner(display_name),tracks(total)');
    const tracks = [];
    let url = 'playlists/' + id + '/tracks?limit=100&additional_types=track&fields=next,items(track(name,duration_ms,artists(name),album(name,images),external_ids,external_urls,type))';
    while (url && tracks.length < 10000) {
      const j = await apiGet(url);
      (j.items || []).forEach(it => { if (it && it.track && it.track.type === 'track' && it.track.name) tracks.push(fromApiTrack(it.track)); });
      url = j.next;
    }
    return { name: p.name, cover: ((p.images || [])[0] || {}).url || '', owner: p.owner && p.owner.display_name, tracks, total: (p.tracks && p.tracks.total) || tracks.length };
  }

  // No key needed: the public embed page has the first 100 songs.
  async function viaEmbed({ kind, id }) {
    const r = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: UA });
    if (r.status === 404) throw Object.assign(new Error('Spotify couldn’t find that. Check the link, and make sure the playlist is public.'), { status: 404 });
    if (!r.ok) throw new Error('Spotify didn’t answer (error ' + r.status + '). Try again in a minute.');
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    let e = null; try { e = JSON.parse(m[1]).props.pageProps.state.data.entity; } catch { e = null; }
    if (!e || !Array.isArray(e.trackList)) throw new Error('Spotify didn’t share that list. Make sure the playlist is public.');
    const cover = ((e.coverArt && e.coverArt.sources) || []).map(x => x.url).find(Boolean) || '';
    const tracks = e.trackList.filter(t => t && t.title).map(t => ({
      title: t.title, artist: t.subtitle || '', album: kind === 'album' ? e.name : '', cover: kind === 'album' ? cover : '',
      duration: Math.round((t.duration || 0) / 1000), isrc: '', url: /^spotify:track:/.test(t.uri || '') ? 'https://open.spotify.com/track/' + t.uri.split(':')[2] : '' }));
    // The embed stops at 100 songs; the playlist page says how many there really are.
    let total = tracks.length;
    if (tracks.length >= 100) {
      try {
        const page = await (await fetch(`https://open.spotify.com/${kind}/${id}`, { headers: UA })).text();
        const c = page.match(/music:song_count" content="(\d+)/); if (c) total = Math.max(total, Number(c[1]));
      } catch { /* unknown total */ }
    }
    return { name: e.name || e.title || 'Spotify ' + kind, cover, owner: kind === 'playlist' ? (e.subtitle || '') : (e.subtitle || ''), tracks, total };
  }

  // Profile link (open.spotify.com/user/<id> or spotify:user:<id>) -> user id.
  function parseProfile(link) {
    link = str(link, 500).trim();
    const m = link.match(/^spotify:user:([^\s:/?#]{1,64})$/) || link.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?user\/([^\s/?#]{1,64})/);
    return m ? { id: decodeURIComponent(m[1]) } : null;
  }
  async function profileViaApi({ id }) {
    const u = await apiGet('users/' + encodeURIComponent(id));
    const playlists = [];
    let url = 'users/' + encodeURIComponent(id) + '/playlists?limit=50';
    while (url && playlists.length < 1000) {
      const j = await apiGet(url);
      (j.items || []).filter(Boolean).forEach(p => playlists.push({ id: p.id, name: p.name, cover: ((p.images || [])[0] || {}).url || '',
        songs: (p.tracks && p.tracks.total) || (p.items && p.items.total) || 0 }));
      url = j.next;
    }
    return { name: u.display_name || id, playlists, total: playlists.length };
  }
  async function profileViaPage({ id }) {
    const r = await fetch('https://open.spotify.com/user/' + encodeURIComponent(id), { headers: UA });
    if (r.status === 404) throw Object.assign(new Error('Spotify couldn’t find that profile. Check the link.'), { status: 404 });
    if (!r.ok) throw new Error('Spotify didn’t answer (error ' + r.status + '). Try again in a minute.');
    const html = await r.text();
    const m = html.match(/<script[^>]*id="initialState"[^>]*>([\s\S]*?)<\/script>/);
    let user = null;
    try {
      const raw = m[1].trim(), state = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
      user = (state.entities && state.entities.items || {})['spotify:user:' + id] || Object.values(state.entities.items).find(x => x && x.publicPlaylistsV2);
    } catch { user = null; }
    if (!user) throw new Error('Spotify didn’t share that profile. Check the link and try again.');
    const pp = user.publicPlaylistsV2 || {};
    const playlists = (pp.items || []).map(w => w && w.data).filter(p => p && p.uri).map(p => ({
      id: String(p.uri).split(':').pop(), name: p.name || 'Playlist',
      cover: ((((p.images || {}).items || [])[0] || {}).sources || []).map(s => s.url).find(Boolean) || '', songs: 0 }));
    return { name: user.name || id, playlists, total: Math.max(pp.totalCount || 0, playlists.length) };
  }

  function cleanTrack(t) {
    return {
      key: str(t.key, 400), title: str(t.title), artist: str(t.artist), album: str(t.album),
      cover: /^https:\/\//.test(t.cover || '') ? str(t.cover, 500) : '',
      duration: Math.max(0, Math.min(36000, Number(t.duration) || 0)),
      isrc: str(t.isrc, 20), url: /^https:\/\/open\.spotify\.com\//.test(t.url || '') ? str(t.url, 200) : ''
    };
  }

  function routes(app) {
    // Settings everyone signed in can see.
    app.get('/api/settings/public', (req, res) => res.json({ spotifyClientId: cfg.clientId || '', spotifyFullLinks: !!(cfg.clientId && cfg.clientSecret) }));

    // Read a public Spotify playlist or album from its link (anyone signed in).
    app.post('/api/spotify/link', async (req, res) => {
      const ref = await parseLink(req.body && req.body.link);
      if (!ref) return res.status(400).json({ error: 'That isn’t a Spotify playlist or album link. In Spotify, tap ⋯ → Share → Copy link.' });
      try {
        let out = null;
        if (cfg.clientId && cfg.clientSecret) { try { out = await viaApi(ref); } catch (e) { out = null; } }
        if (!out) out = await viaEmbed(ref);
        if (!out.tracks.length) return res.status(404).json({ error: 'That list has no songs Murmur can read (podcasts and local files are skipped).' });
        res.json({ kind: ref.kind, spotifyId: ref.id, ...out, partial: out.total > out.tracks.length });
      } catch (e) {
        res.status(e.status === 404 ? 404 : 502).json({ error: e.message || 'Couldn’t read that from Spotify.' });
      }
    });

    // Someone's public playlists from their Spotify profile link (anyone signed in), so they can bring
    // them all over at once. With the app's key and secret Spotify lists every one; without it, the
    // profile page shows the first 10 and the total.
    app.post('/api/spotify/profile', async (req, res) => {
      const ref = parseProfile(req.body && req.body.link);
      if (!ref) return res.status(400).json({ error: 'That isn’t a Spotify profile link. In Spotify, open your profile, tap ⋯ → Share → Copy link to profile.' });
      try {
        let out = null;
        if (cfg.clientId && cfg.clientSecret) { try { out = await profileViaApi(ref); } catch (e) { out = null; } }
        if (!out) out = await profileViaPage(ref);
        if (!out.playlists.length) return res.status(404).json({ error: `${out.name || 'That person'} has no public playlists. In Spotify, open each playlist, tap ⋯ → Add to profile, then try again.` });
        res.json(out);
      } catch (e) {
        res.status(e.status === 404 ? 404 : 502).json({ error: e.message || 'Couldn’t read that profile from Spotify.' });
      }
    });

    app.put('/api/settings/spotify', auth.requireOwner, async (req, res) => {
      const id = str(req.body && req.body.clientId, 64).trim();
      if (!/^[0-9a-f]{32}$/i.test(id)) return res.status(400).json({ error: 'That doesn’t look like a Spotify Client ID. It’s a 32-character code from your app’s Settings page.' });
      const secret = str(req.body && req.body.clientSecret, 64).trim();
      if (secret && !/^[0-9a-f]{32}$/i.test(secret)) return res.status(400).json({ error: 'That doesn’t look like a Client Secret. It’s the 32-character code under “View client secret”.' });
      if (cfg.clientId !== id) appToken = null;
      cfg.clientId = id;
      if (secret) { cfg.clientSecret = secret; appToken = null; }
      if (cfg.clientSecret) {
        try { await apiGet('browse/new-releases?limit=1'); }
        catch (e) { if (secret) { delete cfg.clientSecret; appToken = null; await save('cfg', cfg); return res.status(400).json({ error: 'Spotify didn’t accept that Client ID and Secret together. Copy both again from the app’s Settings page.' }); } }
      }
      await save('cfg', cfg);
      res.json({ spotifyClientId: id, spotifyFullLinks: !!cfg.clientSecret });
    });
    app.delete('/api/settings/spotify', auth.requireOwner, async (req, res) => {
      delete cfg.clientId; delete cfg.clientSecret; appToken = null; await save('cfg', cfg);
      res.json({ spotifyClientId: '', spotifyFullLinks: false });
    });

    // Each person's imported playlists.
    app.get('/api/imports', (req, res) => res.json({ imports: imports[req.user.id] || [] }));

    app.put('/api/imports/:id', async (req, res) => {
      const b = req.body || {}, id = str(req.params.id, 80);
      if (!Array.isArray(b.tracks)) return res.status(400).json({ error: 'No songs were sent.' });
      if (b.tracks.length > 10000) return res.status(400).json({ error: 'That playlist is too big to import (over 10,000 songs).' });
      const imp = {
        id, spotifyId: str(b.spotifyId, 80), name: str(b.name, 200) || 'Spotify playlist',
        cover: /^https:\/\//.test(b.cover || '') ? str(b.cover, 500) : '', owner: str(b.owner, 120),
        importedAt: Date.now(), tracks: b.tracks.map(cleanTrack).filter(t => t.key && t.title)
      };
      const list = imports[req.user.id] = imports[req.user.id] || [];
      const i = list.findIndex(x => x.id === id);
      if (i >= 0) list[i] = imp; else list.unshift(imp);
      await save('imports', imports);
      res.json({ import: imp });
    });

    app.delete('/api/imports/:id', async (req, res) => {
      imports[req.user.id] = (imports[req.user.id] || []).filter(x => x.id !== req.params.id);
      await save('imports', imports);
      res.json({ ok: true });
    });

    // Shared: how each song is played. Key is the song's ISRC, or its artist + title.
    app.get('/api/matches', (req, res) => res.json({ matches }));

    app.put('/api/matches/:key', async (req, res) => {
      const key = str(req.params.key, 400), b = req.body || {};
      if (!key) return res.status(400).json({ error: 'Missing song key.' });
      const m = { ...(matches[key] || {}) };
      if (b.file !== undefined) {
        if (!canEdit(req.user)) return res.status(403).json({ error: 'Your account can’t add music to Murmur. Ask the owner to allow it.' });
        if (b.file && opts.hasFile && !opts.hasFile(b.file)) return res.status(400).json({ error: 'That file isn’t on the server.' });
        if (b.file) m.file = str(b.file, 40); else delete m.file;
      }
      if (b.yt !== undefined) {
        const y = b.yt;
        if (y && /^[\w-]{6,20}$/.test(y.id || '')) {
          m.yt = { id: y.id, title: str(y.title), channel: str(y.channel), thumb: /^https:\/\//.test(y.thumb || '') ? str(y.thumb, 500) : '', duration: Number(y.duration) || 0 };
          delete m.none;
          // A new version was picked: the Murmur copy of the old one stops standing in for it.
          if (b.version && m.file && !(opts.fileYtId && opts.fileYtId(m.file) === y.id)) delete m.file;
        } else delete m.yt;
      }
      if (b.none) { m.none = true; delete m.yt; }
      m.by = req.user.name; m.at = Date.now();
      matches[key] = m;
      await save('matches', matches);
      res.json({ match: m });
    });
  }
  // For server-to-server sync. These objects are shared with the routes above, so they're refilled in place.
  const refill = (target, o) => { for (const k of Object.keys(target)) delete target[k]; Object.assign(target, o); };
  const syncCollections = {
    imports: { get: () => ({ ...imports }), set: o => { refill(imports, o); save('imports', imports); } },
    matches: { get: () => ({ ...matches }), set: o => { refill(matches, o); save('matches', matches); } },
    spotifyApp: { get: () => (Object.keys(cfg).length ? { cfg: { ...cfg } } : {}), set: o => { refill(cfg, o.cfg || {}); appToken = null; save('cfg', cfg); } }
  };

  // A file added by a download source becomes how that song plays (like "Bring into Murmur").
  async function setFileMatch(key, fileId, user) {
    key = str(key, 400); if (!key) return;
    matches[key] = { ...(matches[key] || {}), file: str(fileId, 40), by: user.name, at: Date.now() };
    await save('matches', matches);
    return matches[key];
  }

  // The video picked for a song can't be downloaded (removed, private...): the song goes to "not found" so it can be picked again.
  async function setNotFound(key, user) {
    key = str(key, 400); if (!key || (matches[key] && matches[key].file)) return;
    matches[key] = { ...(matches[key] || {}), none: true, by: user.name, at: Date.now() };
    delete matches[key].yt;
    await save('matches', matches);
  }

  // Songs marked "not found" (for re-checking them), and giving one a YouTube match found later.
  const notFound = () => Object.keys(matches).filter(k => matches[k] && matches[k].none && !matches[k].file && !matches[k].yt);
  async function setFound(key, y, by) {
    if (!matches[key] || !matches[key].none) return;
    matches[key] = { ...matches[key], yt: { id: y.id, title: str(y.title), channel: str(y.channel), thumb: str(y.thumb, 500), duration: Number(y.duration) || 0 }, by, at: Date.now() };
    delete matches[key].none;
    await save('matches', matches);
  }

  return { routes, importsFor: id => imports[id] || [], syncCollections, setFileMatch, setNotFound, notFound, setFound };
};
