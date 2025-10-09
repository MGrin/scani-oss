import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { getUserId } from "../middleware/auth";
import { protectedProcedure, router } from "../trpc";

/**
 * Batch Operations Router
 *
 * Provides atomic multi-entity operations using database transactions.
 * This prevents orphaned entities when network failures occur during
 * sequential mutation chains.
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

export const batchOperationsRouter = router({
  /**
   * Create holding with all dependencies atomically
   *
   * This endpoint ensures that either ALL entities are created or NONE are created.
   * Prevents orphaned institutions/accounts when holding creation fails.
   */
  createHoldingWithDependencies: protectedProcedure
    .input(CreateHoldingWithDependenciesSchema)
    .mutation(async ({ input, ctx }): Promise<CreateHoldingResult> => {
      const userId = getUserId(ctx);
      const now = new Date();

      // Use database transaction for atomicity
      return await db.transaction(async (tx) => {
        let institutionId: string | undefined;
        let createdInstitution = false;
        let tokenId: string;
        let createdToken = false;

        // Step 1: Create or use existing institution
        if (input.institution) {
          // Get institution type
          const [institutionType] = await tx
            .select()
            .from(schema.institutionTypes)
            .where(eq(schema.institutionTypes.code, input.institution.type))
            .limit(1);

          if (!institutionType) {
            throw new Error(
              `Invalid institution type: ${input.institution.type}`
            );
          }

          // Create institution
          const [institution] = await tx
            .insert(schema.institutions)
            .values({
              name: input.institution.name.trim(),
              typeId: institutionType.id,
              description: input.institution.description?.trim() || null,
              website: input.institution.website?.trim() || null,
              logoUrl: input.institution.logoUrl?.trim() || null,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            })
            .returning();

          if (!institution) {
            throw new Error("Failed to create institution");
          }

          institutionId = institution.id;
          createdInstitution = true;
        } else {
          institutionId = input.account.institutionId;
        }

        if (!institutionId) {
          throw new Error("Institution ID is required");
        }

        // Step 2: Create account
        const [accountType] = await tx
          .select()
          .from(schema.accountTypes)
          .where(eq(schema.accountTypes.code, input.account.type))
          .limit(1);

        if (!accountType) {
          throw new Error(`Invalid account type: ${input.account.type}`);
        }

        const [account] = await tx
          .insert(schema.accounts)
          .values({
            userId,
            institutionId,
            name: input.account.name.trim(),
            typeId: accountType.id,
            description: input.account.description?.trim() || null,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        if (!account) {
          throw new Error("Failed to create account");
        }

        const accountId = account.id;

        // Step 3: Create or use existing token
        if (input.token) {
          // Determine token type
          let tokenTypeId = input.token.typeId;
          if (!tokenTypeId) {
            // Default to "other" type
            const [otherType] = await tx
              .select()
              .from(schema.tokenTypes)
              .where(eq(schema.tokenTypes.code, "other"))
              .limit(1);

            if (!otherType) {
              throw new Error('Default token type "other" not found');
            }

            tokenTypeId = otherType.id;
          }

          // Create token
          const [token] = await tx
            .insert(schema.tokens)
            .values({
              symbol: input.token.symbol.trim().toUpperCase(),
              name:
                input.token.name?.trim() ||
                input.token.symbol.trim().toUpperCase(),
              typeId: tokenTypeId,
              decimals: input.token.decimals ?? 18,
              iconUrl: input.token.iconUrl?.trim() || null,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            })
            .returning();

          if (!token) {
            throw new Error("Failed to create token");
          }

          tokenId = token.id;
          createdToken = true;
        } else {
          tokenId = input.holding.tokenId!;
        }

        if (!tokenId) {
          throw new Error("Token ID is required");
        }

        // Step 4: Create holding
        const [holding] = await tx
          .insert(schema.holdings)
          .values({
            userId,
            accountId,
            tokenId,
            balance: input.holding.balance,
            lastUpdated: input.holding.lastUpdated
              ? new Date(input.holding.lastUpdated)
              : now,
            createdAt: now,
          })
          .returning();

        if (!holding) {
          throw new Error("Failed to create holding");
        }

        // Return result with all IDs
        return {
          institutionId: createdInstitution ? institutionId : undefined,
          accountId,
          tokenId: createdToken ? tokenId : undefined,
          holdingId: holding.id,
          createdInstitution,
          createdAccount: true,
          createdToken,
          createdHolding: true,
        };
      });
    }),
});
