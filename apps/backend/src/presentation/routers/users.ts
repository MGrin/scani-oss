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
    const { dbUser } = await requireAuth(ctx);
    return dbUser;
  }),

  // Update current user
  updateCurrent: protectedProcedure.input(UpdateUserDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await SettingsImplementations.updateCurrent({ userId: dbUser.id, dbUser }, input);
  }),

  // Get supported fiat currencies (tokens) for base currency selection
  getSupportedCurrencies: protectedProcedure.query(async ({ ctx }) => {
    usersLogger.debug('Fetching supported fiat currencies');
    const result = await SettingsImplementations.getSupportedCurrencies({ userId: ctx.userId }, {});
    usersLogger.debug({ count: result.length }, 'Fetched fiat tokens');
    return result;
  }),

  // Get user's base currency token (lightweight)
  getBaseCurrency: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await SettingsImplementations.getBaseCurrency({ userId: dbUser.id, dbUser }, {});
  }),

  // Delete all user data (accounts, holdings, wallets, credentials, groups, vaults)
  deleteAllData: protectedProcedure.mutation(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await SettingsImplementations.deleteAllData({ userId: dbUser.id, dbUser }, {});
  }),
});
