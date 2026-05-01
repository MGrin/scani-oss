import { useCallback, useEffect, useRef, useState } from 'react';

interface AppUpdateState {
  /** A new version is available and waiting to be activated */
  updateAvailable: boolean;
  /** Apply the update — activates new SW and reloads the page */
  applyUpdate: () => void;
  /** Dismiss the update banner (will re-appear on next check) */
  dismissUpdate: () => void;
}

const VERSION_CHECK_INTERVAL = 2 * 60 * 1000; // Check every 2 minutes
const VERSION_URL = '/version.json';
const VERSION_STORAGE_KEY = 'scani-last-known-version';

/**
 * Hook that detects when a new version of the app is deployed.
 *
 * Two detection mechanisms:
 * 1. Polls /version.json periodically and compares with the initial version
 * 2. Listens for service worker state changes (waiting → update available)
 *
 * When an update is detected, shows a banner. When the user clicks "Update",
 * tells the waiting SW to skipWaiting and reloads the page.
 */
export function useAppUpdate(): AppUpdateState {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const initialVersion = useRef<string | null>(null);
  const waitingWorker = useRef<ServiceWorker | null>(null);

  // Listen for SW messages
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SW_UPDATE_WAITING') {
        setUpdateAvailable(true);
        setDismissed(false);
      }
      if (event.data?.type === 'SW_ACTIVATED') {
        // New SW activated — reload to get fresh content
        window.location.reload();
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, []);

  // Monitor SW registration for waiting workers
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const checkWaiting = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting) {
        waitingWorker.current = registration.waiting;
        setUpdateAvailable(true);
        setDismissed(false);
      }
    };

    navigator.serviceWorker.ready.then((registration) => {
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
            setUpdateAvailable(true);
            setDismissed(false);
          }
        });
      });
    });
  }, []);

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
              setUpdateAvailable(true);
              setDismissed(false);
            }
          }
          localStorage.setItem(VERSION_STORAGE_KEY, version);
        } else if (version !== initialVersion.current) {
          // Version changed — new deployment detected
          localStorage.setItem(VERSION_STORAGE_KEY, version);
          if (active) {
            setUpdateAvailable(true);
            setDismissed(false);

            // Also trigger SW update check
            if ('serviceWorker' in navigator) {
              const registration = await navigator.serviceWorker.ready;
              registration.update();
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
  }, []);

  // Also check for SW updates periodically
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const interval = setInterval(async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        await registration.update();
      } catch {
        // Ignore errors
      }
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
      } else if ('serviceWorker' in navigator) {
        // No waiting worker — also tell current SW to clear its caches
        const registration = await navigator.serviceWorker.ready;
        registration.active?.postMessage({ type: 'CLEAR_CACHE' });
        // Trigger a SW update check
        await registration.update();
      }
    } catch {
      // Best effort — proceed with reload regardless
    }

    // Hard reload bypassing cache
    window.location.reload();
  }, []);

  const dismissUpdate = useCallback(() => {
    setDismissed(true);
  }, []);

  return {
    updateAvailable: updateAvailable && !dismissed,
    applyUpdate,
    dismissUpdate,
  };
}
