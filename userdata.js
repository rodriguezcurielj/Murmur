// Each person's own library: liked songs, playlists, recently played and what they listen to.
// It lives on the server, so it follows the person to every device and stays separate from
// everyone else's. The owner can open anyone's library read-only (admin view).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// What the player may store per person, and the shape each value must have.
const KEYS = {
  liked: 'array', playlists: 'array', recent: 'array', plays: 'object',
  hidden: 'array', hiddenCols: 'array', ytTracks: 'array', ytRecent: 'array', spTracks: 'array', genres: 'object',
  history: 'array', home: 'object',   // songs played lately; how Home is set up
  stations: 'array',   // saved radio stations
  names: 'object',     // your own title and artist for songs
  recentSearches: 'array', recentSearchSongs: 'array',   // the Search page's recent searches, on every device
  prefs: 'object'      // settings: theme, equalizer, playback, shuffle/repeat, sorting
};
const MAX_BYTES = 4 * 1024 * 1024;   // per value; a very large library still fits easily

module.exports = function createUserData(dir, auth, opts = {}) {
  const file = path.join(dir, 'userdata.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { all = {}; }
  let queue = Promise.resolve();
  function save() {
    const data = JSON.stringify(all);
    queue = queue
      .then(async () => { await fsp.writeFile(file + '.tmp', data); await fsp.rename(file + '.tmp', file); })
      .catch(err => console.error('Could not save userdata.json:', err));
    return queue;
  }
  const shapeOk = (k, v) => KEYS[k] === 'array' ? Array.isArray(v) : (v && typeof v === 'object' && !Array.isArray(v));

  function routes(app) {
    // Your own library. "data" is null until this account saves anything for the first time.
    app.get('/api/me/data', (req, res) => res.json({ data: all[req.user.id] || null }));
    // When the library last changed, so devices can check often without downloading all of it.
    app.get('/api/me/data/version', (req, res) => res.json({ updatedAt: (all[req.user.id] && all[req.user.id].updatedAt) || 0 }));

    // Save parts of your library: { data: { liked: [...], playlists: [...] } }. Keys left out are kept.
    app.put('/api/me/data', async (req, res) => {
      const b = (req.body && req.body.data) || {};
      const doc = all[req.user.id] = all[req.user.id] || {};
      for (const [k, v] of Object.entries(b)) {
        if (!KEYS[k]) continue;
        if (!shapeOk(k, v)) return res.status(400).json({ error: `“${k}” isn’t in the right format.` });
        if (JSON.stringify(v).length > MAX_BYTES) return res.status(413).json({ error: 'Your library is too big to save.' });
        doc[k] = v;
      }
      doc.updatedAt = Date.now();
      await save();
      res.json({ ok: true, updatedAt: doc.updatedAt });
    });

    // Admin view: the owner can look at anyone's library and Spotify imports, read-only.
    app.get('/api/admin/library/:id', auth.requireOwner, (req, res) => {
      const id = String(req.params.id);
      res.json({ data: all[id] || {}, imports: opts.importsFor ? opts.importsFor(id) : [] });
    });
  }

  // When a person is deleted, their library goes with them.
  function removeUser(id) { if (all[id]) { delete all[id]; save(); } }

  // For server-to-server sync: one record per person per part of their library ("<id>/liked", "<id>/playlists", ...).
  const syncCollection = {
    get: () => { const o = {}; for (const [uid, doc] of Object.entries(all)) for (const [k, v] of Object.entries(doc)) o[uid + '/' + k] = v; return o; },
    set: o => {
      const next = {}; for (const [id, v] of Object.entries(o)) { const i = id.indexOf('/'); (next[id.slice(0, i)] = next[id.slice(0, i)] || {})[id.slice(i + 1)] = v; }
      // A library that changed through sync gets a new time, so devices on this server notice and fetch it.
      // (A change to the time alone doesn't count, or two servers would keep bumping each other.)
      const body = d => JSON.stringify(Object.entries(d || {}).filter(([k]) => k !== 'updatedAt').sort(([a], [b]) => a < b ? -1 : 1));
      for (const [uid, doc] of Object.entries(next)) if (body(doc) !== body(all[uid])) doc.updatedAt = Math.max(Date.now(), (doc.updatedAt || 0) + 1);
      all = next; save();
    }
  };

  return { routes, removeUser, syncCollection };
};
