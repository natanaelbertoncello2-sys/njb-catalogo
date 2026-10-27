// Service worker: la app abre sin conexión y, con conexión, siempre usa la última versión publicada.
// La caché es solo respaldo offline; no hace falta cambiar nada acá para publicar actualizaciones.
const CACHE = 'njb-app';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/ui.js', 'js/db.js', 'js/drive.js', 'js/camera.js', 'js/render.js', 'js/process.js', 'js/config.js', 'js/targets.js',
  'js/shared.js', 'js/pano.js', 'js/pano-worker.js', 'js/pano-core.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin) return;
  // Red primero, revalidando con el servidor (sin caché HTTP vieja); si no hay conexión, la copia guardada.
  ev.respondWith(
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname + url.search, copy)); }
        return res;
      })
      .catch(() => caches.match(ev.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
