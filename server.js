// Murmur server: serves the player and stores uploaded media in DATA_DIR.
// Audio-only files browsers can play are kept as-is; everything else
// (video files, WMA, AIFF, ...) has its audio extracted to MP3 with ffmpeg.
const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const createAuth = require('./auth');
const createYouTube = require('./youtube');
const createSpotify = require('./spotify');
const createDiscover = require('./discover');
const createUserData = require('./userdata');
const createSync = require('./sync');
const createSources = require('./sources');

// --- INTEGRATED YOUTUBE CONVERTER MODULE ---
const { convert, OUT_DIR } = require('./sources/youtube_stuff/convert');
const { songName } = require('./songmeta');   // real song names for YouTube videos

const PORT = Number(process.env.PORT) || 8080;
const DATA = path.resolve(process.env.DATA_DIR || './data');
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const DIRS = { music: path.join(DATA, 'music'), covers: path.join(DATA, 'covers'), tmp: path.join(DATA, 'tmp') };
const DB = path.join(DATA, 'library.json');
const PLAYABLE = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// Ensure output directory for youtube_stuff exists too
fs.mkdirSync(OUT_DIR, { recursive: true });

let library = [];
try { library = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { library = []; }

let saving = Promise.resolve();
function save() {
    const data = JSON.stringify(library, null, 2);
    saving = saving
        .then(async () => { await fsp.writeFile(DB + '.tmp', data); await fsp.rename(DB + '.tmp', DB); })
        .catch(err => console.error('Could not save library.json:', err));
    return saving;
}

function run(cmd, args) {
    return new Promise((resolve, reject) =>
        execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (err, stdout, stderr) =>
            err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
}

async function move(from, to) {
    try { await fsp.rename(from, to); }
    catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.copyFile(from, to); await fsp.rm(from, { force: true });
    }
}

function lowerKeys(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) out[k.toLowerCase()] = String(v).trim();
    return out;
}

function guessFromName(name) {
    const base = path.parse(name).name.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    return m ? { artist: m[1], title: m[2] } : { artist: '', title: base || 'Untitled' };
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://rodriguezcurielj.github.io').split(',').map(s => s.trim()).filter(Boolean);
const auth = createAuth(path.join(DATA, 'auth.json'), { allowedOrigins: ALLOWED_ORIGINS });
// Browser protections: no framing (clickjacking), no MIME sniffing, no full addresses leaked to other sites,
// HTTPS remembered, and no camera/microphone/location for this site.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
});
app.use(auth.cors);
app.use(auth.sameOrigin);
// Answers in JSON (song lists, liked songs, synced settings) go out compressed: about a fifth of the size, so
// they arrive much sooner over a phone's connection.
const takesEnc = req => { const a = String(req.headers['accept-encoding'] || ''); return /\bbr\b/.test(a) ? 'br' : /\bgzip\b/.test(a) ? 'gzip' : ''; };
app.use((req, res, next) => {
    const enc = takesEnc(req);
    if (!enc) return next();
    const json = res.json.bind(res);
    res.json = body => {
        const text = JSON.stringify(body);
        if (text === undefined || text.length < 1400 || res.getHeader('Content-Encoding')) return json(body);
        const buf = enc === 'br' ? zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }) : zlib.gzipSync(text, { level: 5 });
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', enc);
        res.setHeader('Vary', 'Accept-Encoding');
        return res.send(buf);
    };
    next();
});

const deferred = {};
const sync = createSync(DATA, deferred, {
    files: () => [...library.flatMap(t => ['music/' + t.file, ...(t.cover ? ['covers/' + t.cover] : [])]), ...(app.locals.ytAudio ? app.locals.ytAudio.files() : [])]
});
sync.routes(app);
app.use(sync.middleware);
app.use('/api', express.json({ limit: '10mb' }));
app.use('/api', auth.requireUser);

const spotify = createSpotify(DATA, auth, { hasFile: id => library.some(t => t.id === id), fileYtId: id => (library.find(t => t.id === id) || {}).ytId });
const userData = createUserData(DATA, auth, { importsFor: spotify.importsFor });

app.delete('/api/users/:id', auth.requireOwner, (req, res, next) => {
    const id = req.params.id;
    res.on('finish', () => { if (res.statusCode < 300) { userData.removeUser(id); sources.removeUser(id); } });
    next();
});
auth.routes(app);
const mail = require('./mail')(DATA, auth);   // PIN reset emails
auth.useMailer(mail);
mail.routes(app);
const youtube = createYouTube(path.join(DATA, 'settings.json'), auth);
youtube.routes(app);
createDiscover(DATA).routes(app);
spotify.routes(app);
userData.routes(app);
require('./lyrics')(DATA).routes(app);   // song lyrics (LRCLIB), timed to the music
const activity = require('./activity')(DATA, auth);   // who uses Murmur, and how (Admin → Activity)
activity.routes(app);

const upload = multer({ dest: DIRS.tmp, limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });

const sources = createSources(DATA, auth, {
    tmpDir: DIRS.tmp, maxBytes: MAX_MB * 1024 * 1024,
    addFile: (p, name, user, extra) => addMediaFile(p, name, user, extra),
    linkToSong: (key, fileId, user) => spotify.setFileMatch(key, fileId, user)
});
sources.routes(app);

// --- SECURED & LIBRARY-INTEGRATED YOUTUBE CONVERTER ROUTE ---
// yt-dlp saves into a temporary folder; each finished file is then added to the library like an upload.
function listAudio(dir) {
    if (!fs.existsSync(dir)) return [];   // yt-dlp removes its folder when a download fails
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return listAudio(full);
        return /\.(mp3|m4a)$/i.test(e.name) ? [full] : [];
    });
}

app.post('/convert', auth.requireUser, auth.requireEdit, express.json(), async (req, res) => {
    const links = (req.body.links || []).filter(l => /^https?:\/\//.test(l));
    const format = req.body.format === 'm4a' ? 'm4a' : 'mp3';

    if (!links.length) {
        return res.status(400).json({ error: 'No valid links provided.' });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(`Starting conversion for ${links.length} link(s)...\n`);

    const work = path.join(DIRS.tmp, 'yt-' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(work, { recursive: true });

    convert(links, format,
        line => res.write(line + '\n'),
        async code => {
            let added = 0;
            for (const file of listAudio(work)) {
                try {
                    const track = await addMediaFile(file, path.basename(file), req.user);
                    added++;
                    res.write(`Added "${track.title}" to Murmur\n`);
                } catch (err) {
                    res.write(`Couldn't add ${path.basename(file)}: ${err.message}\n`);
                }
            }
            await fsp.rm(work, { recursive: true, force: true });
            res.end(code === 0 ? `Finished. Added ${added} song(s) to your library.\n`
                : `Finished with errors (code ${code}). Added ${added} song(s) to your library.\n`);
        },
        // The list of finished videos lives in DATA so it survives rebuilds and re-runs skip them.
        { outDir: work, archive: path.join(DATA, 'youtube-done.txt') }
    );
});

// --- YouTube downloads as background jobs ---
// The page hands over a list of videos and gets a job id straight away; the server works through them one
// song at a time (one job at a time for the whole server, so it never overloads) and adds each song to the
// library as soon as it's ready. The page only polls for progress, so a dropped connection, a reload or
// browsing elsewhere never stops a download. Jobs live in memory: a server restart ends unfinished ones.
const MAX_JOB_SONGS = 100;
const jobs = new Map();
let jobChain = Promise.resolve();
/* Jobs are saved to disk while they run, so a server restart (an update) carries on where it left off instead of
   losing the rest of the songs. */
const JOBS_FILE = path.join(DATA, 'ytjobs.json');
let jobsDirty = false;
const saveJobs = () => { jobsDirty = true; };
setInterval(() => {
    if (!jobsDirty) return; jobsDirty = false;
    const keep = [...jobs.values()].filter(j => !j.finishedAt || Date.now() - j.finishedAt < 24 * 3600e3);
    fsp.writeFile(JOBS_FILE + '.tmp', JSON.stringify(keep)).then(() => fsp.rename(JOBS_FILE + '.tmp', JOBS_FILE)).catch(() => {});
}, 3000).unref();
const YT_LINK = /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{6,20}$/;
const jobView = j => ({ id: j.id, label: j.label, ctx: j.ctx, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, cancelled: !!j.cancelled,
    items: j.items.map(x => ({ title: x.title, state: x.state, pct: x.pct, msg: x.msg, track: x.track })) });

async function linkToSpotify(key, fileId, user) { try { await spotify.setFileMatch(key, fileId, user); } catch (e) { console.error('Could not link the song:', e.message); } }
// Stop yt-dlp and everything it started (on Windows, killing yt-dlp alone leaves its helpers running).
function killTree(child) {
    if (!child || child.exitCode != null) return;
    try { if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); else child.kill('SIGKILL'); } catch {}
}
function convertOne(link, onPct, job) {
    return new Promise(resolve => {
        const work = path.join(DIRS.tmp, 'yt-' + crypto.randomBytes(6).toString('hex'));
        fs.mkdirSync(work, { recursive: true });
        let skipped = false, lastErr = '', last = Date.now();
        // A download that goes quiet for 3 minutes (or runs past 15) is stopped and tried again, so one stuck
        // song can't hold up every download after it.
        const started = Date.now();
        const watch = setInterval(() => {
            if (Date.now() - last > 180e3 || Date.now() - started > 900e3) { lastErr = 'The download got stuck'; killTree(child); }
        }, 15e3);
        const child = convert([link], 'mp3', line => {
            last = Date.now();
            let m;
            if ((m = line.match(/^\[download\]\s+([\d.]+)%/))) onPct(Math.round(parseFloat(m[1]) * 0.8));
            else if (/^\[ExtractAudio\]/.test(line)) onPct(85);
            else if (/^\[(Metadata|EmbedThumbnail)\]/.test(line)) onPct(95);
            else if (/has already been recorded in the archive/.test(line)) skipped = true;
            else if (/^ERROR:/.test(line)) lastErr = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '');
        }, code => { clearInterval(watch); if (job) job.kill = null; resolve({ code, work, skipped, error: lastErr }); }, { outDir: work, archive: false, infoJson: true });
        if (job) job.kill = () => killTree(child);
    });
}
/* The song's real name, artists and genre (songmeta.js), from what yt-dlp knows about the video. Songs from a
   Spotify import or the song catalog already have their real name, so it's kept. */
async function nameForVideo(dir, item) {
    let info = {};
    try { const f = fs.readdirSync(dir).find(n => n.endsWith('.info.json')); if (f) info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch {}
    const ytTitle = String(info.title || item.title || ''), ytArtist = String(info.channel || info.uploader || '');
    try {
        if (item.song && item.song.title) {
            const n = await songName({ title: `${item.song.artist} - ${item.song.title}`, channel: item.song.artist });
            return { title: item.song.title, artist: item.song.artist || n.artist, genre: n.genre, named: 1, ytTitle, ytArtist };
        }
        const n = await songName({ title: ytTitle, channel: ytArtist, track: info.track, artist: info.artist });
        return { title: n.title, artist: n.artist, genre: n.genre, named: 1, ytTitle, ytArtist };
    } catch (e) { console.error('Could not name the song:', e.message); return {}; }
}
// Errors that won't go away by trying again (the video is gone, private, blocked in this country...).
const FOR_GOOD = /unavailable|private video|has been removed|copyright|not available|age.?restrict|members.?only|account.*terminated|music space/i;
async function runJob(job) {
    job.startedAt = job.startedAt || Date.now();
    // Songs added to this job while it runs (another "Add missing" on the same list) are picked up too.
    const runAll = async () => { do await runItems(job, job.items); while (!job.cancelled && job.items.some(x => x.state === 'waiting')); };
    await runAll();
    // Second chance: songs that failed for a passing reason (connection, YouTube busy) are tried once more at the end.
    const again = job.items.filter(x => x.state === 'failed' && !FOR_GOOD.test(x.msg || ''));
    if (again.length && !job.cancelled) {
        await new Promise(r => setTimeout(r, 20e3));
        for (const x of again) { x.state = 'waiting'; x.pct = 0; x.msg = ''; }
        saveJobs();
        await runAll();
    }
    job.finishedAt = Date.now(); saveJobs();
}
async function runItems(job, list) {
    for (const item of list) {
        saveJobs();
        if (job.cancelled) { if (item.state === 'waiting') item.state = 'cancelled'; continue; }
        if (item.state !== 'waiting' && item.state !== 'working') continue;
        const vid = (item.link.match(/[?&]v=([\w-]+)/) || [])[1];
        const have = library.find(t => t.ytId && t.ytId === vid);
        if (have) {
            item.state = 'skipped'; item.msg = 'Already in Murmur'; item.track = have.id; item.pct = 100;
            if (item.key) await linkToSpotify(item.key, have.id, job.user);
            continue;
        }
        const full = overLimit(job.user);
        if (full) { item.state = 'failed'; item.msg = full; item.pct = 100; continue; }
        item.state = 'working';
        for (let attempt = 1; attempt <= 3 && item.state === 'working' && !job.cancelled; attempt++) {
            if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 4000));
            item.pct = 0;
            const r = await convertOne(item.link, p => { item.pct = Math.max(item.pct, p); }, job);
            if (job.cancelled) { await fsp.rm(r.work, { recursive: true, force: true }).catch(() => {}); break; }
            try {
                const files = listAudio(r.work);
                if (files.length) {
                    const named = await nameForVideo(r.work, item);
                    const track = await addMediaFile(files[0], path.basename(files[0]), job.user, { ytId: vid, ...named });
                    item.track = track.id; item.state = 'done'; job.added++;
                    // A song from an imported Spotify playlist now plays this file ("In Murmur").
                    if (item.key) await linkToSpotify(item.key, track.id, job.user);
                }
                else if (attempt === 3 || FOR_GOOD.test(r.error || '')) { item.state = 'failed'; item.msg = r.error || 'YouTube didn’t give the audio'; }
            } catch (err) {
                if (attempt === 3) { item.state = 'failed'; item.msg = err.message; }
            }
            await fsp.rm(r.work, { recursive: true, force: true }).catch(() => {});
        }
        if (job.cancelled && item.state === 'working') item.state = 'cancelled';
        item.pct = 100;
    }
}
// Anyone signed in can bring songs into the library this way (e.g. the songs of a Spotify playlist they imported).
app.post('/api/convert/jobs', auth.requireUser, (req, res) => {
    const b = req.body || {};
    const items = (Array.isArray(b.items) ? b.items : []).filter(x => x && YT_LINK.test(String(x.link || '')));
    if (!items.length) return res.status(400).json({ error: 'No YouTube links were sent.' });
    if (items.length > MAX_JOB_SONGS) return res.status(400).json({ error: `That’s ${items.length} songs. Murmur gets up to ${MAX_JOB_SONGS} at a time; pick fewer and do the rest after.` });
    // Songs already on their way (in any of this person's running jobs) aren't added twice, and new songs for a list
    // that's already downloading join that job: one progress card, no second one waiting behind it.
    const queued = new Set([...jobs.values()].filter(j => j.userId === req.user.id && !j.finishedAt && !j.cancelled).flatMap(j => j.items.filter(x => ['waiting', 'working'].includes(x.state)).map(x => x.link)));
    const fresh = items.filter((x, i) => !queued.has(x.link) && items.findIndex(y => y.link === x.link) === i);
    const ctxNow = String(b.ctx || '').slice(0, 120);
    const joinTo = [...jobs.values()].find(j => j.userId === req.user.id && !j.finishedAt && !j.cancelled && j.ctx === ctxNow);
    const mkItem = x => ({ link: x.link, title: String(x.title || '').slice(0, 200) || 'YouTube song', key: String(x.key || '').slice(0, 400), state: 'waiting', pct: 0, msg: '',
        song: x.song && typeof x.song.title === 'string' ? { title: String(x.song.title).slice(0, 200), artist: String(x.song.artist || '').slice(0, 200) } : null });
    if (joinTo) { joinTo.items.push(...fresh.map(mkItem)); saveJobs(); return res.json({ job: jobView(joinTo) }); }
    if (!fresh.length) { const any = [...jobs.values()].find(j => j.userId === req.user.id && !j.finishedAt); if (any) return res.json({ job: jobView(any) }); }
    const job = { id: crypto.randomBytes(6).toString('hex'), userId: req.user.id, user: { id: req.user.id, name: req.user.name, role: req.user.role }, label: String(b.label || '').slice(0, 120),
        ctx: String(b.ctx || '').slice(0, 120), createdAt: Date.now(), added: 0,
        items: fresh.map(mkItem) };
    jobs.set(job.id, job); saveJobs();
    jobChain = jobChain.then(() => runJob(job)).catch(err => console.error('YouTube job failed:', err));
    // Forget finished jobs after a day.
    for (const [id, j] of jobs) if (j.finishedAt && Date.now() - j.finishedAt > 24 * 3600e3) jobs.delete(id);
    res.json({ job: jobView(job) });
});
app.get('/api/convert/jobs', auth.requireUser, (req, res) => {
    res.json({ jobs: [...jobs.values()].filter(j => j.userId === req.user.id && !j.dismissed).map(jobView) });
});
// Cancel the songs that haven't started, or (once finished) hide the job.
app.delete('/api/convert/jobs/:id', auth.requireUser, (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j || j.userId !== req.user.id) return res.status(404).json({ error: 'That download isn’t running.' });
    if (j.finishedAt) j.dismissed = true; else { j.cancelled = true; if (j.kill) j.kill(); }   // stops the song downloading now too
    saveJobs();
    res.json({ job: jobView(j) });
});
// Jobs that were running when the server stopped: carry on (the song that was mid-download starts over).
try {
    for (const j of JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))) {
        if (!j || !j.id || !Array.isArray(j.items)) continue;
        jobs.set(j.id, j);
        if (j.finishedAt) continue;
        for (const x of j.items) if (x.state === 'working') { x.state = 'waiting'; x.pct = 0; }
        jobChain = jobChain.then(() => runJob(j)).catch(err => console.error('YouTube job failed:', err));
    }
} catch { /* no saved jobs */ }

app.get('/api/health', (req, res) => res.json({ ok: true }));
// A download to someone's device that failed a try: logged, so the cause can be found.
app.post('/api/me/dl-error', auth.requireUser, (req, res) => { const b = req.body || {}; console.log(`Device download failed (${req.user.name}, try ${Number(b.attempt) || 0}): ${String(b.why || '').slice(0, 200)} | ${String(b.url || '').slice(0, 160)} | ${String(b.ua || '').slice(0, 160)}`); res.json({ ok: true }); });

/* Admin → Servers: how this server is doing. */
const backups = require('./backup')(DATA, auth);
backups.routes(app);
const STARTED = Date.now();
const VERSION = (() => {   // the same app on two servers gives the same code
    const h = crypto.createHash('sha1');
    // Line endings are ignored, so a Windows copy and a Linux copy of the same code match.
    for (const f of ['public/index.html', 'server.js', 'songmeta.js', 'ytaudio.js']) { try { h.update(fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n')); } catch {} }
    return h.digest('hex').slice(0, 8);
})();
async function serverInfo() {
    let disk = null;
    try { const s = await fsp.statfs(DATA); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch {}
    let id = ''; try { id = fs.readFileSync(path.join(DATA, 'server-id.txt'), 'utf8').trim(); } catch {}
    const b = await backups.list();
    return {
        id, version: VERSION, startedAt: STARTED, now: Date.now(), platform: process.platform, node: process.version,
        songs: library.length, musicBytes: library.reduce((n, t) => n + (t.size || 0), 0), users: auth.userCount(),
        disk, names: nameFix, lastBackup: b[0] || null, backups: b.length
    };
}
app.get('/api/admin/server', auth.requireOwner, async (req, res) => res.json(await serverInfo()));
// Other servers ask with the shared sync key (a browser can't reach every server itself).
app.get('/api/sync/info', sync.guard, async (req, res) => res.json(await serverInfo()));
app.post('/api/sync/backup', sync.guard, async (req, res) => { await backups.backUp(); res.json({ ok: true }); });
app.get('/api/sync/backup/:date', sync.guard, async (req, res) => {
    const b = await backups.bundle(String(req.params.date));
    if (!b) return res.status(404).json({ error: 'That backup is gone.' });
    res.json(b);
});
// The servers listed in config.js (the same list people pick from).
function knownServers() {
    let txt = '';
    for (const f of [path.join(__dirname, 'public', 'config.js'), path.join(__dirname, 'config.js')]) { try { txt = fs.readFileSync(f, 'utf8'); break; } catch {} }
    return [...txt.matchAll(/\{\s*name:\s*'([^']+)',\s*url:\s*'(https?:\/\/[^']+)'/g)].map(m => ({ name: m[1], url: m[2].replace(/\/+$/, '') }));
}
app.get('/api/admin/servers', auth.requireOwner, async (req, res) => {
    const me = await serverInfo();
    const out = await Promise.all(knownServers().map(async s => {
        try {
            const r = await sync.askPeer(s.url, '/api/sync/info');
            if (!r.ok) {
                // Older code (no /api/sync/info), or a server that isn't linked by sync: is it up at all?
                const h = await fetch(s.url + '/api/health', { signal: AbortSignal.timeout(8000) }).catch(() => null);
                return { ...s, state: h && h.ok ? 'old' : 'off' };
            }
            const info = await r.json();
            return { ...s, state: 'ok', info, self: info.id === me.id };
        } catch (e) {
            const h = await fetch(s.url + '/api/health', { signal: AbortSignal.timeout(8000) }).catch(() => null);
            return { ...s, state: h && h.ok ? 'old' : 'off' };
        }
    }));
    // This server answers for itself even if it can't reach its own public address.
    if (!out.some(x => x.self)) {
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
        const mine = out.find(x => x.url.replace(/^https?:\/\//, '') === host);
        if (mine) Object.assign(mine, { state: 'ok', info: me, self: true });
        else out.unshift({ name: 'This server', url: '', state: 'ok', info: me, self: true });
    }
    res.json({ servers: out, version: VERSION });
});
const pickServer = url => knownServers().find(s => s.url === String(url || '').replace(/\/+$/, ''));
app.post('/api/admin/servers/backup', auth.requireOwner, async (req, res) => {
    const b = req.body || {};
    if (b.self) { await backups.backUp(); return res.json({ ok: true }); }
    const s = pickServer(b.url);
    if (!s) return res.status(400).json({ error: 'Pick one of the servers.' });
    try {
        const r = await sync.askPeer(s.url, '/api/sync/backup', { method: 'POST', timeout: 60000 });
        res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true } : { error: `${s.name} couldn’t back up.` });
    } catch (e) { res.status(502).json({ error: `${s.name} didn’t answer.` }); }
});
app.get('/api/admin/servers/backup', auth.requireOwner, async (req, res) => {
    const d = String(req.query.date || '');
    let b = null;
    if (req.query.self === '1') b = await backups.bundle(d);
    else {
        const s = pickServer(req.query.url);
        if (!s) return res.status(400).json({ error: 'Pick one of the servers.' });
        try { const r = await sync.askPeer(s.url, '/api/sync/backup/' + encodeURIComponent(d), { timeout: 60000 }); if (r.ok) b = await r.json(); } catch {}
    }
    if (!b) return res.status(404).json({ error: 'Couldn’t get that backup.' });
    res.setHeader('Content-Disposition', `attachment; filename="murmur-backup-${d}.json"`);
    res.json(b);
});
app.get('/api/tracks', (req, res) => res.json({ tracks: library }));

const mediaError = (status, message) => Object.assign(new Error(message), { status, expose: true });
async function addMediaFile(srcPath, original, user, extra = {}) {
    const id = crypto.randomBytes(8).toString('hex');
    const coverPath = path.join(DIRS.covers, id + '.jpg');
    let outPath = null;
    try {
        let info;
        try { info = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', srcPath])); }
        catch { throw mediaError(415, "That isn't a media file Murmur can read."); }

        const streams = info.streams || [];
        const audio = streams.find(s => s.codec_type === 'audio');
        if (!audio) throw mediaError(415, 'That file has no audio track.');
        const isPic = s => s.disposition && s.disposition.attached_pic;
        const pic = streams.find(s => s.codec_type === 'video' && isPic(s));
        const video = streams.find(s => s.codec_type === 'video' && !isPic(s));
        const ext = path.extname(original).slice(1).toLowerCase();
        const tags = lowerKeys({ ...((info.format && info.format.tags) || {}), ...(audio.tags || {}) });
        const duration = parseFloat(info.format && info.format.duration) || parseFloat(audio.duration) || 0;

        const vf = 'scale=480:480:force_original_aspect_ratio=increase,crop=480:480';
        let cover = null;
        try {
            if (pic) await run('ffmpeg', ['-v', 'error', '-y', '-i', srcPath, '-map', `0:${pic.index}`, '-frames:v', '1', '-vf', vf, coverPath]);
            else if (video) await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(duration * 0.1, 10)), '-i', srcPath, '-frames:v', '1', '-vf', vf, coverPath]);
            else if (extra.coverUrl) await run('ffmpeg', ['-v', 'error', '-y', '-i', extra.coverUrl, '-frames:v', '1', '-vf', vf, coverPath]);
            if (fs.existsSync(coverPath)) cover = id + '.jpg';
        } catch { /* no cover is fine */ }

        let file, format;
        if (!video && PLAYABLE.has(ext)) {
            file = `${id}.${ext}`; format = ext; outPath = path.join(DIRS.music, file);
            await move(srcPath, outPath);
        } else {
            file = `${id}.mp3`; format = 'mp3'; outPath = path.join(DIRS.music, file);
            await run('ffmpeg', ['-v', 'error', '-y', '-i', srcPath, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-map_metadata', '0', outPath]);
            await fsp.rm(srcPath, { force: true });
        }

        const guess = guessFromName(original);
        const track = {
            id,
            title: extra.title || tags.title || guess.title,
            artist: extra.artist || tags.artist || tags.album_artist || guess.artist || '',
            album: extra.album != null ? extra.album : (tags.album || ''),
            genre: extra.genre || (/^(music|other|unknown)$/i.test(tags.genre || '') ? '' : tags.genre || ''),
            trackNo: parseInt(tags.track, 10) || 0,
            duration,
            file,
            cover,
            format,
            size: (await fsp.stat(outPath)).size,
            originalName: original,
            fromVideo: !!video,
            uploadedBy: user.id,
            uploaderName: user.name,
            ...(extra.source ? { source: extra.source } : {}),
            ...(extra.ytId ? { ytId: extra.ytId } : {}),
            ...(extra.named ? { named: 1, ytTitle: extra.ytTitle || '', ytArtist: extra.ytArtist || '' } : {}),
            addedAt: new Date().toISOString()
        };
        library.push(track);
        await save();
        console.log(`Added "${track.title}" (${extra.source ? 'from ' + extra.source.name : original})`);
        return track;
    } catch (err) {
        if (!err.expose) console.error('Adding a file failed:', err.stderr || err);
        await Promise.all([srcPath, outPath, coverPath].filter(Boolean).map(p => fsp.rm(p, { force: true })));
        throw err.expose ? err : mediaError(500, "Couldn't convert that file. It may be damaged or use an unsupported codec.");
    }
}

/* Storage limits per person (Admin → Accounts): the music they added counts against it. */
const usedBy = uid => library.reduce((n, t) => n + (t.uploadedBy === uid ? t.size || 0 : 0), 0);
const fmtGB = b => b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : Math.round(b / 1024 ** 2) + ' MB';
function overLimit(user, adding = 0) {
    const lim = auth.storageLimit(user.id);
    if (!lim) return '';
    const used = usedBy(user.id);
    return used + adding > lim ? `You’ve used ${fmtGB(used)} of your ${fmtGB(lim)} of music space. Delete some of your songs, or ask the owner for more.` : '';
}
app.get('/api/me/storage', (req, res) => res.json({ used: usedBy(req.user.id), limit: auth.storageLimit(req.user.id) }));
app.get('/api/admin/storage', auth.requireOwner, (req, res) => {
    const used = {};
    for (const t of library) if (t.uploadedBy) used[t.uploadedBy] = (used[t.uploadedBy] || 0) + (t.size || 0);
    res.json({ used });
});

app.post('/api/upload', auth.requireEdit, upload.single('file'), async (req, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file received.' });
    const full = overLimit(req.user, f.size);
    if (full) { await fsp.rm(f.path, { force: true }); return res.status(413).json({ error: full }); }
    try { res.json({ track: await addMediaFile(f.path, Buffer.from(f.originalname, 'latin1').toString('utf8'), req.user) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

const mayChange = (user, t) => user.role === 'owner' || (!!t.uploadedBy && t.uploadedBy === user.id);
async function deleteIds(ids) {
    const want = new Set(ids), gone = library.filter(t => want.has(t.id));
    library = library.filter(t => !want.has(t.id));
    await save();
    for (const t of gone) {
        await fsp.rm(path.join(DIRS.music, t.file), { force: true });
        if (t.cover) await fsp.rm(path.join(DIRS.covers, t.cover), { force: true });
        console.log(`Deleted "${t.title}"`);
    }
    return gone.map(t => t.id);
}
const idList = b => (b && Array.isArray(b.ids) ? b.ids.filter(x => typeof x === 'string') : []);

app.delete('/api/tracks/:id', auth.requireEdit, async (req, res) => {
    const t = library.find(x => x.id === req.params.id);
    if (t && !mayChange(req.user, t)) return res.status(403).json({ error: 'You can only delete songs you uploaded.' });
    const deleted = await deleteIds([req.params.id]);
    if (!deleted.length) return res.status(404).json({ error: 'That file is already gone.' });
    res.json({ ok: true, deleted });
});

app.post('/api/tracks/delete', auth.requireEdit, async (req, res) => {
    const ids = idList(req.body);
    if (!ids.length) return res.status(400).json({ error: 'No songs were picked.' });
    const mine = ids.filter(id => { const t = library.find(x => x.id === id); return !t || mayChange(req.user, t); });
    if (!mine.length) return res.status(403).json({ error: 'You can only delete songs you uploaded.' });
    res.json({ ok: true, deleted: await deleteIds(mine), skipped: ids.length - mine.length });
});

app.patch('/api/tracks', auth.requireEdit, async (req, res) => {
    const ids = new Set(idList(req.body)), b = req.body || {};
    const found = library.filter(t => ids.has(t.id));
    if (!found.length) return res.status(404).json({ error: 'Those songs are no longer on the server.' });
    const tracks = found.filter(t => mayChange(req.user, t));
    if (!tracks.length) return res.status(403).json({ error: 'You can only edit songs you uploaded.' });
    const clean = v => String(v).replace(/\s+/g, ' ').trim().slice(0, 200);
    for (const t of tracks) {
        if (typeof b.title === 'string' && clean(b.title)) t.title = clean(b.title);
        if (typeof b.artist === 'string') t.artist = clean(b.artist);
        if (typeof b.album === 'string') t.album = clean(b.album);
        if (typeof b.title === 'string' || typeof b.artist === 'string') t.userEdited = 1;   // song-name fixing leaves it alone
    }
    await save();
    res.json({ tracks });
});

/* Songs that came from YouTube before songmeta.js existed are named like their videos ("X - Y (Letra)" by a lyrics
   channel). They're renamed once in the background, a few a minute (Apple's catalog allows about 20 lookups a
   minute). Every server does this in its own random order, and the results sync, so they rarely do the same song. */
const nameFix = { running: false, done: 0, total: 0, changed: 0 };
async function fixSongNames() {
    if (nameFix.running) return;
    nameFix.running = true;
    try {
        const todo = library.filter(t => t.ytId && !t.named && !t.userEdited).map(t => t.id).sort(() => Math.random() - .5);
        Object.assign(nameFix, { done: 0, total: todo.length, changed: 0 });
        for (const id of todo) {
            const t = library.find(x => x.id === id);
            if (!t || t.named || t.userEdited) { nameFix.done++; continue; }
            const ytTitle = t.ytTitle || t.title, ytArtist = t.ytArtist || t.artist;
            const n = await songName({ title: ytTitle, channel: ytArtist });
            const cur = library.find(x => x.id === id);   // (the library may have been replaced by a sync meanwhile)
            if (cur && !cur.named && !cur.userEdited) {
                if (n.title !== cur.title || n.artist !== cur.artist) nameFix.changed++;
                Object.assign(cur, { title: n.title || cur.title, artist: n.artist || cur.artist, named: 1, ytTitle, ytArtist });
                if (n.genre && (!cur.genre || /^(music|other)$/i.test(cur.genre))) cur.genre = n.genre;
                await save();
            }
            nameFix.done++;
        }
        if (todo.length) console.log(`Song names: checked ${todo.length}, renamed ${nameFix.changed}.`);
    } catch (e) { console.error('Fixing song names stopped:', e.message); }
    nameFix.running = false;
}
setTimeout(fixSongNames, 30e3 + Math.random() * 60e3);
setInterval(fixSongNames, 6 * 3600e3);
app.get('/api/tracks/names', auth.requireUser, (req, res) => res.json(nameFix));
// The owner can ask for every YouTube song to be named again (songs someone renamed by hand are left alone).
app.post('/api/tracks/names', auth.requireOwner, (req, res) => {
    for (const t of library) if (t.ytId && !t.userEdited) delete t.named;
    save(); fixSongNames();
    res.json(nameFix);
});

app.locals.ytAudio = require('./ytaudio')(app, auth, DATA, { userRecords: () => userData.syncCollection.get(), matches: () => spotify.syncCollections.matches.get() });   // ad-free YouTube audio through this server
// Big app installers (Murmur for Windows) that don't fit in GitHub: put them in DATA/downloads.
app.use('/downloads', express.static(path.join(DATA, 'downloads'), { maxAge: '1h', fallthrough: false }));
app.use('/media', auth.requireUserFiles, express.static(DIRS.music, { maxAge: '7d', fallthrough: false }));
app.use('/covers', auth.requireUserFiles, express.static(DIRS.covers, { maxAge: '7d', fallthrough: false }));
// The app page itself (~600 KB) is sent compressed (~120 KB), made once each time the page changes.
const pageZip = { mtime: 0 };
app.get(['/', '/index.html'], (req, res, next) => {
    const enc = takesEnc(req), file = path.join(__dirname, 'public', 'index.html');
    if (!enc) return next();
    let st; try { st = fs.statSync(file); } catch { return next(); }
    if (pageZip.mtime !== st.mtimeMs) {
        const raw = fs.readFileSync(file);
        Object.assign(pageZip, {
            mtime: st.mtimeMs, etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"',
            br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
            gzip: zlib.gzipSync(raw, { level: 9 })
        });
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', pageZip.etag + enc);
    if (req.headers['if-none-match'] === pageZip.etag + enc) return res.status(304).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Encoding', enc);
    res.send(pageZip[enc]);
});
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, file) {
        if (/\.(html|webmanifest)$/.test(file) || file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    }
}));

app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `That file is over the ${MAX_MB} MB limit.` });
    if (err && err.status === 404) return res.status(404).json({ error: 'Not found.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
});

Object.assign(deferred, {
    users: auth.syncCollections.users,
    sessions: auth.syncCollections.sessions,
    tracks: {
        get: () => Object.fromEntries(library.map(t => [t.id, t])),
        set: o => {
            const keep = new Set(Object.keys(o));
            for (const t of library) if (!keep.has(t.id)) {
                fs.rm(path.join(DIRS.music, t.file), { force: true }, () => {});
                if (t.cover) fs.rm(path.join(DIRS.covers, t.cover), { force: true }, () => {});
            }
            library = Object.values(o).sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
            save();
        }
    },
    library: userData.syncCollection,
    imports: spotify.syncCollections.imports,
    matches: spotify.syncCollections.matches,
    spotifyApp: spotify.syncCollections.spotifyApp,
    youtube: youtube.syncCollection,
    mail: mail.syncCollection,
    sources: sources.syncCollection,
    ytcache: app.locals.ytAudio.syncCollection,   // liked songs kept on disk (their files sync too)
    activity: activity.syncCollection
});
sync.start();

// Leftover temporary files: cleared once this server is really up (a second copy that can't get the port
// must not wipe downloads in progress), and only ones older than an hour.
function clearOldTmp() {
    for (const f of fs.readdirSync(DIRS.tmp)) {
        const p = path.join(DIRS.tmp, f);
        try { if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true, recursive: true }); } catch { /* already gone */ }
    }
}
const server = app.listen(PORT, () => {
    console.log(`Murmur is running at http://localhost:${PORT} (data in ${DATA}). Players allowed from: ${ALLOWED_ORIGINS.join(', ')}`);
    clearOldTmp(); setInterval(clearOldTmp, 6 * 3600e3).unref();
});
server.on('error', err => {
    if (err.code === 'EADDRINUSE') { console.error(`Port ${PORT} is already in use: another Murmur server is running here. This one is stopping.`); process.exit(1); }
    throw err;
});