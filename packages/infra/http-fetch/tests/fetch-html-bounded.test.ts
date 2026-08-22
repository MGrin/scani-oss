import { describe, expect, test } from 'bun:test';
import { fetchHtmlBounded } from '../src/fetch-html-bounded';

// SSRF + URL-validation paths are the security-critical surface; they're
// also the only paths reachable without a network round-trip in CI. The
// happy-path (text/html → truncated body, content-type rejection,
// timeout) is exercised end-to-end by the consumers' integration tests
// against real upstreams.

describe('fetchHtmlBounded — URL validation', () => {
  test('rejects an invalid URL string', async () => {
    await expect(fetchHtmlBounded('not-a-url')).rejects.toMatchObject({
      name: 'BoundedFetchError',
      reason: 'invalid-url',
    });
  });

  test('rejects unsupported protocol (file:)', async () => {
    await expect(fetchHtmlBounded('file:///etc/passwd')).rejects.toMatchObject({
      reason: 'invalid-url',
    });
  });

  test('rejects unsupported protocol (gopher:)', async () => {
    await expect(fetchHtmlBounded('gopher://example.com/')).rejects.toMatchObject({
      reason: 'invalid-url',
    });
  });
});

describe('fetchHtmlBounded — SSRF guards', () => {
  test('rejects literal localhost', async () => {
    await expect(fetchHtmlBounded('http://localhost/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects literal IPv4 loopback', async () => {
    await expect(fetchHtmlBounded('http://127.0.0.1/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects literal RFC1918 10.x range', async () => {
    await expect(fetchHtmlBounded('http://10.0.0.1/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects literal RFC1918 192.168.x range', async () => {
    await expect(fetchHtmlBounded('http://192.168.1.1/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects RFC1918 172.16-31 range (boundary 172.16)', async () => {
    await expect(fetchHtmlBounded('http://172.16.0.1/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects RFC1918 172.16-31 range (boundary 172.31)', async () => {
    await expect(fetchHtmlBounded('http://172.31.255.255/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('does NOT reject 172.32 (just outside the RFC1918 172/12 range)', async () => {
    // Should make it past the SSRF guard and fail later (DNS or fetch).
    // Not reason='blocked-host'.
    await expect(fetchHtmlBounded('http://172.32.0.1/')).rejects.not.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects link-local IPv4 169.254.x', async () => {
    await expect(fetchHtmlBounded('http://169.254.169.254/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects CGNAT range 100.64-127.x', async () => {
    await expect(fetchHtmlBounded('http://100.64.0.1/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects 0.0.0.0/8', async () => {
    await expect(fetchHtmlBounded('http://0.0.0.0/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects multicast 224.0.0.0+', async () => {
    await expect(fetchHtmlBounded('http://224.0.0.1/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects IPv6 loopback', async () => {
    await expect(fetchHtmlBounded('http://[::1]/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects IPv6 link-local fe80::', async () => {
    await expect(fetchHtmlBounded('http://[fe80::1]/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects IPv6 unique-local fc00::', async () => {
    await expect(fetchHtmlBounded('http://[fc00::1]/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects fly-internal suffix .internal', async () => {
    await expect(fetchHtmlBounded('http://api.internal/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects fly-internal suffix .flycast', async () => {
    await expect(fetchHtmlBounded('http://x.flycast/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects fly-internal suffix .fly.dev', async () => {
    await expect(fetchHtmlBounded('http://x.fly.dev/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });
});

describe('fetchHtmlBounded — the total budget covers the DNS step (SC-208)', () => {
  test('the budget rejects even when the step that hangs is the DNS lookup', () => {
    // NOT redundant with TIMEOUT_MS, and this is the case a future reader will
    // try to delete as duplicative. TIMEOUT_MS arms an AbortController, and an
    // AbortSignal only reaches a fetch that has STARTED. `assertHostIsPublic`
    // runs first and calls `dns.lookup`, which takes no signal — so the one
    // step that runs before every budget was the one step nothing bounded.
    //
    // Measured through this function on 2026-08-22: www.robinhood.com and
    // www.bitstamp.net each took SIXTY SECONDS on `DNS lookup failed`, not the
    // 4s this file advertises. `og.ts` and `institutions.ts` call it with a URL
    // the USER pasted, behind a cap of three concurrent fetches.
    //
    // A 1ms budget makes the assertion deterministic without a network: it
    // wins whatever the fetch underneath does.
    return expect(fetchHtmlBounded('http://93.184.216.34/', { budgetMs: 1 })).rejects.toMatchObject(
      { reason: 'timeout' }
    );
  });

  test('AND IT DOES NOT SWALLOW A CALL THAT ACTUALLY COMPLETED', async () => {
    // The control. A `withBudget` that rejected immediately would leave the
    // case above green and every other case in this file green too, because
    // they all assert on `reason` and a rejection is a rejection. This one
    // fails a refusal FAST for a different reason, under a budget it cannot
    // reach — so the reported reason has to be the real one.
    await expect(fetchHtmlBounded('http://127.0.0.1/', { budgetMs: 5_000 })).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });
});
