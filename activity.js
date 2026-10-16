// Who uses Murmur: for each person, which days they were online, how many minutes the app was open, how long music
// actually played, and what they played (genres and artists, by listening time). The owner sees it under
// Admin → Activity. While the app is open it reports once a minute (POST /api/me/activity).
// Each server keeps its own counts under its own id, and server sync brings everyone's together, so it doesn't
// matter which server someone uses (two servers never write the same record).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEEP_DAYS = 90;
const day = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

module.exports = function createActivity(dataDir, auth) {
  const idFile = path.join(dataDir, 'server-id.txt');
  let serverId = '';
  try { serverId = fs.readFileSync(idFile, 'utf8').trim(); } catch { /* new */ }
  if (!/^[a-f0-9]{8,}$/.test(serverId)) { serverId = crypto.randomBytes(6).toString('hex'); fs.writeFileSync(idFile, serverId); }

  const file = path.join(dataDir, 'activity.json');
  let all = {};   // "<serverId>|<userId>" -> { days: { "YYYY-MM-DD": { on, play } }, genres: {}, artists: {}, last, lastPlay }
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { all = {}; }
  let timer = null;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => {
    fs.promises.writeFile(file + '.tmp', JSON.stringify(all)).then(() => fs.promises.rename(file + '.tmp', file)).catch(() => {});
  }, 5000); };

  function prune(rec) {
    const cut = day(Date.now() - KEEP_DAYS * 864e5);
    for (const d of Object.keys(rec.days || {})) if (d < cut) delete rec.days[d];
    for (const k of ['genres', 'artists']) {
      const e = Object.entries(rec[k] || {});
      if (e.length > 60) rec[k] = Object.fromEntries(e.sort((a, b) => b[1] - a[1]).slice(0, 60));
    }
  }
  const clean = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  function routes(app) {
    // { online: seconds the app was open and in view (0-120), played: seconds music played (0-120), genre, artist }
    app.post('/api/me/activity', (req, res) => {
      const b = req.body || {}, now = Date.now();
      const online = Math.max(0, Math.min(120, +b.online || 0)), played = Math.max(0, Math.min(120, +b.played || 0));
      const key = serverId + '|' + req.user.id;
      const rec = all[key] = all[key] || { days: {}, genres: {}, artists: {} };
      const d = rec.days[day(now)] = rec.days[day(now)] || { on: 0, play: 0 };
      d.on += online; d.play += played;
      rec.last = now;
      if (played) {
        rec.lastPlay = now;
        const g = clean(b.genre, 40), a = clean(b.artist);
        if (g) rec.genres[g] = (rec.genres[g] || 0) + played;
        if (a) rec.artists[a] = (rec.artists[a] || 0) + played;
      }
      prune(rec); save();
      res.json({ ok: true });
    });

    // Everyone's activity, put together from every server.
    app.get('/api/admin/activity', auth.requireOwner, (req, res) => {
      const people = {};
      for (const [key, rec] of Object.entries(all)) {
        const uid = key.slice(key.indexOf('|') + 1);
        const p = people[uid] = people[uid] || { days: {}, genres: {}, artists: {}, last: 0, lastPlay: 0 };
        for (const [d, v] of Object.entries(rec.days || {})) { const t = p.days[d] = p.days[d] || { on: 0, play: 0 }; t.on += v.on || 0; t.play += v.play || 0; }
        for (const k of ['genres', 'artists']) for (const [n, s] of Object.entries(rec[k] || {})) p[k][n] = (p[k][n] || 0) + s;
        p.last = Math.max(p.last, rec.last || 0); p.lastPlay = Math.max(p.lastPlay, rec.lastPlay || 0);
      }
      res.json({ today: day(Date.now()), people });
    });
  }

  // For server-to-server sync: each server's own records travel to the others.
  const syncCollection = {
    get: () => ({ ...all }),
    set: o => { all = { ...o }; save(); }
  };
  return { routes, syncCollection };
};
