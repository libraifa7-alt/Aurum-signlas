
const CACHE_NAME = 'aurum-pwa-v2';

const APP_SHELL = [
  '/',
  '/manifest.json'
];

// INSTALL SERVICE WORKER
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ACTIVATE SERVICE WORKER
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});


 
// BACKGROUND WEB PUSH: menerima notifikasi walau halaman tidak terbuka.
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (_) { payload = { body: event.data ? event.data.text() : 'Sinyal baru tersedia' }; }
  const title = payload.title || 'AURUM SIGNAL';
  const options = {
    body: payload.body || 'Ada pembaruan sinyal pasar.',
    icon: '/aurum-icon-192.png',
    badge: '/aurum-icon-192.png',
    tag: payload.tag || 'aurum-signal',
    renotify: true,
    data: { url: payload.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// FETCH REQUEST
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // API HARGA PASAR SELALU MENGGUNAKAN NETWORK
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api')
  ) {
    return;
  }

  // HALAMAN UTAMA: NETWORK FIRST
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put('/', copy));
          }
          return response;
        })
        .catch(() => caches.match('/'))
    );
  }
});
