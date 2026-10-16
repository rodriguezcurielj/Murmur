// convert.js — the CORE. Turns YouTube links into audio files using yt-dlp.
// It doesn't know about the website at all, so any front end (web page, command line, app) can use it.
//
// INPUT:  links  -> array of YouTube links (videos, playlists or channels)
//         format -> 'mp3' or 'm4a'
//         onLine -> function that receives each progress line (text)
//         done   -> function called once at the end with the exit code (0 = all good)
// OUTPUT: audio files saved to OUT_DIR/<channel name>/<video title>.<format>

const path = require('path');               // builds file paths that work on Windows and Linux
const fs = require('fs');                   // checks for cookies file existence
const os = require('os');                   // finds your home folder
const { spawn } = require('child_process'); // runs yt-dlp as a separate program

// OUTPUT folder. Default: C:\Users\<you>\Music\yt2audio  — change this line to save somewhere else.
const OUT_DIR = path.join(os.homedir(), 'Music', 'yt2audio');

// opts (optional): { outDir, archive } — save somewhere other than OUT_DIR, and keep the
//                  list of finished videos in a different file.
function convert(links, format, onLine, done, opts = {}) {
    const outDir = opts.outDir || OUT_DIR;
    // archive: false turns off yt-dlp's "already downloaded" list (Murmur checks its own library instead).
    const archive = opts.archive === false ? null : opts.archive || path.join(OUT_DIR, '.done.txt');

// Options passed to yt-dlp
    const args = [
        '-x', '--audio-format', format,                              // keep audio only, in the chosen format
        '--audio-quality', '0',                                      // best quality
        '--embed-metadata',                                          // store title/artist inside the file
        '--embed-thumbnail',                                         // store the video thumbnail as cover art
        '--ignore-errors',                                           // one bad video doesn't stop the rest
        '--no-overwrites',                                           // never replace a file that already exists
        '--newline',                                                 // print progress one line at a time
        '--remote-components', 'ejs:github',                         // auto-fetch challenge components
        '--js-runtimes', 'deno',                                     // use Deno runtime for EJS scripts...
        '--js-runtimes', 'node',                                     // ...or Node.js where Deno isn't installed (e.g. 32-bit ARM)
        '--extractor-args', 'youtube:player_client=web_safari,web_embedded,-tv_downgraded', // bypass web client blocks
        // OUTPUT: where and how files are named. Murmur's server names files by video id: titles with accents
        // (Virlán García) break ffmpeg's cover step on Windows. The real title and artist are stored inside the file.
        '-o', opts.outDir ? path.join(outDir, '%(id)s.%(ext)s') : path.join(outDir, '%(channel)s', '%(title)s.%(ext)s'),
    ];

    if (archive) args.push('--download-archive', archive);
    if (opts.infoJson) args.push('--write-info-json', '--no-write-playlist-metafiles');   // the video's details, for naming the song           // remembers finished videos so re-runs skip them
    // YouTube sign-in cookies (cookies.txt) are private: they live in the server's data folder (DATA_DIR), never in
    // git or the Docker image. The project folder is still checked for older setups.
    const cookiesPath = [process.env.DATA_DIR && path.join(process.env.DATA_DIR, 'cookies.txt'), path.resolve(__dirname, '../../cookies.txt')]
        .find(p => p && fs.existsSync(p));
    if (cookiesPath) {
        onLine('Using cookies.txt for YouTube authentication.');
        args.push('--cookies', cookiesPath);
    }

    // Push input links to the end of the argument list
    args.push('--', ...links);

    // Start yt-dlp
    const p = spawn('yt-dlp', args);

    // yt-dlp prints text in chunks; split it into whole lines and send each one to onLine
    let buf = '';
    const read = chunk => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();                       // keep any unfinished line for the next chunk
        lines.forEach(l => l && onLine(l));
    };
    p.stdout.on('data', read);                 // normal output
    p.stderr.on('data', read);                 // warnings and errors

    // yt-dlp couldn't be started (usually not installed)
    p.on('error', () => {
        onLine('yt-dlp not found. Run: winget install yt-dlp.yt-dlp Gyan.FFmpeg, then reopen PowerShell.');
        done(1);
    });

    // yt-dlp finished
    p.on('close', code => {
        if (buf) onLine(buf);                    // send any leftover text
        done(code);
    });
}

// Share convert() and OUT_DIR with server.js (or any other file that wants them)
module.exports = { convert, OUT_DIR };