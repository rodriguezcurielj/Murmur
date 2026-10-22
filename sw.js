// Murmur service worker: keeps the app itself available offline.
// Downloaded songs are stored separately in IndexedDB by the page, so audio
// (/media) and the library API (/api) are never cached here: when the server
// is unreachable the page falls back to what's saved on the device.
const SHELL_CACHE = 'murmur-shell-v44';
const RUNTIME_CACHE = 'murmur-runtime-v1';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const BASE = new URL(self.registration.scope).pathname;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// On a weak connection (one bar, captive Wi-Fi) the network can take a minute to fail, so after a few seconds
// the saved copy is used if there is one; the fresh copy still updates the cache for next time.
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const saved = () => cache.match(request, { ignoreSearch: true }).then(r => r || cache.match('index.html'));
  // no-cache: always ask the site whether there's a newer copy (the browser would otherwise reuse one for 10 minutes).
  const net = fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => { if (res.ok) cache.put(request, res.clone()); return res; });
  const slow = new Promise(ok => setTimeout(ok, 4000)).then(saved).then(r => r || net);
  try { return await Promise.race([net, slow]); }
  catch (err) { return (await saved()) || Response.error(); }
}

// The app page opens from the saved copy right away (no waiting on the network every launch), and a fresh copy is
// saved in the background for next time. The page checks for a newer version a few seconds after opening and
// reloads into it when nothing is playing. Asking with cache: 'no-store' (that check) always goes to the network.
async function savedFirst(request) {
  if (request.cache === 'no-store' || request.cache === 'reload') return networkFirst(request);
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true }) || (request.mode === 'navigate' ? await cache.match('index.html') : null);
  if (!hit) return networkFirst(request);
  fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => { if (res.ok) return cache.put(request, res); }).catch(() => {});
  return hit;
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    const path = url.pathname;
    if (path.startsWith(BASE + 'api/') || path.startsWith(BASE + 'media/')) return;
    // config.js holds the server list, so keep a copy for when this site itself can't be reached.
    if (req.mode === 'navigate' || path === BASE || path.endsWith('.html') || path.endsWith('.webmanifest') || path === BASE + 'config.js') {
      event.respondWith(savedFirst(req));
    } else if (path.startsWith(BASE + 'covers/') || path.startsWith(BASE + 'icons/')) {
      event.respondWith(cacheFirst(req));
    }
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
  }
});
