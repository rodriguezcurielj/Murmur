// Download sources: places Murmur can legally get a song's file from, with the rights to keep it.
// Each source is a file in sources/ (see sources/README.md for how to add one, including paid services).
// People search the sources from a song's ⋯ menu ("Find a downloadable copy") or from Search; picking a
// result downloads it on the server and adds it to Murmur like an upload, linked to the song it replaces.
//
// Keys: the owner's key for a source is the shared one. Everyone can also add their own key (their own
// account with that service), which is used for them instead. A paid source's shared key is only used for
// the owner unless the owner turns on sharing, so nobody buys songs on someone else's account.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

module.exports = function createSources(dataDir, auth, opts) {
  const dir = path.join(__dirname, 'sources');
  const providers = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('_')).map(f => require(path.join(dir, f)))
    .filter(p => p && p.id && typeof p.search === 'function' && typeof p.download === 'function');
  const byId = id => providers.find(p => p.id === id);

  // Settings: which sources are on, and their keys. Sources that need no key start switched on.
  const file = path.join(dataDir, 'sources.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cfg = {}; }
  const save = () => fsp.writeFile(file + '.tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 }).then(() => fsp.rename(file + '.tmp', file)).catch(err => console.error('Could not save sources.json:', err));
  // cfg = { <source>: { enabled, key, shareKey }, users: { <person id>: { <source>: { key, off } } } }
  const conf = p => ({ enabled: !p.key, ...(cfg[p.id] || {}) });
  const mine = (p, user) => ((cfg.users || {})[user.id] || {})[p.id] || {};
  const sharedFor = (p, user) => { const c = conf(p); return !!c.key && (!p.paid || user.role === 'owner' || !!c.shareKey); };
  // The settings a source runs with for this person: their own key first, then the shared one.
  const confFor = (p, user) => { const c = conf(p), m = mine(p, user); return { ...c, key: m.key || (sharedFor(p, user) ? c.key : '') }; };
  const ready = (p, user) => { const c = conf(p), m = mine(p, user); return !!c.enabled && !m.off && (!p.key || !!m.key || sharedFor(p, user)); };

  const describe = (p, user) => {
    const c = conf(p), m = mine(p, user), owner = user.role === 'owner';
    return { id: p.id, name: p.name, site: p.site, about: p.about, license: p.license, paid: !!p.paid, enabled: !!c.enabled, ready: ready(p, user),
      linkExample: typeof p.idFromLink === 'function' && Array.isArray(p.links) ? (p.linkExample || p.site) : '',
      needsKey: !!p.key, off: !!m.off, keyLabel: p.key && p.key.label, keyHelp: p.key && p.key.help, keyUrl: p.key && p.key.url,
      hasMyKey: !!m.key, sharedKey: sharedFor(p, user), ...(owner && p.key ? { hasKey: !!c.key, shareKey: !!c.shareKey } : {}) };
  };
  const checkKey = async (p, key) => { try { await p.search('love', { key }); } catch (e) { throw Object.assign(new Error(`${p.name} didn’t accept that key: ${e.message}`), { status: 400 }); } };

  // Download a source's file to a temporary file, with a size limit.
  async function fetchToTmp(url, headers) {
    const tmp = path.join(opts.tmpDir, 'src-' + crypto.randomBytes(6).toString('hex'));
    const r = await fetch(url, { headers: { 'User-Agent': 'Murmur', ...(headers || {}) }, redirect: 'follow' });
    if (!r.ok || !r.body) throw Object.assign(new Error(`The source didn’t hand over the file (error ${r.status}).`), { status: 502 });
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > opts.maxBytes) throw Object.assign(new Error('That file is bigger than the upload limit.'), { status: 413 });
    let seen = 0;
    const limit = async function* (src) { for await (const chunk of src) { seen += chunk.length; if (seen > opts.maxBytes) throw new Error('too big'); yield chunk; } };
    try { await pipeline(Readable.fromWeb(r.body), limit, fs.createWriteStream(tmp)); }
    catch (e) { await fsp.rm(tmp, { force: true }); throw Object.assign(new Error(seen > opts.maxBytes ? 'That file is bigger than the upload limit.' : 'The download was interrupted. Try again.'), { status: 502 }); }
    return tmp;
  }

  // Download one item from a source and add it to Murmur (shared by search results and pasted links).
  async function addFromSource(p, id, user, matchKey) {
    let tmp = null;
    try {
      const got = await p.download(id, confFor(p, user));   // { url, headers?, filename, title, artist, album, cover, license, licenseUrl, page }
      tmp = await fetchToTmp(got.url, got.headers);
      const track = await opts.addFile(tmp, got.filename || 'download.mp3', user, {
        title: got.title, artist: got.artist, album: got.album || '', coverUrl: /^https:\/\//.test(got.cover || '') ? got.cover : '',
        source: { id: p.id, name: p.name, item: id, license: got.license || p.license || '', licenseUrl: got.licenseUrl || '', page: got.page || '' }
      });
      tmp = null;
      if (matchKey) await opts.linkToSong(String(matchKey), track.id, user);
      return track;
    } catch (e) {
      if (tmp) await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  function routes(app) {
    app.get('/api/sources', (req, res) => res.json({ sources: providers.map(p => describe(p, req.user)) }));

    // Anyone: their own key for a source, and whether they use it at all. { key?: '' removes it, off?: bool }
    app.put('/api/sources/:id/mine', async (req, res) => {
      const p = byId(req.params.id); if (!p) return res.status(404).json({ error: 'No such source.' });
      const b = req.body || {};
      const users = cfg.users = cfg.users || {}, me = users[req.user.id] = users[req.user.id] || {}, m = me[p.id] = { ...(me[p.id] || {}) };
      try {
        if (p.key && typeof b.key === 'string') { const key = b.key.trim(); if (key) { await checkKey(p, key); m.key = key; m.off = false; } else delete m.key; }
      } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
      if (typeof b.off === 'boolean') m.off = b.off;
      await save();
      res.json({ source: describe(p, req.user) });
    });

    // Owner: switch a source on or off, and save its key (checked with a test search first).
    app.put('/api/sources/:id', auth.requireOwner, async (req, res) => {
      const p = byId(req.params.id); if (!p) return res.status(404).json({ error: 'No such source.' });
      const b = req.body || {}, c = { ...conf(p) };
      if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
      if (typeof b.shareKey === 'boolean') c.shareKey = b.shareKey;
      if (p.key && typeof b.key === 'string') {
        const key = b.key.trim();
        if (key) {
          try { await checkKey(p, key); } catch (e) { return res.status(400).json({ error: e.message }); }
          c.key = key; c.enabled = true;
        } else delete c.key;
      }
      cfg[p.id] = c; await save();
      res.json({ source: describe(p, req.user) });
    });

    // Search every source that's switched on. Results from a source that fails are skipped (and reported).
    app.get('/api/sources/search', async (req, res) => {
      const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!q) return res.json({ items: [], errors: [] });
      const on = providers.filter(p => ready(p, req.user));
      const results = await Promise.allSettled(on.map(p => Promise.race([p.search(q, confFor(p, req.user)), new Promise((_, no) => setTimeout(() => no(new Error('took too long')), 12000))])));
      const items = [], errors = [];
      results.forEach((r, i) => {
        const p = on[i];
        if (r.status === 'fulfilled') (r.value || []).slice(0, 15).forEach(x => items.push({ ...x, provider: p.id, providerName: p.name, paid: !!p.paid }));
        else errors.push(`${p.name}: ${r.reason && r.reason.message}`);
      });
      res.json({ items, errors, sources: on.length });
    });

    // Get a result's file and add it to Murmur. With "matchKey", it becomes how that imported/catalog song plays.
    app.post('/api/sources/add', auth.requireEdit, async (req, res) => {
      const b = req.body || {}, p = byId(b.provider);
      if (!p || !ready(p, req.user)) return res.status(400).json({ error: 'That source isn’t switched on for you.' });
      try { res.json({ track: await addFromSource(p, String(b.id || ''), req.user, b.matchKey) }); }
      catch (e) { res.status(e.status || 502).json({ error: e.message || 'Couldn’t get that file.' }); }
    });

    // Paste a link: the source that handles that site turns it into a track, then it's added like any result.
    app.post('/api/sources/link', auth.requireEdit, async (req, res) => {
      const link = String((req.body && req.body.link) || '').trim().slice(0, 500);
      let u; try { u = new URL(link); } catch { return res.status(400).json({ error: 'That isn’t a link. Copy the song’s address from the site and paste it here.' }); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return res.status(400).json({ error: 'That isn’t a web link.' });
      const p = providers.find(x => typeof x.idFromLink === 'function' && (x.links || []).some(re => re.test(link)));
      if (!p) return res.status(400).json({ error: `None of the download sources can open links from ${u.hostname}.` });
      if (!ready(p, req.user)) return res.status(400).json({ error: `${p.name} isn’t switched on for you. Turn it on in My download sources.` });
      // A paid source buys the song: only after the person confirmed it.
      if (p.paid && !(req.body && req.body.confirmPaid)) return res.status(409).json({ confirm: true, source: p.name, error: `This link is from ${p.name}, a paid source. Getting it buys the song on your account.` });
      try {
        const id = await p.idFromLink(link, confFor(p, req.user));
        if (!id) return res.status(404).json({ error: `${p.name} couldn’t find a song at that link.` });
        res.json({ track: await addFromSource(p, String(id), req.user, req.body.matchKey), source: p.name });
      } catch (e) { res.status(e.status || 502).json({ error: e.message || 'Couldn’t get that file.' }); }
    });
  }

  // Settings travel with server-to-server sync.
  const syncCollection = {
    get: () => ({ ...cfg }),
    set: o => { for (const k of Object.keys(cfg)) delete cfg[k]; Object.assign(cfg, o); save(); }
  };

  // When a person is deleted, their keys go too.
  function removeUser(id) { if (cfg.users && cfg.users[id]) { delete cfg.users[id]; save(); } }

  return { routes, syncCollection, removeUser };
};
