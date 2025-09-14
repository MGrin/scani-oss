import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { TokenValidationService } from "../services/token-validation";
import { protectedProcedure, router } from "../trpc";

// Local schemas for token operations (will be moved to shared later)
const CreateTokenSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(20)
    .transform((val) => val.toUpperCase()),
  name: z.string().min(1).max(100).optional(), // Optional - will be auto-filled from validation
  typeId: z.string().uuid().optional(), // Optional - will be auto-determined from validation
  decimals: z.number().int().min(0).max(18).default(2),
  iconUrl: z.string().url().optional(),
  isActive: z.boolean().default(true),
});

const ValidateTokenSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(20)
    .transform((val) => val.toUpperCase()),
  typeCode: z.string().optional(), // Optional token type to guide provider selection
});

const UpdateTokenSchema = CreateTokenSchema.partial();

// Helper function to map provider token types to database token types
function mapProviderTypeToDbType(providerType: string): string {
  switch (providerType) {
    case "Equity":
      return "stock";
    case "ETF":
      return "etf";
    case "Mutual Fund":
      return "mutual-fund";
    case "Bond":
      return "bond";
    case "Commodity":
      return "commodity";
    case "Crypto":
      return "crypto";
    default:
      return "stock"; // Default fallback
  }
}

export const tokensRouter = router({
  // Get all active tokens with their types
  getAll: protectedProcedure.query(async () => {
    const tokens = await db
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
        typeId: schema.tokens.typeId,
        type: schema.tokenTypes.code,
        typeName: schema.tokenTypes.name,
        decimals: schema.tokens.decimals,
        iconUrl: schema.tokens.iconUrl,
        isActive: schema.tokens.isActive,
        createdAt: schema.tokens.createdAt,
        updatedAt: schema.tokens.updatedAt,
      })
      .from(schema.tokens)
      .leftJoin(
        schema.tokenTypes,
        eq(schema.tokens.typeId, schema.tokenTypes.id)
      )
      .where(eq(schema.tokens.isActive, true))
      .orderBy(schema.tokens.symbol);
    return tokens;
  }),

  // Get fiat currencies (tokens with type 'fiat')
  getCurrencies: protectedProcedure.query(async () => {
    const currencies = await db
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
        decimals: schema.tokens.decimals,
        iconUrl: schema.tokens.iconUrl,
      })
      .from(schema.tokens)
      .leftJoin(
        schema.tokenTypes,
        eq(schema.tokens.typeId, schema.tokenTypes.id)
      )
      .where(
        and(
          eq(schema.tokens.isActive, true),
          eq(schema.tokenTypes.code, "fiat")
        )
      )
      .orderBy(schema.tokens.symbol);
    return currencies;
  }),

  // Get tokens by type code
  getByTypeCode: protectedProcedure
    .input(z.object({ typeCode: z.string() }))
    .query(async ({ input }) => {
      const tokens = await db
        .select({
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          name: schema.tokens.name,
          typeId: schema.tokens.typeId,
          type: schema.tokenTypes.code,
          typeName: schema.tokenTypes.name,
          decimals: schema.tokens.decimals,
          iconUrl: schema.tokens.iconUrl,
          isActive: schema.tokens.isActive,
          createdAt: schema.tokens.createdAt,
          updatedAt: schema.tokens.updatedAt,
        })
        .from(schema.tokens)
        .leftJoin(
          schema.tokenTypes,
          eq(schema.tokens.typeId, schema.tokenTypes.id)
        )
        .where(
          and(
            eq(schema.tokenTypes.code, input.typeCode),
            eq(schema.tokens.isActive, true)
          )
        )
        .orderBy(schema.tokens.symbol);
      return tokens;
    }),

  // Get token by ID
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [token] = await db
        .select({
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          name: schema.tokens.name,
          typeId: schema.tokens.typeId,
          type: schema.tokenTypes.code,
          typeName: schema.tokenTypes.name,
          decimals: schema.tokens.decimals,
          iconUrl: schema.tokens.iconUrl,
          isActive: schema.tokens.isActive,
          createdAt: schema.tokens.createdAt,
          updatedAt: schema.tokens.updatedAt,
        })
        .from(schema.tokens)
        .leftJoin(
          schema.tokenTypes,
          eq(schema.tokens.typeId, schema.tokenTypes.id)
        )
        .where(eq(schema.tokens.id, input.id))
        .limit(1);

      if (!token) {
        throw new Error("Token not found");
      }
      return token;
    }),

  // Get token by symbol
  getBySymbol: protectedProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const [token] = await db
        .select({
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          name: schema.tokens.name,
          typeId: schema.tokens.typeId,
          type: schema.tokenTypes.code,
          typeName: schema.tokenTypes.name,
          decimals: schema.tokens.decimals,
          iconUrl: schema.tokens.iconUrl,
          isActive: schema.tokens.isActive,
          createdAt: schema.tokens.createdAt,
          updatedAt: schema.tokens.updatedAt,
        })
        .from(schema.tokens)
        .leftJoin(
          schema.tokenTypes,
          eq(schema.tokens.typeId, schema.tokenTypes.id)
        )
        .where(eq(schema.tokens.symbol, input.symbol.toUpperCase()))
        .limit(1);

      if (!token) {
        throw new Error("Token not found");
      }
      return token;
    }),

  // Validate token against appropriate provider (Finnhub or CoinGecko)
  validate: protectedProcedure
    .input(ValidateTokenSchema)
    .query(async ({ input }) => {
      const validationService = new TokenValidationService();
      const result = await validationService.validateToken(
        input.symbol,
        input.typeCode
      );

      if (!result.isValid) {
        throw new Error(result.error || "Token validation failed");
      }

      // Check if token already exists in our database with the same type
      let existingToken = null;
      if (result.metadata) {
        // Get the token type ID for the validated token
        const tokenTypeCode = mapProviderTypeToDbType(result.metadata.type);
        const [tokenType] = await db
          .select()
          .from(schema.tokenTypes)
          .where(eq(schema.tokenTypes.code, tokenTypeCode))
          .limit(1);

        if (tokenType) {
          [existingToken] = await db
            .select()
            .from(schema.tokens)
            .where(
              and(
                eq(schema.tokens.symbol, input.symbol),
                eq(schema.tokens.typeId, tokenType.id)
              )
            )
            .limit(1);
        }
      }

      return {
        ...result,
        existsInDatabase: !!existingToken,
        existingToken: existingToken
          ? {
              id: existingToken.id,
              symbol: existingToken.symbol,
              name: existingToken.name,
              isActive: existingToken.isActive,
            }
          : null,
      };
    }),

  // Get token type ID by code (helper for UI)
  getTokenTypeByCode: protectedProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ input }) => {
      const [tokenType] = await db
        .select()
        .from(schema.tokenTypes)
        .where(eq(schema.tokenTypes.code, input.code))
        .limit(1);

      if (!tokenType) {
        throw new Error(`Token type '${input.code}' not found`);
      }

      return tokenType;
    }),

  // Create new token with validation
  create: protectedProcedure
    .input(CreateTokenSchema)
    .mutation(async ({ input }) => {
      const symbol = input.symbol;

      // Determine token type first (if provided) to guide validation
      let tokenTypeCode: string | undefined;
      if (input.typeId) {
        const [tokenType] = await db
          .select()
          .from(schema.tokenTypes)
          .where(eq(schema.tokenTypes.id, input.typeId))
          .limit(1);

        if (!tokenType) {
          throw new Error("Invalid token type ID provided");
        }

        tokenTypeCode = tokenType.code;

        // Forbid creation of fiat tokens
        if (tokenTypeCode === "fiat") {
          throw new Error(
            "Creation of fiat tokens is not allowed. Fiat currencies are managed by system administrators."
          );
        }
      }

      // Validate token against appropriate provider
      const validationService = new TokenValidationService();
      const validation = await validationService.validateToken(
        symbol,
        tokenTypeCode
      );

      if (!validation.isValid || !validation.metadata) {
        throw new Error(validation.error || "Token validation failed");
      }

      // Determine final token type ID
      let typeId = input.typeId;
      if (!typeId) {
        // Map provider type to our token type
        const mappedTypeCode = mapProviderTypeToDbType(
          validation.metadata.type
        );

        // Forbid creation of fiat tokens (double check)
        if (mappedTypeCode === "fiat") {
          throw new Error(
            "Creation of fiat tokens is not allowed. Fiat currencies are managed by system administrators."
          );
        }

        const [tokenType] = await db
          .select()
          .from(schema.tokenTypes)
          .where(eq(schema.tokenTypes.code, mappedTypeCode))
          .limit(1);

        if (!tokenType) {
          throw new Error(
            `Token type '${mappedTypeCode}' not found in database`
          );
        }

        typeId = tokenType.id;
      }

      if (!typeId) {
        throw new Error(
          "Token type must be provided or determinable from validation"
        );
      }

      // Check unique constraint: (symbol, typeId) must be unique
      const [existingTokenWithType] = await db
        .select()
        .from(schema.tokens)
        .where(
          and(
            eq(schema.tokens.symbol, symbol),
            eq(schema.tokens.typeId, typeId)
          )
        )
        .limit(1);

      if (existingTokenWithType) {
        throw new Error(
          `Token ${symbol} with this type already exists in the database`
        );
      }

      // Use validated name if not provided
      const name = input.name || validation.metadata.name || symbol;

      // Create provider metadata based on the provider used
      const providerMetadata = JSON.stringify({
        provider: validation.metadata.provider,
        [validation.metadata.provider]: validation.metadata.providerMetadata,
        validatedAt: new Date().toISOString(),
      });

      const now = new Date();
      const tokenData = {
        symbol,
        name,
        typeId,
        decimals: input.decimals || 2,
        iconUrl: input.iconUrl || null,
        providerMetadata,
        isActive: input.isActive ?? true,
        createdAt: now,
        updatedAt: now,
      };

      const [createdToken] = await db
        .insert(schema.tokens)
        .values(tokenData)
        .returning();

      if (!createdToken) {
        throw new Error("Failed to create token");
      }

      return {
        ...createdToken,
        validation: validation.metadata,
      };
    }),

  // Update token
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateTokenSchema,
      })
    )
    .mutation(async ({ input }) => {
      // If updating symbol or typeId, check for uniqueness of (symbol, typeId) tuple
      if (input.data.symbol || input.data.typeId) {
        // Get current token to check what values we need to validate
        const [currentToken] = await db
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, input.id))
          .limit(1);

        if (!currentToken) {
          throw new Error("Token not found");
        }

        const newSymbol =
          input.data.symbol?.toUpperCase() || currentToken.symbol;
        const newTypeId = input.data.typeId || currentToken.typeId;

        const [existingToken] = await db
          .select()
          .from(schema.tokens)
          .where(
            and(
              eq(schema.tokens.symbol, newSymbol),
              eq(schema.tokens.typeId, newTypeId),
              // Exclude current token from uniqueness check
              sql`${schema.tokens.id} != ${input.id}`
            )
          )
          .limit(1);

        if (existingToken) {
          throw new Error(
            "Token with this symbol and type combination already exists"
          );
        }
      }

      const updateData = {
        ...input.data,
        ...(input.data.symbol && { symbol: input.data.symbol.toUpperCase() }),
        updatedAt: new Date(),
      };

      const [updatedToken] = await db
        .update(schema.tokens)
        .set(updateData)
        .where(eq(schema.tokens.id, input.id))
        .returning();

      if (!updatedToken) {
        throw new Error("Token not found");
      }

      return updatedToken;
    }),

  // Delete token (soft delete by setting isActive to false)
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const [deletedToken] = await db
        .update(schema.tokens)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.tokens.id, input.id))
        .returning();

      if (!deletedToken) {
        throw new Error("Token not found");
      }

      return { success: true, deleted: deletedToken };
    }),
});
