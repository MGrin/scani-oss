import { createCloudOGClient } from '@scani/cloud-client/cloud-services/cloud-og-client';
import { getCloudClient } from '@scani/cloud-client/runtime';
import { InstitutionRepository, InstitutionTypeRepository } from '@scani/domain/repositories';
import { InstitutionService, siteHost } from '@scani/domain/services';
import { BoundedFetchError, fetchHtmlBounded } from '@scani/http-fetch';
import { createComponentLogger } from '@scani/logging';
import { TRPCError } from '@trpc/server';
import ogs from 'open-graph-scraper';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
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

// Map iterates in insertion order, so we get LRU semantics for free
// by deleting + re-inserting on every read hit: hot entries drift to
// the end, cold entries stay at the front and are the first to be
// evicted when the cap is reached. Previously this was FIFO, which
// could evict a frequently-accessed URL while a never-touched URL
// stayed cached.
function getOGFromCache(url: string): OGData | null {
  const entry = ogCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    ogCache.delete(url);
    return null;
  }
  // Promote to most-recently-used.
  ogCache.delete(url);
  ogCache.set(url, entry);
  return entry.data;
}

function setOGInCache(url: string, data: OGData, ttlMs: number): void {
  // If the URL is already present, delete first so the new entry lands
  // at the end of the iteration order (otherwise Map.set on an
  // existing key keeps the original position).
  if (ogCache.has(url)) ogCache.delete(url);
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
function resolveCloudOG(): ReturnType<typeof createCloudOGClient> | null {
  const client = getCloudClient();
  return client ? createCloudOGClient(client) : null;
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

/** Collapse whitespace and control characters, and cap the length. */
function cleanText(value: string, max: number): string {
  const printable = Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : ch;
  }).join('');
  return printable.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** One bounded, cached, rate-limited scrape of a site's origin. */
async function scrapeSite(origin: string, userId: string): Promise<OGData> {
  const cached = getOGFromCache(origin);
  if (cached) return cached;
  if (!checkUserRateLimit(userId)) {
    institutionsLogger.warn({ userId, origin }, 'Site scrape rate limit exceeded');
    return EMPTY_OG;
  }
  if (!(await tryAcquireFetchSlot())) {
    institutionsLogger.warn(
      { origin, inFlight: inFlightFetches },
      'Site scrape concurrency cap hit'
    );
    return EMPTY_OG;
  }
  try {
    const data = await extractOG(origin);
    setOGInCache(origin, data, OG_CACHE_TTL_MS);
    return data;
  } catch (error) {
    institutionsLogger.warn(
      {
        origin,
        reason: error instanceof BoundedFetchError ? error.reason : undefined,
        error: error instanceof Error ? error.message : String(error),
      },
      'Site scrape failed'
    );
    setOGInCache(origin, EMPTY_OG, OG_NEGATIVE_CACHE_TTL_MS);
    return EMPTY_OG;
  } finally {
    releaseFetchSlot();
  }
}

export const institutionsRouter = router({
  // The institutions this user may pick: the verified catalogue plus their own (SC-1354).
  getAll: protectedProcedure.query(async ({ ctx }) => {
    return await Container.get(InstitutionRepository).findVisibleTo(ctx.userId);
  }),

  getByUserId: protectedProcedure.query(async ({ ctx }) => {
    return await Container.get(InstitutionRepository).findByUserId(ctx.userId);
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(InstitutionService).getInstitutionsByUserIdWithSummary(dbUser.id);
  }),

  // An institution from its website, shared with everyone (SC-1354, mgrin
  // 2026-09-26). The client sends a URL and nothing else: name, logo and
  // description come from the server's own scrape of the site's origin, so a
  // client cannot publish arbitrary text into every user's picker. A site that
  // already has a verified row is reused without scraping. `null` means the
  // site gave no name; the user then types one, and that row stays private.
  //
  // The scrape is the old autofill's, with its guards: `fetchHtmlBounded` caps
  // the body at 512KB and blocks private hosts, at most 3 fetches run at once,
  // 20 per user per minute, and results are cached (1h, empty ones 5 min).
  createFromWebsite: protectedProcedure
    .input(strictInput(z.object({ url: z.string().url(), typeId: z.string().uuid().optional() })))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const host = siteHost(input.url);
      if (!host) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a public website' });
      }
      const service = Container.get(InstitutionService);
      const existing = await Container.get(InstitutionRepository).findVerifiedBySiteHost(host);
      if (existing) return { id: existing.id, name: existing.name };

      const origin = `https://${host}`;
      const og = await scrapeSite(origin, dbUser.id);
      const name = cleanText(og.siteName || og.title, 120);
      if (!name) return null;

      const typeId =
        input.typeId ?? (await Container.get(InstitutionTypeRepository).findByCode('other'))?.id;
      if (!typeId) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'No institution type' });
      }
      const { institution } = await service.ensureFromSite({
        host,
        name,
        description: cleanText(og.description, 500) || null,
        logoUrl: /^https:\/\//i.test(og.image) ? og.image : null,
        typeId,
      });
      return { id: institution.id, name: institution.name };
    }),
});
