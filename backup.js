// Automatic backups of what Murmur knows: the song list, accounts, everyone's libraries and playlists, Spotify
// imports, settings and activity. Once a day each server copies its data files (the small .json files, not the
// music, which already lives on every server through sync) into DATA/backups/<date>/ and keeps the last 14 days.
// The owner can back up now and download a backup from Admin → Servers.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const KEEP = 14;
const SKIP = /cache|sync-state|\.tmp$/i;           // rebuilt on their own; not worth keeping
const MAX_FILE = 50 * 1024 * 1024;

module.exports = function createBackups(DATA, auth) {
    const dir = path.join(DATA, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const day = (d = new Date()) => d.toISOString().slice(0, 10);

    async function list() {
        const out = [];
        for (const name of (await fsp.readdir(dir).catch(() => [])).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse()) {
            const files = await fsp.readdir(path.join(dir, name)).catch(() => []);
            let bytes = 0, at = 0;
            for (const f of files) { const st = await fsp.stat(path.join(dir, name, f)).catch(() => null); if (st) { bytes += st.size; at = Math.max(at, st.mtimeMs); } }
            out.push({ date: name, files: files.length, bytes, at });
        }
        return out;
    }

    let running = null;
    function backUp() {
        if (running) return running;
        running = (async () => {
            const to = path.join(dir, day());
            await fsp.mkdir(to, { recursive: true });
            let n = 0;
            for (const f of await fsp.readdir(DATA)) {
                if (!f.endsWith('.json') || SKIP.test(f)) continue;
                const st = await fsp.stat(path.join(DATA, f)).catch(() => null);
                if (!st || !st.isFile() || st.size > MAX_FILE) continue;
                await fsp.copyFile(path.join(DATA, f), path.join(to, f)); n++;
            }
            const old = (await list()).slice(KEEP);
            for (const b of old) await fsp.rm(path.join(dir, b.date), { recursive: true, force: true });
            console.log(`Backed up ${n} data files to backups/${day()}.`);
        })().catch(err => console.error('Backup failed:', err.message)).finally(() => { running = null; });
        return running;
    }

    // Once a day (a few minutes after starting, then hourly checks for a new day).
    const daily = async () => { const l = await list(); if (!l.length || l[0].date !== day()) backUp(); };
    setTimeout(daily, 3 * 60e3);
    setInterval(daily, 3600e3);

    function routes(app) {
        app.get('/api/admin/backups', auth.requireOwner, async (req, res) => res.json({ backups: await list() }));
        app.post('/api/admin/backups', auth.requireOwner, async (req, res) => { await backUp(); res.json({ backups: await list() }); });
        // One backup as a single file: { "library.json": ..., "auth.json": ... }
        app.get('/api/admin/backups/:date', auth.requireOwner, async (req, res) => {
            const d = String(req.params.date), b = await bundle(d);
            if (!b) return res.status(404).json({ error: 'That backup is gone.' });
            res.setHeader('Content-Disposition', `attachment; filename="murmur-backup-${d}.json"`);
            res.json(b);
        });
    }
    // One backup as a single object: { "library.json": ..., "auth.json": ... }, or null.
    async function bundle(d) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
        const from = path.join(dir, d), out = {};
        for (const f of await fsp.readdir(from).catch(() => [])) {
            try { out[f] = JSON.parse(await fsp.readFile(path.join(from, f), 'utf8')); } catch { /* skip unreadable */ }
        }
        return Object.keys(out).length ? out : null;
    }
    return { routes, list, backUp, bundle };
};
