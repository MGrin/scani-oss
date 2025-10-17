import { Container } from 'typedi';
import { DashboardService } from '../../application/services/DashboardService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const dashboardService = Container.get(DashboardService);

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
});
