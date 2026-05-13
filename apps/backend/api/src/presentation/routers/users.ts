import { TokenService, UserService } from '@scani/domain/services';
import { USER_DATA_DELETE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService } from '@scani/queue';
import { UpdateUserDto } from '@scani/shared';
import { Container } from 'typedi';
import { z } from 'zod';
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
    return await Container.get(UserService).updateUser(dbUser.id, input);
  }),

  // Get supported fiat currencies (tokens) for base currency selection
  getSupportedCurrencies: protectedProcedure.query(async () => {
    usersLogger.debug('Fetching supported fiat currencies');
    const fiatTokens = await Container.get(TokenService).getTokensByType('fiat');
    const result = fiatTokens.map((token) => ({
      id: token.id,
      symbol: token.symbol,
      name: token.name,
    }));
    usersLogger.debug({ count: result.length }, 'Fetched fiat tokens');
    return result;
  }),

  // Get user's base currency token (lightweight)
  getBaseCurrency: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    if (!dbUser.baseCurrencyId) return null;
    const baseCurrency = await Container.get(TokenService).getTokenById(dbUser.baseCurrencyId);
    if (!baseCurrency) return null;
    return {
      id: baseCurrency.id,
      symbol: baseCurrency.symbol,
      name: baseCurrency.name,
    };
  }),

  /**
   * Enqueue deletion of all user data. The worker runs the large
   * transaction (accounts, holdings, wallets, credentials, groups,
   * vaults) off the request path so it doesn't time out for users
   * with hundreds of holdings. `attempts: 1` — destructive, no retry.
   */
  deleteAllData: protectedProcedure
    .input(z.object({ requestId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      usersLogger.warn({ userId: dbUser.id }, 'Enqueuing delete-all-data job');
      const jobId = await Container.get(BullMqEnqueueService).add(USER_DATA_DELETE, {
        userId: dbUser.id,
        requestId: input.requestId,
      });
      return { jobId };
    }),
});
