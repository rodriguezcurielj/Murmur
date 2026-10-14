// Download sources: places Murmur can legally get a song's file from, with the rights to keep it.
// Each source is a file in sources/ (see sources/README.md for how to add one, including paid services).
// People search the sources from a song's ⋯ menu ("Find a downloadable copy") or from Search; picking a
// result downloads it on the server and adds it to Murmur like an upload, linked to the song it replaces.
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
  const conf = p => ({ enabled: !p.key, ...(cfg[p.id] || {}) });
  const ready = p => { const c = conf(p); return !!c.enabled && (!p.key || !!c.key); };

  const describe = (p, owner) => {
    const c = conf(p);
    return { id: p.id, name: p.name, site: p.site, about: p.about, license: p.license, paid: !!p.paid, enabled: !!c.enabled, ready: ready(p),
      needsKey: !!p.key, ...(owner && p.key ? { keyLabel: p.key.label, keyHelp: p.key.help, keyUrl: p.key.url, hasKey: !!c.key } : {}) };
  };

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

  function routes(app) {
    app.get('/api/sources', (req, res) => res.json({ sources: providers.map(p => describe(p, req.user.role === 'owner')) }));

    // Owner: switch a source on or off, and save its key (checked with a test search first).
    app.put('/api/sources/:id', auth.requireOwner, async (req, res) => {
      const p = byId(req.params.id); if (!p) return res.status(404).json({ error: 'No such source.' });
      const b = req.body || {}, c = { ...conf(p) };
      if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
      if (p.key && typeof b.key === 'string') {
        const key = b.key.trim();
        if (key) {
          try { await p.search('love', { key }); }
          catch (e) { return res.status(400).json({ error: `${p.name} didn’t accept that key: ${e.message}` }); }
          c.key = key; c.enabled = true;
        } else delete c.key;
      }
      cfg[p.id] = c; await save();
      res.json({ source: describe(p, true) });
    });

    // Search every source that's switched on. Results from a source that fails are skipped (and reported).
    app.get('/api/sources/search', async (req, res) => {
      const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!q) return res.json({ items: [], errors: [] });
      const on = providers.filter(ready);
      const results = await Promise.allSettled(on.map(p => Promise.race([p.search(q, conf(p)), new Promise((_, no) => setTimeout(() => no(new Error('took too long')), 12000))])));
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
      if (!p || !ready(p)) return res.status(400).json({ error: 'That source isn’t switched on.' });
      let tmp = null;
      try {
        const got = await p.download(String(b.id || ''), conf(p));   // { url, headers?, filename, title, artist, album, cover, license, licenseUrl, page }
        tmp = await fetchToTmp(got.url, got.headers);
        const track = await opts.addFile(tmp, got.filename || 'download.mp3', req.user, {
          title: got.title, artist: got.artist, album: got.album || '', coverUrl: /^https:\/\//.test(got.cover || '') ? got.cover : '',
          source: { id: p.id, name: p.name, item: String(b.id), license: got.license || p.license || '', licenseUrl: got.licenseUrl || '', page: got.page || '' }
        });
        tmp = null;
        if (b.matchKey) await opts.linkToSong(String(b.matchKey), track.id, req.user);
        res.json({ track });
      } catch (e) {
        if (tmp) await fsp.rm(tmp, { force: true });
        res.status(e.status || 502).json({ error: e.message || 'Couldn’t get that file.' });
      }
    });
  }

  // Settings travel with server-to-server sync.
  const syncCollection = {
    get: () => ({ ...cfg }),
    set: o => { for (const k of Object.keys(cfg)) delete cfg[k]; Object.assign(cfg, o); save(); }
  };

  return { routes, syncCollection };
};
