/**
 * Scani PWA Service Worker
 * Provides offline support and smart caching with version update detection.
 *
 * Caching strategies:
 * - HTML documents: network-first (always try to get fresh HTML)
 * - Hashed assets (JS/CSS with content hashes): cache-first (immutable)
 * - API requests (/trpc): network-first with cache fallback
 * - version.json: always network, never cached (used for update detection)
 */

const CACHE_VERSION = 'v3';
const STATIC_CACHE = `scani-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `scani-dynamic-${CACHE_VERSION}`;
const API_CACHE = `scani-api-${CACHE_VERSION}`;

const STATIC_ASSETS = ['/', '/manifest.json', '/favicon.ico'];
const API_ROUTES = ['/trpc'];

// Files that should NEVER be served from cache
const NEVER_CACHE = ['/version.json', '/sw.js'];

/**
 * Install event - cache static assets
 * Do NOT call skipWaiting here — let the app control when to activate
 */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing new service worker...');

  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    })
  );

  // Notify all clients that a new version is waiting
  self.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const client of clients) {
      client.postMessage({ type: 'SW_UPDATE_WAITING' });
    }
  });
});

/**
 * Activate event - clean up old caches and take control
 */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => {
              return (
                name.startsWith('scani-') &&
                name !== STATIC_CACHE &&
                name !== DYNAMIC_CACHE &&
                name !== API_CACHE
              );
            })
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        // Take control of all pages immediately after activation
        return self.clients.claim();
      })
      .then(() => {
        // Notify all clients that the new SW is now active
        return self.clients.matchAll({ type: 'window' });
      })
      .then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'SW_ACTIVATED' });
        }
      })
  );
});

/**
 * Determine if a URL is a hashed asset (immutable, safe to cache forever).
 * Vite generates filenames like: /assets/index-a1b2c3d4.js
 */
function isHashedAsset(url) {
  return /\/assets\/.*-[a-f0-9]{8,}\.(js|css|woff2?|png|jpg|svg)$/i.test(url.pathname);
}

/**
 * Fetch event - handle requests with appropriate caching strategy
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // Never cache these - always go to network
  if (NEVER_CACHE.some((path) => url.pathname === path)) {
    event.respondWith(fetch(request));
    return;
  }

  // API requests - network first, fallback to cache
  if (API_ROUTES.some((route) => url.pathname.startsWith(route))) {
    event.respondWith(networkFirstStrategy(request, API_CACHE));
    return;
  }

  // HTML documents - network first (get fresh HTML with latest asset references)
  if (request.destination === 'document' || request.mode === 'navigate') {
    event.respondWith(networkFirstStrategy(request, STATIC_CACHE));
    return;
  }

  // Hashed assets (JS/CSS with content hashes) - cache first (they're immutable)
  if (isHashedAsset(url)) {
    event.respondWith(cacheFirstStrategy(request, DYNAMIC_CACHE));
    return;
  }

  // Other static assets (images, fonts, etc.) - stale-while-revalidate
  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'image' ||
    request.destination === 'font'
  ) {
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }

  // Default: network only
  event.respondWith(fetch(request));
});

/**
 * Cache-first strategy: for immutable hashed assets
 */
async function cacheFirstStrategy(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    if (request.destination === 'document') {
      return caches.match('/');
    }
    throw error;
  }
}

/**
 * Network-first strategy: for HTML and API requests
 */
async function networkFirstStrategy(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      console.log('[SW] Serving from cache (offline):', request.url);
      return cached;
    }

    if (request.destination === 'document' || request.mode === 'navigate') {
      const fallback = await caches.match('/');
      if (fallback) return fallback;
    }

    return new Response(
      JSON.stringify({ error: 'You are offline and no cached data is available.' }),
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Stale-while-revalidate: return cache immediately, update in background
 */
async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        const cache = caches.open(cacheName);
        cache.then((c) => c.put(request, response.clone()));
      }
      return response;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || new Response('', { status: 408 });
}

/**
 * Handle messages from the main thread
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    console.log('[SW] Skip waiting requested by app');
    self.skipWaiting();
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.filter((name) => name.startsWith('scani-')).map((name) => caches.delete(name))
        );
      })
    );
  }

  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage({
      type: 'SW_VERSION',
      version: CACHE_VERSION,
    });
  }
});

/**
 * Push notification handler
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const options = {
      body: data.body || 'New notification',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      vibrate: [100, 50, 100],
      data: { url: data.url || '/' },
    };
    event.waitUntil(self.registration.showNotification(data.title || 'Scani', options));
  } catch (error) {
    console.error('[SW] Push notification error:', error);
  }
});

/**
 * Notification click handler
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

console.log('[SW] Service worker loaded (cache version:', CACHE_VERSION, ')');
