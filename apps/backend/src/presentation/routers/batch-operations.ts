import { BatchOperationImplementations } from '@scani/core/features/implementations';
import {
  CreateHoldingsWithDependenciesDto,
  type CreateHoldingsWithDependenciesResponseDto,
} from '@scani/shared';
import { z } from 'zod';
import { withIdempotency } from '../../lib/idempotency';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

// Schema for updating multiple holdings in batch
const UpdateHoldingsBatchSchema = z.object({
  holdings: z
    .array(
      z.object({
        id: z.string().uuid(),
        balance: z.string().regex(/^-?\d+(\.\d+)?$/, 'Balance must be a valid decimal string'),
        lastUpdated: z.string().datetime().optional(),
      })
    )
    .min(1, 'At least one holding is required'),
  /**
   * Optional idempotency key. If the client retries with the same key
   * within the cache TTL (5 minutes), the prior response is returned and
   * the mutation is NOT re-run. Prevents duplicate updates on network
   * retries / double-submits.
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
});

// Extended DTO: accept an optional idempotency key alongside the standard
// CreateHoldingsWithDependenciesDto payload.
const CreateHoldingsInputSchema = CreateHoldingsWithDependenciesDto.extend({
  idempotencyKey: z.string().min(1).max(200).optional(),
});

type UpdateHoldingsBatchResult = {
  updated: Array<{
    id: string;
    success: boolean;
    error?: string;
  }>;
  totalUpdated: number;
  totalFailed: number;
};

export const batchOperationsRouter = router({
  createHoldingsWithDependencies: protectedProcedure
    .input(CreateHoldingsInputSchema)
    .mutation(async ({ input, ctx }): Promise<CreateHoldingsWithDependenciesResponseDto> => {
      const { dbUser } = await requireAuth(ctx);
      const { idempotencyKey, ...payload } = input;
      return withIdempotency(dbUser.id, idempotencyKey, () =>
        BatchOperationImplementations.createHoldingsWithDependencies(
          { userId: dbUser.id, dbUser },
          payload
        )
      );
    }),

  updateHoldingsBatch: protectedProcedure
    .input(UpdateHoldingsBatchSchema)
    .mutation(async ({ input, ctx }): Promise<UpdateHoldingsBatchResult> => {
      const { dbUser } = await requireAuth(ctx);
      const { idempotencyKey, ...payload } = input;
      return withIdempotency(dbUser.id, idempotencyKey, () =>
        BatchOperationImplementations.updateHoldingsBatch({ userId: dbUser.id, dbUser }, payload)
      );
    }),
});
