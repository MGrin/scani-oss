import { PortfolioHistoryService } from '@scani/core/services';
import { GetPortfolioHistoryChartInputDto, GetPortfolioHistoryEventsInputDto } from '@scani/shared';
import { Container } from 'typedi';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const portfolioHistoryService = Container.get(PortfolioHistoryService);

export const portfolioHistoryRouter = router({
  /**
   * Get portfolio history events (for the paginated list)
   */
  getEvents: protectedProcedure
    .input(GetPortfolioHistoryEventsInputDto)
    .query(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);

      // Parse dates if provided
      const startDate = input.startDate ? new Date(input.startDate) : undefined;
      const endDate = input.endDate ? new Date(input.endDate) : undefined;

      return await portfolioHistoryService.getHistoryEvents(dbUser.id, {
        limit: input.limit,
        offset: input.offset,
        startDate,
        endDate,
      });
    }),

  /**
   * Get portfolio history chart data (optimized for visualization)
   */
  getChart: protectedProcedure
    .input(GetPortfolioHistoryChartInputDto)
    .query(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);

      const startDate = new Date(input.startDate);
      const endDate = new Date(input.endDate);

      return await portfolioHistoryService.getHistoryChart(
        dbUser.id,
        startDate,
        endDate,
        input.maxPoints
      );
    }),
});
