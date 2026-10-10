// Service worker: rende l'app utilizzabile offline. I dati sono in IndexedDB, non qui.
// Ogni copia (app vera e copia di prova) ha la sua cache, distinta dal percorso.
const SCOPE = new URL(self.registration.scope).pathname;
const PREFIX = `bilancio:${SCOPE}:`;
const VERSION = PREFIX + '2.7.0';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/home.js', 'js/charts.js', 'js/store.js', 'js/model.js', 'js/util.js', 'js/ui.js', 'js/bank.js',
  'js/importer.js', 'js/stats.js', 'js/more.js', 'js/backup.js', 'js/dropbox.js', 'js/tricount.js',
  'lib/xlsx.mini.min.js', 'lib/pdf.min.js', 'lib/pdf.worker.min.js',
  'fonts/bricolage.woff2', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      // elimina solo le versioni vecchie di questa copia (e la cache della prima versione, senza prefisso)
      if ((k.startsWith(PREFIX) && k !== VERSION) || (k === 'bilancio-v1.0.0' && !SCOPE.endsWith('/test/'))) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // l'app vera non gestisce le pagine della copia di prova
  if (!SCOPE.endsWith('/test/') && url.pathname.startsWith(SCOPE + 'test/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match(new URL('index.html', self.registration.scope).href).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  })));
});
