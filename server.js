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
app.use('/api', express.json({ limit: '1mb' }));
const upload = multer({ dest: DIRS.tmp, limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });

app.get('/api/health', (req, res) => res.json({ ok: true, tracks: library.length }));
app.get('/api/tracks', (req, res) => res.json({ tracks: library }));

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'No file received.' });
  const id = crypto.randomBytes(8).toString('hex');
  const coverPath = path.join(DIRS.covers, id + '.jpg');
  let outPath = null;
  try {
    const original = Buffer.from(f.originalname, 'latin1').toString('utf8');
    let info;
    try { info = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f.path])); }
    catch { await fsp.rm(f.path, { force: true }); return res.status(415).json({ error: "That isn't a media file Murmur can read." }); }

    const streams = info.streams || [];
    const audio = streams.find(s => s.codec_type === 'audio');
    if (!audio) { await fsp.rm(f.path, { force: true }); return res.status(415).json({ error: 'That file has no audio track.' }); }
    const isPic = s => s.disposition && s.disposition.attached_pic;
    const pic = streams.find(s => s.codec_type === 'video' && isPic(s));
    const video = streams.find(s => s.codec_type === 'video' && !isPic(s));
    const ext = path.extname(original).slice(1).toLowerCase();
    const tags = lowerKeys({ ...((info.format && info.format.tags) || {}), ...(audio.tags || {}) });
    const duration = parseFloat(info.format && info.format.duration) || parseFloat(audio.duration) || 0;

    // Cover art: embedded picture, or a frame from the video.
    const vf = 'scale=480:480:force_original_aspect_ratio=increase,crop=480:480';
    let cover = null;
    try {
      if (pic) await run('ffmpeg', ['-v', 'error', '-y', '-i', f.path, '-map', `0:${pic.index}`, '-frames:v', '1', '-vf', vf, coverPath]);
      else if (video) await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(duration * 0.1, 10)), '-i', f.path, '-frames:v', '1', '-vf', vf, coverPath]);
      if (fs.existsSync(coverPath)) cover = id + '.jpg';
    } catch { /* no cover is fine */ }

    let file, format;
    if (!video && PLAYABLE.has(ext)) {
      file = `${id}.${ext}`; format = ext; outPath = path.join(DIRS.music, file);
      await move(f.path, outPath);
    } else {
      file = `${id}.mp3`; format = 'mp3'; outPath = path.join(DIRS.music, file);
      await run('ffmpeg', ['-v', 'error', '-y', '-i', f.path, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-map_metadata', '0', outPath]);
      await fsp.rm(f.path, { force: true });
    }

    const guess = guessFromName(original);
    const track = {
      id,
      title: tags.title || guess.title,
      artist: tags.artist || tags.album_artist || guess.artist || '',
      album: tags.album || '',
      trackNo: parseInt(tags.track, 10) || 0,
      duration,
      file,
      cover,
      format,
      size: (await fsp.stat(outPath)).size,
      originalName: original,
      fromVideo: !!video,
      addedAt: new Date().toISOString()
    };
    library.push(track);
    await save();
    console.log(`Added "${track.title}" (${original})`);
    res.json({ track });
  } catch (err) {
    console.error('Upload failed:', err.stderr || err);
    await Promise.all([f.path, outPath, coverPath].filter(Boolean).map(p => fsp.rm(p, { force: true })));
    res.status(500).json({ error: "Couldn't convert that file. It may be damaged or use an unsupported codec." });
  }
});

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

app.delete('/api/tracks/:id', async (req, res) => {
  const deleted = await deleteIds([req.params.id]);
  if (!deleted.length) return res.status(404).json({ error: 'That file is already gone.' });
  res.json({ ok: true, deleted });
});

// Bulk delete: { ids: [...] }
app.post('/api/tracks/delete', async (req, res) => {
  const ids = idList(req.body);
  if (!ids.length) return res.status(400).json({ error: 'No songs were picked.' });
  res.json({ ok: true, deleted: await deleteIds(ids) });
});

// Bulk edit: { ids: [...], title?, artist?, album? }. Fields left out are kept.
app.patch('/api/tracks', async (req, res) => {
  const ids = new Set(idList(req.body)), b = req.body || {};
  const tracks = library.filter(t => ids.has(t.id));
  if (!tracks.length) return res.status(404).json({ error: 'Those songs are no longer on the server.' });
  const clean = v => String(v).replace(/\s+/g, ' ').trim().slice(0, 200);
  for (const t of tracks) {
    if (typeof b.title === 'string' && clean(b.title)) t.title = clean(b.title);
    if (typeof b.artist === 'string') t.artist = clean(b.artist);
    if (typeof b.album === 'string') t.album = clean(b.album);
  }
  await save();
  res.json({ tracks });
});

app.use('/media', express.static(DIRS.music, { maxAge: '7d', fallthrough: false }));
app.use('/covers', express.static(DIRS.covers, { maxAge: '7d', fallthrough: false }));
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

app.listen(PORT, () => console.log(`Murmur is running at http://localhost:${PORT} (data in ${DATA})`));
