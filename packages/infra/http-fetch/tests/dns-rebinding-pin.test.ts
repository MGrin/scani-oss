import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoundedFetchError,
  type FetchLike,
  followRedirectsSafely,
  type Resolver,
} from '../src/fetch-html-bounded';

/**
 * SC-1284, the second gap. The guard resolved a hostname and judged the
 * answer, then `fetch` resolved the SAME NAME AGAIN and connected to whatever
 * that second lookup said. A resolver that answers public once and loopback
 * the next time (DNS rebinding, TTL 0) passed the check and reached the
 * private address anyway.
 *
 * The fix connects to the address that was validated: the URL's host is
 * replaced by the IP, the `Host` header carries the original host, and on
 * https `tls.serverName` carries the original name — which Bun uses for SNI
 * AND for certificate verification (measured in the last describe below, and
 * against a real Cloudflare origin while writing this).
 */

const PUBLIC = '93.184.216.34';

interface Call {
  url: string;
  host: string | null;
  serverName: string | undefined;
}

function recording(responses: Response[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        host: new Headers(init.headers).get('host'),
        serverName: (init as { tls?: { serverName?: string } }).tls?.serverName,
      });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r ?? new Response('ok');
    },
  };
}

/** Public on the first answer, loopback on every answer after it. */
function rebinding(): { resolve: Resolver; lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    resolve: async (hostname) => {
      lookups.push(hostname);
      return [{ address: lookups.length === 1 ? PUBLIC : '127.0.0.1', family: 4 }];
    },
  };
}

describe('the request goes to the address that was validated', () => {
  test('THE HOLE: a rebinding resolver cannot move the connection to loopback', async () => {
    const { resolve, lookups } = rebinding();
    const { fetch, calls } = recording([new Response('ok')]);
    const { url } = await followRedirectsSafely(
      new URL('https://rebind.test/p?q=1'),
      {},
      fetch,
      resolve
    );

    // One lookup, and the connection target IS its answer. Nothing downstream
    // is given the hostname to resolve a second time.
    expect(lookups).toEqual(['rebind.test']);
    expect(calls).toEqual([
      { url: `https://${PUBLIC}/p?q=1`, host: 'rebind.test', serverName: 'rebind.test' },
    ]);
    // The caller still sees the URL it asked for, not the pinned IP.
    expect(url.href).toBe('https://rebind.test/p?q=1');
  });

  test('a resolver that answers private first is refused before any request', async () => {
    const { fetch, calls } = recording([new Response('ok')]);
    const privateFirst: Resolver = async () => [{ address: '10.0.0.5', family: 4 }];
    await expect(
      followRedirectsSafely(new URL('https://rebind.test/'), {}, fetch, privateFirst)
    ).rejects.toBeInstanceOf(BoundedFetchError);
    expect(calls).toEqual([]);
  });

  test('one private answer among several refuses the host', async () => {
    const { fetch, calls } = recording([new Response('ok')]);
    const mixed: Resolver = async () => [
      { address: PUBLIC, family: 4 },
      { address: '::ffff:7f00:1', family: 6 },
    ];
    await expect(
      followRedirectsSafely(new URL('https://rebind.test/'), {}, fetch, mixed)
    ).rejects.toBeInstanceOf(BoundedFetchError);
    expect(calls).toEqual([]);
  });

  test('each redirect hop is resolved once and pinned to its own answer', async () => {
    const { resolve, lookups } = rebinding();
    const { fetch, calls } = recording([
      new Response(null, { status: 302, headers: { location: '/next' } }),
      new Response('ok'),
    ]);
    // The second hop's lookup answers loopback, so the walk must refuse it —
    // it may not reuse the first hop's validation for a new request.
    await expect(
      followRedirectsSafely(new URL('https://rebind.test/'), {}, fetch, resolve)
    ).rejects.toBeInstanceOf(BoundedFetchError);
    expect(lookups).toEqual(['rebind.test', 'rebind.test']);
    expect(calls).toHaveLength(1);
  });

  test('a relative redirect resolves against the requested URL, not the pinned IP', async () => {
    const resolve: Resolver = async () => [{ address: PUBLIC, family: 4 }];
    const { fetch, calls } = recording([
      new Response(null, { status: 301, headers: { location: '/icon.png' } }),
      new Response('img'),
    ]);
    const { url } = await followRedirectsSafely(new URL('https://a.test/x'), {}, fetch, resolve);
    expect(url.href).toBe('https://a.test/icon.png');
    expect(calls[1]).toEqual({
      url: `https://${PUBLIC}/icon.png`,
      host: 'a.test',
      serverName: 'a.test',
    });
  });

  test('a non-default port stays in the URL and in the Host header', async () => {
    const resolve: Resolver = async () => [{ address: PUBLIC, family: 4 }];
    const { fetch, calls } = recording([new Response('ok')]);
    await followRedirectsSafely(new URL('http://a.test:8080/'), {}, fetch, resolve);
    expect(calls[0]).toEqual({
      url: `http://${PUBLIC}:8080/`,
      host: 'a.test:8080',
      serverName: undefined,
    });
  });

  test('an IPv6 answer is bracketed in the pinned URL', async () => {
    const resolve: Resolver = async () => [{ address: '2606:4700:4700::1111', family: 6 }];
    const { fetch, calls } = recording([new Response('ok')]);
    await followRedirectsSafely(new URL('https://a.test/'), {}, fetch, resolve);
    expect(calls[0]?.url).toBe('https://[2606:4700:4700::1111]/');
  });

  test('caller headers survive beside the pinned Host', async () => {
    const resolve: Resolver = async () => [{ address: PUBLIC, family: 4 }];
    let seen: Headers | undefined;
    const fetch: FetchLike = async (_url, init) => {
      seen = new Headers(init.headers);
      return new Response('ok');
    };
    await followRedirectsSafely(
      new URL('https://a.test/'),
      { headers: { 'User-Agent': 'ScaniBot/1.0' } },
      fetch,
      resolve
    );
    expect(seen?.get('user-agent')).toBe('ScaniBot/1.0');
    expect(seen?.get('host')).toBe('a.test');
  });
});

/**
 * The pin is only safe if certificate verification still binds to the NAME.
 * Measured on Bun 1.3.14: fetching `https://<ip>/` with no `serverName` does
 * not check the certificate's name at all — a cert for `a.test` is accepted
 * for `127.0.0.1`. With `serverName` set, Bun verifies against it. So these
 * run the pinned request through REAL fetch against a TLS server whose cert
 * names `a.test`, and the second test is the control: the same server under a
 * name its cert does not carry must be refused.
 */
describe('the pinned request still verifies the certificate against the name', () => {
  let dir = '';
  let cert = '';
  let server: ReturnType<typeof Bun.serve> | undefined;
  const hosts: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc1284-'));
    const gen = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=a.test',
      '-addext',
      'subjectAltName=DNS:a.test',
    ]);
    if (gen.exitCode !== 0) throw new Error(`openssl failed: ${gen.stderr.toString()}`);
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert, key: readFileSync(join(dir, 'key.pem'), 'utf8') },
      fetch: (req) => {
        hosts.push(req.headers.get('host') ?? '');
        return new Response('ok');
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // The resolver answers a public address so the guard admits it; the fetch
  // then swaps that address for the loopback server and trusts the test CA.
  // Everything else — Host, serverName — is exactly what the pin produced.
  const resolve: Resolver = async () => [{ address: PUBLIC, family: 4 }];
  const viaLoopback: FetchLike = (url, init) =>
    fetch(url.replace(PUBLIC, '127.0.0.1'), {
      ...init,
      tls: { ...(init as { tls?: object }).tls, ca: cert },
    } as RequestInit);

  test('the name on the certificate is accepted', async () => {
    const { response } = await followRedirectsSafely(
      new URL(`https://a.test:${server?.port}/`),
      {},
      viaLoopback,
      resolve
    );
    expect(response.status).toBe(200);
    expect(hosts.at(-1)).toBe(`a.test:${server?.port}`);
  });

  test('CONTROL: a name the certificate does not carry is refused', async () => {
    await expect(
      followRedirectsSafely(new URL(`https://b.test:${server?.port}/`), {}, viaLoopback, resolve)
    ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });
});
