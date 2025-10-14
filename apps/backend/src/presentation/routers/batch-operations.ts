import { z } from 'zod';
import type { BatchOperationsService } from '../../application/services';
import { getUserId } from '../../middleware/auth';
import { protectedProcedure, router } from '../trpc';

/**
 * Batch Operations Router
 *
 * Provides atomic multi-entity operations using database transactions.
 * This prevents orphaned entities when network failures occur during
 * sequential mutation chains.
 *
 * Refactored to use BatchOperationsService with dependency injection.
 */

// Schema for creating holding with all dependencies in one transaction
const CreateHoldingWithDependenciesSchema = z.object({
  // Institution (optional - create if needed)
  institution: z
    .object({
      name: z.string().min(1, 'Institution name is required'),
      type: z.string().min(1, 'Institution type is required'),
      description: z.string().optional(),
      website: z.string().url().optional().or(z.literal('')),
      logoUrl: z.string().url().optional().or(z.literal('')),
    })
    .optional(),

  // Account (required)
  account: z.object({
    institutionId: z.string().uuid().optional(), // Use if institution not being created
    name: z.string().min(1, 'Account name is required'),
    type: z.string().min(1, 'Account type is required'),
    description: z.string().optional(),
  }),

  // Token (optional - create if external token)
  token: z
    .object({
      symbol: z.string().min(1, 'Token symbol is required'),
      name: z.string().optional(),
      typeId: z.string().optional(),
      decimals: z.number().int().min(0).max(18).optional(),
      iconUrl: z.string().url().optional().or(z.literal('')),
    })
    .optional(),

  // Holding (required)
  holding: z.object({
    tokenId: z.string().uuid().optional(), // Use if token not being created
    balance: z.string().regex(/^-?\d+\.?\d*$/, 'Balance must be a valid decimal string'),
    lastUpdated: z.string().datetime().optional(),
  }),
});

type CreateHoldingResult = {
  institutionId?: string;
  accountId: string;
  tokenId?: string; // Optional because token might already exist
  holdingId: string;
  createdInstitution?: boolean;
  createdAccount: boolean;
  createdToken?: boolean;
  createdHolding: boolean;
};

/**
 * Factory function to create batch operations router with injected dependencies
 */
export function createBatchOperationsRouter(batchOperationsService: BatchOperationsService) {
  return router({
    /**
     * Create holding with all dependencies atomically
     *
     * This endpoint ensures that either ALL entities are created or NONE are created.
     * Prevents orphaned institutions/accounts when holding creation fails.
     */
    createHoldingWithDependencies: protectedProcedure
      .input(CreateHoldingWithDependenciesSchema)
      .mutation(async ({ input, ctx }): Promise<CreateHoldingResult> => {
        const userIdStr = getUserId(ctx);

        // Map router input to service input format
        const serviceInput = {
          institution: input.institution
            ? {
                name: input.institution.name,
                typeCode: input.institution.type, // Map 'type' to 'typeCode'
                description: input.institution.description,
              }
            : undefined,
          account: {
            institutionId: input.account.institutionId,
            name: input.account.name,
            typeCode: input.account.type, // Map 'type' to 'typeCode'
            description: input.account.description,
          },
          token: input.token
            ? {
                symbol: input.token.symbol,
                isActive: true,
                decimals: input.token.decimals ?? 8,
                name: input.token.name,
                typeId: input.token.typeId,
                iconUrl: input.token.iconUrl,
              }
            : undefined,
          holding: {
            tokenId: input.holding.tokenId,
            balance: input.holding.balance,
            lastUpdated: input.holding.lastUpdated
              ? new Date(input.holding.lastUpdated)
              : undefined,
          },
        };

        // NOTE: Service expects number userId, but getUserId returns string
        // This needs to be fixed in a future refactor (userId type inconsistency)
        // For now, convert string to number temporarily
        const userId = parseInt(userIdStr, 10);
        if (Number.isNaN(userId)) {
          throw new Error('Invalid user ID');
        }

        // Delegate to service for atomic operation
        return await batchOperationsService.createHoldingWithDependencies(serviceInput, userIdStr);
      }),
  });
}
