/**
 * Bounded HTML fetcher for Open Graph metadata extraction.
 *
 * `open-graph-scraper` v6 internally calls `await response.arrayBuffer()`,
 * which buffers the entire response body into memory with no size cap.
 * On a 512MB Fly machine, a handful of concurrent requests to slow or
 * large pages (including intentionally-blocked geo regions that keep
 * streaming until the 5s abort fires) is enough to OOM the process —
 * see PR #408 and the follow-up in this file's git blame.
 *
 * This helper does the HTTP ourselves with hard limits, then the caller
 * passes the truncated HTML into `ogs({ html })`. All OG / Twitter Card
 * / oEmbed tags live in `<head>`, so the first ~32KB is almost always
 * enough — we cap at 512KB to leave generous headroom for CMSes that
 * inject large amounts of boilerplate before `</head>`.
 *
 * Guards:
 *   - Only `http:` / `https:` URLs.
 *   - DNS-resolved SSRF guard (rejects private / loopback / link-local /
 *     unique-local / fly-internal addresses, and IPv6 forms that embed one),
 *     with the connection pinned to the address it judged.
 *   - 4s end-to-end timeout via `AbortSignal.timeout`.
 *   - Response body truncated at `MAX_BYTES` via streaming reader.
 *   - Content-Type must start with `text/` (HTML-ish). JSON / binary
 *     downloads are rejected before we start reading the body.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BoundedFetchError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'invalid-url'
      | 'blocked-host'
      | 'timeout'
      | 'bad-status'
      | 'bad-content-type'
      | 'too-large'
      | 'network'
  ) {
    super(message);
    this.name = 'BoundedFetchError';
  }
}

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 4000;

/**
 * The bound on the WHOLE call, and it is not redundant with `TIMEOUT_MS`.
 *
 * `TIMEOUT_MS` arms an `AbortController` and an `AbortSignal` only reaches a
 * fetch that has STARTED. `assertHostIsPublic` runs first and calls
 * `dns.lookup`, which takes no signal and has no deadline of its own — so the
 * one step that runs before every budget is the one step nothing bounds.
 *
 * Measured through this function on 2026-08-22 (SC-208): `www.robinhood.com`
 * and `www.bitstamp.net` each took **60 seconds** on `DNS lookup failed`, not
 * the 4 seconds this file advertises.
 *
 * It matters most on the path that was here first. `og.ts` and
 * `institutions.ts` call this with a URL THE USER PASTED, behind a cap of
 * three concurrent fetches — so three hosts with a black-holed resolver hold
 * every OG slot for a minute, and the per-user limiter allows twenty a minute.
 *
 * 6s is `TIMEOUT_MS` plus headroom for a healthy lookup.
 */
const TOTAL_BUDGET_MS = 6_000;

/**
 * Reject with a `BoundedFetchError` if `work` has not settled in `ms`.
 *
 * A race, not a cancellation — the abandoned lookup finishes on its own and is
 * collected. That is the honest bound available here: `dns.lookup` takes no
 * signal, so the alternative is not "cancel it" but "stop waiting for it".
 *
 * Exported and shared with `site-icon.ts` on the same reasoning
 * `no-second-fetcher.test.ts` encodes: a bound that exists twice is one that
 * will be right in one place and stale in the other.
 */
export async function withBudget<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BoundedFetchError(`${label} exceeded ${ms}ms`, 'timeout')),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Host suffixes we never want to hit from the backend — either our own
// internal Fly service names (SSRF self-recursion) or well-known cloud
// metadata endpoints reached by hostname.
const BLOCKED_HOST_SUFFIXES = ['.internal', '.flycast', '.fly.dev'];

function isPrivateOrReservedIpv4(bytes: ArrayLike<number>): boolean {
  const a = bytes[0] ?? 0;
  const b = bytes[1] ?? 0;
  const c = bytes[2] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224;
}

/** 16 bytes of an address `isIP` has already accepted as IPv6. */
function ipv6Bytes(address: string): Uint8Array {
  const bytes = new Uint8Array(16);
  let text = address.split('%')[0] ?? '';
  const tail: number[] = [];
  const dotted = text.lastIndexOf(':');
  if (text.includes('.')) {
    for (const part of text.slice(dotted + 1).split('.')) tail.push(Number(part));
    text = `${text.slice(0, dotted + 1)}0:0`;
  }
  const [head = '', rest] = text.split('::');
  const toGroups = (s: string) => (s ? s.split(':').map((g) => Number.parseInt(g, 16)) : []);
  const front = toGroups(head);
  const back = rest === undefined ? [] : toGroups(rest);
  const groups = [...front, ...new Array(8 - front.length - back.length).fill(0), ...back];
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  if (tail.length === 4) bytes.set(tail, 12);
  return bytes;
}

const startsWithBytes = (bytes: Uint8Array, prefix: number[]) =>
  prefix.every((b, i) => bytes[i] === b);

/**
 * Classified on the 16 bytes, never on the text (SC-1284). WHATWG URL writes
 * `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`, and a textual unwrap that only
 * recognised the dotted form judged every mapped address public. Any prefix
 * that carries an IPv4 address inside it is classified AS that IPv4 address,
 * because that is where a kernel or a NAT64 gateway will actually send it.
 */
function isPrivateOrReservedIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  const zeros = (n: number) => bytes.subarray(0, n).every((b) => b === 0);
  // ::ffff:0:0/96 mapped, and ::/96 compatible (which covers :: and ::1).
  if (zeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateOrReservedIpv4(bytes.subarray(12));
  }
  if (zeros(12)) return isPrivateOrReservedIpv4(bytes.subarray(12));
  // ::ffff:0:0:0/96, SIIT's IPv4-translated form.
  if (zeros(8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) {
    return isPrivateOrReservedIpv4(bytes.subarray(12));
  }
  // 64:ff9b::/96 well-known NAT64; 64:ff9b:1::/48 local-use NAT64 is never public.
  if (startsWithBytes(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) {
    return isPrivateOrReservedIpv4(bytes.subarray(12));
  }
  if (startsWithBytes(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return true;
  // 2002::/16 6to4 carries its IPv4 in bytes 2-5.
  if (startsWithBytes(bytes, [0x20, 0x02])) return isPrivateOrReservedIpv4(bytes.subarray(2, 6));
  // 2001::/32 Teredo hides an obfuscated IPv4 relay path; 2001:db8::/32 is documentation.
  if (startsWithBytes(bytes, [0x20, 0x01, 0x00, 0x00])) return true;
  if (startsWithBytes(bytes, [0x20, 0x01, 0x0d, 0xb8])) return true;
  // 100::/64 discard.
  if (startsWithBytes(bytes, [0x01, 0x00, 0, 0, 0, 0, 0, 0])) return true;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local (Fly 6PN)
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  return first === 0xff; // multicast
}

/**
 * True when the IP belongs to a range that must never be reachable from a
 * user-supplied URL. Anything that is not an IP at all is refused too.
 */
function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateOrReservedIpv4(address.split('.').map(Number));
  if (family === 6) return isPrivateOrReservedIpv6(address);
  return true;
}

/** Every address a hostname resolves to. Injectable so a rebinding resolver is testable. */
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const resolveAll: Resolver = (hostname) => lookup(hostname, { all: true });

/**
 * Exported so a second fetcher reuses THIS guard rather than growing its own
 * (SC-208). A private-address check that exists twice is one that will be
 * right in one place and stale in the other, and the second copy is always the
 * one nobody reviews.
 *
 * Returns the address that was judged, and a caller must CONNECT to that one
 * (SC-1284): resolving the name a second time lets a rebinding resolver answer
 * public here and loopback to `fetch`. `followRedirectsSafely` does this.
 */
export async function assertHostIsPublic(
  hostname: string,
  resolve: Resolver = resolveAll
): Promise<string> {
  const lowered = hostname.toLowerCase();
  if (lowered === 'localhost') {
    throw new BoundedFetchError('Blocked host (localhost)', 'blocked-host');
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      throw new BoundedFetchError(`Blocked host suffix (${suffix})`, 'blocked-host');
    }
  }

  // `URL.hostname` for `http://[::1]/` returns `[::1]` (brackets kept).
  // Strip them before the IP-literal check.
  const hostForIpCheck =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  // Literal IP in the URL — validate directly without DNS.
  if (isIP(hostForIpCheck)) {
    if (isPrivateOrReservedAddress(hostForIpCheck)) {
      throw new BoundedFetchError('Blocked private IP', 'blocked-host');
    }
    return hostForIpCheck;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new BoundedFetchError(`DNS lookup failed for ${hostname}`, 'network');
  }
  const [first] = addresses;
  if (!first) {
    throw new BoundedFetchError(`No addresses for ${hostname}`, 'network');
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      throw new BoundedFetchError('Host resolves to a private address', 'blocked-host');
    }
  }
  return first.address;
}

export interface FetchHtmlBoundedResult {
  html: string;
  truncated: boolean;
  finalUrl: string;
}

/**
 * Fetch a URL and return at most `MAX_BYTES` of its body as UTF-8 HTML.
 * Throws `BoundedFetchError` for any refusal (blocked host, non-HTML,
 * bad status, timeout). The caller should treat any throw as "no OG
 * data available" and surface an empty result to the client.
 */
/** Redirect hops we are willing to walk. Three is generous for a real site. */
const MAX_REDIRECTS = 3;

/** The fetch this module uses. Injectable so the hop walk is testable without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Follow redirects ONE HOP AT A TIME, re-validating the host each time (SC-208).
 *
 * This used to be `redirect: 'follow'`, with `assertHostIsPublic` called once
 * on the URL the caller supplied. That guard is worth nothing against a
 * redirect: a public host answers 302 to `http://169.254.169.254/` or a
 * `.internal` name and `fetch` walks there on our behalf, from inside the Fly
 * network. `response.url` — the address we actually ended up at — was returned
 * to the caller and never checked.
 *
 * It matters more than the SC-208 ticket assumed. That ticket reasons the risk
 * is low because `institutions.website` is data we seed; but
 * `InstitutionService.create` lets a USER create an institution with any
 * `website` they like, so the URL is attacker-influenced and always was.
 */
export async function followRedirectsSafely(
  start: URL,
  init: RequestInit,
  fetchImpl: FetchLike = fetch,
  resolve: Resolver = resolveAll
): Promise<{ response: Response; url: URL }> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // The whole point: every hop is validated, not just the first — and the
    // request goes to the address that was validated, not to a second lookup.
    const address = await assertHostIsPublic(current.hostname, resolve);
    const response = await fetchImpl(...pinnedRequest(current, address, init));
    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) return { response, url: current };

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new BoundedFetchError('Invalid redirect target', 'invalid-url');
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new BoundedFetchError(`Unsupported redirect protocol ${next.protocol}`, 'invalid-url');
    }
    current = next;
  }
  throw new BoundedFetchError(`More than ${MAX_REDIRECTS} redirects`, 'network');
}

/**
 * The request for `url`, sent to `address` (SC-1284).
 *
 * Bun's fetch has no `lookup` hook, so the pin is done in the URL: the host is
 * replaced by the validated IP, `Host` carries the original host, and on https
 * `tls.serverName` carries the original name. Bun sends that as SNI and — this
 * is the load-bearing half — verifies the certificate against it. Without
 * `serverName`, Bun 1.3.14 does not check the certificate's name at all when
 * the URL host is an IP; `dns-rebinding-pin.test.ts` asserts both.
 */
function pinnedRequest(url: URL, address: string, init: RequestInit): [string, RequestInit] {
  const target = new URL(url);
  target.hostname = isIP(address) === 6 ? `[${address}]` : address;
  const headers = new Headers(init.headers);
  headers.set('Host', url.host);
  const pinned: RequestInit & { tls?: { serverName: string } } = {
    ...init,
    headers,
    redirect: 'manual',
  };
  const literal = url.hostname.startsWith('[') || isIP(url.hostname) !== 0;
  if (url.protocol === 'https:' && !literal) pinned.tls = { serverName: url.hostname };
  return [target.toString(), pinned];
}

export async function fetchHtmlBounded(
  rawUrl: string,
  opts: { budgetMs?: number } = {}
): Promise<FetchHtmlBoundedResult> {
  return withBudget(runFetchHtmlBounded(rawUrl), opts.budgetMs ?? TOTAL_BUDGET_MS, 'html fetch');
}

async function runFetchHtmlBounded(rawUrl: string): Promise<FetchHtmlBoundedResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BoundedFetchError('Invalid URL', 'invalid-url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BoundedFetchError(`Unsupported protocol ${parsed.protocol}`, 'invalid-url');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  let finalUrl: string;
  try {
    const walked = await followRedirectsSafely(parsed, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html, application/xhtml+xml',
        'User-Agent': 'ScaniBot/1.0 (+https://scani.xyz)',
      },
    });
    response = walked.response;
    finalUrl = walked.url.toString();
  } catch (err) {
    if (err instanceof BoundedFetchError) {
      clearTimeout(timeoutId);
      throw err;
    }
    clearTimeout(timeoutId);
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new BoundedFetchError('Fetch timed out', 'timeout');
    }
    throw new BoundedFetchError(
      err instanceof Error ? `Network error: ${err.message}` : 'Network error',
      'network'
    );
  }

  try {
    if (!response.ok) {
      throw new BoundedFetchError(`HTTP ${response.status}`, 'bad-status');
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('text/') && !contentType.includes('xhtml')) {
      throw new BoundedFetchError(
        `Non-HTML content-type: ${contentType || '<missing>'}`,
        'bad-content-type'
      );
    }
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_BYTES * 4) {
        // The Content-Length is advisory; we'll still truncate mid-stream,
        // but if the peer declares a body that's many times our cap there's
        // no point starting the read at all.
        throw new BoundedFetchError(`Content-Length ${contentLength} exceeds cap`, 'too-large');
      }
    }

    const body = response.body;
    if (!body) {
      return { html: '', truncated: false, finalUrl };
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const remaining = MAX_BYTES - received;
        if (value.byteLength <= remaining) {
          chunks.push(value);
          received += value.byteLength;
        } else {
          if (remaining > 0) {
            chunks.push(value.subarray(0, remaining));
            received += remaining;
          }
          truncated = true;
          break;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // reader may already be closed; ignore.
      }
    }

    // Decode as UTF-8. We intentionally skip iconv-lite charset detection
    // here — OG tag extraction is resilient to mojibake in body text, and
    // the tag names / attribute values themselves are always ASCII.
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let html = '';
    for (const chunk of chunks) html += decoder.decode(chunk, { stream: true });
    html += decoder.decode();

    return { html, truncated, finalUrl };
  } finally {
    clearTimeout(timeoutId);
    if (!controller.signal.aborted) controller.abort();
  }
}
