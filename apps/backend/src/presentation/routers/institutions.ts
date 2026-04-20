import { InstitutionImplementations } from '@scani/domain/features';
import { createComponentLogger } from '@scani/logging';
import ogs from 'open-graph-scraper';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const institutionsLogger = createComponentLogger('router:institutions');

// PERFORMANCE: In-memory cache for OpenGraph metadata
// TTL: 1 hour (OG data rarely changes)
interface OGCacheEntry {
  data: {
    title: string;
    description: string;
    siteName: string;
    image: string;
    type: string;
  };
  expiresAt: number;
}

const ogCache = new Map<string, OGCacheEntry>();
const OG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getOGFromCache(url: string): OGCacheEntry['data'] | null {
  const entry = ogCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    ogCache.delete(url);
    return null;
  }
  return entry.data;
}

function setOGInCache(url: string, data: OGCacheEntry['data']): void {
  // Limit cache size to prevent memory issues
  if (ogCache.size > 1000) {
    // Remove oldest 100 entries
    const keys = Array.from(ogCache.keys()).slice(0, 100);
    for (const key of keys) {
      ogCache.delete(key);
    }
  }
  ogCache.set(url, { data, expiresAt: Date.now() + OG_CACHE_TTL_MS });
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

  // Get Open Graph metadata from a website URL
  // PERFORMANCE: Cached for 1 hour to avoid repeated external fetches
  getOpenGraphMetadata: protectedProcedure
    .input(z.object({ url: z.string().url() }))
    .query(async ({ input }) => {
      // Check cache first
      const cached = getOGFromCache(input.url);
      if (cached) {
        return cached;
      }

      try {
        const { result } = await ogs({ url: input.url });

        const data = {
          title: result.ogTitle || result.twitterTitle || result.dcTitle || '',
          description:
            result.ogDescription || result.twitterDescription || result.dcDescription || '',
          siteName: result.ogSiteName || '',
          image: result.ogImage?.[0]?.url || result.twitterImage?.[0]?.url || '',
          type: result.ogType || '',
        };

        // Cache the result
        setOGInCache(input.url, data);

        return data;
      } catch (error) {
        institutionsLogger.error({ error }, 'Failed to fetch Open Graph metadata');
        // Return empty metadata instead of throwing
        const emptyData = {
          title: '',
          description: '',
          siteName: '',
          image: '',
          type: '',
        };
        // Cache empty results too to avoid repeated failed requests
        setOGInCache(input.url, emptyData);
        return emptyData;
      }
    }),
});
