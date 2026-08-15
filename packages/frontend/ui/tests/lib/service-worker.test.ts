import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  interpretServiceWorkerMessage,
  listenForServiceWorkerReports,
  registerServiceWorker,
  requestServiceWorkerUpdate,
  serviceWorkerReady,
  setServiceWorkerReporter,
  wasDocumentControlledAtLoad,
} from '../../src/lib/service-worker';

type Mutable = Record<string, unknown>;

const originalNavigator = (globalThis as Mutable).navigator;
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalError = console.error;

const LOAD_FAILURE = new TypeError('Script https://app.scani.xyz/sw.js load failed');

function setNavigator(serviceWorker: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: serviceWorker === undefined ? {} : { serviceWorker },
    configurable: true,
    writable: true,
  });
}

/** Stand in for what Cloudflare Pages returns for `/sw.js`. */
function stubProbe(status: number, contentType: string | null): void {
  globalThis.fetch = mock(
    async () =>
      new Response(null, {
        status,
        headers: contentType ? { 'content-type': contentType } : {},
      })
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  console.warn = mock(() => {});
  console.error = mock(() => {});
  setServiceWorkerReporter(null);
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
  globalThis.fetch = originalFetch;
  setServiceWorkerReporter(null);
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
});

describe('registerServiceWorker', () => {
  test('a mid-deploy failure resolves instead of rejecting, and is not reported', async () => {
    setNavigator({ register: async () => Promise.reject(LOAD_FAILURE) });
    // The script is still served — the reference the tab held simply went stale.
    stubProbe(200, 'application/javascript');
    const report = mock(() => {});
    setServiceWorkerReporter(report);

    expect(await registerServiceWorker()).toBeNull();

    expect(report).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  test('a script that is not served is reported as an error', async () => {
    setNavigator({ register: async () => Promise.reject(LOAD_FAILURE) });
    stubProbe(404, 'text/html');
    const report = mock(() => {});
    setServiceWorkerReporter(report);

    expect(await registerServiceWorker()).toBeNull();

    expect(report).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });

  test('the Pages SPA fallback (200 text/html) counts as not served', async () => {
    // Cloudflare Pages answers an unknown path with the SPA shell at HTTP 200,
    // so status alone would silently absolve a genuinely missing sw.js.
    setNavigator({ register: async () => Promise.reject(LOAD_FAILURE) });
    stubProbe(200, 'text/html; charset=utf-8');
    const report = mock(() => {});
    setServiceWorkerReporter(report);

    await registerServiceWorker();

    expect(report).toHaveBeenCalledTimes(1);
  });

  test('an unreachable probe (offline) is treated as transient', async () => {
    setNavigator({ register: async () => Promise.reject(LOAD_FAILURE) });
    globalThis.fetch = mock(async () => {
      throw new TypeError('Load failed');
    }) as unknown as typeof fetch;
    const report = mock(() => {});
    setServiceWorkerReporter(report);

    await registerServiceWorker();

    expect(report).not.toHaveBeenCalled();
  });

  test('returns null without touching the network when SW is unsupported', async () => {
    setNavigator(undefined);
    globalThis.fetch = mock(async () => new Response(null)) as unknown as typeof fetch;

    expect(await registerServiceWorker()).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('a successful registration is returned unchanged', async () => {
    const registration = { scope: '/' } as unknown as ServiceWorkerRegistration;
    setNavigator({ register: async () => registration });

    expect(await registerServiceWorker()).toBe(registration);
  });
});

describe('requestServiceWorkerUpdate', () => {
  test('swallows the rejection that used to escape as an unhandled error', async () => {
    setNavigator({});
    stubProbe(200, 'application/javascript');
    const registration = {
      update: async () => Promise.reject(LOAD_FAILURE),
    } as unknown as ServiceWorkerRegistration;

    await expect(requestServiceWorkerUpdate(registration)).resolves.toBeUndefined();
  });
});

describe('serviceWorkerReady', () => {
  test('resolves null rather than hanging when no worker ever activates', async () => {
    // What a failed registration leaves behind: `ready` never settles.
    setNavigator({ ready: new Promise<never>(() => {}) });

    expect(await serviceWorkerReady(10)).toBeNull();
  });

  test('resolves the registration when a worker is active', async () => {
    const registration = { scope: '/' } as unknown as ServiceWorkerRegistration;
    setNavigator({ ready: Promise.resolve(registration) });

    expect(await serviceWorkerReady(50)).toBe(registration);
  });

  test('resolves null when the browser has no service-worker support', async () => {
    setNavigator(undefined);

    expect(await serviceWorkerReady(10)).toBeNull();
  });
});

describe('listenForServiceWorkerReports', () => {
  function setMessageChannel(): (message: unknown) => void {
    const handlers = new Set<(event: MessageEvent) => void>();
    setNavigator({
      addEventListener: (_type: string, handler: (event: MessageEvent) => void) =>
        handlers.add(handler),
      removeEventListener: (_type: string, handler: (event: MessageEvent) => void) =>
        handlers.delete(handler),
    });
    return (data: unknown) => {
      for (const handler of handlers) handler({ data } as MessageEvent);
    };
  }

  test('reports an asset the worker could not get served', () => {
    const send = setMessageChannel();
    const report = mock(() => {});
    setServiceWorkerReporter(report);

    listenForServiceWorkerReports();
    send({
      type: 'SW_ASSET_UNAVAILABLE',
      url: 'https://app.scani.xyz/assets/index-deadbeef.js',
      detail: 'HTTP 200, content-type text/html',
    });

    expect(report).toHaveBeenCalledTimes(1);
    const [error, detail] = report.mock.calls[0] as unknown as [Error, string];
    expect(error.message).toContain('/assets/index-deadbeef.js');
    expect(detail).toBe('fetch: HTTP 200, content-type text/html');
  });

  test('ignores the worker messages that are not failures', () => {
    const send = setMessageChannel();
    const report = mock(() => {});
    setServiceWorkerReporter(report);

    listenForServiceWorkerReports();
    send({ type: 'SW_ACTIVATED' });

    expect(report).not.toHaveBeenCalled();
  });

  test('stops reporting once detached', () => {
    const send = setMessageChannel();
    const report = mock(() => {});
    setServiceWorkerReporter(report);

    listenForServiceWorkerReports()();
    send({ type: 'SW_ASSET_UNAVAILABLE', url: '/a.js', detail: 'x' });

    expect(report).not.toHaveBeenCalled();
  });

  test('is a no-op without service-worker support', () => {
    setNavigator(undefined);

    expect(() => listenForServiceWorkerReports()()).not.toThrow();
  });
});

describe('interpretServiceWorkerMessage', () => {
  test('a first install announces itself, and is not an update', () => {
    // The device had no worker, so this document fetched its own bytes from
    // the network during this navigation. Reloading for it would pay for the
    // whole boot twice — the eight-second magic-link landing in SC-130.
    expect(interpretServiceWorkerMessage({ type: 'SW_ACTIVATED' }, false)).toEqual({
      reload: false,
      offerUpdate: false,
    });
    expect(interpretServiceWorkerMessage({ type: 'SW_UPDATE_WAITING' }, false)).toEqual({
      reload: false,
      offerUpdate: false,
    });
  });

  test('an activation under a running worker is a real update', () => {
    expect(interpretServiceWorkerMessage({ type: 'SW_ACTIVATED' }, true)).toEqual({
      reload: true,
      offerUpdate: false,
    });
  });

  test('a worker waiting behind the running one offers the banner', () => {
    expect(interpretServiceWorkerMessage({ type: 'SW_UPDATE_WAITING' }, true)).toEqual({
      reload: false,
      offerUpdate: true,
    });
  });

  test('unrelated or malformed messages do nothing', () => {
    for (const data of [undefined, null, {}, { type: 'SW_ASSET_UNAVAILABLE' }, 'SW_ACTIVATED']) {
      expect(interpretServiceWorkerMessage(data, true)).toEqual({
        reload: false,
        offerUpdate: false,
      });
    }
  });
});

describe('wasDocumentControlledAtLoad', () => {
  test('answers about load time, not about now', () => {
    // The value is captured when the module is evaluated. A worker that
    // claims the page later must not change the answer, or the guard above
    // reads `true` for exactly the first install it exists to catch.
    const atLoad = wasDocumentControlledAtLoad();
    setNavigator({ controller: {} });

    expect(wasDocumentControlledAtLoad()).toBe(atLoad);
  });
});
