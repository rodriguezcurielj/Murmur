// Murmur service worker: keeps the app itself available offline.
// Downloaded songs are stored separately in IndexedDB by the page, so audio
// (/media) and the library API (/api) are never cached here: when the server
// is unreachable the page falls back to what's saved on the device.
const SHELL_CACHE = 'murmur-shell-v36';
const RUNTIME_CACHE = 'murmur-runtime-v1';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const BASE = new URL(self.registration.scope).pathname;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(request, { ignoreSearch: true })) || (await cache.match('index.html')) || Response.error();
  }
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
    if (req.mode === 'navigate' || path === BASE || path.endsWith('.html') || path.endsWith('.webmanifest')) {
      event.respondWith(networkFirst(req));
    } else if (path.startsWith(BASE + 'covers/') || path.startsWith(BASE + 'icons/')) {
      event.respondWith(cacheFirst(req));
    }
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
  }
});
