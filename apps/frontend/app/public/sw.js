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

// v5 also drops any entry the previous worker cached: it stored a 200 response
// regardless of content type, so an asset the build no longer contained could
// be pinned as the SPA shell under its own URL.
const CACHE_VERSION = 'v5';
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
 * A network failure is not an application error.
 *
 * `respondWith` requires a promise that settles with a Response; a rejection
 * is surfaced by the browser as `TypeError: FetchEvent.respondWith received
 * an error: <cause>` and reported as an unhandled application error. That is
 * what an api outage produced (SC-62) — the api being unreachable is not a
 * defect in the app. `Response.error()` states the same thing the way the
 * spec intends: the caller's own `fetch()` rejects with a plain network
 * TypeError, which the app already reports in its own words, and the service
 * worker raises nothing.
 */
function networkFailure() {
  return Response.error();
}

/**
 * The single entry point to `respondWith`, so no strategy can reintroduce a
 * rejecting response by accident. A strategy that throws — or resolves to
 * nothing, which `respondWith` rejects just the same — degrades to a network
 * failure rather than an exception.
 */
function respondSafely(event, responsePromise) {
  event.respondWith(
    responsePromise
      .then((response) => response ?? networkFailure())
      .catch((error) => {
        console.warn('[SW] no response available for', event.request.url, error);
        return networkFailure();
      })
  );
}

/**
 * Fetch event - handle requests with appropriate caching strategy
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // Never cached, and re-issuing the request adds nothing the browser would
  // not do itself. Leaving the event unhandled is strictly better than
  // wrapping it: a failure then belongs to the caller, with no service
  // worker anywhere in the trace.
  if (NEVER_CACHE.some((path) => url.pathname === path)) return;

  // API requests - network first, fallback to cache
  if (API_ROUTES.some((route) => url.pathname.startsWith(route))) {
    respondSafely(event, networkFirstStrategy(request, API_CACHE));
    return;
  }

  // HTML documents - network first (get fresh HTML with latest asset references)
  if (request.destination === 'document' || request.mode === 'navigate') {
    respondSafely(event, networkFirstStrategy(request, STATIC_CACHE));
    return;
  }

  // Hashed assets (JS/CSS with content hashes) - cache first (they're immutable)
  if (isHashedAsset(url)) {
    respondSafely(event, cacheFirstStrategy(request, DYNAMIC_CACHE));
    return;
  }

  // Other static assets (images, fonts, etc.) - stale-while-revalidate
  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'image' ||
    request.destination === 'font'
  ) {
    respondSafely(event, staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }

  // Everything else — the app's own cross-origin calls to the api, analytics
  // beacons, anything with no caching story here. Nothing is gained by
  // proxying them, so leave them to the browser.
});

/**
 * Cloudflare Pages answers an unknown path with the SPA shell — HTTP 200 and
 * `text/html` — so a status code cannot separate a served asset from one the
 * build no longer contains; the content type is what does. Same reasoning as
 * `packages/frontend/ui/src/lib/service-worker.ts` applies to `/sw.js`.
 *
 * A script or stylesheet answered with HTML is a broken build, not a network
 * blip: it must never be cached (cache-first would then serve HTML for that
 * URL until the cache version changes) and it must stay visible.
 */
function isMissingAsset(request, response) {
  if (request.destination !== 'script' && request.destination !== 'style') return false;
  if (!response.ok) return false;
  return /text\/html/i.test(response.headers.get('content-type') ?? '');
}

/**
 * There is no error reporter in this scope, so hand the finding to the page,
 * which owns the Sentry client.
 */
async function reportMissingAsset(request, response) {
  const contentType = response.headers.get('content-type') ?? 'none';
  const detail = `HTTP ${response.status}, content-type ${contentType}`;
  console.error('[SW] asset is not being served:', request.url, '-', detail);

  const windows = await self.clients.matchAll({ type: 'window' });
  for (const client of windows) {
    client.postMessage({ type: 'SW_ASSET_UNAVAILABLE', url: request.url, detail });
  }
}

/** A cache lookup that cannot fail the request it was meant to accelerate. */
async function matchCache(request) {
  try {
    return await caches.match(request);
  } catch (error) {
    console.warn('[SW] cache lookup failed for', request.url ?? request, error);
    return undefined;
  }
}

/** Warming the cache is best-effort; a full or evicted cache is not an error. */
async function putInCache(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch (error) {
    console.warn('[SW] could not cache', request.url, error);
  }
}

/** Cache a fresh response unless it is the SPA shell standing in for a missing asset. */
async function cacheIfSound(request, response, cacheName) {
  if (isMissingAsset(request, response)) {
    await reportMissingAsset(request, response);
    return;
  }
  if (response.ok) {
    await putInCache(cacheName, request, response.clone());
  }
}

/**
 * Cache-first strategy: for immutable hashed assets
 */
async function cacheFirstStrategy(request, cacheName) {
  const cached = await matchCache(request);
  if (cached) return cached;

  const response = await fetch(request);
  await cacheIfSound(request, response, cacheName);
  return response;
}

/**
 * Network-first strategy: for HTML and API requests
 */
async function networkFirstStrategy(request, cacheName) {
  try {
    const response = await fetch(request);
    await cacheIfSound(request, response, cacheName);
    return response;
  } catch (error) {
    const cached = await matchCache(request);
    if (cached) {
      console.log('[SW] Serving from cache (offline):', request.url);
      return cached;
    }

    if (request.destination === 'document' || request.mode === 'navigate') {
      const fallback = await matchCache('/');
      if (fallback) return fallback;
    }

    console.warn('[SW] network unreachable and nothing cached:', request.url, error);
    return networkFailure();
  }
}

/**
 * Stale-while-revalidate: return cache immediately, update in background
 */
async function staleWhileRevalidate(request, cacheName) {
  const cached = await matchCache(request);

  const fetchPromise = fetch(request)
    .then(async (response) => {
      await cacheIfSound(request, response, cacheName);
      return response;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || networkFailure();
}

/**
 * Handle messages from the main thread.
 *
 * Origin gate: a Service Worker's `message` channel is reachable from
 * any window holding a reference to its registration, including
 * cross-origin embeds. The two messages this SW handles (SKIP_WAITING,
 * CLEAR_CACHE) are not security-bearing — the worst case is a cache
 * flush, i.e. one extra round-trip to the api on the next request —
 * but there's no reason to accept them from anything other than our
 * own origin. Reject anything that isn't.
 */
self.addEventListener('message', (event) => {
  if (event.origin && event.origin !== self.location.origin) {
    return;
  }

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
