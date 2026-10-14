// Service worker: keeps the app shell on the phone so Drive Timer opens and runs with no signal.
// Every path is relative to this file, so the app works from any folder, for example a GitHub
// Pages project address such as https://<user>.github.io/drive-timer/.
// Change VERSION whenever any file below changes; the old cache is then replaced.

const VERSION = 'drive-timer-1.0.0';
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/analysis.js',
  'js/charts.js',
  'js/csv.js',
  'js/db.js',
  'js/defs.js',
  'js/drive.js',
  'js/engine.js',
  'js/geo.js',
  'js/library.js',
  'js/live.js',
  'js/more.js',
  'js/recorder.js',
  'js/sensors.js',
  'js/sessions.js',
  'js/store.js',
  'js/synth.js',
  'js/ui.js',
  'builtin/library.json',
  'assets/keepawake.mp4',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('drive-timer-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // the app never calls other sites
  const scope = new URL(self.registration.scope);
  const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : url.pathname;
  if (rel.startsWith('test/') || rel.startsWith('data/') || rel.startsWith('tools/')) return; // development files: always from the network
  if (DEV) {
    // on the laptop: always try the latest files first, fall back to the cache when offline
    event.respondWith(fetch(req).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => (hit && req.headers.has('range') ? rangeResponse(req, hit) : hit || Response.error()))));
    return;
  }
  if (req.headers.has('range')) {
    // Safari asks for video in byte ranges and will not play a plain 200 from the cache
    event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => (hit ? rangeResponse(req, hit) : fetch(req))));
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic' && !req.headers.has('range')) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    }),
  );
});

async function rangeResponse(req, res) {
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let start = 0;
  let end = size - 1;
  if (m && m[1] !== '') {
    start = Number(m[1]);
    if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
  } else if (m && m[2] !== '') {
    start = Math.max(size - Number(m[2]), 0); // suffix range: the last N bytes
  }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
