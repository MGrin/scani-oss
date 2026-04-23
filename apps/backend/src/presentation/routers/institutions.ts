import { createCloudOGClient } from '@scani/cloud-client/adapters/og';
import { getCloudClient } from '@scani/cloud-client/runtime';
import { InstitutionImplementations } from '@scani/domain/features';
import { createComponentLogger } from '@scani/logging';
import ogs from 'open-graph-scraper';
import { z } from 'zod';
import { BoundedFetchError, fetchHtmlBounded } from '../../lib/fetch-html-bounded';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const institutionsLogger = createComponentLogger('router:institutions');

interface OGData {
  title: string;
  description: string;
  siteName: string;
  image: string;
  type: string;
}

const EMPTY_OG: OGData = { title: '', description: '', siteName: '', image: '', type: '' };

// In-memory LRU-ish cache for OpenGraph metadata. Successful results are
// cached for an hour (OG data rarely changes); failures / empty results
// only for 5 minutes so we don't hide transient network or upstream
// issues for too long. Cache is process-local — fine for our
// single-machine backend (fly.toml: max_machines_running = 1).
interface OGCacheEntry {
  data: OGData;
  expiresAt: number;
}

const OG_CACHE_TTL_MS = 60 * 60 * 1000;
const OG_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const OG_CACHE_MAX_ENTRIES = 500;
const OG_CACHE_EVICT_BATCH = 50;

const ogCache = new Map<string, OGCacheEntry>();

function getOGFromCache(url: string): OGData | null {
  const entry = ogCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    ogCache.delete(url);
    return null;
  }
  return entry.data;
}

function setOGInCache(url: string, data: OGData, ttlMs: number): void {
  if (ogCache.size >= OG_CACHE_MAX_ENTRIES) {
    const keys = Array.from(ogCache.keys()).slice(0, OG_CACHE_EVICT_BATCH);
    for (const key of keys) ogCache.delete(key);
  }
  ogCache.set(url, { data, expiresAt: Date.now() + ttlMs });
}

// Process-wide concurrency gate for external fetches. OG scraping
// buffers bytes + builds a cheerio DOM; stacking many of these on a
// 512MB Fly machine was what caused the OOM (see BoundedFetchError
// docstring). A hard cap of 3 concurrent fetches keeps the OG code
// path to tens of MB rather than hundreds under load.
const MAX_CONCURRENT_OG_FETCHES = 3;
const CONCURRENCY_WAIT_MS = 250;

let inFlightFetches = 0;
const concurrencyWaiters: Array<() => void> = [];

function tryAcquireFetchSlot(): Promise<boolean> {
  if (inFlightFetches < MAX_CONCURRENT_OG_FETCHES) {
    inFlightFetches += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const waiter = () => {
      if (settled) return;
      settled = true;
      inFlightFetches += 1;
      resolve(true);
    };
    concurrencyWaiters.push(waiter);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = concurrencyWaiters.indexOf(waiter);
      if (idx !== -1) concurrencyWaiters.splice(idx, 1);
      resolve(false);
    }, CONCURRENCY_WAIT_MS);
  });
}

function releaseFetchSlot(): void {
  inFlightFetches -= 1;
  const next = concurrencyWaiters.shift();
  if (next) next();
}

// Per-user sliding-window rate limit. Kept in-memory because the backend
// runs on a single Fly machine and this limiter is purely hygiene —
// preventing a single logged-in client from bypassing the URL cache by
// spamming distinct URLs. Horizontal scaling would need to move this
// to Redis, but right now that's unnecessary coupling.
const OG_USER_WINDOW_MS = 60_000;
const OG_USER_MAX = 20;

const userRequestTimes = new Map<string, number[]>();

function checkUserRateLimit(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - OG_USER_WINDOW_MS;
  const times = (userRequestTimes.get(userId) ?? []).filter((t) => t > cutoff);
  if (times.length >= OG_USER_MAX) {
    userRequestTimes.set(userId, times);
    return false;
  }
  times.push(now);
  userRequestTimes.set(userId, times);
  // Opportunistic cleanup so this map doesn't grow unbounded for
  // long-lived processes with many unique users.
  if (userRequestTimes.size > 10_000) {
    for (const [uid, ts] of userRequestTimes) {
      const pruned = ts.filter((t) => t > cutoff);
      if (pruned.length === 0) userRequestTimes.delete(uid);
      else userRequestTimes.set(uid, pruned);
    }
  }
  return true;
}

// When the cloud client is configured, delegate the actual HTTP fetch
// (and `open-graph-scraper` parse) to the data-provider so the SSRF
// guard + OOM cap live next to every other outbound call. The backend
// keeps its per-user rate gate and in-process cache — those need
// authenticated context the data-provider doesn't have. Resolved
// lazily so tests can swap the client via @scani/cloud-client/runtime.
let cloudOG: ReturnType<typeof createCloudOGClient> | null | undefined;
function resolveCloudOG(): ReturnType<typeof createCloudOGClient> | null {
  if (cloudOG !== undefined) return cloudOG;
  const client = getCloudClient();
  cloudOG = client ? createCloudOGClient(client) : null;
  return cloudOG;
}

async function extractOG(url: string): Promise<OGData> {
  const cloud = resolveCloudOG();
  if (cloud) {
    const m = await cloud.fetchMetadata(url);
    return {
      title: m.title,
      description: m.description,
      siteName: m.siteName,
      image: m.image,
      type: m.type,
    };
  }
  const { html } = await fetchHtmlBounded(url);
  if (!html) return EMPTY_OG;
  const { result } = await ogs({ html });
  return {
    title: result.ogTitle || result.twitterTitle || result.dcTitle || '',
    description: result.ogDescription || result.twitterDescription || result.dcDescription || '',
    siteName: result.ogSiteName || '',
    image: result.ogImage?.[0]?.url || result.twitterImage?.[0]?.url || '',
    type: result.ogType || '',
  };
}

export const institutionsRouter = router({
  // Get all institutions
  getAll: protectedProcedure.query(async ({ ctx }) => {
    return await InstitutionImplementations.getAll({ userId: ctx.userId }, {});
  }),

  getByUserId: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userId;
    return await InstitutionImplementations.getByUserId({ userId }, {});
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const userId = dbUser.id;
    return await InstitutionImplementations.getByUserIdWithSummary({ userId, dbUser }, {});
  }),

  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input, ctx }) => {
    return await InstitutionImplementations.getById({ userId: ctx.userId }, { id: input.id });
  }),

  // Fetch Open Graph metadata for a user-supplied website URL.
  //
  // This is the institution-creation autofill ("user pastes revolut.com,
  // we autofill name + icon"). The naive implementation OOM-killed the
  // backend because:
  //   1. `open-graph-scraper` buffers the entire response body in RAM.
  //   2. No concurrency cap — a handful of slow/geo-blocked URLs could
  //      stack hundreds of MB on a 512MB machine.
  //   3. No SSRF guard on user-supplied URLs.
  // Mitigations layered here:
  //   - `fetchHtmlBounded` caps response body at 512KB and blocks private
  //     hosts before the fetch ever starts.
  //   - `tryAcquireFetchSlot` caps concurrent external fetches at 3.
  //   - Per-user sliding-window limiter (20 / 60s) keeps any one client
  //     from being able to blow past the cache with unique URLs.
  //   - Positive results cached for 1h, empty/failed for 5 min.
  getOpenGraphMetadata: protectedProcedure
    .input(z.object({ url: z.string().url() }))
    .query(async ({ input, ctx }) => {
      const cached = getOGFromCache(input.url);
      if (cached) return cached;

      if (!checkUserRateLimit(ctx.userId)) {
        institutionsLogger.warn(
          { userId: ctx.userId, url: input.url },
          'OG metadata rate limit exceeded — returning empty metadata'
        );
        return EMPTY_OG;
      }

      const acquired = await tryAcquireFetchSlot();
      if (!acquired) {
        institutionsLogger.warn(
          { url: input.url, inFlight: inFlightFetches },
          'OG metadata concurrency cap hit — returning empty metadata'
        );
        return EMPTY_OG;
      }

      try {
        const data = await extractOG(input.url);
        setOGInCache(input.url, data, OG_CACHE_TTL_MS);
        return data;
      } catch (error) {
        if (error instanceof BoundedFetchError) {
          institutionsLogger.warn(
            { url: input.url, reason: error.reason, message: error.message },
            'OG metadata fetch refused'
          );
        } else {
          institutionsLogger.warn(
            { url: input.url, error: error instanceof Error ? error.message : String(error) },
            'OG metadata fetch failed'
          );
        }
        setOGInCache(input.url, EMPTY_OG, OG_NEGATIVE_CACHE_TTL_MS);
        return EMPTY_OG;
      } finally {
        releaseFetchSlot();
      }
    }),
});
