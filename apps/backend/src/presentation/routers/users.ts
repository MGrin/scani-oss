import { SettingsImplementations } from '@scani/core/features/implementations';
import { createComponentLogger } from '@scani/core/utils/logger';
import { UpdateUserDto } from '@scani/shared';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const usersLogger = createComponentLogger('router:users');

export const usersRouter = router({
  // Get current authenticated user
  getCurrent: protectedProcedure.query(async ({ ctx }) => {
    // Use cached user data from auth context instead of querying database
    const { dbUser } = requireAuth(ctx);
    return dbUser;
  }),

  // Update current user
  updateCurrent: protectedProcedure.input(UpdateUserDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);
    return await SettingsImplementations.updateCurrent({ userId: dbUser.id, dbUser }, input);
  }),

  // Get supported fiat currencies (tokens) for base currency selection
  getSupportedCurrencies: protectedProcedure.query(async ({ ctx }) => {
    usersLogger.debug('Fetching supported fiat currencies');
    const result = await SettingsImplementations.getSupportedCurrencies(
      { userId: ctx.user.id },
      {}
    );
    usersLogger.debug({ count: result.length }, 'Fetched fiat tokens');
    return result;
  }),

  // Get user's base currency token (lightweight)
  getBaseCurrency: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    return await SettingsImplementations.getBaseCurrency({ userId: dbUser.id, dbUser }, {});
  }),
});
