// Server-to-server sync: keeps two or more Murmur servers (e.g. a laptop and a cloud server) holding the
// same accounts, sign-ins, songs, libraries, Spotify imports and settings, in both directions.
//
// Every record (a person, a sign-in, a song, one part of someone's library, ...) gets a version: a hash of its
// content plus the time it last changed here. When servers compare notes, the newer version of each record
// wins, and deletions travel as "deleted at" markers. Audio and cover files are copied to whichever side lacks them.
//
// Setup (both servers): the same secret in MURMUR_SYNC_KEY. On a server that can reach the others, list their
// addresses in MURMUR_PEERS (comma-separated). It pushes its changes to them and pulls theirs, so a server whose
// own address keeps changing (like a laptop on a quick tunnel) can still sync with a fixed one.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const EVERY_MS = 10e3;
const FILE_RE = /^(music|covers)\/[A-Za-z0-9._-]+$/;

module.exports = function createSync(dataDir, collections, opts = {}) {
  const key = String(process.env.MURMUR_SYNC_KEY || '').trim();
  const peers = String(process.env.MURMUR_PEERS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const stateFile = path.join(dataDir, 'sync-state.json');
  let state = { versions: {} };
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  state.versions = state.versions || {};
  const saveState = () => fsp.writeFile(stateFile + '.tmp', JSON.stringify(state)).then(() => fsp.rename(stateFile + '.tmp', stateFile)).catch(() => {});

  // Stable hash of a record (object keys sorted), ignoring fields that change all the time.
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.keys(v).sort().reduce((o, k) => { o[k] = stable(v[k]); return o; }, {}) : v;
  const hashOf = (c, v) => crypto.createHash('sha1').update(JSON.stringify(stable(c.strip ? c.strip(v) : v))).digest('hex');

  // Notice what changed here since last time and give it a new version.
  function refresh() {
    const now = Date.now(); let changed = false;
    for (const [name, c] of Object.entries(collections)) {
      const cur = c.get(), seen = new Set();
      for (const [k, v] of Object.entries(cur)) {
        const id = name + ':' + k, h = hashOf(c, v), old = state.versions[id];
        seen.add(id);
        if (!old || old.del || old.h !== h) { state.versions[id] = { h, t: Math.max(now, old ? old.t + 1 : 0) }; changed = true; }
      }
      for (const [id, ver] of Object.entries(state.versions)) {
        if (id.startsWith(name + ':') && !seen.has(id) && !ver.del) { state.versions[id] = { h: '', t: Math.max(now, ver.t + 1), del: true }; changed = true; }
      }
    }
    if (changed) saveState();
  }

  function exportRecords() {
    refresh();
    const out = {};
    for (const [name, c] of Object.entries(collections)) {
      const cur = c.get();
      for (const [k, v] of Object.entries(cur)) { const id = name + ':' + k; out[id] = { ...state.versions[id], v }; }
    }
    for (const [id, ver] of Object.entries(state.versions)) if (ver.del) out[id] = ver;
    return out;
  }

  // Take the newer version of every record.
  function merge(records) {
    refresh();
    const touched = {};
    for (const [id, inc] of Object.entries(records || {})) {
      const i = id.indexOf(':'), name = id.slice(0, i), k = id.slice(i + 1), c = collections[name];
      if (!c || !inc || typeof inc.t !== 'number') continue;
      const mine = state.versions[id];
      const incH = inc.del ? '' : hashOf(c, inc.v);
      const newer = !mine || inc.t > mine.t || (inc.t === mine.t && incH > (mine.h || ''));
      if (!newer) continue;
      if (mine && !mine.del && !inc.del && mine.h === incH) { state.versions[id] = { h: incH, t: inc.t }; continue; }   // same content
      const cur = touched[name] = touched[name] || c.get();
      if (inc.del) delete cur[k]; else cur[k] = inc.v;
      state.versions[id] = inc.del ? { h: '', t: inc.t, del: true } : { h: incH, t: inc.t };
    }
    for (const [name, obj] of Object.entries(touched)) collections[name].set(obj);
    saveState();
    return Object.keys(touched);
  }

  const filePath = p => path.join(dataDir, p);
  const missingFiles = () => (opts.files ? opts.files() : []).filter(p => FILE_RE.test(p) && !fs.existsSync(filePath(p)));

  /* --- endpoints other servers call (protected by the shared key) --- */
  function authorized(req) {
    const got = Buffer.from(String(req.headers['x-murmur-sync'] || '')), want = Buffer.from(key);
    return !!key && got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  function routes(app) {
    const guard = (req, res, next) => authorized(req) ? next() : res.status(404).json({ error: 'Not found.' });
    app.get('/api/sync/state', guard, (req, res) => res.json({ records: exportRecords() }));
    app.post('/api/sync/state', guard, express.json({ limit: '200mb' }), (req, res) => {
      const changed = merge(req.body && req.body.records);
      if (changed.length) console.log('Sync: updated ' + changed.join(', ') + ' from another server');
      res.json({ missing: missingFiles() });
    });
    app.get('/api/sync/file', guard, (req, res) => {
      const p = String(req.query.path || '');
      if (!FILE_RE.test(p) || !fs.existsSync(filePath(p))) return res.status(404).end();
      res.sendFile(filePath(p));
    });
    app.put('/api/sync/file', guard, async (req, res) => {
      const p = String(req.query.path || '');
      if (!FILE_RE.test(p)) return res.status(400).end();
      const tmp = filePath(p) + '.part';
      try { await pipeline(req, fs.createWriteStream(tmp)); await fsp.rename(tmp, filePath(p)); res.json({ ok: true }); }
      catch (e) { await fsp.rm(tmp, { force: true }); res.status(500).end(); }
    });
  }

  /* --- this server reaches out to its peers --- */
  const H = { 'X-Murmur-Sync': key };
  async function syncWith(peer) {
    // 1. Their changes -> here.
    const r = await fetch(peer + '/api/sync/state', { headers: H });
    if (!r.ok) throw new Error('state ' + r.status);
    const changed = merge((await r.json()).records);
    if (changed.length) console.log(`Sync: updated ${changed.join(', ')} from ${peer}`);
    // 2. Song files we don't have yet.
    for (const p of missingFiles()) {
      const f = await fetch(peer + '/api/sync/file?path=' + encodeURIComponent(p), { headers: H });
      if (!f.ok || !f.body) continue;
      const tmp = filePath(p) + '.part';
      try { await pipeline(Readable.fromWeb(f.body), fs.createWriteStream(tmp)); await fsp.rename(tmp, filePath(p)); }
      catch (e) { await fsp.rm(tmp, { force: true }); }
    }
    // 3. Our changes -> there, then send the files they're missing.
    const body = JSON.stringify({ records: exportRecords() });
    const pr = await fetch(peer + '/api/sync/state', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body });
    if (!pr.ok) throw new Error('push ' + pr.status);
    const { missing = [] } = await pr.json();
    for (const p of missing) {
      if (!FILE_RE.test(p) || !fs.existsSync(filePath(p))) continue;
      await fetch(peer + '/api/sync/file?path=' + encodeURIComponent(p), { method: 'PUT', headers: H, body: fs.createReadStream(filePath(p)), duplex: 'half' });
    }
  }
  let running = false, again = false, timer = null;
  const lastError = {};
  async function syncAll() {
    if (running) { again = true; return; }
    running = true;
    for (const peer of peers) {
      try { await syncWith(peer); if (lastError[peer]) console.log('Sync: back in touch with ' + peer); lastError[peer] = null; }
      catch (e) { const msg = e.cause ? e.cause.code || e.message : e.message; if (lastError[peer] !== msg) console.log(`Sync: can’t reach ${peer} (${msg}); will keep trying`); lastError[peer] = msg; }
    }
    running = false;
    if (again) { again = false; setTimeout(syncAll, 1000); }
  }
  // Sync soon after anything changes here (uploads, edits, sign-ins, playlists...).
  function soon() { if (!peers.length || !key) return; clearTimeout(timer); timer = setTimeout(syncAll, 2000); }
  function middleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'OPTIONS' && !req.path.startsWith('/api/sync/')) res.on('finish', soon);
    next();
  }
  function start() {
    if (!key) { if (peers.length) console.log('Sync: MURMUR_PEERS is set but MURMUR_SYNC_KEY is empty, so sync is off.'); return; }
    refresh();
    if (!peers.length) { console.log('Sync: ready for other servers to connect.'); return; }
    console.log('Sync: keeping in step with ' + peers.join(', '));
    setTimeout(syncAll, 3000);
    setInterval(syncAll, EVERY_MS).unref();
  }

  return { routes, middleware, start };
};
