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
 *     unique-local / fly-internal addresses).
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

// Host suffixes we never want to hit from the backend — either our own
// internal Fly service names (SSRF self-recursion) or well-known cloud
// metadata endpoints reached by hostname.
const BLOCKED_HOST_SUFFIXES = ['.internal', '.flycast', '.fly.dev'];

/**
 * True when the IP belongs to a range that must never be reachable from
 * a user-supplied URL. Covers IPv4 (RFC1918, loopback, link-local, CGNAT,
 * 0.0.0.0/8) and IPv6 (loopback, link-local, unique-local, IPv4-mapped).
 */
function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length);
      if (isIP(mapped) === 4) return isPrivateOrReservedAddress(mapped);
    }
    return false;
  }
  return true;
}

async function assertHostIsPublic(hostname: string): Promise<void> {
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
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new BoundedFetchError(`DNS lookup failed for ${hostname}`, 'network');
  }
  if (addresses.length === 0) {
    throw new BoundedFetchError(`No addresses for ${hostname}`, 'network');
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      throw new BoundedFetchError('Host resolves to a private address', 'blocked-host');
    }
  }
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
export async function fetchHtmlBounded(rawUrl: string): Promise<FetchHtmlBoundedResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BoundedFetchError('Invalid URL', 'invalid-url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BoundedFetchError(`Unsupported protocol ${parsed.protocol}`, 'invalid-url');
  }

  await assertHostIsPublic(parsed.hostname);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html, application/xhtml+xml',
        'User-Agent': 'ScaniBot/1.0 (+https://example.com)',
      },
    });
  } catch (err) {
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
      return { html: '', truncated: false, finalUrl: response.url };
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

    return { html, truncated, finalUrl: response.url };
  } finally {
    clearTimeout(timeoutId);
    if (!controller.signal.aborted) controller.abort();
  }
}
