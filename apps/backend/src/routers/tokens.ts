import { manualPriceMinimum, privateTokenUpdateSchema } from "@scani/shared";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { getUserId } from "../middleware/auth";
import { pricingService } from "../services/pricing";
import { emitEntityChange } from "../services/real-time-updates";
import { tokenValidationService } from "../services/token-validation";
import { protectedProcedure, router } from "../trpc";
import { createComponentLogger } from "../utils/logger";

const tokensLogger = createComponentLogger("router:tokens");

// Local schemas for token operations (will be moved to shared later)
const CreateTokenSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(20)
    .transform((val) => val.toUpperCase()),
  name: z.string().min(1).max(100).optional(), // Optional - will be auto-filled from validation
  typeId: z.string().optional(), // For private tokens, use type code instead
  decimals: z.number().int().min(0).max(18).default(2),
  iconUrl: z.string().url().optional(),
  isActive: z.boolean().default(true),
  // For private tokens (private-company, other)
  manualPrice: z.number().min(manualPriceMinimum).optional(),
  priceDescription: z.string().optional(),
  description: z.string().optional(),
  // For external tokens - specify exact CoinGecko ID when user has selected a specific token
  coinGeckoId: z.string().min(1).max(100).optional(),
});

const ValidateTokenSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(20)
    .transform((val) => val.toUpperCase()),
  typeCode: z.string().optional(), // Optional token type to guide provider selection
});

const ValidateTokenByCoinGeckoIdSchema = z.object({
  coinGeckoId: z.string().min(1).max(100),
});

// Helper function to check if a token is private (editable)
function isPrivateToken(typeCode: string): boolean {
  return typeCode === "private-company" || typeCode === "other";
}

// Helper function to map provider token types to database token types
// Note: 'stock' type covers Stock/ETF/Equity/Commodity as per seed data
function mapProviderTypeToDbType(providerType: string): string {
  switch (providerType) {
    case "Equity":
    case "ETF":
    case "Mutual Fund":
    case "Bond":
    case "Commodity":
      // All equity-like instruments map to 'stock' type
      return "stock";
    case "Crypto":
    case "Cryptocurrency":
      return "crypto";
    default:
      return "stock"; // Default fallback for unknown types
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

  // Get tokens where the current user has holdings
  getByUserId: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    const tokens = await db
      .selectDistinct({
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
      .innerJoin(schema.holdings, eq(schema.tokens.id, schema.holdings.tokenId))
      .innerJoin(
        schema.accounts,
        and(
          eq(schema.holdings.accountId, schema.accounts.id),
          eq(schema.accounts.userId, userId),
          eq(schema.accounts.isActive, true)
        )
      )
      .where(eq(schema.tokens.isActive, true))
      .orderBy(schema.tokens.symbol);
    return tokens;
  }),

  // Get basic token info for lookups (lightweight)
  getBasicInfo: protectedProcedure.query(async () => {
    const tokens = await db
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
        type: schema.tokenTypes.code,
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
      const result = await tokenValidationService.validateToken(
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

  // Validate a specific token by CoinGecko ID (for user-selected tokens)
  validateByCoinGeckoId: protectedProcedure
    .input(ValidateTokenByCoinGeckoIdSchema)
    .query(async ({ input }) => {
      const result = await tokenValidationService.validateTokenByCoinGeckoId(
        input.coinGeckoId
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
                eq(schema.tokens.symbol, result.metadata.symbol),
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

  // Search tokens across database and external providers
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1).max(20),
        limit: z.number().int().min(1).max(50).default(10),
      })
    )
    .query(async ({ input }) => {
      const query = input.query.toUpperCase();

      // First, search in our database
      const dbTokens = await db
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
          source: sql<"database">`'database'`.as("source"),
        })
        .from(schema.tokens)
        .leftJoin(
          schema.tokenTypes,
          eq(schema.tokens.typeId, schema.tokenTypes.id)
        )
        .where(
          and(
            eq(schema.tokens.isActive, true),
            sql`(UPPER(${schema.tokens.symbol}) LIKE ${`%${query}%`} OR UPPER(${
              schema.tokens.name
            }) LIKE ${`%${query}%`})`
          )
        )
        .orderBy(schema.tokens.symbol)
        .limit(input.limit);

      const results: Array<{
        id?: string;
        symbol: string;
        name: string;
        typeId?: string;
        type?: string | null;
        typeName?: string | null;
        decimals?: number;
        iconUrl?: string | null;
        isActive?: boolean;
        source: "database" | "external";
        provider?: "finnhub" | "coingecko";
        metadata?: Record<string, unknown>;
      }> = [...dbTokens];

      // If we have fewer than the limit from database, search external providers
      if (dbTokens.length < input.limit) {
        try {
          // Search both Finnhub and CoinGecko concurrently
          const [finnhubResults, coinGeckoResults] = await Promise.all([
            tokenValidationService.searchFinnhubTokens(query),
            tokenValidationService.searchCoinGeckoTokens(query),
          ]);

          // Combine and prioritize results: crypto tokens first for exact symbol matches
          const allProviderResults = [
            ...coinGeckoResults.map((r) => ({
              ...r,
              priority:
                r.metadata?.symbol.toLowerCase() === query.toLowerCase()
                  ? 1
                  : 2,
            })),
            ...finnhubResults.map((r) => ({
              ...r,
              priority:
                r.metadata?.symbol.toLowerCase() === query.toLowerCase()
                  ? 1
                  : 3,
            })),
          ];

          // Sort by priority (lower number = higher priority)
          allProviderResults.sort((a, b) => a.priority - b.priority);

          // Process all provider results in priority order
          for (const providerResult of allProviderResults) {
            if (
              providerResult.isValid &&
              providerResult.metadata &&
              results.length < input.limit
            ) {
              // Check if this external token is already in our database or results
              const alreadyExistsInDb = dbTokens.some(
                (token) =>
                  token.symbol.toUpperCase() ===
                  providerResult.metadata!.symbol.toUpperCase()
              );

              const alreadyExistsInResults = results.some(
                (token) =>
                  token.symbol.toUpperCase() ===
                  providerResult.metadata!.symbol.toUpperCase()
              );

              if (!alreadyExistsInDb && !alreadyExistsInResults) {
                results.push({
                  symbol: providerResult.metadata.symbol,
                  name: providerResult.metadata.name,
                  type: mapProviderTypeToDbType(providerResult.metadata.type),
                  decimals: providerResult.metadata.type === "Crypto" ? 18 : 2,
                  source: "external" as const,
                  provider: providerResult.metadata.provider,
                  metadata: { ...providerResult.metadata },
                });
              }
            }
          }

          // If we still have space and no provider results, try the old validation method as fallback
          if (
            results.length < input.limit &&
            finnhubResults.length === 0 &&
            coinGeckoResults.length === 0
          ) {
            const fallbackResult = await tokenValidationService.validateToken(
              query
            );
            if (fallbackResult.isValid && fallbackResult.metadata) {
              const alreadyExists = results.some(
                (token) =>
                  token.symbol.toUpperCase() ===
                  fallbackResult.metadata!.symbol.toUpperCase()
              );

              if (!alreadyExists) {
                results.push({
                  symbol: fallbackResult.metadata.symbol,
                  name: fallbackResult.metadata.name,
                  type: mapProviderTypeToDbType(fallbackResult.metadata.type),
                  decimals: fallbackResult.metadata.type === "Crypto" ? 18 : 2,
                  source: "external" as const,
                  provider: fallbackResult.metadata.provider,
                  metadata: { ...fallbackResult.metadata },
                });
              }
            }
          }
        } catch (error) {
          // External provider search failed, but we still have database results
          tokensLogger.warn(
            {
              query,
              error:
                error instanceof Error
                  ? { name: error.name, message: error.message }
                  : error,
            },
            "External provider search failed"
          );
        }
      }

      return results.slice(0, input.limit);
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
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const symbol = input.symbol;

      // For private tokens, handle differently
      const isPrivateToken =
        input.typeId === "private-company" || input.typeId === "other";

      if (isPrivateToken) {
        // Private tokens require manual price
        if (!input.manualPrice) {
          throw new Error("Manual price is required for private tokens");
        }

        // Get token type ID from code
        const [tokenType] = await db
          .select()
          .from(schema.tokenTypes)
          .where(eq(schema.tokenTypes.code, input.typeId!))
          .limit(1);

        if (!tokenType) {
          throw new Error(`Token type '${input.typeId}' not found`);
        }

        // Check unique constraint for private tokens
        const [existingToken] = await db
          .select()
          .from(schema.tokens)
          .where(
            and(
              eq(schema.tokens.symbol, symbol),
              eq(schema.tokens.typeId, tokenType.id)
            )
          )
          .limit(1);

        if (existingToken) {
          throw new Error(`Private token ${symbol} already exists`);
        }

        // Create private token without external validation
        const now = new Date();
        const tokenData = {
          symbol,
          name: input.name || symbol,
          typeId: tokenType.id,
          decimals: input.decimals || 2,
          iconUrl: input.iconUrl || null,
          providerMetadata: JSON.stringify({
            provider: "manual",
            description: input.description || "",
            createdAt: now.toISOString(),
          }),
          isActive: input.isActive ?? true,
          createdAt: now,
          updatedAt: now,
        };

        const [createdToken] = await db
          .insert(schema.tokens)
          .values(tokenData)
          .returning();

        if (!createdToken) {
          throw new Error("Failed to create private token");
        }

        // Create manual price entry (use USD as base token for manual prices)
        const [usdToken] = await db
          .select()
          .from(schema.tokens)
          .leftJoin(
            schema.tokenTypes,
            eq(schema.tokens.typeId, schema.tokenTypes.id)
          )
          .where(
            and(
              eq(schema.tokens.symbol, "USD"),
              eq(schema.tokenTypes.code, "fiat")
            )
          )
          .limit(1);

        if (!usdToken) {
          throw new Error(
            "USD base token not found - required for manual pricing"
          );
        }

        const priceData = {
          tokenId: createdToken.id,
          baseTokenId: usdToken.tokens.id,
          price: input.manualPrice.toString(),
          timestamp: now,
          source: `manual - ${input.priceDescription || "Initial price"}`,
          createdAt: now,
        };

        await db.insert(schema.tokenPrices).values(priceData);

        const result = {
          id: createdToken.id,
          symbol: createdToken.symbol,
          name: createdToken.name,
          type: input.typeId,
          decimals: createdToken.decimals,
          manualPrice: input.manualPrice,
        };

        emitEntityChange({
          type: "entity_changed",
          entityType: "token",
          operationType: "create",
          entityId: createdToken.id,
          userId,
          data: {
            symbol: createdToken.symbol,
            typeId: tokenType.id,
            isPrivate: true,
          },
        });

        return result;
      }

      // Standard external validation for non-private tokens
      let tokenTypeCode: string | undefined;
      if (input.typeId) {
        const [tokenType] = await db
          .select()
          .from(schema.tokenTypes)
          .where(eq(schema.tokenTypes.code, input.typeId))
          .limit(1);

        if (!tokenType) {
          throw new Error("Invalid token type provided");
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
      // Use CoinGecko ID if provided (user selected specific token from search results)
      const validation = input.coinGeckoId
        ? await tokenValidationService.validateTokenByCoinGeckoId(
            input.coinGeckoId
          )
        : await tokenValidationService.validateToken(symbol, tokenTypeCode);

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

      emitEntityChange({
        type: "entity_changed",
        entityType: "token",
        operationType: "create",
        entityId: createdToken.id,
        userId,
        data: {
          symbol: createdToken.symbol,
          typeId,
          provider: validation.metadata.provider,
        },
      });

      return {
        ...createdToken,
        validation: validation.metadata,
      };
    }),

  // Create token from external provider metadata (for holding creation)
  createFromExternal: protectedProcedure
    .input(
      z.object({
        symbol: z
          .string()
          .min(1)
          .max(20)
          .transform((val) => val.toUpperCase()),
        metadata: z.record(z.unknown()),
        provider: z.enum(["finnhub", "coingecko"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const { symbol, metadata, provider } = input;

      // Validate the metadata has the required fields
      if (!metadata.name || typeof metadata.name !== "string") {
        throw new Error("External token metadata must include a name");
      }

      if (!metadata.type || typeof metadata.type !== "string") {
        throw new Error("External token metadata must include a type");
      }

      // Map provider type to our token type
      const mappedTypeCode = mapProviderTypeToDbType(metadata.type as string);

      // Get token type ID
      const [tokenType] = await db
        .select()
        .from(schema.tokenTypes)
        .where(eq(schema.tokenTypes.code, mappedTypeCode))
        .limit(1);

      if (!tokenType) {
        throw new Error(`Token type '${mappedTypeCode}' not found in database`);
      }

      // Check if token already exists with this symbol and type
      const [existingToken] = await db
        .select()
        .from(schema.tokens)
        .where(
          and(
            eq(schema.tokens.symbol, symbol),
            eq(schema.tokens.typeId, tokenType.id)
          )
        )
        .limit(1);

      if (existingToken) {
        // Return existing token instead of creating duplicate
        return existingToken;
      }

      // Create provider metadata
      // Extract the provider-specific data (like CoinGecko ID) from metadata
      let providerSpecificData = metadata;

      // If metadata has providerMetadata (from token search), extract it
      if (
        metadata.providerMetadata &&
        typeof metadata.providerMetadata === "object"
      ) {
        providerSpecificData = {
          ...metadata,
          ...(metadata.providerMetadata as Record<string, unknown>),
        };
      }

      const providerMetadata = JSON.stringify({
        provider,
        [provider]: providerSpecificData,
        validatedAt: new Date().toISOString(),
      });

      const now = new Date();
      const tokenData = {
        symbol,
        name: metadata.name as string,
        typeId: tokenType.id,
        decimals: 2, // Default for external tokens
        iconUrl: null,
        providerMetadata,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };

      const [createdToken] = await db
        .insert(schema.tokens)
        .values(tokenData)
        .returning();

      if (!createdToken) {
        throw new Error("Failed to create external token");
      }

      emitEntityChange({
        type: "entity_changed",
        entityType: "token",
        operationType: "create",
        entityId: createdToken.id,
        userId,
        data: {
          symbol: createdToken.symbol,
          typeId: tokenType.id,
          provider,
        },
      });

      return createdToken;
    }),

  // Update private token (only private-company and other types can be updated)
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        data: privateTokenUpdateSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      // Get current token to verify it's a private token
      const [currentTokenWithType] = await db
        .select({
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          typeId: schema.tokens.typeId,
          typeCode: schema.tokenTypes.code,
          providerMetadata: schema.tokens.providerMetadata,
        })
        .from(schema.tokens)
        .leftJoin(
          schema.tokenTypes,
          eq(schema.tokens.typeId, schema.tokenTypes.id)
        )
        .where(eq(schema.tokens.id, input.id))
        .limit(1);

      if (!currentTokenWithType) {
        throw new Error("Token not found");
      }

      // Only allow updating private tokens
      if (
        !currentTokenWithType.typeCode ||
        !isPrivateToken(currentTokenWithType.typeCode)
      ) {
        throw new Error("Only private company and other tokens can be updated");
      }

      // Update the token description if provided
      const now = new Date();
      let updatedToken: typeof schema.tokens.$inferSelect | undefined;

      if (input.data.description !== undefined) {
        // Update token description in providerMetadata
        const currentMetadata = JSON.parse(
          currentTokenWithType.providerMetadata || "{}"
        );
        const updatedMetadata = {
          ...currentMetadata,
          description: input.data.description,
          updatedAt: now.toISOString(),
        };

        [updatedToken] = await db
          .update(schema.tokens)
          .set({
            providerMetadata: JSON.stringify(updatedMetadata),
            updatedAt: now,
          })
          .where(eq(schema.tokens.id, input.id))
          .returning();
      }

      // Update manual price if provided
      if (input.data.manualPrice !== undefined) {
        // Get USD token as base currency
        const [usdToken] = await db
          .select()
          .from(schema.tokens)
          .leftJoin(
            schema.tokenTypes,
            eq(schema.tokens.typeId, schema.tokenTypes.id)
          )
          .where(
            and(
              eq(schema.tokens.symbol, "USD"),
              eq(schema.tokenTypes.code, "fiat")
            )
          )
          .limit(1);

        if (!usdToken) {
          throw new Error(
            "USD base token not found - required for manual pricing"
          );
        }

        // Insert new price entry
        await db.insert(schema.tokenPrices).values({
          tokenId: input.id,
          baseTokenId: usdToken.tokens.id,
          price: input.data.manualPrice.toString(),
          timestamp: now,
          source: `manual_update - ${
            input.data.priceDescription || "Price updated"
          }`,
          createdAt: now,
        });
      }

      // If we didn't update the token metadata, get the current token data
      if (!updatedToken) {
        [updatedToken] = await db
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, input.id))
          .limit(1);
      }

      if (!updatedToken) {
        throw new Error("Token not found after update");
      }

      emitEntityChange({
        type: "entity_changed",
        entityType: "token",
        operationType: "update",
        entityId: updatedToken.id,
        userId,
        data: {
          symbol: updatedToken.symbol,
          typeId: updatedToken.typeId,
        },
      });

      return {
        ...updatedToken,
        message: "Token updated successfully",
      };
    }),

  // Get tokens with their total values for the current user
  getWithTotalValues: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    // Get user's base currency
    const user = await db
      .select({
        baseCurrencyId: schema.users.baseCurrencyId,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user.length || !user[0]?.baseCurrencyId) {
      throw new Error("User or base currency not found");
    }

    const baseCurrency = await db
      .select({
        symbol: schema.tokens.symbol,
      })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, user[0].baseCurrencyId))
      .limit(1);

    if (!baseCurrency.length || !baseCurrency[0]?.symbol) {
      throw new Error("Base currency not found");
    }

    const baseCurrencySymbol = baseCurrency[0].symbol;

    // Get tokens with their holdings and calculate total values
    const tokensWithHoldings = await db
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
        holdingBalance: schema.holdings.balance,
        accountId: schema.holdings.accountId,
      })
      .from(schema.tokens)
      .leftJoin(
        schema.tokenTypes,
        eq(schema.tokens.typeId, schema.tokenTypes.id)
      )
      .innerJoin(schema.holdings, eq(schema.tokens.id, schema.holdings.tokenId))
      .innerJoin(
        schema.accounts,
        and(
          eq(schema.holdings.accountId, schema.accounts.id),
          eq(schema.accounts.userId, userId),
          eq(schema.accounts.isActive, true)
        )
      )
      .where(eq(schema.tokens.isActive, true))
      .orderBy(schema.tokens.symbol);

    // Group holdings by token and calculate total values
    const tokenSummaries = new Map<
      string,
      {
        token: {
          id: string;
          symbol: string;
          name: string | null;
          typeId: string | null;
          type: string | null;
          typeName: string | null;
          decimals: number;
          iconUrl: string | null;
          isActive: boolean;
          createdAt: Date;
          updatedAt: Date;
        };
        totalBalance: Decimal;
        totalValue: Decimal;
      }
    >();

    // First, group holdings by token without pricing
    for (const row of tokensWithHoldings) {
      const tokenId = row.id;

      if (!tokenSummaries.has(tokenId)) {
        tokenSummaries.set(tokenId, {
          token: {
            id: row.id,
            symbol: row.symbol,
            name: row.name,
            typeId: row.typeId,
            type: row.type,
            typeName: row.typeName,
            decimals: row.decimals,
            iconUrl: row.iconUrl,
            isActive: row.isActive,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
          totalBalance: new Decimal(0),
          totalValue: new Decimal(0),
        });
      }

      const summary = tokenSummaries.get(tokenId)!;
      const balance = new Decimal(row.holdingBalance || "0");
      summary.totalBalance = summary.totalBalance.add(balance);
    }

    // Batch fetch prices for all unique tokens that need conversion
    // Use singleton pricing service
    const uniqueTokens = Array.from(tokenSummaries.keys());
    const uniqueSymbols = Array.from(
      new Set(
        uniqueTokens.map((tokenId) => {
          const summary = tokenSummaries.get(tokenId)!;
          return summary.token.symbol;
        })
      )
    );

    const tokensToPrice = uniqueSymbols.filter(
      (symbol) => symbol !== baseCurrencySymbol
    );

    // Get full token objects for pricing service
    const tokens =
      tokensToPrice.length > 0
        ? await db
            .select()
            .from(schema.tokens)
            .where(inArray(schema.tokens.symbol, tokensToPrice))
        : [];

    let prices = new Map<string, string>();
    if (tokens.length > 0) {
      const now = new Date();
      prices = await pricingService.getTokenPrices(
        tokens,
        baseCurrencySymbol,
        now
      );
    }

    // Now calculate values using the batch-fetched prices
    for (const row of tokensWithHoldings) {
      const tokenId = row.id;
      const summary = tokenSummaries.get(tokenId)!;
      const balance = new Decimal(row.holdingBalance || "0");

      // Convert to base currency value
      let convertedValue: Decimal;
      if (row.symbol === baseCurrencySymbol) {
        // Same currency, no conversion needed
        convertedValue = balance;
      } else {
        // Use batch-fetched price - find token ID first
        const token = tokens.find((t) => t.symbol === row.symbol);
        const price = token ? prices.get(token.id) || "0" : "0";
        convertedValue = balance.mul(new Decimal(price));
      }
      summary.totalValue = summary.totalValue.add(convertedValue);
    }

    // Convert to array and format for response
    const tokensWithValues = Array.from(tokenSummaries.values()).map(
      ({ token, totalBalance, totalValue }) => ({
        ...token,
        totalBalance: totalBalance.toString(),
        totalValueInBaseCurrency: totalValue.toString(),
        baseCurrencySymbol,
      })
    );

    return tokensWithValues;
  }),
});
