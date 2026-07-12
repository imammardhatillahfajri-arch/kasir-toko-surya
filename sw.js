const CACHE_NAME = 'kasir-surya-v2';
const NETWORK_TIMEOUT = 4000; // 4 detik — kalau jaringan lelet, pakai cache dulu

// Asset yang di-cache saat install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-72.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.26.4/babel.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
];

// Fetch dengan batas waktu — kalau lewat, reject supaya fallback ke cache
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), ms);
    fetch(request).then(res => { clearTimeout(timer); resolve(res); },
                        err => { clearTimeout(timer); reject(err); });
  });
}

// Install - cache semua assets utama
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching assets...');
      return cache.addAll(PRECACHE_ASSETS).catch(err => {
        console.warn('[SW] Pre-cache partial fail:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate - hapus cache lama
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      )
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// - index.html → Network first + timeout 4s (selalu ambil update terbaru, tapi tidak menggantung di sinyal jelek)
// - CDN libs   → Cache first (hemat bandwidth)
// - Supabase   → Network only (data harus realtime)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Supabase API → selalu network
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // index.html → network first (dengan timeout), fallback cache
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetchWithTimeout(event.request, NETWORK_TIMEOUT)
        .then(res => {
          if (event.request.method === 'GET' && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // CDN libs → cache first
  if (url.hostname.includes('unpkg.com') || url.hostname.includes('jsdelivr.net')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (event.request.method === 'GET' && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Default → network first, fallback cache
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Push notification (untuk reminder hutang jatuh tempo)
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  const title = data.title || 'Kasir Surya Listrik';
  const options = {
    body: data.body || 'Ada notifikasi baru',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    vibrate: [200, 100, 200],
    data: data.url || '/',
    actions: [
      {action: 'open', title: 'Buka App'},
      {action: 'close', title: 'Tutup'},
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'open' || !event.action) {
    event.waitUntil(clients.openWindow(event.notification.data || '/'));
  }
});
