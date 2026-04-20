import { DashboardImplementations } from '@scani/domain/features';
import { GetAssetAllocationInputDto } from '@scani/shared';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const dashboardRouter = router({
  /**
   * Get comprehensive dashboard data in a single request
   * Includes: portfolio value, counts, top holdings, and asset allocation
   */
  getOverview: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await DashboardImplementations.getOverview(
      { userId: dbUser.id, dbUser, requestCache: ctx.requestCache },
      {}
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
      return await DashboardImplementations.getAssetAllocation(
        { userId: dbUser.id, dbUser, requestCache: ctx.requestCache },
        input
      );
    }),
});
