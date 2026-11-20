// Backup copy of the app on each phone.
// Always tries GitHub first; if GitHub is down or slow (or the phone is offline),
// it opens the last saved copy of the app and the last snow numbers instead of an error page.
const CACHE = 'wcsnow-v1';
const CORE = ['./', 'index.html', 'manifest.json', 'data.json', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png'];
const TIMEOUT_MS = 6000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(CORE.map(u => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Fetch from GitHub, but give up after a few seconds or on an error page (like the unicorn).
function fresh(req) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
    fetch(req).then(r => { clearTimeout(t); r.ok ? resolve(r) : reject(new Error('HTTP ' + r.status)); }, err => { clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // leave webcams, fonts, counter alone
  const isPage = req.mode === 'navigate';
  const key = isPage ? 'index.html' : url.pathname.endsWith('/data.json') ? 'data.json' : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const r = await fresh(req);
      cache.put(key, r.clone());
      return r;
    } catch (err) {
      const saved = await cache.match(key, { ignoreSearch: true });
      if (saved) return saved;
      throw err;
    }
  })());
});
