// Song lyrics, timed to the music when possible, from LRCLIB (https://lrclib.net: free, no key, community lyrics).
// GET /api/lyrics?artist=&title=&album=&duration= -> { synced: "[mm:ss.xx] line\n...", plain: "...", source } or 404.
// Answers are remembered (DATA/lyrics-cache.json): found ones for 60 days, "none found" for 3 days.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const UA = 'Murmur (https://github.com/rodriguezcurielj/Murmur)';
const FOUND_MS = 60 * 86400e3, NONE_MS = 3 * 86400e3;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const baseTitle = t => String(t || '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim();
const firstArtist = a => String(a || '').split(/,|&| x | feat\.? | ft\.? /i)[0].replace(/\s*-\s*topic$/i, '').trim();

module.exports = function createLyrics(DATA) {
    const file = path.join(DATA, 'lyrics-cache.json');
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cache = {}; }
    let saving = null;
    const save = () => { clearTimeout(saving); saving = setTimeout(() => fsp.writeFile(file, JSON.stringify(cache)).catch(() => {}), 2000); };

    async function ask(u) {
        const r = await fetch('https://lrclib.net/api/' + u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('LRCLIB answered ' + r.status);
        return r.json();
    }
    const pack = x => x && (x.syncedLyrics || x.plainLyrics) && !x.instrumental
        ? { synced: x.syncedLyrics || '', plain: x.plainLyrics || '', source: 'LRCLIB', name: x.trackName || '', artist: x.artistName || '' }
        : x && x.instrumental ? { instrumental: true, source: 'LRCLIB' } : null;

    async function find(artist, title, album, duration) {
        const a = firstArtist(artist), t = baseTitle(title) || title;
        let failed = 0;   // the service didn't answer: don't remember "no lyrics"
        const ask2 = u => ask(u).catch(() => { failed++; return null; });
        // 1. The exact song (with its length, so the timing fits this recording).
        if (duration) {
            const q = new URLSearchParams({ artist_name: a, track_name: t, ...(album ? { album_name: album } : {}), duration: String(Math.round(duration)) });
            const hit = pack(await ask2('get?' + q));
            if (hit) return hit;
        }
        // 2. Search, then pick the same song by name and artist, closest in length, timed lyrics first.
        const list = await ask2('search?' + new URLSearchParams({ track_name: t, artist_name: a }))
            || await ask2('search?' + new URLSearchParams({ q: `${a} ${t}` })) || [];
        const nt = norm(t), na = norm(a);
        const ok = list.filter(x => norm(baseTitle(x.trackName)) === nt && (!na || norm(x.artistName).includes(na) || na.includes(norm(x.artistName))));
        ok.sort((x, y) => (!!y.syncedLyrics - !!x.syncedLyrics) || (duration ? Math.abs(x.duration - duration) - Math.abs(y.duration - duration) : 0));
        const best = ok.find(x => !duration || Math.abs(x.duration - duration) <= 8) || ok[0];
        const got = pack(best);
        if (!got && failed) throw new Error('The lyrics service didn’t answer.');
        return got;
    }

    function routes(app) {
        app.get('/api/lyrics', async (req, res) => {
            const artist = String(req.query.artist || '').slice(0, 200), title = String(req.query.title || '').slice(0, 200);
            const album = String(req.query.album || '').slice(0, 200), duration = Number(req.query.duration) || 0;
            if (!title) return res.status(400).json({ error: 'Which song?' });
            const key = `${norm(firstArtist(artist))}|${norm(baseTitle(title) || title)}|${Math.round(duration / 5)}`;
            const c = cache[key];
            if (c && Date.now() - c.at < (c.none ? NONE_MS : FOUND_MS)) return c.none ? res.status(404).json({ error: 'No lyrics found for this song.' }) : res.json(c.data);
            try {
                const data = await find(artist, title, album, duration);
                cache[key] = data ? { at: Date.now(), data } : { at: Date.now(), none: true };
                if (Object.keys(cache).length > 20000) { const old = Object.keys(cache).sort((x, y) => cache[x].at - cache[y].at).slice(0, 2000); old.forEach(k => delete cache[k]); }
                save();
                if (!data) return res.status(404).json({ error: 'No lyrics found for this song.' });
                res.json(data);
            } catch (e) { res.status(502).json({ error: 'Couldn’t reach the lyrics service. Try again in a moment.' }); }
        });
    }
    return { routes };
};
