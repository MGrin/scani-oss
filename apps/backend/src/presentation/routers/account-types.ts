import { TypeImplementations } from '@scani/core/features/implementations';
import { protectedProcedure, router } from '../trpc';

export const accountTypesRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    return await TypeImplementations.getAccountTypes({ userId: ctx.user.id }, {});
  }),
});
