import { describe, expect, test } from 'bun:test';
import {
  assertHostIsPublic,
  BoundedFetchError,
  type FetchLike,
  followRedirectsSafely,
} from '../src/fetch-html-bounded';

/**
 * SC-208. Found while designing the favicon proxy, which would have inherited
 * it — and then, on review, found to have been fixed in the wrong file.
 *
 * There were THREE byte-identical copies of this module on `main`:
 * `apps/backend/api/src/lib/`, `apps/backend/data-provider/src/lib/`, and this
 * package. Only the package is imported by anything — `institutions.ts` and
 * `og.ts` both go through `@scani/http-fetch` — so the first version of this
 * fix hardened a dead copy and left the live hole open. The two dead copies are
 * deleted; `no-second-fetcher.test.ts` is what stops a fourth appearing.
 *
 * `fetchHtmlBounded` validated the host once, on the URL the caller supplied,
 * and then fetched with `redirect: 'follow'`. That guard is worth nothing
 * against a redirect: a public host answers 302 to `http://169.254.169.254/`
 * or a `.internal` name and `fetch` walks there on our behalf, from inside the
 * Fly network. `response.url` — where we actually ended up — was returned to
 * the caller and never checked.
 *
 * It matters more than the SC-208 ticket assumed. That ticket reasons the risk
 * is low because `institutions.website` is data we seed. It is not only seeded:
 * `InstitutionService.create` lets a USER create an institution with any
 * `website` they like, so the URL is attacker-influenced and always was.
 *
 * The hop walk takes an injected `fetch`, so every case below is deterministic
 * and touches no network — including DNS. Public hops use IP LITERALS rather
 * than hostnames on purpose: `assertHostIsPublic` resolves a hostname before
 * judging it, so a test written with `example.com` fails in a sandbox with no
 * resolver, for a reason that has nothing to do with what it is testing.
 * 93.184.216.34 and 93.184.216.35 are public addresses and skip DNS entirely.
 */

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** A fetch that replays a scripted sequence and records where it was sent. */
function scripted(responses: Response[]): { fetch: FetchLike; visited: string[] } {
  const visited: string[] = [];
  let i = 0;
  return {
    visited,
    fetch: async (url: string) => {
      visited.push(url);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r ?? new Response('ok', { status: 200 });
    },
  };
}

describe('a redirect cannot walk us into the private network', () => {
  test('THE HOLE: a public host redirecting to the metadata address is refused', async () => {
    // 169.254.169.254 is the cloud metadata endpoint — the canonical SSRF
    // target, and reachable from inside Fly.
    const { fetch, visited } = scripted([redirectTo('http://169.254.169.254/latest/meta-data/')]);
    await expect(
      followRedirectsSafely(new URL('https://example.com/'), {}, fetch)
    ).rejects.toBeInstanceOf(BoundedFetchError);

    // Refused BEFORE the second request went out. Under `redirect: 'follow'`
    // the request had already been made by the time anyone could object.
    expect(visited).toEqual(['https://example.com/']);
  });

  test('a redirect to a fly-internal name is refused', async () => {
    const { fetch, visited } = scripted([redirectTo('http://scani-worker.internal:6379/')]);
    await expect(
      followRedirectsSafely(new URL('https://example.com/'), {}, fetch)
    ).rejects.toBeInstanceOf(BoundedFetchError);
    expect(visited).toHaveLength(1);
  });

  test('a redirect to loopback is refused', async () => {
    const { fetch } = scripted([redirectTo('http://127.0.0.1:8080/')]);
    await expect(
      followRedirectsSafely(new URL('https://example.com/'), {}, fetch)
    ).rejects.toBeInstanceOf(BoundedFetchError);
  });

  test('a redirect to a non-http scheme is refused', async () => {
    const { fetch } = scripted([redirectTo('file:///etc/passwd')]);
    await expect(
      followRedirectsSafely(new URL('https://example.com/'), {}, fetch)
    ).rejects.toBeInstanceOf(BoundedFetchError);
  });

  test('a redirect CHAIN is validated at every hop, not just the first', async () => {
    // The case a "check the final URL afterwards" fix would also catch, and
    // the case a "check the first hop" fix would not: two public hops, then a
    // private one.
    const { fetch, visited } = scripted([
      redirectTo('https://93.184.216.35/'),
      redirectTo('http://10.0.0.1/'),
    ]);
    await expect(
      followRedirectsSafely(new URL('https://93.184.216.34/'), {}, fetch)
    ).rejects.toBeInstanceOf(BoundedFetchError);
    expect(visited).toEqual(['https://93.184.216.34/', 'https://93.184.216.35/']);
  });
});

describe('THE SUCCESS PATH — asserted deliberately', () => {
  test('a direct 200 is returned untouched, with one request', async () => {
    const { fetch, visited } = scripted([new Response('hello', { status: 200 })]);
    const r = await followRedirectsSafely(new URL('https://example.com/'), {}, fetch);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hello');
    expect(visited).toEqual(['https://example.com/']);
  });

  test('an ordinary public redirect is followed', async () => {
    // The behaviour that must survive: `www.` → apex, http → https, and the
    // Google favicon service's own 301 to gstatic, which is what SC-203 was.
    const { fetch, visited } = scripted([
      redirectTo('https://93.184.216.35/'),
      new Response('final', { status: 200 }),
    ]);
    const r = await followRedirectsSafely(new URL('https://93.184.216.34/'), {}, fetch);
    expect(r.status).toBe(200);
    expect(visited).toEqual(['https://93.184.216.34/', 'https://93.184.216.35/']);
  });

  test('a relative Location is resolved against the current hop', async () => {
    const { fetch, visited } = scripted([
      redirectTo('/icon.png'),
      new Response('img', { status: 200 }),
    ]);
    await followRedirectsSafely(new URL('https://93.184.216.34/a/b'), {}, fetch);
    expect(visited[1]).toBe('https://93.184.216.34/icon.png');
  });

  test('a 3xx with no Location is a response, not a redirect', async () => {
    // 304 Not Modified carries no Location and must not be walked.
    const { fetch } = scripted([new Response(null, { status: 304 })]);
    const r = await followRedirectsSafely(new URL('https://example.com/'), {}, fetch);
    expect(r.status).toBe(304);
  });
});

describe('the walk is bounded', () => {
  test('an endless redirect loop stops rather than spinning', async () => {
    const { fetch, visited } = scripted([redirectTo('https://93.184.216.34/next')]);
    await expect(
      followRedirectsSafely(new URL('https://93.184.216.34/'), {}, fetch)
    ).rejects.toBeInstanceOf(BoundedFetchError);
    // MAX_REDIRECTS = 3, so four requests are made and the fifth is refused.
    expect(visited.length).toBeLessThanOrEqual(4);
  });
});

describe('the guard itself, now shared rather than copied', () => {
  test('it is exported so a second fetcher reuses it', async () => {
    // A private-address check that exists twice is one that will be right in
    // one place and stale in the other — and the copy is the one nobody
    // reviews. Same argument as SC-300's date formatting.
    expect(typeof assertHostIsPublic).toBe('function');
  });

  test('public hostnames pass, private literals do not', async () => {
    await expect(assertHostIsPublic('93.184.216.34')).resolves.toBeUndefined();
    await expect(assertHostIsPublic('localhost')).rejects.toBeInstanceOf(BoundedFetchError);
    await expect(assertHostIsPublic('10.1.2.3')).rejects.toBeInstanceOf(BoundedFetchError);
    await expect(assertHostIsPublic('169.254.169.254')).rejects.toBeInstanceOf(BoundedFetchError);
    await expect(assertHostIsPublic('[::1]')).rejects.toBeInstanceOf(BoundedFetchError);
    await expect(assertHostIsPublic('anything.internal')).rejects.toBeInstanceOf(BoundedFetchError);
  });
});
