import { TypeImplementations } from '@scani/core/features/implementations';
import { protectedProcedure, router } from '../trpc';

export const scheduleStepTypesRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    return await TypeImplementations.getScheduleStepTypes({ userId: ctx.user.id }, {});
  }),
});
