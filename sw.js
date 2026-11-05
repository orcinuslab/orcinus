// ═══════════════════════════════════════════════════════════════
// Orcinus — service worker: permite abrir la app sin conexión.
// Al cambiar archivos de la app, subir VERSION para renovar la caché.
// ═══════════════════════════════════════════════════════════════
const VERSION = 'v1';
const SHELL = 'orcinus-shell-' + VERSION;   // la propia app
const LIBS  = 'orcinus-libs-v1';            // librerías y fuentes (versionadas en su URL)
const TILES = 'orcinus-tiles-v1';           // trozos del mapa ya vistos
const MAX_TILES = 1500;                     // ~25-40 MB como mucho

const SHELL_FILES = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const LIB_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap',
];
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES);
    const libs = await caches.open(LIBS);
    await Promise.all(LIB_URLS.map(async url => {          // si alguna falla, no bloquea la instalación
      try { if (!(await libs.match(url))) { const r = await fetch(url); if (r.ok) await libs.put(url, r); } } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [SHELL, LIBS, TILES];
    for (const k of await caches.keys()) if (k.startsWith('orcinus-') && !keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('.supabase.co')) return;                 // datos en vivo: siempre a la red

  if (req.mode === 'navigate') { event.respondWith(pageNetworkFirst(req)); return; }
  if (url.origin === self.location.origin) { event.respondWith(staleWhileRevalidate(req, SHELL)); return; }
  if (url.hostname === 'tile.openstreetmap.org') { event.respondWith(staleWhileRevalidate(req, TILES, MAX_TILES)); return; }
  if (LIB_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(req, LIBS)); return; }
});

// La página: intentar la red (para recibir actualizaciones); si tarda más de 4 s o no hay red, usar la copia
async function pageNetworkFirst(req) {
  const cache = await caches.open(SHELL);
  const network = fetch(req).then(r => { if (r.ok) cache.put('./', r.clone()); return r; });
  network.catch(() => {});
  const timeout = new Promise(res => setTimeout(res, 4000, null));
  try {
    const r = await Promise.race([network, timeout]);
    if (r) return r;
    return (await cache.match('./')) || await network;
  } catch (e) {
    return (await cache.match('./')) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') cache.put(req, r.clone());
  return r;
}

// Responder al instante con lo guardado y actualizarlo por detrás
async function staleWhileRevalidate(req, name, maxEntries) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  const update = fetch(req).then(async r => {
    if (r.ok || r.type === 'opaque') { await cache.put(req, r.clone()); if (maxEntries) trim(cache, maxEntries); }
    return r;
  }).catch(() => null);
  if (hit) return hit;
  return (await update) || new Response('', { status: 504 });
}

let trimming = false;
async function trim(cache, max) {
  if (trimming) return; trimming = true;
  try { const keys = await cache.keys(); for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]); }
  finally { trimming = false; }
}
