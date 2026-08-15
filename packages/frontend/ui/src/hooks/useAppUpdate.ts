import { useCallback, useEffect, useRef, useState } from 'react';
import {
  interpretServiceWorkerMessage,
  requestServiceWorkerUpdate,
  serviceWorkerReady,
  wasDocumentControlledAtLoad,
} from '../lib/service-worker';

interface AppUpdateState {
  /** A new version is available and waiting to be activated */
  updateAvailable: boolean;
  /** Apply the update — activates new SW and reloads the page */
  applyUpdate: () => void;
  /** Dismiss the update banner. Persisted per version — it will not re-appear
   *  for the dismissed version, but a genuinely newer deploy still shows it. */
  dismissUpdate: () => void;
}

const VERSION_CHECK_INTERVAL = 2 * 60 * 1000; // Check every 2 minutes
const VERSION_URL = '/version.json';
const VERSION_STORAGE_KEY = 'scani-last-known-version';
// The app version the user last dismissed the update banner for. The banner
// stays hidden for this version even across reloads; a different (newer)
// version string clears the suppression.
const DISMISSED_VERSION_STORAGE_KEY = 'scani-dismissed-update-version';

/**
 * Hook that detects when a new version of the app is deployed.
 *
 * Two detection mechanisms:
 * 1. Polls /version.json periodically and compares with the initial version
 * 2. Listens for service worker state changes (waiting → update available)
 *
 * When an update is detected, shows a banner. When the user clicks "Update",
 * tells the waiting SW to skipWaiting and reloads the page. Dismissals are
 * persisted per version so the banner doesn't loop back every poll interval.
 */
export function useAppUpdate(): AppUpdateState {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const initialVersion = useRef<string | null>(null);
  // The version currently being offered to the user (from the /version.json
  // poll). `null` for service-worker-only updates with no version string.
  const offeredVersion = useRef<string | null>(null);
  const waitingWorker = useRef<ServiceWorker | null>(null);

  // Surface an update unless the user already dismissed this exact version.
  const offerUpdate = useCallback((version: string | null) => {
    if (version && version === localStorage.getItem(DISMISSED_VERSION_STORAGE_KEY)) {
      return;
    }
    offeredVersion.current = version;
    setUpdateAvailable(true);
    setDismissed(false);
  }, []);

  // Listen for SW messages
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      const action = interpretServiceWorkerMessage(event.data, wasDocumentControlledAtLoad());
      if (action.offerUpdate) {
        offerUpdate(offeredVersion.current);
      }
      if (action.reload) {
        // A newer SW took over from the one this page was running under —
        // reload to get the content it now serves.
        window.location.reload();
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [offerUpdate]);

  // Monitor SW registration for waiting workers
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const checkWaiting = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting) {
        waitingWorker.current = registration.waiting;
        offerUpdate(offeredVersion.current);
      }
    };

    let cancelled = false;

    // Best-effort: when registration failed there is no worker to observe,
    // and `serviceWorkerReady` resolves `null` rather than hanging. The
    // version.json poll below is the update route that still works then.
    const observe = async () => {
      const registration = await serviceWorkerReady();
      if (!registration || cancelled) return;

      // Check if there's already a waiting worker
      checkWaiting(registration);

      // Listen for new workers
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New SW installed while old one is still controlling — update available
            waitingWorker.current = newWorker;
            offerUpdate(offeredVersion.current);
          }
        });
      });
    };

    void observe();

    return () => {
      cancelled = true;
    };
  }, [offerUpdate]);

  // Poll version.json for changes
  useEffect(() => {
    let active = true;

    const checkVersion = async () => {
      try {
        const response = await fetch(VERSION_URL, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!response.ok) return;

        const data = await response.json();
        const version = data.version;

        if (!version || version === 'dev') return;

        if (initialVersion.current === null) {
          // First check this session — compare with last known version from localStorage
          initialVersion.current = version;
          const lastKnown = localStorage.getItem(VERSION_STORAGE_KEY);
          if (lastKnown && lastKnown !== version) {
            // Version changed since last session — show update banner
            if (active) {
              offerUpdate(version);
            }
          }
          localStorage.setItem(VERSION_STORAGE_KEY, version);
        } else if (version !== initialVersion.current) {
          // Version changed — new deployment detected
          localStorage.setItem(VERSION_STORAGE_KEY, version);
          if (active) {
            // Offer the banner first: it is the user's route off a stale
            // bundle and must not depend on the service worker succeeding.
            offerUpdate(version);

            // Then try to pull the new worker down. `requestServiceWorkerUpdate`
            // owns the failure — an un-awaited `update()` here escaped this
            // try/catch and reached Sentry as an unhandled rejection whenever
            // a deploy landed mid-session (SCANI-FRONTEND-C).
            const registration = await serviceWorkerReady();
            if (registration) {
              await requestServiceWorkerUpdate(registration);
            }
          }
        }
      } catch {
        // Silently ignore fetch errors (offline, etc.)
      }
    };

    // Initial check after a short delay (let the app settle)
    const initialTimer = setTimeout(checkVersion, 5000);
    // Periodic checks
    const interval = setInterval(checkVersion, VERSION_CHECK_INTERVAL);

    return () => {
      active = false;
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [offerUpdate]);

  // Also check for SW updates periodically
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const poll = async () => {
      const registration = await serviceWorkerReady();
      if (registration) {
        await requestServiceWorkerUpdate(registration);
      }
    };

    const interval = setInterval(() => {
      void poll();
    }, VERSION_CHECK_INTERVAL);

    return () => clearInterval(interval);
  }, []);

  const applyUpdate = useCallback(async () => {
    try {
      // Always clear all caches first to ensure fresh content on reload
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((name) => caches.delete(name)));
      }

      if (waitingWorker.current) {
        // Tell the waiting SW to take over
        waitingWorker.current.postMessage({ type: 'SKIP_WAITING' });
      } else {
        // No waiting worker — also tell current SW to clear its caches.
        // `serviceWorkerReady` is bounded: when registration failed there is
        // no worker and a bare await would strand the banner on "Updating…"
        // forever, trapping the user on the stale bundle.
        const registration = await serviceWorkerReady();
        if (registration) {
          registration.active?.postMessage({ type: 'CLEAR_CACHE' });
          // Trigger a SW update check
          await requestServiceWorkerUpdate(registration);
        }
      }
    } catch {
      // Best effort — proceed with reload regardless
    }

    // Hard reload bypassing cache
    window.location.reload();
  }, []);

  const dismissUpdate = useCallback(() => {
    // Persist the dismissal so the banner doesn't loop back on the next poll
    // (or after a reload). Only a different version string re-shows it.
    if (offeredVersion.current) {
      localStorage.setItem(DISMISSED_VERSION_STORAGE_KEY, offeredVersion.current);
    }
    setDismissed(true);
  }, []);

  return {
    updateAvailable: updateAvailable && !dismissed,
    applyUpdate,
    dismissUpdate,
  };
}
