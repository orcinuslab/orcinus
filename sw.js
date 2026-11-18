// ═══════════════════════════════════════════════════════════════
// Orcinus — service worker: permite abrir la app sin conexión.
// Al cambiar archivos que no sean páginas (iconos, vendor/…), subir VERSION.
// ═══════════════════════════════════════════════════════════════
const VERSION = 'v3';
const SHELL = 'orcinus-shell-' + VERSION;   // la app y sus librerías (todo alojado aquí)
const TILES = 'orcinus-tiles-v1';           // trozos del mapa ya vistos
const MAX_TILES = 1500;                     // ~25-40 MB como mucho

const FONTS = ['dm-sans-latin-400', 'dm-sans-latin-500', 'dm-sans-latin-600', 'dm-sans-latin-700',
               'dm-sans-latin-ext-400', 'dm-sans-latin-ext-500', 'dm-sans-latin-ext-600', 'dm-sans-latin-ext-700',
               'dm-mono-latin-400', 'dm-mono-latin-500', 'dm-mono-latin-ext-400', 'dm-mono-latin-ext-500']
  .map(f => `./vendor/fonts/${f}-normal.woff2`);
const SHELL_FILES = ['./', './legal.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './vendor/leaflet.css', './vendor/leaflet.js', './vendor/supabase.js', './vendor/fonts.css', ...FONTS];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [SHELL, TILES];
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
});

// Páginas: intentar la red (para recibir actualizaciones); si tarda más de 4 s o no hay red,
// usar la copia guardada de esa misma página (o la app, si no hay copia)
async function pageNetworkFirst(req) {
  const cache = await caches.open(SHELL);
  const key = new URL(req.url); key.hash = ''; key.search = '';
  const network = fetch(req).then(r => { if (r.ok) cache.put(key.href, r.clone()); return r; });
  network.catch(() => {});
  const timeout = new Promise(res => setTimeout(res, 4000, null));
  const fallback = async () => (await cache.match(key.href)) || (await cache.match('./'));
  try {
    const r = await Promise.race([network, timeout]);
    if (r) return r;
    return (await fallback()) || await network;
  } catch (e) {
    return (await fallback()) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
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
