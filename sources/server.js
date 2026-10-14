// server.js — the local web server. Connects the web page (INPUT) to convert.js (CORE) and serves the files (OUTPUT).
// Run: node server.js   then open http://localhost:8765
//
// Routes:
//   GET  /            -> sends the page files from the public folder (index.html, style.css, app.js)
//   POST /convert     -> INPUT arrives here as JSON { links: [...], format: 'mp3' | 'm4a' }; streams progress back
//   GET  /files       -> OUTPUT: list of saved audio files
//   GET  /file?p=...  -> OUTPUT: download one saved file

const http = require('http');              // built-in web server
const fs = require('fs');                  // read files from disk
const path = require('path');              // build file paths safely
const { convert, OUT_DIR } = require('./convert'); // the CORE and the OUTPUT folder

const PORT = 8765;                                  // website address: http://localhost:8765
const PUBLIC = path.join(__dirname, 'public');      // folder holding the page files
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }; // tells the browser what each file is

// Finds every .mp3/.m4a in OUT_DIR (and its channel folders). Returns paths like "Channel/Song.mp3".
function listFiles(dir = OUT_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);   // look inside channel folders
    if (/\.(mp3|m4a)$/i.test(entry.name)) return [path.relative(OUT_DIR, full).split(path.sep).join('/')];
    return [];                                          // skip anything that isn't audio
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');   // makes the address and ?query easy to read

  // ---------- INPUT: receive links from the page ----------
  if (req.method === 'POST' && url.pathname === '/convert') {
    let body = '';
    req.on('data', chunk => body += chunk);           // collect the request body
    return req.on('end', () => {
      let input = {};
      try { input = JSON.parse(body); } catch {}      // ignore bad JSON
      const links = (input.links || []).filter(l => /^https?:\/\//.test(l)); // keep only real links
      const format = input.format === 'm4a' ? 'm4a' : 'mp3';                 // default to mp3

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.write(`Saving ${format} files to ${OUT_DIR}\n`);

      // Run the CORE. Each progress line goes straight back to the page as it happens.
      convert(links, format,
        line => res.write(line + '\n'),
        code => res.end(code === 0 ? 'Finished.\n' : `Finished with errors (code ${code}).\n`));
    });
  }

  // ---------- OUTPUT: list saved files ----------
  if (url.pathname === '/files') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(listFiles()));
  }

  // ---------- OUTPUT: download one saved file ----------
  if (url.pathname === '/file') {
    const file = path.resolve(OUT_DIR, url.searchParams.get('p') || '');
    // Only allow files inside OUT_DIR (blocks tricks like ../../secret.txt)
    if (!file.startsWith(OUT_DIR + path.sep) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
    return fs.createReadStream(file).pipe(res);
  }

  // ---------- PAGE: send index.html, style.css or app.js ----------
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const pageFile = path.join(PUBLIC, path.basename(name));   // basename = only files directly in public/
  if (fs.existsSync(pageFile)) {
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(pageFile)] || 'text/plain') + '; charset=utf-8' });
    return fs.createReadStream(pageFile).pipe(res);
  }

  res.statusCode = 404; res.end('Not found');                // anything else
}).listen(PORT, '127.0.0.1', () => {                         // 127.0.0.1 = only your computer can open it
  fs.mkdirSync(OUT_DIR, { recursive: true });                // make sure the OUTPUT folder exists
  console.log(`yt2audio running at http://localhost:${PORT}  (files go to ${OUT_DIR})`);
});
