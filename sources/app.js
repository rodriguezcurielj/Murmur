// app.js — runs in the browser. Reads the INPUT from the page, sends it to the server, shows progress and OUTPUT.

// Shortcut: $('links') = the element with id="links"
const $ = id => document.getElementById(id);

// OUTPUT: ask the server for the saved files (GET /files) and show them as download links
async function loadFiles() {
  const files = await (await fetch('/files')).json();
  $('files').innerHTML = '';
  if (!files.length) { $('files').innerHTML = '<li>None yet</li>'; return; }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = '/file?p=' + encodeURIComponent(f);   // GET /file downloads it
    a.textContent = f;                              // shows "Channel/Song.mp3"
    const li = document.createElement('li');
    li.append(a);
    $('files').append(li);
  }
}

// INPUT: when Convert is clicked, send the links + format to the server (POST /convert)
$('go').onclick = async () => {
  // Read the link box: one link per line, skip blank lines
  const links = $('links').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!links.length) return;
  const format = $('fmt').value;                    // 'mp3' or 'm4a'

  $('go').disabled = true;                          // stop double clicks while working
  $('log').textContent = '';

  const res = await fetch('/convert', { method: 'POST', body: JSON.stringify({ links, format }) });

  // The server sends progress lines as they happen; add each piece to the progress box
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (let chunk; !(chunk = await reader.read()).done;) {
    $('log').textContent += decoder.decode(chunk.value);
    $('log').scrollTop = $('log').scrollHeight;     // keep the newest line in view
  }

  $('go').disabled = false;
  loadFiles();                                      // refresh the OUTPUT list
};

// Show existing files when the page opens
loadFiles();
