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
const createAuth = require('./auth');
const createYouTube = require('./youtube');
const createSpotify = require('./spotify');
const createDiscover = require('./discover');
const createUserData = require('./userdata');
const createSync = require('./sync');
const createSources = require('./sources');

// --- INTEGRATED YOUTUBE CONVERTER MODULE ---
const { convert, OUT_DIR } = require('./sources/youtube_stuff/convert');

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

const deferred = {};
const sync = createSync(DATA, deferred, {
    files: () => [...library.flatMap(t => ['music/' + t.file, ...(t.cover ? ['covers/' + t.cover] : [])]), ...(app.locals.ytAudio ? app.locals.ytAudio.files() : [])]
});
sync.routes(app);
app.use(sync.middleware);
app.use('/api', express.json({ limit: '10mb' }));
app.use('/api', auth.requireUser);

const spotify = createSpotify(DATA, auth, { hasFile: id => library.some(t => t.id === id) });
const userData = createUserData(DATA, auth, { importsFor: spotify.importsFor });

app.delete('/api/users/:id', auth.requireOwner, (req, res, next) => {
    const id = req.params.id;
    res.on('finish', () => { if (res.statusCode < 300) { userData.removeUser(id); sources.removeUser(id); } });
    next();
});
auth.routes(app);
const youtube = createYouTube(path.join(DATA, 'settings.json'), auth);
youtube.routes(app);
createDiscover(DATA).routes(app);
spotify.routes(app);
userData.routes(app);

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
const YT_LINK = /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{6,20}$/;
const jobView = j => ({ id: j.id, label: j.label, ctx: j.ctx, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, cancelled: !!j.cancelled,
    items: j.items.map(x => ({ title: x.title, state: x.state, pct: x.pct, msg: x.msg, track: x.track })) });

async function linkToSpotify(key, fileId, user) { try { await spotify.setFileMatch(key, fileId, user); } catch (e) { console.error('Could not link the song:', e.message); } }
function convertOne(link, onPct) {
    return new Promise(resolve => {
        const work = path.join(DIRS.tmp, 'yt-' + crypto.randomBytes(6).toString('hex'));
        fs.mkdirSync(work, { recursive: true });
        let skipped = false, lastErr = '';
        convert([link], 'mp3', line => {
            let m;
            if ((m = line.match(/^\[download\]\s+([\d.]+)%/))) onPct(Math.round(parseFloat(m[1]) * 0.8));
            else if (/^\[ExtractAudio\]/.test(line)) onPct(85);
            else if (/^\[(Metadata|EmbedThumbnail)\]/.test(line)) onPct(95);
            else if (/has already been recorded in the archive/.test(line)) skipped = true;
            else if (/^ERROR:/.test(line)) lastErr = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '');
        }, code => resolve({ code, work, skipped, error: lastErr }), { outDir: work, archive: false });
    });
}
async function runJob(job) {
    job.startedAt = Date.now();
    for (const item of job.items) {
        if (job.cancelled) { if (item.state === 'waiting') item.state = 'cancelled'; continue; }
        const vid = (item.link.match(/[?&]v=([\w-]+)/) || [])[1];
        const have = library.find(t => t.ytId && t.ytId === vid);
        if (have) {
            item.state = 'skipped'; item.msg = 'Already in Murmur'; item.track = have.id; item.pct = 100;
            if (item.key) await linkToSpotify(item.key, have.id, job.user);
            continue;
        }
        item.state = 'working';
        for (let attempt = 1; attempt <= 2 && item.state === 'working'; attempt++) {
            item.pct = 0;
            const r = await convertOne(item.link, p => { item.pct = Math.max(item.pct, p); }, vid);
            try {
                const files = listAudio(r.work);
                if (files.length) {
                    const track = await addMediaFile(files[0], path.basename(files[0]), job.user, { ytId: vid });
                    item.track = track.id; item.state = 'done'; job.added++;
                    // A song from an imported Spotify playlist now plays this file ("In Murmur").
                    if (item.key) await linkToSpotify(item.key, track.id, job.user);
                }
                else if (attempt === 2) { item.state = 'failed'; item.msg = r.error || 'YouTube didn’t give the audio'; }
            } catch (err) {
                if (attempt === 2) { item.state = 'failed'; item.msg = err.message; }
            }
            await fsp.rm(r.work, { recursive: true, force: true }).catch(() => {});
        }
        item.pct = 100;
    }
    job.finishedAt = Date.now();
}
app.post('/api/convert/jobs', auth.requireUser, auth.requireEdit, (req, res) => {
    const b = req.body || {};
    const items = (Array.isArray(b.items) ? b.items : []).filter(x => x && YT_LINK.test(String(x.link || '')));
    if (!items.length) return res.status(400).json({ error: 'No YouTube links were sent.' });
    if (items.length > MAX_JOB_SONGS) return res.status(400).json({ error: `That’s ${items.length} songs. Murmur gets up to ${MAX_JOB_SONGS} at a time; pick fewer and do the rest after.` });
    const job = { id: crypto.randomBytes(6).toString('hex'), userId: req.user.id, user: req.user, label: String(b.label || '').slice(0, 120),
        ctx: String(b.ctx || '').slice(0, 120), createdAt: Date.now(), added: 0,
        items: items.map(x => ({ link: x.link, title: String(x.title || '').slice(0, 200) || 'YouTube song', key: String(x.key || '').slice(0, 400), state: 'waiting', pct: 0, msg: '' })) };
    jobs.set(job.id, job);
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
    if (j.finishedAt) j.dismissed = true; else j.cancelled = true;
    res.json({ job: jobView(j) });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
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
            genre: tags.genre || '',
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

app.post('/api/upload', auth.requireEdit, upload.single('file'), async (req, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file received.' });
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
    }
    await save();
    res.json({ tracks });
});

app.locals.ytAudio = require('./ytaudio')(app, auth, DATA, { userRecords: () => userData.syncCollection.get(), matches: () => spotify.syncCollections.matches.get() });   // ad-free YouTube audio through this server
app.use('/media', auth.requireUserFiles, express.static(DIRS.music, { maxAge: '7d', fallthrough: false }));
app.use('/covers', auth.requireUserFiles, express.static(DIRS.covers, { maxAge: '7d', fallthrough: false }));
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
    sources: sources.syncCollection,
    ytcache: app.locals.ytAudio.syncCollection   // liked songs kept on disk (their files sync too)
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