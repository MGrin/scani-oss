import { Container } from 'typedi';
import { DashboardService } from '../../application/services/DashboardService';
import { getUserId } from '../../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const dashboardRouter = router({
  /**
   * Get comprehensive dashboard data in a single request
   * Includes: portfolio value, counts, top holdings, and asset allocation
   */
  getOverview: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);
    const dashboardService = Container.get(DashboardService);

    // Get user's base currency if available
    const userBaseCurrencyId = ctx.dbUser?.baseCurrencyId || undefined;

    return dashboardService.getDashboardOverview(userId, userBaseCurrencyId);
  }),
});
