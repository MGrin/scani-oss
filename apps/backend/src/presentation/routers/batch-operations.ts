import { z } from "zod";
import {
  CreateHoldingsWithDependenciesUseCase,
  UpdateHoldingsBatchUseCase,
} from "../../application/use-cases";
import { Container } from "typedi";
import { getUserId } from "../../middleware/auth";
import { protectedProcedure, router } from "../trpc";

/**
 * Batch Operations Router
 *
 * Thin presentation layer for batch operations.
 * Delegates all business logic to use cases following clean architecture principles.
 */

// Schema for creating holdings with all dependencies in one transaction
const CreateHoldingsWithDependenciesSchema = z.object({
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

  // Account (optional - provide EITHER accountId OR account details to create)
  accountId: z.string().uuid().optional(), // Use existing account
  account: z
    .object({
      institutionId: z.string().uuid().optional().or(z.literal("")), // Use if institution not being created
      name: z.string().min(1, "Account name is required"),
      type: z.string().min(1, "Account type is required"),
      description: z.string().optional(),
    })
    .optional(), // Optional when accountId is provided

  // Holdings (required - at least one)
  holdings: z
    .array(
      z.object({
        tokenId: z.string().uuid().optional(), // Use if token already exists
        token: z
          .object({
            symbol: z.string().min(1, "Token symbol is required"),
            name: z.string().optional(),
            typeId: z.string().optional(),
            decimals: z.number().int().min(0).max(18).optional(),
            iconUrl: z.string().url().optional().or(z.literal("")),
          })
          .optional(), // Provide if token needs to be created
        balance: z
          .string()
          .regex(/^-?\d+\.?\d*$/, "Balance must be a valid decimal string"),
        lastUpdated: z.string().datetime().optional(),
      })
    )
    .min(1, "At least one holding is required"),
});

type CreateHoldingsWithDependenciesResult = {
  institutionId?: string;
  accountId: string;
  holdings: Array<{
    holdingId: string;
    tokenId: string;
    createdToken?: boolean;
    createdHolding: boolean;
  }>;
  createdInstitution?: boolean;
  createdAccount: boolean;
};

// Schema for updating multiple holdings in batch
const UpdateHoldingsBatchSchema = z.object({
  holdings: z
    .array(
      z.object({
        id: z.string().uuid(),
        balance: z
          .string()
          .regex(/^-?\d+\.?\d*$/, "Balance must be a valid decimal string"),
        lastUpdated: z.string().datetime().optional(),
      })
    )
    .min(1, "At least one holding is required"),
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

export function createBatchOperationsRouter() {
  return router({
    /**
     * Create holdings with all dependencies atomically
     *
     * This endpoint ensures that either ALL entities are created or NONE are created.
     * Prevents orphaned institutions/accounts when holding creation fails.
     *
     * Supports two modes:
     * 1. Create new account: Provide institution (optional) + account details + holdings
     * 2. Use existing account: Provide accountId + holdings
     */
    createHoldingsWithDependencies: protectedProcedure
      .input(CreateHoldingsWithDependenciesSchema)
      .mutation(
        async ({
          input,
          ctx,
        }): Promise<CreateHoldingsWithDependenciesResult> => {
          const userId = getUserId(ctx);
          const useCase = Container.get(CreateHoldingsWithDependenciesUseCase);

          // Convert string dates to Date objects
          const holdings = input.holdings.map((h) => ({
            ...h,
            lastUpdated: h.lastUpdated ? new Date(h.lastUpdated) : undefined,
          }));

          return await useCase.execute(
            {
              institution: input.institution,
              accountId: input.accountId,
              account: input.account,
              holdings,
            },
            userId
          );
        }
      ),

    /**
     * Update multiple holdings in batch
     *
     * This endpoint updates the balance (and optionally lastUpdated) for multiple holdings
     * in a single API call. Much more efficient than updating holdings one by one.
     *
     * Use case: When user edits multiple existing holdings in the AddData form
     */
    updateHoldingsBatch: protectedProcedure
      .input(UpdateHoldingsBatchSchema)
      .mutation(async ({ input, ctx }): Promise<UpdateHoldingsBatchResult> => {
        const userId = getUserId(ctx);
        const useCase = Container.get(UpdateHoldingsBatchUseCase);

        // Convert string dates to Date objects
        const holdings = input.holdings.map((h) => ({
          ...h,
          lastUpdated: h.lastUpdated ? new Date(h.lastUpdated) : undefined,
        }));

        return await useCase.execute({ holdings }, userId);
      }),
  });
}
