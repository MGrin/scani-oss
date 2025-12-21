import { TypeImplementations } from '@scani/core/features/implementations';
import { protectedProcedure, router } from '../trpc';

export const scheduleTypesRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    return await TypeImplementations.getScheduleTypes({ userId: ctx.userId }, {});
  }),
});
