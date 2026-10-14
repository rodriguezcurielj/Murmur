// convert.js — the CORE. Turns YouTube links into audio files using yt-dlp.
// It doesn't know about the website at all, so any front end (web page, command line, app) can use it.
//
// INPUT:  links  -> array of YouTube links (videos, playlists or channels)
//         format -> 'mp3' or 'm4a'
//         onLine -> function that receives each progress line (text)
//         done   -> function called once at the end with the exit code (0 = all good)
// OUTPUT: audio files saved to OUT_DIR/<channel name>/<video title>.<format>

const path = require('path');               // builds file paths that work on Windows and Linux
const os = require('os');                   // finds your home folder
const { spawn } = require('child_process'); // runs yt-dlp as a separate program

// OUTPUT folder. Default: C:\Users\<you>\Music\yt2audio  — change this line to save somewhere else.
const OUT_DIR = path.join(os.homedir(), 'Music', 'yt2audio');

function convert(links, format, onLine, done) {
  // Options passed to yt-dlp
  const args = [
    '-x', '--audio-format', format,                              // keep audio only, in the chosen format
    '--audio-quality', '0',                                      // best quality
    '--embed-metadata',                                          // store title/artist inside the file
    '--download-archive', path.join(OUT_DIR, '.done.txt'),       // remembers finished videos so re-runs skip them
    '--ignore-errors',                                           // one bad video doesn't stop the rest
    '--no-overwrites',                                           // never replace a file that already exists
    '--newline',                                                 // print progress one line at a time
    '-o', path.join(OUT_DIR, '%(channel)s', '%(title)s.%(ext)s'), // OUTPUT: where and how files are named
    '--', ...links                                               // INPUT: the links go last
  ];

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
