import { BatchOperationImplementations } from '@scani/core/features/implementations';
import {
  CreateHoldingsWithDependenciesDto,
  type CreateHoldingsWithDependenciesResponseDto,
} from '@scani/shared';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

// Schema for updating multiple holdings in batch
const UpdateHoldingsBatchSchema = z.object({
  holdings: z
    .array(
      z.object({
        id: z.string().uuid(),
        balance: z.string().regex(/^-?\d+\.?\d*$/, 'Balance must be a valid decimal string'),
        lastUpdated: z.string().datetime().optional(),
      })
    )
    .min(1, 'At least one holding is required'),
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
    .input(CreateHoldingsWithDependenciesDto)
    .mutation(async ({ input, ctx }): Promise<CreateHoldingsWithDependenciesResponseDto> => {
      const { dbUser } = requireAuth(ctx);
      return await BatchOperationImplementations.createHoldingsWithDependencies(
        { userId: dbUser.id, dbUser },
        input
      );
    }),

  updateHoldingsBatch: protectedProcedure
    .input(UpdateHoldingsBatchSchema)
    .mutation(async ({ input, ctx }): Promise<UpdateHoldingsBatchResult> => {
      const { dbUser } = requireAuth(ctx);
      return await BatchOperationImplementations.updateHoldingsBatch(
        { userId: dbUser.id, dbUser },
        input
      );
    }),
});
