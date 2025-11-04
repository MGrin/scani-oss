import ogs from 'open-graph-scraper';
import Container from 'typedi';
import { z } from 'zod';
import { InstitutionService } from '../../application/services/InstitutionService';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { protectedProcedure, router } from '../trpc';

const institutionRepository = Container.get(InstitutionRepository);
const institutionService = Container.get(InstitutionService);

export const institutionsRouter = router({
  // Get all institutions
  // KEEP
  getAll: protectedProcedure.query(async () => {
    const institutions = await institutionRepository.findAll();
    return institutions;
  }),

  getByUserId: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const institutions = await institutionRepository.findByUserId(userId);
    return institutions;
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = ctx;
    const userId = dbUser.id;

    // Delegate to service for business logic
    const institutionsWithSummary =
      await institutionService.getInstitutionsByUserIdWithSummary(userId);

    return institutionsWithSummary;
  }),

  // KEEP
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const institution = await institutionRepository.findById(input.id);
    return institution ?? null;
  }),

  // Get Open Graph metadata from a website URL
  // KEEP
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
