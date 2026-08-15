/**
 * Service-worker registration and update, with failure classification.
 *
 * A service worker that fails to install leaves a degraded — not broken —
 * app: the SPA still runs, it simply is not offline-capable until the next
 * load. The usual cause is benign, a deploy landing mid-session: the bytes
 * behind the registered `sw.js` are replaced while a tab still holds a
 * reference, and the browser rejects with `TypeError: Script <url> load
 * failed`. That must not reach Sentry as an error.
 *
 * A `sw.js` that is genuinely absent is a real defect and has to stay
 * visible, so every failure is classified by re-fetching the script.
 * Cloudflare Pages answers an unknown path with the SPA shell — HTTP 200
 * and `text/html` — so the status code alone cannot separate the two cases;
 * the content type is what distinguishes a served script from the fallback.
 */

const SERVICE_WORKER_URL = '/sw.js';
const READY_TIMEOUT_MS = 5000;
const SCRIPT_CONTENT_TYPE = /javascript|ecmascript/i;

export type ServiceWorkerReporter = (error: Error, detail: string) => void;

let reporter: ServiceWorkerReporter | null = null;

/**
 * Wire the host app's error reporter (Sentry, in practice). Only failures
 * classified as a genuinely unavailable script reach it. Shared code stays
 * free of a hard `@sentry/react` dependency, matching `ErrorBoundary`'s
 * `onError` prop.
 */
export function setServiceWorkerReporter(report: ServiceWorkerReporter | null): void {
  reporter = report;
}

type FailureKind = 'transient' | 'unavailable';

async function classifyFailure(): Promise<{ kind: FailureKind; detail: string }> {
  try {
    const response = await fetch(SERVICE_WORKER_URL, { cache: 'no-store' });
    const contentType = response.headers.get('content-type') ?? 'none';
    const served = response.ok && SCRIPT_CONTENT_TYPE.test(contentType);
    return {
      kind: served ? 'transient' : 'unavailable',
      detail: `HTTP ${response.status}, content-type ${contentType}`,
    };
  } catch {
    // The probe could not run at all — offline, or the network dropped
    // between the failed attempt and here. Nothing in that indicts the build.
    return { kind: 'transient', detail: 'probe unreachable' };
  }
}

async function handleFailure(phase: 'registration' | 'update', cause: unknown): Promise<void> {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const { kind, detail } = await classifyFailure();

  if (kind === 'transient') {
    console.warn(
      `[SW] ${phase} failed while ${SERVICE_WORKER_URL} is still being served (${detail}) — ` +
        `most likely a deploy landing mid-session. The next load re-registers. ${error.message}`
    );
    return;
  }

  console.error(
    `[SW] ${SERVICE_WORKER_URL} is not being served (${detail}) — offline support is broken`,
    error
  );
  reporter?.(error, `${phase}: ${detail}`);
}

/**
 * The service worker's own `fetch` handler applies the same classification to
 * the assets it serves: a request that fails at the network layer is a
 * transient outage it degrades over, while one answered with the SPA shell
 * where a script or stylesheet was asked for is a build that no longer
 * contains the file. There is no Sentry client in the worker's scope, so it
 * posts that second case to its clients; this is the page-side half.
 */
export function listenForServiceWorkerReports(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  const handleMessage = (event: MessageEvent) => {
    if (event.data?.type !== 'SW_ASSET_UNAVAILABLE') return;

    const url = String(event.data.url ?? 'unknown');
    const detail = String(event.data.detail ?? 'no detail');
    const error = new Error(`Asset is not being served: ${url}`);

    console.error(`[SW] ${url} is not being served (${detail})`);
    reporter?.(error, `fetch: ${detail}`);
  };

  navigator.serviceWorker.addEventListener('message', handleMessage);
  return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;

  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  } catch (cause) {
    await handleFailure('registration', cause);
    return null;
  }
}

export async function requestServiceWorkerUpdate(
  registration: ServiceWorkerRegistration
): Promise<void> {
  try {
    await registration.update();
  } catch (cause) {
    await handleFailure('update', cause);
  }
}

/**
 * `navigator.serviceWorker.ready` never settles while no worker has ever
 * reached activation — precisely the state a failed registration leaves
 * behind. Awaiting it bare strands the update flow forever, so cap the wait
 * and let callers treat `null` as "no worker to talk to".
 */
export async function serviceWorkerReady(
  timeoutMs: number = READY_TIMEOUT_MS
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a worker was already controlling this document when the bundle
 * first ran.
 *
 * Read at module evaluation, before the app registers its own worker: a
 * first-install worker calls `clients.claim()`, and from that moment
 * `navigator.serviceWorker.controller` is non-null and can no longer answer
 * the question that matters — was this document *served* under a worker?
 */
const controlledAtLoad =
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  Boolean(navigator.serviceWorker.controller);

export function wasDocumentControlledAtLoad(): boolean {
  return controlledAtLoad;
}

export interface ServiceWorkerUpdateAction {
  /** Reload: a newer build has taken over from the one currently running. */
  reload: boolean;
  /** Offer the update banner: a newer build is installed and waiting. */
  offerUpdate: boolean;
}

/**
 * What a worker's lifecycle message means for the page that received it.
 *
 * `sw.js` announces every install and every activation, and cannot tell the
 * two cases apart from inside its own scope: on a device with no worker yet,
 * the first install fires exactly the pair of messages a genuine deploy
 * fires. Only the page knows the difference — a document that was NOT under
 * a worker when it loaded fetched its own bytes from the network during this
 * navigation, so there is nothing newer to reload for.
 *
 * Treating that first install as an update is what made the iOS magic-link
 * landing take eight seconds (SC-130). The worker claimed the page mid-boot,
 * the page reloaded, and a boot that had already fetched the shell, the
 * bundle, the session probe and the first queries paid for all of it a second
 * time. WebKit reaches this state far more often than Chrome, because it
 * clears service workers along with the rest of script-writable storage after
 * seven days without interaction — so on iOS Safari "no worker yet" is the
 * ordinary state of a returning user, not an edge case.
 */
export function interpretServiceWorkerMessage(
  data: unknown,
  wasControlledAtLoad: boolean
): ServiceWorkerUpdateAction {
  // Nothing this document ran under has been superseded, so neither message
  // is an update — whatever the worker called it.
  if (!wasControlledAtLoad) return { reload: false, offerUpdate: false };

  const type = (data as { type?: unknown } | null | undefined)?.type;
  return {
    reload: type === 'SW_ACTIVATED',
    offerUpdate: type === 'SW_UPDATE_WAITING',
  };
}
