import { EntityRepository } from '@scani/domain/repositories';
import { EntityValuationService } from '@scani/domain/services';
import {
  AssignAccountsToEntityDto,
  CreateEntityDto,
  entityValuationSchema,
  IdInputDto,
  UpdateEntityDto,
} from '@scani/shared';
import { Container } from 'typedi';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

/**
 * Ownership boundaries over accounts — one owner, two sets of books (SC-463).
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

  create: protectedProcedure
    .input(strictInput(CreateEntityDto))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return await Container.get(EntityRepository).create({
        userId: dbUser.id,
        name: input.name,
        description: input.description ?? null,
      });
    }),

  update: protectedProcedure
    .input(strictInput(UpdateEntityDto))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const repository = Container.get(EntityRepository);
      const existing = await repository.findByIdForUser(dbUser.id, input.id);
      if (!existing) throw new Error('Unauthorized access to entity');

      const { id, ...changes } = input;
      return await repository.update(id, { ...changes, updatedAt: new Date() });
    }),

  /**
   * Deleting a boundary does NOT delete what is inside it.
   *
   * The FK is `ON DELETE SET NULL`, so the accounts fall back to unassigned —
   * visible in their own bucket, with their holdings and history intact.
   * Cascading here would destroy real financial records to remove a label.
   */
  delete: protectedProcedure.input(strictInput(IdInputDto)).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const repository = Container.get(EntityRepository);
    const existing = await repository.findByIdForUser(dbUser.id, input.id);
    if (!existing) throw new Error('Unauthorized access to entity');

    await repository.delete(input.id);
    return { success: true as const };
  }),

  /**
   * Move accounts across the boundary, or out of every boundary with a null
   * `entityId`.
   *
   * The target entity is checked for ownership before anything is written, and
   * the accounts are scoped by `userId` inside the UPDATE itself — an
   * ownership boundary is exactly where a caller passing somebody else's id
   * must write nothing.
   */
  assignAccounts: protectedProcedure
    .input(strictInput(AssignAccountsToEntityDto))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const repository = Container.get(EntityRepository);

      if (input.entityId !== null) {
        const target = await repository.findByIdForUser(dbUser.id, input.entityId);
        if (!target) throw new Error('Unauthorized access to entity');
      }

      const assigned = await repository.assignAccounts(dbUser.id, input.accountIds, input.entityId);
      return { assigned };
    }),
});
