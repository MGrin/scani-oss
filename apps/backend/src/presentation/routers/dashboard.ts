import { DashboardService } from '@scani/core/services/DashboardService';
import { GetAssetAllocationUseCase } from '@scani/core/use-cases';
import { GetAssetAllocationInputDto } from '@scani/shared';
import { Container } from 'typedi';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const dashboardService = Container.get(DashboardService);
const getAssetAllocationUseCase = Container.get(GetAssetAllocationUseCase);

export const dashboardRouter = router({
  /**
   * Get comprehensive dashboard data in a single request
   * Includes: portfolio value, counts, top holdings, and asset allocation
   */
  getOverview: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);

    // Get user's base currency if available
    const userBaseCurrencyId = dbUser.baseCurrencyId || undefined;

    return dashboardService.getDashboardOverview(dbUser.id, userBaseCurrencyId);
  }),

  /**
   * Get asset allocation by a specific dimension
   * Dimensions: token, token_type, account, account_type, institution, institution_type
   */
  getAssetAllocation: protectedProcedure
    .input(GetAssetAllocationInputDto)
    .query(async ({ ctx, input }) => {
      const { dbUser } = requireAuth(ctx);

      // Get user's base currency if available
      const userBaseCurrencyId = dbUser.baseCurrencyId || undefined;

      const result = await getAssetAllocationUseCase.execute(
        dbUser.id,
        input.dimension,
        userBaseCurrencyId
      );

      return {
        dimension: input.dimension,
        ...result,
      };
    }),
});
