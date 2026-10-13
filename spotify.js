// Spotify import: each person's imported playlists (song lists only, no audio), plus a shared
// table that remembers how each song is played in Murmur (an uploaded file or a YouTube video).
// The Spotify sign-in itself happens in the browser (PKCE), so no Spotify secret is stored here.
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
    app.get('/api/settings/public', (req, res) => res.json({ spotifyClientId: cfg.clientId || '' }));

    app.put('/api/settings/spotify', auth.requireOwner, async (req, res) => {
      const id = str(req.body && req.body.clientId, 64).trim();
      if (!/^[0-9a-f]{32}$/i.test(id)) return res.status(400).json({ error: 'That doesn’t look like a Spotify Client ID. It’s a 32-character code from your app’s Settings page.' });
      cfg.clientId = id; await save('cfg', cfg);
      res.json({ spotifyClientId: id });
    });
    app.delete('/api/settings/spotify', auth.requireOwner, async (req, res) => {
      delete cfg.clientId; await save('cfg', cfg);
      res.json({ spotifyClientId: '' });
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
        } else delete m.yt;
      }
      if (b.none) { m.none = true; delete m.yt; }
      m.by = req.user.name; m.at = Date.now();
      matches[key] = m;
      await save('matches', matches);
      res.json({ match: m });
    });
  }
  return { routes };
};
