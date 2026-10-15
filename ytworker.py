# A yt-dlp that stays running for ytaudio.js: started once, then it answers one request per line on stdin.
# Starting yt-dlp for every song costs 1.5-2 seconds (and it re-solves YouTube's player code each time);
# this keeps both ready, so finding a song's audio takes about a second.
# Request:  {"id": "<n>", "video": "<11-char id>", "cookies": "<path or empty>"}
# Answer:   {"id": "<n>", "url": "...", "headers": {...}, "ext": "m4a"}  or  {"id": "<n>", "error": "..."}
import json
import sys
import threading

import yt_dlp

lock = threading.Lock()
out_lock = threading.Lock()
apps = {}


def ydl_for(cookies):
    # One YoutubeDL per cookies file, reused so its caches (player code, solved challenges) stay warm.
    if cookies not in apps:
        opts = {
            'quiet': True, 'no_warnings': True, 'noplaylist': True, 'skip_download': True,
            'format': 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio',
            'remote_components': ['ejs:github'],
            'js_runtimes': {'deno': {}, 'node': {}},
        }
        if cookies:
            opts['cookiefile'] = cookies
        apps[cookies] = yt_dlp.YoutubeDL(opts)
    return apps[cookies]


def answer(msg):
    with out_lock:
        sys.stdout.write(json.dumps(msg) + '\n')
        sys.stdout.flush()


def handle(req):
    rid = req.get('id')
    try:
        with lock:
            ydl = ydl_for(req.get('cookies') or '')
        info = ydl.extract_info('https://www.youtube.com/watch?v=' + req['video'], download=False)
        info = ydl.sanitize_info(info)
        fmt = (info.get('requested_formats') or [info])[0]
        url = fmt.get('url') or info.get('url')
        if not url:
            raise Exception('no audio stream')
        answer({'id': rid, 'url': url, 'headers': fmt.get('http_headers') or info.get('http_headers') or {}, 'ext': fmt.get('ext') or info.get('ext')})
    except Exception as e:  # noqa: BLE001 - every failure goes back to the caller
        answer({'id': rid, 'error': str(e).replace('\n', ' ')[:300]})


answer({'ready': True, 'version': yt_dlp.version.__version__})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except ValueError:
        continue
    threading.Thread(target=handle, args=(req,), daemon=True).start()
