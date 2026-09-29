// Incrementa la versión cada vez que despliegues cambios
// para forzar que los usuarios reciban el archivo nuevo.
const CACHE_NAME = 'cambio-rapido-v4';

// Solo cacheamos los assets locales (HTML y manifest).
// Las fuentes ya no existen (se eliminaron), y la API
// se consulta en red con fallback al ultimo dato guardado en localStorage.
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json'
];

// INSTALL: precachea los assets al instalar el SW
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting()) // Activa el SW nuevo de inmediato sin esperar
  );
});

// ACTIVATE: limpia caches viejos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim()) // Toma control de todas las tabs abiertas
  );
});

// FETCH: Cache-first para assets locales, Network-only para la API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // La API del dólar siempre va a la red (sin cachear, datos frescos)
  if (url.hostname === 've.dolarapi.com') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Para todo lo demás: cache-first con fallback a red
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Solo cachea respuestas válidas y del mismo origen
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
