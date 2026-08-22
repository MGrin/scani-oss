/**
 * A site's icon, fetched under the same guards as its HTML (SC-208).
 *
 * This is the server half of "stop asking google.com for every institution
 * mark". It lives beside `fetchHtmlBounded` rather than in the app that calls
 * it because that is the rule `no-second-fetcher.test.ts` enforces: the SSRF
 * guard exists once, and every fetch of an attacker-influenceable URL goes
 * through it. `institutions.website` is attacker-influenceable —
 * `InstitutionService.create` lets a user set it to anything.
 *
 * ## The content type is derived from the BYTES, never from the header
 *
 * We re-serve these bytes from our own origin, so echoing an upstream
 * `Content-Type` would let a third-party site choose a content type on
 * `api.scani.xyz`. `sniffImageType` reads the magic bytes instead and returns
 * one of six inert raster formats; anything it cannot identify is refused.
 *
 * That also fixes a real coverage problem in the other direction: plenty of
 * hosts serve a perfectly good `/favicon.ico` as `application/octet-stream` or
 * `text/plain`, which a header-only check would throw away.
 *
 * **SVG is refused on purpose.** It is the one image format that can carry
 * script, and while an `<img src>` will not execute it, a direct navigation to
 * our own URL would. A site that only declares an SVG icon gets the letter
 * tile — which is the documented fallback, not a degradation we invented.
 */

import {
  assertHostIsPublic,
  BoundedFetchError,
  type FetchLike,
  fetchHtmlBounded,
  followRedirectsSafely,
  withBudget,
} from './fetch-html-bounded';

/**
 * Icons are small. 128KB is generous for a 180x180 apple-touch-icon and still
 * far below anything that could pressure a 512MB machine.
 */
const MAX_ICON_BYTES = 128 * 1024;

/**
 * The budget for the image phase, shared across every candidate.
 */
const ICON_PHASE_TIMEOUT_MS = 3_000;

/**
 * How many declared icons we are willing to try before falling back. Two plus
 * `/favicon.ico` covers every real site and keeps the worst case bounded.
 */
const MAX_CANDIDATES = 2;

/**
 * The bound on the WHOLE resolve, and it is not redundant with the two above.
 *
 * Measured against 20 real seeded institutions on 2026-08-22: 16 resolved, and
 * two of the four misses took **60 seconds each** — `www.robinhood.com` and
 * `www.bitstamp.net`, both on `DNS lookup failed`. Neither timeout above can
 * cap that. `assertHostIsPublic` calls `dns.lookup` with no deadline of its
 * own, `fetchHtmlBounded` arms its 4s `AbortController` *after* that call
 * returns, and an `AbortSignal` only reaches a fetch that has started. So the
 * one step that runs before every budget is the one step nothing bounds.
 *
 * It matters more than a slow icon: the api holds at most three of these at a
 * time, so three hung lookups stop every institution mark in the product, and
 * a browser sits on an open connection for a minute waiting on an `<img>`.
 *
 * 8s is above the slowest success observed (3.2s) with headroom, and far below
 * the 60s a stuck resolver costs.
 *
 * The inner budgets can sum HIGHER than this (6s of HTML plus 3s of images) and
 * that is deliberate: those are per-step allowances, this is the ceiling. A
 * site that spends its whole HTML budget gets whatever is left; one that would
 * spend more than all of it gets a letter tile, which is the right answer for
 * something that slow.
 */
const TOTAL_BUDGET_MS = 8_000;

export interface SiteIcon {
  bytes: Uint8Array;
  /** Derived from the bytes by `sniffImageType`, never from a response header. */
  contentType: string;
  /** The host that actually answered, after redirects. Logged by the caller, never served. */
  sourceUrl: string;
}

export interface FetchSiteIconDeps {
  /** Injectable so the whole resolve is testable without a network. */
  fetchImpl?: FetchLike;
  /** Injectable so candidate selection can be tested without an HTML server. */
  fetchHtml?: (url: string) => Promise<{ html: string; finalUrl: string }>;
  /** Injectable so the budget can be asserted in milliseconds rather than seconds. */
  budgetMs?: number;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF = [0x47, 0x49, 0x46, 0x38];
const ICO = [0x00, 0x00, 0x01, 0x00];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const FTYP = [0x66, 0x74, 0x79, 0x70];
const AVIF = [0x61, 0x76, 0x69, 0x66];

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/**
 * The served content type, read off the first bytes. `null` means "not one of
 * the six formats we are willing to re-serve", and the caller refuses.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, GIF)) return 'image/gif';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  if (startsWith(bytes, FTYP, 4) && startsWith(bytes, AVIF, 8)) return 'image/avif';
  // Last, because it is the weakest signature: four bytes, two of them zero.
  // A file that also matched one of the above is that thing, not an icon.
  if (startsWith(bytes, ICO)) return 'image/x-icon';
  return null;
}

/**
 * Fetch one URL and return it only if the bytes are an image we will re-serve.
 *
 * Same three guards as `fetchHtmlBounded` — protocol, `assertHostIsPublic`,
 * per-hop redirect revalidation — plus a hard byte cap enforced while reading
 * rather than from `Content-Length`, which the peer chooses.
 */
export async function fetchImageBounded(
  rawUrl: string,
  init: { signal?: AbortSignal } = {},
  fetchImpl: FetchLike = fetch
): Promise<SiteIcon> {
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

  let response: Response;
  try {
    response = await followRedirectsSafely(
      parsed,
      {
        signal: init.signal,
        headers: {
          Accept: 'image/png,image/webp,image/*;q=0.8,*/*;q=0.5',
          'User-Agent': 'ScaniBot/1.0 (+https://scani.xyz)',
        },
      },
      fetchImpl
    );
  } catch (err) {
    if (err instanceof BoundedFetchError) throw err;
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new BoundedFetchError('Icon fetch timed out', 'timeout');
    }
    throw new BoundedFetchError(
      err instanceof Error ? `Network error: ${err.message}` : 'Network error',
      'network'
    );
  }

  if (!response.ok) {
    throw new BoundedFetchError(`HTTP ${response.status}`, 'bad-status');
  }

  const declared = response.headers.get('content-length');
  if (declared) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > MAX_ICON_BYTES) {
      throw new BoundedFetchError(`Content-Length ${length} exceeds icon cap`, 'too-large');
    }
  }

  const bytes = await readCapped(response, MAX_ICON_BYTES);
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new BoundedFetchError(
      `Not a re-servable image (${bytes.length} bytes, header said ` +
        `${response.headers.get('content-type') ?? '<missing>'})`,
      'bad-content-type'
    );
  }
  return { bytes, contentType, sourceUrl: response.url || parsed.toString() };
}

/**
 * Read at most `cap` bytes, then stop. A body that runs past the cap is an
 * error rather than a truncation: half an image is not an image, and silently
 * storing one would put a broken icon in R2 for good.
 */
async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) throw new BoundedFetchError('Empty icon body', 'bad-content-type');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > cap) {
        throw new BoundedFetchError(`Icon body exceeds ${cap} bytes`, 'too-large');
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed; nothing to do.
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface Candidate {
  href: string;
  /** Largest dimension the tag declares, or 0 when it declares none. */
  size: number;
  /** Ordering tiebreak: an apple-touch-icon is a known-good square. */
  apple: boolean;
}

const LINK_TAG = /<link\b[^>]*>/gi;
const ATTR = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');

function attr(tag: string, name: string): string | null {
  const m = ATTR(name).exec(tag);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

/**
 * The icon hrefs a page declares, best first.
 *
 * Pure and exported so the ranking is testable without a network. Only `<head>`
 * is scanned: a `<link rel=icon>` in the body is not a thing, and reading the
 * whole document invites matches inside inlined markup.
 *
 * `mask-icon` is skipped deliberately. It is a monochrome Safari template that
 * renders as a solid black silhouette, so picking it produces an icon that
 * looks broken rather than absent — the worse of the two failures.
 */
export function extractIconHrefs(html: string): string[] {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const found: Candidate[] = [];

  for (const match of head.matchAll(LINK_TAG)) {
    const tag = match[0];
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    if (!rel.split(/\s+/).some((token) => token === 'icon' || token === 'apple-touch-icon')) {
      // `shortcut icon` splits into two tokens, one of which is `icon`, so the
      // legacy spelling is covered without naming it. `apple-touch-icon-
      // precomposed` is deliberately not: it is the pre-iOS7 variant and any
      // site that has it also has the plain one.
      continue;
    }
    const href = attr(tag, 'href');
    if (!href) continue;
    const sizes = (attr(tag, 'sizes') ?? '').toLowerCase();
    const dims = [...sizes.matchAll(/(\d+)\s*x\s*(\d+)/g)].map((m) => Number(m[1]));
    found.push({
      // `split`/`join` rather than `replaceAll`: this package is type-checked
      // as part of the frontend workspaces too, and their lib target predates
      // it.
      href: href.split('&amp;').join('&'),
      size: dims.length > 0 ? Math.max(...dims) : 0,
      apple: rel.includes('apple-touch-icon'),
    });
  }

  found.sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    if (a.apple !== b.apple) return a.apple ? -1 : 1;
    return 0;
  });
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of found) {
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    ordered.push(candidate.href);
  }
  return ordered;
}

/**
 * Resolve and fetch the icon for a site, or throw `BoundedFetchError`.
 *
 * Declared icons first, `/favicon.ico` last. The HTML step is best-effort: a
 * site that refuses us its HTML (403 to a bot user-agent is common) very often
 * still serves `/favicon.ico`, so a failure there narrows the candidate list
 * rather than ending the resolve.
 */
export async function fetchSiteIcon(
  websiteUrl: string,
  deps: FetchSiteIconDeps = {}
): Promise<SiteIcon> {
  return withBudget(
    resolveSiteIcon(websiteUrl, deps),
    deps.budgetMs ?? TOTAL_BUDGET_MS,
    'icon resolve'
  );
}

async function resolveSiteIcon(websiteUrl: string, deps: FetchSiteIconDeps): Promise<SiteIcon> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fetchHtml = deps.fetchHtml ?? (async (url: string) => fetchHtmlBounded(url));

  let base: URL;
  try {
    base = new URL(websiteUrl);
  } catch {
    throw new BoundedFetchError('Invalid website URL', 'invalid-url');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new BoundedFetchError(`Unsupported protocol ${base.protocol}`, 'invalid-url');
  }

  let declared: string[] = [];
  let origin = base;
  try {
    const { html, finalUrl } = await fetchHtml(base.toString());
    try {
      origin = new URL(finalUrl || base.toString());
    } catch {
      origin = base;
    }
    declared = extractIconHrefs(html);
  } catch {
    // Best-effort: fall through to `/favicon.ico` on the original origin.
  }

  const urls: string[] = [];
  for (const href of declared.slice(0, MAX_CANDIDATES)) {
    try {
      urls.push(new URL(href, origin).toString());
    } catch {
      // A malformed href in someone else's markup is not our problem.
    }
  }
  const fallback = new URL('/favicon.ico', origin).toString();
  if (!urls.includes(fallback)) urls.push(fallback);

  const signal = AbortSignal.timeout(ICON_PHASE_TIMEOUT_MS);
  let last: unknown;
  for (const url of urls) {
    try {
      return await fetchImageBounded(url, { signal }, fetchImpl);
    } catch (err) {
      last = err;
      if (signal.aborted) break;
    }
  }
  if (last instanceof BoundedFetchError) throw last;
  throw new BoundedFetchError(
    `No usable icon for ${base.hostname}${last instanceof Error ? `: ${last.message}` : ''}`,
    'bad-status'
  );
}
