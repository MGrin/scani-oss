'use client';

import { useEffect } from 'react';

/**
 * Registers `/sw.js` on first client paint. Empty render — exists purely
 * for its side effect. Production-only so dev iteration isn't disturbed
 * by stale caches.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('[SW] Service Worker registration failed:', error);
    });
  }, []);

  return null;
}
