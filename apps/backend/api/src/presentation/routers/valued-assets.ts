import { ValuedAssetService } from '@scani/domain/services';
import {
  CreateValuedAssetUseCase,
  NotHandValuedError,
  NothingHeldThenError,
} from '@scani/domain/use-cases';
import { emitEntityChange } from '@scani/realtime';
import { AddValuationDto, CreateValuedAssetDto, UpdateValuedAssetDetailsDto } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { withIdempotency } from '../../lib/idempotency';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const idempotencyKey = z.string().min(1).max(128).optional();

function refuse(error: unknown): never {
  if (error instanceof NotHandValuedError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Valued asset not found' });
  }
  if (error instanceof NothingHeldThenError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That date is before you bought it.' });
  }
  throw error;
}

function emitHoldingChanged(holdingId: string, userId: string, operationType: 'create' | 'update') {
  emitEntityChange({ entityType: 'holding', operationType, entityId: holdingId, userId, data: {} });
}

/**
 * Property and vehicles valued by hand (SC-1643). Each write rebuilds the
 * rollup from the day it changed, which may be years back: a purchase date
 * or a past valuation moves every day after it.
 */
export const valuedAssetsRouter = router({
  create: protectedProcedure
    .input(strictInput(z.object({ asset: CreateValuedAssetDto, idempotencyKey })))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const result = await Container.get(CreateValuedAssetUseCase).execute(input.asset, dbUser);
        emitHoldingChanged(result.holdingId, dbUser.id, 'create');
        void enqueuePortfolioRollup(dbUser.id, result.fromDay);
        return result;
      });
    }),

  addValuation: protectedProcedure
    .input(strictInput(z.object({ valuation: AddValuationDto, idempotencyKey })))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const result = await Container.get(ValuedAssetService)
          .addValuation(input.valuation, dbUser.id)
          .catch(refuse);
        emitHoldingChanged(result.holdingId, dbUser.id, 'update');
        void enqueuePortfolioRollup(dbUser.id, input.valuation.occurredOn);
        return result;
      });
    }),

  history: protectedProcedure
    .input(strictInput(z.object({ holdingId: z.string().uuid() })))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return Container.get(ValuedAssetService).history(input.holdingId, dbUser.id).catch(refuse);
    }),

  updateDetails: protectedProcedure
    .input(strictInput(z.object({ update: UpdateValuedAssetDetailsDto, idempotencyKey })))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        await Container.get(ValuedAssetService)
          .updateDetails(input.update, dbUser.id)
          .catch(refuse);
        emitHoldingChanged(input.update.holdingId, dbUser.id, 'update');
        return { holdingId: input.update.holdingId };
      });
    }),
});
