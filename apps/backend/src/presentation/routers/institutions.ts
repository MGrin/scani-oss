import { InstitutionImplementations } from '@scani/core/features/implementations';
import ogs from 'open-graph-scraper';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

export const institutionsRouter = router({
  // Get all institutions
  getAll: protectedProcedure.query(async ({ ctx }) => {
    return await InstitutionImplementations.getAll({ userId: ctx.user.id }, {});
  }),

  getByUserId: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    return await InstitutionImplementations.getByUserId({ userId }, {});
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = ctx;
    const userId = dbUser.id;
    return await InstitutionImplementations.getByUserIdWithSummary({ userId, dbUser }, {});
  }),

  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input, ctx }) => {
    return await InstitutionImplementations.getById({ userId: ctx.user.id }, { id: input.id });
  }),

  // Get Open Graph metadata from a website URL
  getOpenGraphMetadata: protectedProcedure
    .input(z.object({ url: z.string().url() }))
    .query(async ({ input }) => {
      try {
        const { result } = await ogs({ url: input.url });

        return {
          title: result.ogTitle || result.twitterTitle || result.dcTitle || '',
          description:
            result.ogDescription || result.twitterDescription || result.dcDescription || '',
          siteName: result.ogSiteName || '',
          image: result.ogImage?.[0]?.url || result.twitterImage?.[0]?.url || '',
          type: result.ogType || '',
        };
      } catch (error) {
        console.error('Failed to fetch Open Graph metadata:', error);
        // Return empty metadata instead of throwing
        return {
          title: '',
          description: '',
          siteName: '',
          image: '',
          type: '',
        };
      }
    }),
});
