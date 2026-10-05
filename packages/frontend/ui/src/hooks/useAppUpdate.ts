import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activateWaitingWorker,
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
 * The build identity a `/version.json` payload offers, or `null` when it offers
 * none worth comparing (a dev server, or anything that is not the payload).
 *
 * Only `version` is read. The payload also names the `commit` a build came
 * from (SC-964), and that must never stand in for it: a commit that changed
 * only the backend moves the commit and leaves this app byte-identical, and
 * `version`, a hash of the app's own output, is what says so (SC-1360).
 */
export function deployedVersion(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const version = (payload as { version?: unknown }).version;
  if (typeof version !== 'string' || version === '' || version === 'dev') return null;
  return version;
}

// Replaced at build time by `viteVersion` with the id it writes to
// `/version.json`; undeclared in a bundle built without that plugin.
declare const __SCANI_BUILD_VERSION__: string | undefined;

/** The version this running bundle was built as, or `null` when its build did not say. */
export function bundleVersion(): string | null {
  return deployedVersion({
    version: typeof __SCANI_BUILD_VERSION__ === 'string' ? __SCANI_BUILD_VERSION__ : undefined,
  });
}

/**
 * Whether the first `/version.json` read of a page load offers the update.
 *
 * With the bundle's own version the answer is exact: the page is stale only if
 * the host serves a different build. The comparison with what the PREVIOUS
 * visit saw is the fallback for a bundle that cannot say, because it offers
 * the update to a page that already loaded the new build, once per deploy.
 */
export function offersOnFirstRead(
  served: string,
  bundle: string | null,
  lastKnown: string | null
): boolean {
  if (bundle !== null) return served !== bundle;
  return lastKnown !== null && lastKnown !== served;
}

/** Which detection route raised the banner. */
export type UpdateRoute =
  | 'first-read'
  | 'version-poll'
  | 'sw-waiting'
  | 'sw-installed'
  | 'sw-message';

export interface UpdateOffer {
  route: UpdateRoute;
  /** What `/version.json` named, or `null` when the route did not read it. */
  served: string | null;
  bundle: string | null;
}

export type UpdateOfferReporter = (offer: UpdateOffer) => void;

let offerReporter: UpdateOfferReporter | null = null;

/**
 * Wire the host app's reporter for every banner raised, so a banner a user
 * reports names the route that raised it and the two versions it compared
 * (SC-1562). Shared code stays free of `@sentry/react`, as with
 * `setServiceWorkerReporter`.
 */
export function setUpdateOfferReporter(report: UpdateOfferReporter | null): void {
  offerReporter = report;
}

/**
 * Whether a service-worker signal offers the update, given a fresh read of
 * `/version.json`.
 *
 * A waiting worker says only that the browser holds a worker it has not
 * activated, which iOS standalone apps were seen to report again on every
 * load while the page already ran the served build (SC-1562). The host is
 * the authority on which build is current, so an unread host offers nothing;
 * the version poll still finds a real deploy.
 */
export function serviceWorkerRouteOffers(served: string | null, bundle: string | null): boolean {
  if (served === null) return false;
  if (bundle === null) return true;
  return served !== bundle;
}

async function fetchServedVersion(): Promise<string | null> {
  try {
    const response = await fetch(VERSION_URL, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) return null;
    return deployedVersion(await response.json());
  } catch {
    return null;
  }
}

/**
 * Hook that detects when a new version of the app is deployed.
 *
 * Two detection mechanisms:
 * 1. Polls /version.json periodically and compares with the initial version
 * 2. Listens for service worker state changes (waiting → update available),
 *    offered only when a fresh /version.json differs from the running bundle
 *
 * When an update is detected, shows a banner. When the user clicks "Update",
 * hands the page to the waiting SW and reloads it. Dismissals are
 * persisted per version so the banner doesn't loop back every poll interval.
 */
export function useAppUpdate(): AppUpdateState {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const initialVersion = useRef<string | null>(null);
  // The version currently being offered to the user (from the /version.json
  // poll). `null` for service-worker-only updates with no version string.
  const offeredVersion = useRef<string | null>(null);

  const showing = useRef(false);

  // Surface an update unless the user already dismissed this exact version.
  const offerUpdate = useCallback((version: string | null, route: UpdateRoute) => {
    if (version && version === localStorage.getItem(DISMISSED_VERSION_STORAGE_KEY)) {
      return;
    }
    if (showing.current && offeredVersion.current === version) return;
    showing.current = true;
    offeredVersion.current = version;
    setUpdateAvailable(true);
    setDismissed(false);
    offerReporter?.({ route, served: version, bundle: bundleVersion() });
  }, []);

  const confirmAndOffer = useCallback(
    async (route: UpdateRoute) => {
      const served = await fetchServedVersion();
      if (serviceWorkerRouteOffers(served, bundleVersion())) offerUpdate(served, route);
    },
    [offerUpdate]
  );

  // Listen for SW messages
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      const action = interpretServiceWorkerMessage(event.data, wasDocumentControlledAtLoad());
      if (action.offerUpdate) {
        void confirmAndOffer('sw-message');
      }
      if (action.reload) {
        // A newer SW took over from the one this page was running under —
        // reload to get the content it now serves.
        window.location.reload();
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [confirmAndOffer]);

  // Monitor SW registration for waiting workers
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const checkWaiting = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting) {
        void confirmAndOffer('sw-waiting');
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
            void confirmAndOffer('sw-installed');
          }
        });
      });
    };

    void observe();

    return () => {
      cancelled = true;
    };
  }, [confirmAndOffer]);

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

        const version = deployedVersion(await response.json());
        if (version === null) return;

        if (initialVersion.current === null) {
          // First check this session — compare with last known version from localStorage
          initialVersion.current = version;
          const lastKnown = localStorage.getItem(VERSION_STORAGE_KEY);
          if (active && offersOnFirstRead(version, bundleVersion(), lastKnown)) {
            offerUpdate(version, 'first-read');
          }
          localStorage.setItem(VERSION_STORAGE_KEY, version);
        } else if (version !== initialVersion.current) {
          // Version changed — new deployment detected
          localStorage.setItem(VERSION_STORAGE_KEY, version);
          if (active) {
            // Offer the banner first: it is the user's route off a stale
            // bundle and must not depend on the service worker succeeding.
            offerUpdate(version, 'version-poll');

            // Then try to pull the new worker down. `requestServiceWorkerUpdate`
            // owns the failure — an un-awaited `update()` here escaped this
            // try/catch and reached Sentry as an unhandled rejection whenever
            // a deploy landed mid-session.
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

      // `serviceWorkerReady` is bounded: when registration failed there is no
      // worker and a bare await would strand the banner on "Updating…" forever,
      // trapping the user on the stale bundle.
      const registration = await serviceWorkerReady();
      if (registration && !(await activateWaitingWorker(registration))) {
        // No newer worker — tell the current one to clear its caches, and check
        // for one.
        registration.active?.postMessage({ type: 'CLEAR_CACHE' });
        await requestServiceWorkerUpdate(registration);
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
    showing.current = false;
    setDismissed(true);
  }, []);

  return {
    updateAvailable: updateAvailable && !dismissed,
    applyUpdate,
    dismissUpdate,
  };
}
