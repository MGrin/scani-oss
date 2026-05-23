import { AssetAllocationService, DashboardService } from '@scani/domain/services';
import { GetAssetAllocationInputDto } from '@scani/shared';
import { Container } from 'typedi';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const dashboardRouter = router({
  /**
   * Get comprehensive dashboard data in a single request
   * Includes: portfolio value, counts, top holdings, and asset allocation
   */
  getOverview: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(DashboardService).getDashboardOverview(
      dbUser.id,
      dbUser.baseCurrencyId || undefined,
      ctx.requestCache
    );
  }),

  /**
   * Get asset allocation by a specific dimension
   * Dimensions: token, token_type, account, account_type, institution, institution_type
   */
  getAssetAllocation: protectedProcedure
    .input(GetAssetAllocationInputDto)
    .query(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      const result = await Container.get(AssetAllocationService).execute(
        dbUser.id,
        input.dimension,
        dbUser.baseCurrencyId || undefined,
        ctx.requestCache
      );
      return {
        dimension: input.dimension,
        ...result,
      };
    }),
});
