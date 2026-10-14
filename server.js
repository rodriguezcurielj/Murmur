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

const PORT = Number(process.env.PORT) || 8080;
const DATA = path.resolve(process.env.DATA_DIR || './data');
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const DIRS = { music: path.join(DATA, 'music'), covers: path.join(DATA, 'covers'), tmp: path.join(DATA, 'tmp') };
const DB = path.join(DATA, 'library.json');
const PLAYABLE = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
for (const f of fs.readdirSync(DIRS.tmp)) fs.rmSync(path.join(DIRS.tmp, f), { force: true, recursive: true });

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
// Behind the tunnel every request arrives from the tunnel container; trust its
// X-Forwarded-* headers so wrong-PIN limits apply per real visitor and cookies get Secure.
app.set('trust proxy', 'loopback, uniquelocal');
// Players hosted elsewhere (GitHub Pages) that may sign in to this server. Comma-separated.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://rodriguezcurielj.github.io').split(',').map(s => s.trim()).filter(Boolean);
const auth = createAuth(path.join(DATA, 'auth.json'), { allowedOrigins: ALLOWED_ORIGINS });
app.use(auth.cors);
app.use(auth.sameOrigin);
// Server-to-server sync (see sync.js). Its endpoints use their own key instead of a sign-in.
const deferred = {};   // what to keep in sync; filled in below, once every part of the server exists
const sync = createSync(DATA, deferred, {
  files: () => library.flatMap(t => ['music/' + t.file, ...(t.cover ? ['covers/' + t.cover] : [])])
});
sync.routes(app);
app.use(sync.middleware);
app.use('/api', express.json({ limit: '10mb' }));   // imported Spotify playlists can be large
app.use('/api', auth.requireUser);
const spotify = createSpotify(DATA, auth, { hasFile: id => library.some(t => t.id === id) });
const userData = createUserData(DATA, auth, { importsFor: spotify.importsFor });
// Deleting a person also deletes their library (liked songs, playlists, history).
app.delete('/api/users/:id', auth.requireOwner, (req, res, next) => {
  const id = req.params.id;
  res.on('finish', () => { if (res.statusCode < 300) { userData.removeUser(id); sources.removeUser(id); } });
  next();
});
auth.routes(app);
const youtube = createYouTube(path.join(DATA, 'settings.json'), auth);
youtube.routes(app);
createDiscover().routes(app);
spotify.routes(app);
userData.routes(app);
const upload = multer({ dest: DIRS.tmp, limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });

const sources = createSources(DATA, auth, {
  tmpDir: DIRS.tmp, maxBytes: MAX_MB * 1024 * 1024,
  addFile: (p, name, user, extra) => addMediaFile(p, name, user, extra),
  linkToSong: (key, fileId, user) => spotify.setFileMatch(key, fileId, user)
});
sources.routes(app);

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/tracks', (req, res) => res.json({ tracks: library }));

// Adds a media file to the library: reads its tags and cover, converts it to MP3 if browsers can't play it.
// Used by uploads and by download sources. "extra" can set the title/artist/album and where the file came from.
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

    // Cover art: embedded picture, or a frame from the video, or one the source provided.
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

// Songs uploaded before uploads had owners belong to the owner.
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

// Bulk delete: { ids: [...] }
app.post('/api/tracks/delete', auth.requireEdit, async (req, res) => {
  const ids = idList(req.body);
  if (!ids.length) return res.status(400).json({ error: 'No songs were picked.' });
  const mine = ids.filter(id => { const t = library.find(x => x.id === id); return !t || mayChange(req.user, t); });
  if (!mine.length) return res.status(403).json({ error: 'You can only delete songs you uploaded.' });
  res.json({ ok: true, deleted: await deleteIds(mine), skipped: ids.length - mine.length });
});

// Bulk edit: { ids: [...], title?, artist?, album? }. Fields left out are kept.
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

app.use('/media', auth.requireUserFiles, express.static(DIRS.music, { maxAge: '7d', fallthrough: false }));
app.use('/covers', auth.requireUserFiles, express.static(DIRS.covers, { maxAge: '7d', fallthrough: false }));
// The app shell is revalidated on every load so updates reach installed copies;
// the service worker keeps the last good version for offline use.
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

// What sync keeps the same on every server.
Object.assign(deferred, {
  users: auth.syncCollections.users,
  sessions: auth.syncCollections.sessions,
  tracks: {
    get: () => Object.fromEntries(library.map(t => [t.id, t])),
    set: o => {
      const keep = new Set(Object.keys(o));
      // Songs deleted on another server: delete their files here too.
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
  sources: sources.syncCollection
});
sync.start();

app.listen(PORT, () => console.log(`Murmur is running at http://localhost:${PORT} (data in ${DATA}). Players allowed from: ${ALLOWED_ORIGINS.join(', ')}`));
