/* GeoCampo — service worker: deja la app disponible sin conexión. */
const VERSION = 'geocampo-0.1.0';
const FONTS = 'geocampo-fonts';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Primero la copia guardada (rápido y sin señal); se actualiza por detrás.
    const key = req.mode === 'navigate' ? './index.html' : req;
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(key);
        const net = fetch(req)
          .then((r) => { if (r && r.ok) c.put(key, r.clone()); return r; })
          .catch(() => hit);
        return hit || net;
      }),
    );
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(FONTS).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req).then((r) => { c.put(req, r.clone()); return r; }).catch(() => hit);
        return hit || net;
      }),
    );
  }
  // Teselas en línea (OSM, OpenTopoMap): red directa, sin guardar.
});
