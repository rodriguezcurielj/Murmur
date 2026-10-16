// Song names for songs that came from YouTube. A video is called something like
// "Fuerza Regida, Manuel Turizo - UNA CERVEZA (Letra) || ¿qué estás haciendo?" and uploaded by a lyrics
// channel, so the song gets a real title ("UNA CERVEZA"), the real artists ("Fuerza Regida, Manuel Turizo") and
// keeps what kind of version it is: "(Remix)", "(Instrumental)", "(Slowed)", "(En Vivo)", "(blackbear Remix)".
// Featured artists go in the artist list, like Spotify shows them.
//
// First the video title is cleaned up; then Apple's free song catalog (iTunes Search, no key) is asked, and when it
// clearly has the same song its spelling of the title and artists is used, plus its genre.

const VERSION = /\b(remix(es)?|rmx|mix|instrumental|slowed|reverb|sped[\s-]*up|speed[\s-]*up|nightcore|acoustic|ac[uú]stic[oa]|live|en vivo|en directo|remaster(ed)?|version|versi[oó]n|edit|cover|extended|karaoke|bootleg|flip|vip|demo|unplugged|a ?cappella|acapella|8d|bass ?boost(ed)?|epicenter|piano|orchestral|sierreñ[oa]|banda|mariachi|tumbado|corrido|lofi|lo-fi|chopped|screwed|muffled|underwater|bachata|cumbia|ballad|balada|radio edit|clean|explicit|tiktok)\b/i;
const FEAT = /^\s*(feat\.?|ft\.?|featuring|con|with|w\/)\s+/i;
const JUNK = /\b(official|oficial|video|v[ií]deo|audio|lyrics?|letras?|visuali[sz]er|hd|hq|4k|1080p|720p|mv|m\/v|clip|estreno|exclusiv[oa]|premiere|subtitulad[oa]|sub|español|english|full song|topic|records|music group|entertainment|prod\.?|dir\.?|shot by|in4k)\b/i;
const LABELY = /\b(records|music group|entertainment|lyrics|letras|music|radio|tv|channel|beats|vevo|oficial|official|label|studio|network|media|nation|world|hits|mx|latino)\b/i;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const tidy = s => String(s || '').replace(/\s+/g, ' ').replace(/^[\s\-–—|:·~,.]+|[\s\-–—|:·~,]+$/g, '').trim();

// "Peso Pluma - Topic", "BadBunnyVEVO", "TornillO Oficial" -> the artist name
function cleanChannel(c) {
    return tidy(String(c || '').replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/\s+(oficial|official|official channel|music)$/i, ''));
}
function splitArtists(s) {
    return tidy(s).split(/\s*(?:,|&| x | X | y | and | feat\.? | ft\.? | featuring | con | with | vs\.? )\s*/).map(tidy).filter(Boolean);
}
function uniq(list) {
    const seen = new Set();
    return list.filter(a => { const k = norm(a); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

/* The video's title (and channel) -> { title, artists[], versions[] } */
function parseVideoTitle(raw, channel) {
    let s = String(raw || '').replace(/[“”«»]/g, '"').replace(/\s+/g, ' ').trim();
    const versions = [], feats = [];
    s = s.replace(/^\s*\d{1,3}\s*[.)-]\s+/, '');                              // "05. Tornillo - ..."
    // Bracketed parts: keep the kind of version and featured artists, drop "(Official Video)" and the like.
    s = s.replace(/[([{【]([^)\]}】]*)[)\]}】]/g, (m, inner) => {
        inner = tidy(inner);
        if (FEAT.test(inner)) { feats.push(...splitArtists(inner.replace(FEAT, ''))); return ' '; }
        if (VERSION.test(inner)) {
            const v = inner.split(/\s*[\/|+]\s*/).map(x => tidy(x.replace(JUNK, ''))).filter(x => x && VERSION.test(x)).join(', ');
            if (v) { versions.push(v); return ' '; }
        }
        return '  ';   // "(Lyrics)", "[Official Video]": anything after it is usually a lyric quote
    }).replace(/\s*[\[(]\s*/g, ' - ');
    // Text after "(Lyrics)" that isn't "- Artist" is dropped.
    s = s.replace(/\s+\/(?!\/)\S.*$/, '').replace(/\s*(?![\s–—~-]).*$/, '').replace(//g, ' ');
    // "Song | Album", "Song // Lyrics", "Vietsub | Song - Artist | ...", "MANÁ || Vivir sin Aire"
    const segs = s.split(/\s*°?\|{1,2}\s*|\s+\/\/\s+/).map(tidy).filter(Boolean);
    const dashed = x => /\s[-–—~]\s|\S-\s|\s-\S/.test(x);
    if (segs.length > 1 && !dashed(segs[0])) {
        const d = segs.find(dashed);
        s = d || (segs[0].split(' ').length <= 4 && !JUNK.test(segs[1]) ? segs[0] + ' - ' + segs[1] : segs[0]);
    } else s = segs[0] || '';
    // "feat. X" outside brackets
    s = s.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+(.+?)(?=\s+[-–—]\s+|$)/i, (m, who) => { feats.push(...splitArtists(who)); return ''; });
    // Words like "Letra", "Official Video" left without brackets.
    s = s.replace(/\s+(?:\(|-)?\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyric(?:s)?(?:\s+video)?|letras?|visuali[sz]er)(?:\s+oficial|\s+official)?\s*$/i, '');
    let parts = s.split(/\s+[-–—~]\s+|\s+-(?=\S)|(?<=\S)-\s+/).map(tidy).filter(p => p && !/^(19|20)\d\d$/.test(p) && !(JUNK.test(p) && p.split(' ').length <= 4 && !VERSION.test(p)) && !/\b(records|music group)\b/i.test(p));
    const ch = cleanChannel(channel), chKey = norm(ch);
    let title, artists = [];
    if (parts.length >= 2) {
        // Which part is the artist? The one naming the channel; otherwise "Artist - Song".
        let ai = chKey ? parts.findIndex(p => norm(p) === chKey || norm(p).includes(chKey) || (chKey.includes(norm(p)) && norm(p).length > 3)) : -1;
        // "Song - Artist A, Artist B": the side that lists several people is the artists.
        const many = x => /,| x | & | y /i.test(x);
        if (ai < 0 && many(parts[1]) && !many(parts[0])) ai = 1;
        const a = ai >= 0 ? ai : 0, ti = a === 0 ? 1 : 0;
        artists = splitArtists(parts[a]); title = parts[ti];
        for (let i = 0; i < parts.length; i++) if (i !== a && i !== ti && VERSION.test(parts[i])) versions.push(parts[i]);
    } else {
        title = parts[0] || tidy(raw);
        if (ch && !LABELY.test(String(channel))) artists = splitArtists(ch);
    }
    title = tidy(title.replace(/^"|"$/g, ''));
    return { title, artists: uniq([...artists, ...feats]), feats: uniq(feats), versions: uniq(versions), channel: ch };
}

const versionText = vs => vs.map(v => `(${v.replace(/^(.)/, c => c.toUpperCase())})`).join(' ');
const baseOf = t => tidy(String(t).replace(/\s*[([][^)\]]*[)\]]/g, ''));

/* Apple's catalog: { title, artists[], genre } for the same song, or null. */
let lastAsk = 0, pausedUntil = 0;
async function lookup(p, hay) {
    if (Date.now() < pausedUntil) return null;
    const term = [p.artists[0] || '', baseOf(p.title)].join(' ').trim();
    if (!term) return null;
    const wait = lastAsk + 3200 - Date.now();               // Apple allows about 20 searches a minute
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAsk = Date.now();
    let res;
    try {
        const r = await fetch('https://itunes.apple.com/search?entity=song&limit=10&term=' + encodeURIComponent(term), { signal: AbortSignal.timeout(8000) });
        if (r.status === 403 || r.status === 429) { pausedUntil = Date.now() + 120e3; return null; }
        if (!r.ok) return null;
        res = (await r.json()).results || [];
    } catch { return null; }
    const want = norm(baseOf(p.title)), hayN = ' ' + norm(hay) + ' ';
    const wantVer = p.versions.some(v => /remix|mix|live|en vivo|acoustic|ac[uú]stic/i.test(v));
    let best = null, bestScore = 0;
    for (const x of res) {
        const name = String(x.trackName || ''), got = norm(baseOf(name.replace(/\s*\[[^\]]*\]/g, '')));
        // The same song name (or the name appears in the video title, e.g. "MI ENTORNO - VIRLAN GARCIA").
        if (!got || !(got === want || (want.length > 4 && (got.startsWith(want) || want.startsWith(got))) || (got.length >= 4 && hayN.includes(' ' + got + ' ')))) continue;
        const arts = splitArtists(x.artistName || '');
        if (!arts.some(a => norm(a).length > 1 && hayN.includes(' ' + norm(a) + ' '))) continue;   // a different artist's song
        const isVer = /remix|mix\)|live|en vivo|acoustic|ac[uú]stic|instrumental|sped|slowed/i.test(name);
        // Prefer the same artists (not a duet version with someone else) and the same kind of version.
        const allThere = arts.every(a => hayN.includes(' ' + norm(a) + ' '));
        let score = 1 + (got === want ? 1 : 0) + (isVer === wantVer ? 1 : 0) + (allThere ? 2 : 0);
        if (score > bestScore) { best = x; bestScore = score; }
    }
    if (!best) return null;
    const name = String(best.trackName);
    const feats = [];
    const title = tidy(name.replace(/\s*[([](?:feat\.?|ft\.?|with|con)\s+([^)\]]+)[)\]]/gi, (m, who) => { feats.push(...splitArtists(who)); return ''; }));
    return { title, artists: uniq([...splitArtists(best.artistName), ...feats]), genre: String(best.primaryGenreName || '') };
}

/* The name a YouTube song should have in Murmur. info: { title, channel, track, artist } (yt-dlp's fields when known). */
async function songName(info, opts = {}) {
    const raw = String(info.title || ''), channel = String(info.channel || info.uploader || '');
    let p;
    if (info.track && info.artist) {
        // YouTube Music already knows the song ("Topic" channels and official uploads).
        p = parseVideoTitle(info.track, info.artist);
        p.artists = uniq([...splitArtists(info.artist), ...p.artists]);
    } else p = parseVideoTitle(raw, channel);
    const out = { title: p.title, artist: p.artists.join(', ') || cleanChannel(channel), genre: '' };
    const apple = opts.lookup === false ? null : await lookup(p, `${raw} ${channel} ${info.artist || ''}`);
    if (apple) {
        // Apple's spelling of the song, plus the kind of version the video is (unless Apple's name already says it).
        // (a live or remix version Apple lists isn't kept when the video doesn't say so)
        const base = p.versions.length ? apple.title : tidy(apple.title.replace(/\s*[([]([^)\]]*)[)\]]/g, (m, x) => VERSION.test(x) ? '' : m));
        const extra = p.versions.filter(v => !norm(base).includes(norm(v)));
        out.title = tidy(`${base} ${versionText(extra)}`);
        out.artist = uniq([...apple.artists, ...p.feats]).join(', ');
        out.genre = apple.genre;
        out.matched = true;
    } else if (p.versions.length) out.title = tidy(`${p.title} ${versionText(p.versions.filter(v => !norm(p.title).includes(norm(v))))}`);
    if (!out.title) out.title = tidy(raw) || 'Untitled';
    return out;
}

module.exports = { songName, parseVideoTitle };
