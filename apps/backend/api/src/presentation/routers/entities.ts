import { EntityRepository } from '@scani/domain/repositories';
import { EntityValuationService } from '@scani/domain/services';
import { entityValuationSchema } from '@scani/shared';
import { Container } from 'typedi';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

/**
 * Read-only archival ownership API. Existing associations remain exportable after retirement.
 *
 * **Not tax output.** SC-90 stays parked
 * (`docs/technical/2026-08-14_why-no-tax-statement.md`). Nothing here may
 * acquire a tax framing, including a route name.
 */
export const entitiesRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(EntityRepository).findByUser(dbUser.id);
  }),

  /**
   * Per-boundary totals AND the combined figure, from one call.
   *
   * The output schema is the contract rather than decoration: the number a
   * person checks on this screen is `sum(entities) + unassigned ===
   * totalValue`, and shipping the parts and the whole together is what stops a
   * client pairing today's parts with a total it fetched a moment earlier.
   */
  getValues: protectedProcedure.output(entityValuationSchema).query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(EntityValuationService).execute(
      dbUser.id,
      dbUser.baseCurrencyId || undefined,
      ctx.requestCache
    );
  }),
});
