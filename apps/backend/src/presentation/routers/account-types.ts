import { TypeImplementations } from '@scani/domain/features';
import { protectedProcedure, router } from '../trpc';

export const accountTypesRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    return await TypeImplementations.getAccountTypes({ userId: ctx.userId }, {});
  }),
});
