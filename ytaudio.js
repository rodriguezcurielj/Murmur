// Ad-free YouTube playback: the server finds a YouTube song's audio stream with yt-dlp and passes it through to
// the player, so it plays as plain audio (no YouTube player, so no ads, and it keeps playing with the screen locked).
// Used where no ad blocker can run, like Safari on iPhone. Seeking works (Range requests are passed on).
// YouTube sometimes refuses cloud servers ("confirm you're not a bot"); then this answers 502 and the player
// tries another server or falls back to YouTube's own player.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const ID = /^[A-Za-z0-9_-]{11}$/;
const KEEP_MS = 4 * 3600e3;   // YouTube's stream addresses last about 6 hours

module.exports = function ytAudio(app, auth, dataDir) {
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
      '--remote-components', 'ejs:github', '--js-runtimes', 'deno', '--js-runtimes', 'node'];
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
    if (!busy.has(id)) busy.set(id, lookUp(id).then(r => { found.set(id, r); failsInARow = 0; saveCache(); return r; },
      e => { found.set(id, { failed: e.message, at: Date.now() }); failsInARow++; throw e; }).finally(() => busy.delete(id)));
    if (found.size > 500) found.delete(found.keys().next().value);
    return busy.get(id);
  }

  // ?prep=1 only looks the song up (for the next song in the queue), so it starts right away when its turn comes.
  app.get('/ytaudio/:id', auth.requireUserFiles, async (req, res) => {
    const id = req.params.id;
    if (!ID.test(id)) return res.status(400).end();
    try {
      let s = await stream(id);
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
  return { prep(ids) { if (failsInARow >= 3) return; for (const id of ids) if (ID.test(id)) stream(id).catch(() => {}); } };
};
