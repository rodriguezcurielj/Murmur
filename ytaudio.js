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

  function lookUp(id) {
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
    if (!busy.has(id)) busy.set(id, lookUp(id).then(r => { found.set(id, r); return r; }, e => { found.set(id, { failed: e.message, at: Date.now() }); throw e; }).finally(() => busy.delete(id)));
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
};
