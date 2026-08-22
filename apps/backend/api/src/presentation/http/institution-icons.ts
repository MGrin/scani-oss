import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { InstitutionRepository } from '@scani/domain/repositories';
import { BoundedFetchError, fetchSiteIcon } from '@scani/http-fetch';
import { createComponentLogger } from '@scani/logging';
import { Container } from 'typedi';

const log = createComponentLogger('http:institution-icons');

/**
 * Institution marks, served from our own origin instead of Google's (SC-208).
 *
 * `getFaviconUrl` used to build `www.google.com/s2/favicons?domain=<host>`, so
 * every row of a holdings table was a third-party request to google.com from a
 * finance app. Three reasons that had to stop, and only the third is cosmetic:
 * content blockers target exactly that shape and we have no way to know how
 * many users already saw letter tiles; it is unreachable from China, which
 * SC-201 intends to ship a translation for; and the endpoint is undocumented
 * and has already changed under us once — the 301 that broke SC-203.
 *
 * ## The URL is keyed on the institution id, and that is the security design
 *
 * The obvious shape — `/icon?url=<website>` — is an open proxy: anyone could
 * make this machine fetch any public address and park the bytes in our bucket.
 * Keying on a primary key means the only URLs reachable through here are the
 * ones already in `institutions.website`, and the allowlist needs no
 * maintenance because it *is* the table.
 *
 * It does not make the URL trustworthy — `InstitutionService.create` lets a
 * user set `website` to anything — which is why the fetch still goes through
 * `@scani/http-fetch`'s per-hop SSRF guard.
 *
 * ## Three layers, and only the last one leaves the machine
 *
 * 1. An in-process byte cache. This api runs two Fly machines and reaches R2
 *    through the data-provider (base64 over tRPC, in cloud mode), so a cache
 *    hit here is worth a cross-service round trip, not just a disk read.
 * 2. R2, shared by both machines and surviving deploys. This is where an icon
 *    lives once anyone has looked at it.
 * 3. The institution's own website. Bounded, guarded, and paid at most once
 *    per institution per bucket.
 *
 * ## A miss is a 404, and the letter tile is the fallback
 *
 * `FaviconImg` already draws a first-letter tile on `onerror`, and SC-208 says
 * explicitly not to invent a placeholder image. So every refusal — no website,
 * no resolvable icon, a site that answers its favicon path with an HTML error
 * page — is an empty 404 and the row keeps its mark-sized letter tile.
 */

/** Where an institution's icon lives. No extension: `readObject` carries the type. */
function iconKey(institutionId: string): string {
  return `institution-icons/${institutionId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A day in the browser's cache, a week of serving the stale copy while a new
 * one is fetched. Not `immutable`: a bank does redesign its logo, and the only
 * cost of being wrong for a day is a slightly old mark.
 */
const HIT_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

/**
 * An hour on a miss. Long enough that a catalog entry with no icon is not
 * re-asked on every render; short enough that adding one shows up the same
 * afternoon.
 */
const MISS_CACHE_CONTROL = 'public, max-age=3600';

/**
 * How long this process refuses to re-attempt a resolve that failed.
 *
 * Load-bearing rather than an optimisation. Without it, an institution whose
 * site is slow or blocks bots costs a 7-second outbound attempt on every
 * single render of every row that names it.
 */
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

/** Bounds on the in-process positive cache. 128 icons at 128KB is 16MB worst case. */
const CACHE_MAX_ENTRIES = 128;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Concurrent outbound resolves. Same cap and the same reason as the OG path in
 * `routers/institutions.ts`: a handful of slow third-party sites must not be
 * able to stack unbounded work on a 1GB machine.
 */
const MAX_CONCURRENT_RESOLVES = 3;

interface CachedIcon {
  bytes: Uint8Array;
  contentType: string;
}

const iconCache = new Map<string, CachedIcon>();
let cachedBytes = 0;
const negativeCache = new Map<string, number>();
let inFlight = 0;

/** Test seam: drop every in-process layer so a case starts from a known state. */
export function resetInstitutionIconCaches(): void {
  iconCache.clear();
  negativeCache.clear();
  cachedBytes = 0;
  inFlight = 0;
}

function cacheGet(id: string): CachedIcon | null {
  const entry = iconCache.get(id);
  if (!entry) return null;
  // Map iterates in insertion order, so re-inserting on a hit gives LRU
  // eviction for free — the same trick `routers/institutions.ts` uses.
  iconCache.delete(id);
  iconCache.set(id, entry);
  return entry;
}

function cachePut(id: string, icon: CachedIcon): void {
  if (iconCache.has(id)) {
    cachedBytes -= iconCache.get(id)?.bytes.byteLength ?? 0;
    iconCache.delete(id);
  }
  iconCache.set(id, icon);
  cachedBytes += icon.bytes.byteLength;
  while (iconCache.size > CACHE_MAX_ENTRIES || cachedBytes > CACHE_MAX_BYTES) {
    const oldest = iconCache.keys().next();
    if (oldest.done) break;
    cachedBytes -= iconCache.get(oldest.value)?.bytes.byteLength ?? 0;
    iconCache.delete(oldest.value);
  }
}

function isNegative(id: string): boolean {
  const until = negativeCache.get(id);
  if (until === undefined) return false;
  if (Date.now() > until) {
    negativeCache.delete(id);
    return false;
  }
  return true;
}

function markNegative(id: string): void {
  negativeCache.set(id, Date.now() + NEGATIVE_TTL_MS);
  // Bounded the crude way: the catalog is a few hundred rows, so this only
  // ever trims if something is generating ids that are not in it.
  if (negativeCache.size > 2_000) {
    const now = Date.now();
    for (const [key, until] of negativeCache) if (now > until) negativeCache.delete(key);
  }
}

const miss = (): Response =>
  new Response(null, { status: 404, headers: { 'Cache-Control': MISS_CACHE_CONTROL } });

const hit = (icon: CachedIcon): Response =>
  new Response(icon.bytes, {
    status: 200,
    headers: {
      'Content-Type': icon.contentType,
      'Content-Length': String(icon.bytes.byteLength),
      'Cache-Control': HIT_CACHE_CONTROL,
    },
  });

/**
 * Resolve, store and return an institution's icon, or `null`.
 *
 * Everything it can throw is caught here: a caller that gets `null` renders a
 * letter tile, and there is no failure mode worth distinguishing at the HTTP
 * layer.
 */
async function resolveAndStoreIcon(
  institutionId: string,
  website: string
): Promise<CachedIcon | null> {
  if (inFlight >= MAX_CONCURRENT_RESOLVES) {
    // Deliberately not queued. A queued request holds a connection open
    // waiting on a third party; a refused one draws a letter tile now and
    // resolves on a later render, and the icon is the same either way.
    log.debug({ institutionId, inFlight }, 'icon resolve refused — concurrency cap');
    return null;
  }
  inFlight += 1;
  try {
    const icon = await fetchSiteIcon(website);
    const stored: CachedIcon = { bytes: icon.bytes, contentType: icon.contentType };
    try {
      await Container.get(StorageFacade).write(
        iconKey(institutionId),
        icon.bytes,
        icon.contentType
      );
    } catch (err) {
      // A bucket that will not take the write still leaves us holding a good
      // icon for this request and this process. Serving it is strictly better
      // than a letter tile, and the next process will try the write again.
      log.warn(
        { institutionId, error: err instanceof Error ? err.message : String(err) },
        'icon resolved but could not be stored'
      );
    }
    return stored;
  } catch (err) {
    if (err instanceof BoundedFetchError) {
      log.debug(
        { institutionId, website, reason: err.reason, message: err.message },
        'icon resolve refused'
      );
    } else {
      log.warn(
        { institutionId, error: err instanceof Error ? err.message : String(err) },
        'icon resolve failed'
      );
    }
    return null;
  } finally {
    inFlight -= 1;
  }
}

export async function handleInstitutionIcon(institutionId: string): Promise<Response> {
  // A malformed id never reaches the database: `institutions.id` is a uuid
  // column and Postgres raises on a bad comparison rather than returning no
  // rows, which would turn a junk URL into a 500.
  if (!UUID.test(institutionId)) return miss();

  const cached = cacheGet(institutionId);
  if (cached) return hit(cached);
  if (isNegative(institutionId)) return miss();

  try {
    const stored = await Container.get(StorageFacade).readObject(iconKey(institutionId));
    if (stored) {
      const icon = { bytes: stored.bytes, contentType: stored.contentType };
      cachePut(institutionId, icon);
      return hit(icon);
    }
  } catch (err) {
    // Not fatal and not cached as a miss: the bucket being unreachable says
    // nothing about whether this institution has an icon. Fall through to the
    // resolve, which is what a cold bucket would have done anyway.
    log.warn(
      { institutionId, error: err instanceof Error ? err.message : String(err) },
      'icon store read failed'
    );
  }

  const institution = await Container.get(InstitutionRepository).findById(institutionId);
  const website = institution?.website;
  if (!website) {
    markNegative(institutionId);
    return miss();
  }

  const resolved = await resolveAndStoreIcon(institutionId, website);
  if (!resolved) {
    markNegative(institutionId);
    return miss();
  }
  cachePut(institutionId, resolved);
  return hit(resolved);
}

/**
 * Unauthenticated on purpose. `institutions` is the public catalog — the same
 * names and websites the marketing site lists — and a session cookie on an
 * `<img>` buys nothing: the id has to be known already, and what comes back is
 * a bank's own public brand mark.
 */
// biome-ignore lint/suspicious/noExplicitAny: Elysia's app type is dynamic here, as in the sibling registrars.
export function registerInstitutionIconRoutes(app: any): void {
  app.get(
    '/institution-icons/:institutionId',
    ({ params }: { params: { institutionId: string } }) =>
      handleInstitutionIcon(params.institutionId)
  );
}
