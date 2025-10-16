import { z } from "zod";
import type { BatchOperationsService } from "../../application/services";
import { CreateHoldingUseCase } from "../../application/use-cases";
import { Container } from "typedi";
import { getUserId } from "../../middleware/auth";
import { protectedProcedure, router } from "../trpc";

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
      name: z.string().min(1, "Institution name is required"),
      type: z.string().min(1, "Institution type is required"),
      description: z.string().optional(),
      website: z.string().url().optional().or(z.literal("")),
      logoUrl: z.string().url().optional().or(z.literal("")),
    })
    .optional(),

  // Account (required)
  account: z.object({
    institutionId: z.string().uuid().optional(), // Use if institution not being created
    name: z.string().min(1, "Account name is required"),
    type: z.string().min(1, "Account type is required"),
    description: z.string().optional(),
  }),

  // Token (optional - create if external token)
  token: z
    .object({
      symbol: z.string().min(1, "Token symbol is required"),
      name: z.string().optional(),
      typeId: z.string().optional(),
      decimals: z.number().int().min(0).max(18).optional(),
      iconUrl: z.string().url().optional().or(z.literal("")),
    })
    .optional(),

  // Holding (required)
  holding: z.object({
    tokenId: z.string().uuid().optional(), // Use if token not being created
    balance: z
      .string()
      .regex(/^-?\d+\.?\d*$/, "Balance must be a valid decimal string"),
    lastUpdated: z.string().datetime().optional(),
  }),
});

const CreateHoldingsBatchSchema = z.object({
  accountId: z.string().uuid(),
  holdings: z.array(
    z.object({
      tokenId: z.string().uuid().optional(), // Use if token not being created
      token: z
        .object({
          symbol: z.string().min(1, "Token symbol is required"),
          name: z.string().optional(),
          typeId: z.string().optional(),
          decimals: z.number().int().min(0).max(18).optional(),
          iconUrl: z.string().url().optional().or(z.literal("")),
        })
        .optional(),
      balance: z
        .string()
        .regex(/^-?\d+\.?\d*$/, "Balance must be a valid decimal string"),
      lastUpdated: z.string().datetime().optional(),
    })
  ),
});

type CreateHoldingsBatchResult = {
  accountId: string;
  holdings: Array<{
    holdingId: string;
    tokenId?: string;
    createdToken?: boolean;
    createdHolding: boolean;
  }>;
};

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
export function createBatchOperationsRouter(
  batchOperationsService: BatchOperationsService
) {
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
          throw new Error("Invalid user ID");
        }

        // Delegate to service for atomic operation
        return await batchOperationsService.createHoldingWithDependencies(
          serviceInput,
          userIdStr
        );
      }),

    /**
     * Create multiple holdings in batch
     *
     * This endpoint creates multiple holdings for the same account.
     * Assumes all tokens are already created (database or external).
     */
    createHoldingsBatch: protectedProcedure
      .input(CreateHoldingsBatchSchema)
      .mutation(async ({ input, ctx }): Promise<CreateHoldingsBatchResult> => {
        const userIdStr = getUserId(ctx);
        const createHoldingUseCase = Container.get(CreateHoldingUseCase);

        const results = [];
        for (const holdingInput of input.holdings) {
          try {
            if (!holdingInput.tokenId) {
              throw new Error("tokenId is required for batch holding creation");
            }

            const result = await createHoldingUseCase.execute(
              {
                accountId: input.accountId,
                tokenId: holdingInput.tokenId,
                balance: holdingInput.balance,
                lastUpdated: holdingInput.lastUpdated
                  ? new Date(holdingInput.lastUpdated)
                  : undefined,
              },
              userIdStr
            );

            results.push({
              holdingId: result.holding.id,
              tokenId: holdingInput.tokenId,
              createdToken: false, // Tokens assumed to be pre-created
              createdHolding: true,
            });
          } catch (error) {
            console.error("Failed to create holding in batch:", error);
            results.push({
              holdingId: "",
              tokenId: holdingInput.tokenId || "",
              createdToken: false,
              createdHolding: false,
            });
          }
        }

        return {
          accountId: input.accountId,
          holdings: results,
        };
      }),
  });
}
