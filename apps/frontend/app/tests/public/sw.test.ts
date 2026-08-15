/**
 * `public/sw.js` ships as a static file, so it is loaded here as source and
 * evaluated against stand-in globals. The contract under test is the one
 * SC-62 broke: whatever the network does, nothing handed to `respondWith`
 * may reject — a rejection is reported by the browser as
 * `TypeError: FetchEvent.respondWith received an error`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const SW_SOURCE = await Bun.file(new URL('../../public/sw.js', import.meta.url)).text();

interface FakeRequest {
  url: string;
  method: string;
  destination: string;
  mode: string;
}

type FetchStub = (request: FakeRequest) => Promise<Response>;

interface Harness {
  dispatchFetch: (request: FakeRequest) => Promise<Response> | undefined;
  setFetch: (stub: FetchStub) => void;
  cache: Map<string, Response>;
  cachePutFailure: { value: Error | null };
  cacheMatchFailure: { value: Error | null };
  posted: unknown[];
}

function makeRequest(url: string, overrides: Partial<FakeRequest> = {}): FakeRequest {
  return { url, method: 'GET', destination: '', mode: 'cors', ...overrides };
}

function keyOf(request: FakeRequest | string): string {
  return typeof request === 'string' ? request : request.url;
}

function loadServiceWorker(): Harness {
  const listeners = new Map<string, (event: unknown) => void>();
  const cache = new Map<string, Response>();
  const cachePutFailure: { value: Error | null } = { value: null };
  const cacheMatchFailure: { value: Error | null } = { value: null };
  const posted: unknown[] = [];

  let fetchStub: FetchStub = async () => {
    throw new TypeError('Load failed');
  };

  const cacheStorage = {
    async match(request: FakeRequest | string) {
      if (cacheMatchFailure.value) throw cacheMatchFailure.value;
      return cache.get(keyOf(request));
    },
    async open() {
      return {
        async put(request: FakeRequest | string, response: Response) {
          if (cachePutFailure.value) throw cachePutFailure.value;
          cache.set(keyOf(request), response);
        },
      };
    },
    async keys() {
      return [];
    },
    async delete() {
      return true;
    },
  };

  const self = {
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(type, handler);
    },
    location: { origin: 'https://app.scani.xyz' },
    clients: {
      async matchAll() {
        return [{ postMessage: (message: unknown) => posted.push(message) }];
      },
    },
    registration: { showNotification: async () => {} },
    skipWaiting() {},
  };

  const factory = new Function(
    'self',
    'caches',
    'clients',
    'fetch',
    'Response',
    'URL',
    'console',
    SW_SOURCE
  );
  factory(
    self,
    cacheStorage,
    self.clients,
    (request: FakeRequest) => fetchStub(request),
    Response,
    URL,
    console
  );

  const onFetch = listeners.get('fetch');
  if (!onFetch) throw new Error('sw.js registered no fetch listener');

  return {
    dispatchFetch(request) {
      let responded: Promise<Response> | undefined;
      onFetch({
        request,
        respondWith(value: Promise<Response>) {
          responded = value;
        },
      });
      return responded;
    },
    setFetch(stub) {
      fetchStub = stub;
    },
    cache,
    cachePutFailure,
    cacheMatchFailure,
    posted,
  };
}

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

let sw: Harness;

beforeEach(() => {
  console.log = mock(() => {});
  console.warn = mock(() => {});
  console.error = mock(() => {});
  sw = loadServiceWorker();
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

describe('an unreachable api', () => {
  test('a /trpc call resolves to a network failure instead of rejecting', async () => {
    const responded = sw.dispatchFetch(makeRequest('https://api.scani.xyz/trpc/holdings.list'));

    expect(responded).toBeDefined();
    const response = await (responded as Promise<Response>);
    expect(response.type).toBe('error');
  });

  test('a /trpc call still prefers a cached answer', async () => {
    sw.cache.set('https://api.scani.xyz/trpc/holdings.list', new Response('{"cached":true}'));

    const response = await (sw.dispatchFetch(
      makeRequest('https://api.scani.xyz/trpc/holdings.list')
    ) as Promise<Response>);

    expect(await response.text()).toBe('{"cached":true}');
  });

  /**
   * The regression SC-62 was reported for: a session probe is a plain
   * cross-origin GET, so it fell through every strategy to a bare
   * `respondWith(fetch(request))` that rejected the moment api.scani.xyz went
   * down. Leaving the event unhandled hands the failure back to the caller,
   * where the app's own "Connection issue" handling already lives.
   */
  test('an auth session probe is left to the browser entirely', () => {
    expect(sw.dispatchFetch(makeRequest('https://api.scani.xyz/api/auth/get-session'))).toBe(
      undefined
    );
  });

  test('a navigation falls back to the cached shell', async () => {
    sw.cache.set('/', new Response('<!doctype html>shell'));

    const response = await (sw.dispatchFetch(
      makeRequest('https://app.scani.xyz/holdings', { destination: 'document', mode: 'navigate' })
    ) as Promise<Response>);

    expect(await response.text()).toBe('<!doctype html>shell');
  });

  test('a navigation with no cached shell still resolves', async () => {
    const response = await (sw.dispatchFetch(
      makeRequest('https://app.scani.xyz/holdings', { destination: 'document', mode: 'navigate' })
    ) as Promise<Response>);

    expect(response.type).toBe('error');
  });

  test('an uncached hashed asset resolves instead of rethrowing', async () => {
    const response = await (sw.dispatchFetch(
      makeRequest('https://app.scani.xyz/assets/index-a1b2c3d4.js', { destination: 'script' })
    ) as Promise<Response>);

    expect(response.type).toBe('error');
  });

  test('an uncached font resolves instead of rejecting', async () => {
    const response = await (sw.dispatchFetch(
      makeRequest('https://app.scani.xyz/fonts/plex.woff2', { destination: 'font' })
    ) as Promise<Response>);

    expect(response.type).toBe('error');
  });

  test('nothing is reported to the page — an outage is not a build defect', async () => {
    await (sw.dispatchFetch(
      makeRequest('https://api.scani.xyz/trpc/holdings.list')
    ) as Promise<Response>);

    expect(sw.posted).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('/version.json', () => {
  test('is left to the browser rather than proxied', () => {
    expect(sw.dispatchFetch(makeRequest('https://app.scani.xyz/version.json'))).toBe(undefined);
  });
});

describe('a missing asset', () => {
  /**
   * Cloudflare Pages answers an unknown path with the SPA shell at HTTP 200
   * and `text/html`, so only the content type separates a served script from
   * one the build no longer contains.
   */
  const shell = () =>
    new Response('<!doctype html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

  test('is reported to the page instead of being swallowed', async () => {
    sw.setFetch(async () => shell());

    await (sw.dispatchFetch(
      makeRequest('https://app.scani.xyz/assets/index-deadbeef.js', { destination: 'script' })
    ) as Promise<Response>);

    expect(sw.posted).toEqual([
      {
        type: 'SW_ASSET_UNAVAILABLE',
        url: 'https://app.scani.xyz/assets/index-deadbeef.js',
        detail: 'HTTP 200, content-type text/html; charset=utf-8',
      },
    ]);
  });

  test('is never cached, so cache-first cannot pin the shell under its URL', async () => {
    sw.setFetch(async () => shell());

    await (sw.dispatchFetch(
      makeRequest('https://app.scani.xyz/assets/index-deadbeef.js', { destination: 'script' })
    ) as Promise<Response>);

    expect(sw.cache.size).toBe(0);
  });

  test('a genuinely served script is cached and reported to nobody', async () => {
    sw.setFetch(
      async () =>
        new Response('export {}', {
          status: 200,
          headers: { 'content-type': 'application/javascript' },
        })
    );

    await (sw.dispatchFetch(
      makeRequest('https://app.scani.xyz/assets/index-c0ffee00.js', { destination: 'script' })
    ) as Promise<Response>);

    expect(sw.cache.has('https://app.scani.xyz/assets/index-c0ffee00.js')).toBe(true);
    expect(sw.posted).toEqual([]);
  });
});

describe('a failing cache', () => {
  test('a rejected put still returns the fresh response', async () => {
    sw.cachePutFailure.value = new Error('QuotaExceededError');
    sw.setFetch(async () => new Response('fresh'));

    const response = await (sw.dispatchFetch(
      makeRequest('https://api.scani.xyz/trpc/holdings.list')
    ) as Promise<Response>);

    expect(await response.text()).toBe('fresh');
  });

  test('a rejected lookup degrades to the network rather than failing', async () => {
    sw.cacheMatchFailure.value = new Error('cache unavailable');
    sw.setFetch(async () => new Response('fresh'));

    const response = await (sw.dispatchFetch(
      makeRequest('https://app.scani.xyz/assets/index-a1b2c3d4.js', { destination: 'script' })
    ) as Promise<Response>);

    expect(await response.text()).toBe('fresh');
  });
});

describe('non-GET requests', () => {
  test('are never intercepted', () => {
    expect(
      sw.dispatchFetch(
        makeRequest('https://api.scani.xyz/trpc/holdings.create', { method: 'POST' })
      )
    ).toBe(undefined);
  });
});
