// Ad-free YouTube playback: the server finds a YouTube song's audio stream with yt-dlp and passes it through to
// the player, so it plays as plain audio (no YouTube player, so no ads, and it keeps playing with the screen locked).
// Used where no ad blocker can run, like Safari on iPhone. Seeking works (Range requests are passed on).
// YouTube sometimes refuses cloud servers ("confirm you're not a bot"); then this answers 502 and the player
// tries another server or falls back to YouTube's own player.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ID = /^[A-Za-z0-9_-]{11}$/;
const KEEP_MS = 4 * 3600e3;   // YouTube's stream addresses last about 6 hours

module.exports = function ytAudio(app, auth, dataDir, opts = {}) {
  const found = new Map();     // id -> { url, headers, at } or { failed, at }
  const busy = new Map();      // id -> Promise (one lookup per song at a time)
  // Stream addresses are kept on disk too, so songs looked up before a restart still start right away.
  const cacheFile = path.join(dataDir, 'ytaudio-cache.json');
  try { for (const [id, v] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))) if (v && v.url && Date.now() - v.at < KEEP_MS) found.set(id, v); } catch { /* none yet */ }
  let saveTimer = null;
  const saveCache = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => {
    const keep = {}; for (const [id, v] of found) if (v.url && Date.now() - v.at < KEEP_MS) keep[id] = v;
    fs.promises.writeFile(cacheFile, JSON.stringify(keep)).catch(() => {});
  }, 3000); };
  let failsInARow = 0;   // this server keeps failing (YouTube blocking it): don't look songs up ahead of time
  // YouTube treating this server as a bot: for a while, say so at once instead of trying (each try costs ~2 s),
  // so the player goes straight to a server that works. Songs kept on disk still play from here.
  let blockedUntil = 0;
  const BOT = /not a bot|sign in to confirm|429|too many requests/i;

  /* A yt-dlp that stays running (ytworker.py): about 1 second per song instead of 3-4, since yt-dlp doesn't start
     up again for each one. If Python or its yt_dlp module isn't there, each lookup starts yt-dlp as before. */
  const worker = { p: null, ready: null, wait: new Map(), n: 0, broken: false };
  function startWorker() {
    if (worker.broken) return Promise.resolve(false);
    if (worker.ready) return worker.ready;
    worker.ready = new Promise(ok => {
      const tryPy = names => {
        if (!names.length) { worker.broken = true; worker.ready = null; return ok(false); }
        const p = spawn(names[0], ['-u', path.join(__dirname, 'ytworker.py')]);
        let buf = '', up = false;
        p.on('error', () => { if (!up) tryPy(names.slice(1)); });
        p.stderr.on('data', () => {});
        p.stdout.on('data', d => {
          buf += d; let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            let m; try { m = JSON.parse(buf.slice(0, i)); } catch { m = {}; }
            buf = buf.slice(i + 1);
            if (m.ready) { up = true; worker.p = p; ok(true); continue; }
            const w = worker.wait.get(m.id); if (w) { worker.wait.delete(m.id); w(m); }
          }
        });
        p.on('close', () => {
          if (!up) return tryPy(names.slice(1));
          // Stopped: answer whatever was waiting, start fresh next time.
          worker.p = null; worker.ready = null;
          for (const w of worker.wait.values()) w({ error: 'yt-dlp worker stopped' });
          worker.wait.clear();
        });
      };
      tryPy(process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']);
    });
    return worker.ready;
  }
  startWorker();
  async function lookUpFast(id, cookies) {
    if (!(await startWorker()) || !worker.p) return null;
    const rid = String(++worker.n);
    const m = await new Promise(ok => {
      worker.wait.set(rid, ok);
      setTimeout(() => { if (worker.wait.delete(rid)) ok({ error: 'took too long' }); }, 40e3);
      worker.p.stdin.write(JSON.stringify({ id: rid, video: id, cookies }) + '\n');
    });
    if (m.error) throw new Error(m.error);
    return { url: m.url, headers: m.headers || {}, type: m.ext === 'webm' ? 'audio/webm' : 'audio/mp4', at: Date.now() };
  }

  async function lookUp(id) {
    const cookies = path.join(dataDir, 'cookies.txt');
    const fast = await lookUpFast(id, fs.existsSync(cookies) ? cookies : '');
    if (fast) return fast;
    return lookUpSpawn(id);
  }
  function lookUpSpawn(id) {
    const args = ['-j', '--no-warnings', '--no-playlist', '-f', 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio',
      // yt-dlp's default YouTube clients: their stream addresses can be fetched directly (web_safari's answer 403).
      '--remote-components', 'ejs:github', '--js-runtimes', 'deno', '--js-runtimes', 'node',
      '--extractor-args', 'youtube:skip=dash,hls,translated_subs'];
    const cookies = path.join(dataDir, 'cookies.txt');
    if (fs.existsSync(cookies)) args.push('--cookies', cookies);
    args.push('--', 'https://www.youtube.com/watch?v=' + id);
    return new Promise((ok, no) => {
      const p = spawn('yt-dlp', args);
      let out = '', err = '';
      const t = setTimeout(() => p.kill(), 45e3);
      p.stdout.on('data', c => { out += c; });
      p.stderr.on('data', c => { err += c; });
      p.on('error', no);
      p.on('close', code => {
        clearTimeout(t);
        try {
          const j = JSON.parse(out);
          if (!j.url) throw new Error('no audio stream');
          ok({ url: j.url, headers: j.http_headers || {}, type: j.ext === 'webm' ? 'audio/webm' : 'audio/mp4', at: Date.now() });
        } catch (e) { no(new Error((err.match(/ERROR: (.*)/) || [])[1] || 'yt-dlp exited ' + code)); }
      });
    });
  }
  async function stream(id, fresh) {
    const hit = found.get(id);
    if (!fresh && hit && Date.now() - hit.at < (hit.failed ? 10 * 60e3 : KEEP_MS)) { if (hit.failed) throw new Error(hit.failed); return hit; }
    if (!busy.has(id)) busy.set(id, lookUp(id).then(r => { found.set(id, r); failsInARow = 0; blockedUntil = 0; saveCache(); return r; },
      e => { found.set(id, { failed: e.message, at: Date.now() }); failsInARow++; if (BOT.test(e.message)) blockedUntil = Date.now() + 20 * 60e3; throw e; }).finally(() => busy.delete(id)));
    if (found.size > 500) found.delete(found.keys().next().value);
    return busy.get(id);
  }

  // ?prep=1 only looks the song up (for the next song in the queue), so it starts right away when its turn comes.
  app.get('/ytaudio/:id', auth.requireUserFiles, async (req, res) => {
    const id = req.params.id;
    if (!ID.test(id)) return res.status(400).end();
    // Kept on disk (a liked song): straight from the file, instant, and it works where YouTube blocks the server.
    if (fs.existsSync(cached(id))) {
      if (req.query.prep) return res.status(204).end();
      return res.sendFile(cached(id), { headers: { 'Content-Type': 'audio/mp4', 'Cache-Control': 'private, max-age=86400' } });
    }
    // Played or got ready lately: also kept on disk for a while, so it starts instantly (and seeks/replays too).
    if (fs.existsSync(recent(id))) {
      if (req.query.prep) return res.status(204).end();
      const now = new Date(); fs.utimes(recent(id), now, now, () => {});
      return res.sendFile(recent(id), { headers: { 'Content-Type': 'audio/mp4', 'Cache-Control': 'private, max-age=86400' } });
    }
    const known = found.get(id);
    if (blockedUntil > Date.now() && !(known && known.url && Date.now() - known.at < KEEP_MS)) {
      res.setHeader('X-Murmur-Yt', 'blocked');
      return res.status(503).type('text').send('YouTube is blocking this server right now.');
    }
    try {
      let s = await stream(id);
      warm(id);
      if (req.query.prep) return res.status(204).end();
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctl = new AbortController();
        req.on('close', () => ctl.abort());
        const headers = { ...s.headers, Range: req.headers.range || 'bytes=0-' };
        const r = await fetch(s.url, { headers, signal: ctl.signal });
        if ((r.status === 403 || r.status === 410) && attempt === 0) { s = await stream(id, true); continue; }   // address expired
        if (!r.ok) return res.status(502).type('text').send('YouTube refused the stream.');
        res.status(r.status);
        res.setHeader('Content-Type', s.type);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        for (const h of ['content-length', 'content-range']) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
        if (!r.body) return res.end();
        Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
        return;
      }
    } catch (e) {
      if (!res.headersSent) res.status(502).type('text').send('Couldn’t get this song from YouTube here: ' + e.message);
    }
  });

  // Get songs ready ahead of time (the top search results while the player picks one), unless this server
  // can't get YouTube audio at the moment.

  /* ---------- liked songs kept on disk ----------
     Everyone's liked YouTube songs (and the YouTube matches of liked Spotify songs) are downloaded here in the
     background, one at a time, up to 3 GB. They then start instantly, and server sync copies the files to the
     other servers, so a server YouTube blocks (the cloud one) still plays them ad-free. A song nobody has liked
     for a day is removed again. */
  const CACHE_DIR = path.join(dataDir, 'ytcache');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const MAX_CACHE = 3 * 1024 ** 3;
  const recFile = path.join(dataDir, 'ytcache.json');
  let recs = {};   // id -> { at, size, unwanted? }: synced between servers, so the files follow
  try { recs = JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { /* none yet */ }
  const saveRecs = () => fs.promises.writeFile(recFile + '.tmp', JSON.stringify(recs)).then(() => fs.promises.rename(recFile + '.tmp', recFile)).catch(() => {});
  const cached = id => path.join(CACHE_DIR, id + '.m4a');
  // Same ids as the player gives imported Spotify songs (addSpTrack in index.html).
  const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const spId = key => 'sp-' + hashStr(key).toString(36) + hashStr('m' + key).toString(36);
  function wanted() {
    const out = new Set();
    if (!opts.userRecords || !opts.matches) return out;
    const users = {};
    for (const [k, v] of Object.entries(opts.userRecords())) { const i = k.indexOf('/'); (users[k.slice(0, i)] = users[k.slice(0, i)] || {})[k.slice(i + 1)] = v; }
    const matches = opts.matches();
    for (const d of Object.values(users)) {
      const liked = new Set(Array.isArray(d.liked) ? d.liked : []);
      for (const id of liked) if (/^yt-/.test(id) && ID.test(id.slice(3))) out.add(id.slice(3));
      for (const x of Array.isArray(d.spTracks) ? d.spTracks : []) {
        if (!x || !x.key || !liked.has(spId(x.key))) continue;
        const m = matches[x.key];
        if (m && m.yt && ID.test(m.yt.id || '') && !m.file) out.add(m.yt.id);
      }
    }
    return out;
  }
  async function download(id, dest = cached(id)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await stream(id, attempt > 0);
      const r = await fetch(s.url, { headers: { ...s.headers, Range: 'bytes=0-' }, signal: AbortSignal.timeout(180e3) });
      if ((r.status === 403 || r.status === 410) && attempt === 0) continue;
      if (!r.ok || !r.body) throw new Error('YouTube answered ' + r.status);
      const tmp = dest + '.part';
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
      const size = fs.statSync(tmp).size;
      if (size < 100e3) { fs.rmSync(tmp, { force: true }); throw new Error('file too small'); }
      fs.renameSync(tmp, dest);
      return size;
    }
    throw new Error('stream address expired');
  }
  /* Songs played or got ready lately (the next ones in the queue, the top of a list you opened, search results)
     are downloaded whole in the background, a couple at a time: a few MB each, about a second on a server's
     connection. Playing one is then just reading a file here, instant, with no wait on YouTube. Kept up to
     1 GB, the least recently played go first. These stay on this server (only liked songs are synced). */
  const RECENT_DIR = path.join(CACHE_DIR, 'recent');
  fs.mkdirSync(RECENT_DIR, { recursive: true });
  const MAX_RECENT = 1024 ** 3;
  const recent = id => path.join(RECENT_DIR, id + '.m4a');
  const warming = new Set(), warmQueue = [];
  function warm(id) {
    if (!ID.test(id) || warming.has(id) || warmQueue.includes(id) || failsInARow >= 3) return;
    if (fs.existsSync(cached(id)) || fs.existsSync(recent(id))) return;
    warmQueue.push(id);
    if (warmQueue.length > 30) warmQueue.shift();
    pumpWarm();
  }
  function pumpWarm() {
    while (warming.size < 2 && warmQueue.length) {
      const id = warmQueue.shift();
      warming.add(id);
      download(id, recent(id)).catch(() => fs.rm(recent(id) + '.part', { force: true }, () => {}))
        .finally(() => { warming.delete(id); trimRecent(); pumpWarm(); });
    }
  }
  let trimming = false;
  async function trimRecent() {
    if (trimming) return; trimming = true;
    try {
      const files = [];
      for (const f of await fs.promises.readdir(RECENT_DIR)) {
        if (!f.endsWith('.m4a')) continue;
        try { const st = await fs.promises.stat(path.join(RECENT_DIR, f)); files.push({ f, size: st.size, t: st.mtimeMs }); } catch { /* gone */ }
      }
      let total = files.reduce((a, x) => a + x.size, 0);
      for (const x of files.sort((a, b) => a.t - b.t)) {
        if (total <= MAX_RECENT) break;
        await fs.promises.rm(path.join(RECENT_DIR, x.f), { force: true }); total -= x.size;
      }
    } catch { /* tried again next time */ } finally { trimming = false; }
  }
  // Left over from a restart in the middle of a download
  for (const f of fs.readdirSync(RECENT_DIR)) if (f.endsWith('.part')) fs.rm(path.join(RECENT_DIR, f), { force: true }, () => {});

  let filling = false;
  async function fillCache() {
    if (filling) return;
    filling = true;
    try {
      const want = wanted(), now = Date.now();
      let changed = false;
      for (const [id, r] of Object.entries(recs)) {
        if (want.has(id)) { if (r.unwanted) { delete r.unwanted; changed = true; } continue; }
        if (!r.unwanted) { r.unwanted = now; changed = true; }
        else if (now - r.unwanted > 24 * 3600e3) { delete recs[id]; fs.rm(cached(id), { force: true }, () => {}); changed = true; }
      }
      if (changed) saveRecs();
      let total = Object.values(recs).reduce((a, r) => a + (r.size || 0), 0);
      for (const id of want) {
        if (failsInARow >= 3) break;   // YouTube is blocking this server: the files come from the others by sync
        if (recs[id] || total > MAX_CACHE) continue;
        if (fs.existsSync(recent(id))) {   // already here from playing it: keep that file
          try { fs.renameSync(recent(id), cached(id)); recs[id] = { at: Date.now(), size: fs.statSync(cached(id)).size }; total += recs[id].size; saveRecs(); continue; } catch { /* download it */ }
        }
        try { const size = await download(id); recs[id] = { at: Date.now(), size }; total += size; saveRecs(); }
        catch { /* tried again next round */ }
        await new Promise(r => setTimeout(r, 1500));
      }
    } finally { filling = false; }
  }
  setTimeout(fillCache, 30e3);
  setInterval(fillCache, 5 * 60e3).unref();

  // Check now and then (in the background, with a well-known video) whether YouTube lets this server in, so a
  // blocked server says so before anyone's song waits on it.
  async function selfTest() {
    try { await lookUp('dQw4w9WgXcQ'); blockedUntil = 0; }
    catch (e) { if (BOT.test(e.message)) blockedUntil = Date.now() + 20 * 60e3; }
  }
  setTimeout(selfTest, 20e3);
  setInterval(selfTest, 15 * 60e3).unref();

  // Can this server get YouTube audio right now? The player asks every server and uses the ones that can first.
  app.get('/ytaudio-status', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: !(blockedUntil > Date.now()) }); });

  // Which songs are on disk here, so the player plays them from the file even where it would use YouTube's player.
  app.get('/api/ytcache', (req, res) => res.json({ ids: Object.keys(recs).filter(id => fs.existsSync(cached(id))) }));

  return {
    prep(ids) { if (failsInARow >= 3) return; for (const id of ids) if (ID.test(id) && !fs.existsSync(cached(id)) && !fs.existsSync(recent(id))) stream(id).then(() => warm(id), () => {}); },
    // For server-to-server sync: the list of kept songs, and their files.
    files: () => Object.keys(recs).map(id => 'ytcache/' + id + '.m4a'),
    syncCollection: {
      get: () => ({ ...recs }),
      set: o => { for (const id of Object.keys(recs)) if (!o[id]) fs.rm(cached(id), { force: true }, () => {}); recs = { ...o }; saveRecs(); }
    }
  };
};
