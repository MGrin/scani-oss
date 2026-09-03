import {
  ObservedBurnAnswerCurrencyMismatch,
  TokenService,
  UserService,
} from '@scani/domain/services';
import { USER_DATA_DELETE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import {
  CurrentUserDto,
  ObservedBurnAnswerDto,
  ReportTimezoneDto,
  UpdateUserDto,
} from '@scani/shared';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const usersLogger = createComponentLogger('router:users');

export const usersRouter = router({
  /**
   * The current user as `CurrentUserDto` NAMES them, not as the row holds them
   * (SC-688). `dbUser` is a whole `users` record, so returning it put
   * `emailUnsubscribeToken` — a bearer credential — in front of every
   * signed-in tab. The `.output()` is what stops that, and it stops it at the
   * SERVER: no client can opt back into a column the schema does not list, and
   * a bundle built against an older contract cannot either.
   */
  getCurrent: protectedProcedure.output(CurrentUserDto).query(async ({ ctx }) => {
    // Use cached user data from auth context instead of querying database
    const { dbUser } = await requireAuth(ctx);
    return dbUser;
  }),

  /**
   * Update current user.
   *
   * Two of the fields here are not preferences — they are the unit and the rule
   * every money figure on every screen is computed with, so changing either
   * moves numbers the user has already read. Both emit a `user:update` realtime
   * event, which every open tab and device turns into a re-invalidation of the
   * portfolio queries. Name-only edits do NOT emit: refetching dozens of queries
   * on a name typo is waste, and there is nothing to explain.
   *
   * - `baseCurrencyId` — every dashboard total, holding price and vault value is
   *   denominated in it, so a switch is effectively "refetch everything that
   *   shows money".
   * - `costBasisMethod` — decides which lots a disposal is matched against, so it
   *   moves every REALIZED figure, historical ones included (SC-957).
   *
   * ## What a cost-basis change does, and why it is not silent
   *
   * The persisted derived figures are the `portfolio_value_daily` rollup rows,
   * which carry cost basis and realized PnL, plus the live valuation cache.
   * `enqueuePortfolioRollup` busts the cache and enqueues the same
   * `PORTFOLIO_HISTORY_BACKFILL` job the 04:00 UTC schedule runs, over
   * `PORTFOLIO_HISTORY_LOOKBACK_DAYS` — so re-computation is bounded to that
   * window for this one user, and BullMQ's job id coalesces a burst of edits
   * into one run.
   *
   * The event is emitted for the same reason the currency one is: figures that
   * move while somebody is looking at them must move VISIBLY. `UserService`
   * has already recorded what the method was, what it became and when, so a
   * figure that moved also has a stored cause after the fact — which is the
   * property this ticket is actually about.
   */
  updateCurrent: protectedProcedure
    .input(strictInput(UpdateUserDto))
    .output(CurrentUserDto)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const previousBaseCurrencyId = dbUser.baseCurrencyId;
      const { user: updated, costBasisMethodChange } = await Container.get(UserService).updateUser(
        dbUser.id,
        input
      );
      if (input.baseCurrencyId !== undefined && input.baseCurrencyId !== previousBaseCurrencyId) {
        emitEntityChange({
          entityType: 'user',
          operationType: 'update',
          entityId: dbUser.id,
          userId: dbUser.id,
          metadata: {
            source: 'base-currency-change',
            previousBaseCurrencyId,
            newBaseCurrencyId: updated.baseCurrencyId,
          },
        });
      }
      if (costBasisMethodChange) {
        usersLogger.info(
          {
            userId: dbUser.id,
            previousMethod: costBasisMethodChange.previousMethod,
            newMethod: costBasisMethodChange.newMethod,
          },
          'Cost-basis method changed — recomputing every figure it moved'
        );
        // Non-fatal by construction: `enqueuePortfolioRollup` swallows enqueue
        // failures because the nightly rollup and the next mutation catch up.
        // The history row is already committed either way, so a lost enqueue
        // leaves stale figures with a recorded cause rather than moved figures
        // with none.
        await enqueuePortfolioRollup(dbUser.id);
        emitEntityChange({
          entityType: 'user',
          operationType: 'update',
          entityId: dbUser.id,
          userId: dbUser.id,
          metadata: {
            source: 'cost-basis-method-change',
            previousCostBasisMethod: costBasisMethodChange.previousMethod,
            newCostBasisMethod: costBasisMethodChange.newMethod,
          },
        });
      }
      return updated;
    }),

  /**
   * Record the browser's IANA timezone (SC-226).
   *
   * This is the only thing that ever writes `users.timezone`, and the payment
   * reminder cannot fire for a user whose zone is null — so if this endpoint
   * stops being called, the feature becomes a no-op that reports success. The
   * job counts and logs those users on every fire for exactly that reason.
   *
   * Not folded into `updateCurrent`: that mutation is a profile edit, and a
   * page load is not one.
   */
  reportTimezone: protectedProcedure
    .input(strictInput(ReportTimezoneDto))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const result = await Container.get(UserService).reportTimezone(dbUser.id, input.timezone);
      if (result.changed) {
        usersLogger.info({ userId: dbUser.id, timezone: input.timezone }, 'Recorded user timezone');
      }
      return result;
    }),

  /**
   * Override the measured monthly drain, confirm it, or withdraw either
   * (SC-661).
   *
   * Emits `user:update` for the same reason a base-currency change does: this
   * governs the runway on Home and the affordability answer in Money, so every
   * open tab is showing a stale conclusion the instant it lands. Unlike
   * `reportTimezone` this is one deliberate act by a person, not a report fired
   * on every page load, so the cost of the broadcast is not a concern.
   *
   * `confirm` echoes back the figure the surface DISPLAYED rather than letting
   * the server re-derive it. The user agreed with what they were shown, and the
   * server recomputing at write time could store agreement with a number nobody
   * ever saw.
   */
  setObservedBurnAnswer: protectedProcedure
    .input(strictInput(ObservedBurnAnswerDto))
    .output(CurrentUserDto)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      let updated: Awaited<ReturnType<UserService['setObservedBurnAnswer']>>;
      try {
        updated = await Container.get(UserService).setObservedBurnAnswer(dbUser.id, input);
      } catch (error) {
        // The client sends the currency because it is what gets STORED, and a
        // client reading a cached profile can send the one the account has just
        // left. A 400 telling it to re-read beats a stored answer that decodes
        // as `currencyChanged` the first time anybody looks at it.
        if (error instanceof ObservedBurnAnswerCurrencyMismatch) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'That figure was given in a currency this account no longer uses. Reload and try again.',
          });
        }
        throw error;
      }
      emitEntityChange({
        entityType: 'user',
        operationType: 'update',
        entityId: dbUser.id,
        userId: dbUser.id,
        metadata: { source: 'observed-burn-answer', kind: input.kind },
      });
      return updated;
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
    .input(strictInput(z.object({ requestId: z.string().uuid() })))
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
