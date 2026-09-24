// Service worker: offline app shell, offline reads, and push notifications.
//
// Built by the `serviceWorker` plugin in vite.config.js, which replaces
// __PRECACHE__ with the files of this build and __VERSION__ with a hash of
// them, so every deploy installs a fresh worker and drops the old shell.
//
// Strategy per request:
//   * page navigations  — network first, falling back to the cached shell, so
//                         the app always opens, and is never stale when online.
//   * built assets      — cache first; their names are content-hashed.
//   * GET /api/*        — network first; a successful answer is kept, and
//                         served (marked with X-Offline-Cache) when the
//                         server can't be reached. Writes are never touched.
//   * Google Fonts      — stale-while-revalidate.

const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;
const SHELL_CACHE = `shell-${VERSION}`;
const FONT_CACHE = 'fonts-v1';
// Shared with src/pwa.js, which clears it on sign-out so the next person on
// this device can't read the last one's tasks offline.
const API_CACHE = 'api-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) {
      // Only reads that are useful offline. /auth/me is included because the
      // app asks it before rendering anything.
      if (!url.pathname.startsWith('/api/auth/') || url.pathname === '/api/auth/me') {
        event.respondWith(networkFirstApi(request));
      }
      return;
    }
    if (request.mode === 'navigate') {
      event.respondWith(fetch(request).catch(() => caches.match('/index.html', { cacheName: SHELL_CACHE })));
      return;
    }
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
  }
});

async function networkFirstApi(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    // A 401 means this session is over; whatever is cached belongs to it.
    else if (response.status === 401) await caches.delete(API_CACHE);
    return response;
  } catch {
    const hit = await cache.match(request);
    if (!hit) {
      return new Response(JSON.stringify({ error: "You're offline and this hasn't been saved on this device yet." }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'X-Offline-Cache': 'miss' },
      });
    }
    const headers = new Headers(hit.headers);
    headers.set('X-Offline-Cache', 'hit');
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
      return response;
    })
    .catch(() => hit);
  return hit || fresh;
}

// ---------- notifications ----------

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data?.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'This-Organiser', {
      body: data.body || '',
      tag: data.tag,
      icon: '/web-app-manifest-192x192.png',
      badge: '/favicon-96x96.png',
      data: { url: data.url || '/' },
    }),
  );
});

// Focus an open window if there is one, rather than stacking up new ones.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.focus();
      return self.clients.openWindow(target);
    }),
  );
});
