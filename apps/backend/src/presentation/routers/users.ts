import { SettingsImplementations } from '@scani/domain/features';
import { createComponentLogger } from '@scani/logging';
import { JOB_NAMES } from '@scani/queue';
import { UpdateUserDto } from '@scani/shared';
import { z } from 'zod';
import { enqueueJob } from '../../queues/enqueue';
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
      const jobId = await enqueueJob(JOB_NAMES.userDataDelete, {
        userId: dbUser.id,
        requestId: input.requestId,
      });
      return { jobId };
    }),
});
