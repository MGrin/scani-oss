import Decimal from 'decimal.js';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId } from '../middleware/auth';
import { PricingService } from '../services/pricing';
import { TokenValidationService } from '../services/token-validation';
import { protectedProcedure, router } from '../trpc';

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
  manualPrice: z.number().min(0.000001).optional(),
  priceDescription: z.string().optional(),
  description: z.string().optional(),
});

const ValidateTokenSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(20)
    .transform((val) => val.toUpperCase()),
  typeCode: z.string().optional(), // Optional token type to guide provider selection
});

// Schema for updating private tokens (only allows updating price-related and description fields)
const UpdatePrivateTokenSchema = z.object({
  description: z.string().optional(),
  manualPrice: z.number().min(0.000001).optional(),
  priceDescription: z.string().optional(),
});

// Helper function to check if a token is private (editable)
function isPrivateToken(typeCode: string): boolean {
  return typeCode === 'private-company' || typeCode === 'other';
}

// Helper function to map provider token types to database token types
function mapProviderTypeToDbType(providerType: string): string {
  switch (providerType) {
    case 'Equity':
      return 'stock';
    case 'ETF':
      return 'etf';
    case 'Mutual Fund':
      return 'mutual-fund';
    case 'Bond':
      return 'bond';
    case 'Commodity':
      return 'commodity';
    case 'Crypto':
      return 'crypto';
    default:
      return 'stock'; // Default fallback
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
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
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
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
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
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(and(eq(schema.tokens.isActive, true), eq(schema.tokenTypes.code, 'fiat')))
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
        .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .where(and(eq(schema.tokenTypes.code, input.typeCode), eq(schema.tokens.isActive, true)))
        .orderBy(schema.tokens.symbol);
      return tokens;
    }),

  // Get token by ID
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
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
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(eq(schema.tokens.id, input.id))
      .limit(1);

    if (!token) {
      throw new Error('Token not found');
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
        .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .where(eq(schema.tokens.symbol, input.symbol.toUpperCase()))
        .limit(1);

      if (!token) {
        throw new Error('Token not found');
      }
      return token;
    }),

  // Validate token against appropriate provider (Finnhub or CoinGecko)
  validate: protectedProcedure.input(ValidateTokenSchema).query(async ({ input }) => {
    const validationService = new TokenValidationService();
    const result = await validationService.validateToken(input.symbol, input.typeCode);

    if (!result.isValid) {
      throw new Error(result.error || 'Token validation failed');
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
            and(eq(schema.tokens.symbol, input.symbol), eq(schema.tokens.typeId, tokenType.id))
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
          source: sql<'database'>`'database'`.as('source'),
        })
        .from(schema.tokens)
        .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
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
        source: 'database' | 'external';
        provider?: 'finnhub' | 'coingecko';
        metadata?: Record<string, unknown>;
      }> = [...dbTokens];

      // If we have fewer than the limit from database, search external providers
      if (dbTokens.length < input.limit) {
        try {
          const validationService = new TokenValidationService();

          // Search Finnhub for multiple matching tokens
          const finnhubResults = await validationService.searchFinnhubTokens(query);

          for (const providerResult of finnhubResults) {
            if (providerResult.isValid && providerResult.metadata) {
              // Check if this external token is already in our database results
              const alreadyExists = dbTokens.some(
                (token) =>
                  token.symbol.toUpperCase() === providerResult.metadata!.symbol.toUpperCase()
              );

              if (!alreadyExists && results.length < input.limit) {
                results.push({
                  symbol: providerResult.metadata.symbol,
                  name: providerResult.metadata.name,
                  type: mapProviderTypeToDbType(providerResult.metadata.type),
                  decimals: 2, // Default for external tokens
                  source: 'external' as const,
                  provider: providerResult.metadata.provider,
                  metadata: { ...providerResult.metadata },
                });
              }
            }
          }

          // If we still have space and no Finnhub results, try the old validation method as fallback
          if (results.length < input.limit && finnhubResults.length === 0) {
            const fallbackResult = await validationService.validateToken(query);
            if (fallbackResult.isValid && fallbackResult.metadata) {
              const alreadyExists = results.some(
                (token) =>
                  token.symbol.toUpperCase() === fallbackResult.metadata!.symbol.toUpperCase()
              );

              if (!alreadyExists) {
                results.push({
                  symbol: fallbackResult.metadata.symbol,
                  name: fallbackResult.metadata.name,
                  type: mapProviderTypeToDbType(fallbackResult.metadata.type),
                  decimals: 2, // Default for external tokens
                  source: 'external' as const,
                  provider: fallbackResult.metadata.provider,
                  metadata: { ...fallbackResult.metadata },
                });
              }
            }
          }
        } catch (error) {
          // External provider search failed, but we still have database results
          console.warn('External provider search failed:', error);
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
  create: protectedProcedure.input(CreateTokenSchema).mutation(async ({ input }) => {
    const symbol = input.symbol;

    // For private tokens, handle differently
    const isPrivateToken = input.typeId === 'private-company' || input.typeId === 'other';

    if (isPrivateToken) {
      // Private tokens require manual price
      if (!input.manualPrice) {
        throw new Error('Manual price is required for private tokens');
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
        .where(and(eq(schema.tokens.symbol, symbol), eq(schema.tokens.typeId, tokenType.id)))
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
          provider: 'manual',
          description: input.description || '',
          createdAt: now.toISOString(),
        }),
        isActive: input.isActive ?? true,
        createdAt: now,
        updatedAt: now,
      };

      const [createdToken] = await db.insert(schema.tokens).values(tokenData).returning();

      if (!createdToken) {
        throw new Error('Failed to create private token');
      }

      // Create manual price entry (use USD as base token for manual prices)
      const [usdToken] = await db
        .select()
        .from(schema.tokens)
        .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokenTypes.code, 'fiat')))
        .limit(1);

      if (!usdToken) {
        throw new Error('USD base token not found - required for manual pricing');
      }

      const priceData = {
        tokenId: createdToken.id,
        baseTokenId: usdToken.tokens.id,
        price: input.manualPrice.toString(),
        timestamp: now,
        source: `manual - ${input.priceDescription || 'Initial price'}`,
        createdAt: now,
      };

      await db.insert(schema.tokenPrices).values(priceData);

      return {
        id: createdToken.id,
        symbol: createdToken.symbol,
        name: createdToken.name,
        type: input.typeId,
        decimals: createdToken.decimals,
        manualPrice: input.manualPrice,
      };
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
        throw new Error('Invalid token type provided');
      }

      tokenTypeCode = tokenType.code;

      // Forbid creation of fiat tokens
      if (tokenTypeCode === 'fiat') {
        throw new Error(
          'Creation of fiat tokens is not allowed. Fiat currencies are managed by system administrators.'
        );
      }
    }

    // Validate token against appropriate provider
    const validationService = new TokenValidationService();
    const validation = await validationService.validateToken(symbol, tokenTypeCode);

    if (!validation.isValid || !validation.metadata) {
      throw new Error(validation.error || 'Token validation failed');
    }

    // Determine final token type ID
    let typeId = input.typeId;
    if (!typeId) {
      // Map provider type to our token type
      const mappedTypeCode = mapProviderTypeToDbType(validation.metadata.type);

      // Forbid creation of fiat tokens (double check)
      if (mappedTypeCode === 'fiat') {
        throw new Error(
          'Creation of fiat tokens is not allowed. Fiat currencies are managed by system administrators.'
        );
      }

      const [tokenType] = await db
        .select()
        .from(schema.tokenTypes)
        .where(eq(schema.tokenTypes.code, mappedTypeCode))
        .limit(1);

      if (!tokenType) {
        throw new Error(`Token type '${mappedTypeCode}' not found in database`);
      }

      typeId = tokenType.id;
    }

    if (!typeId) {
      throw new Error('Token type must be provided or determinable from validation');
    }

    // Check unique constraint: (symbol, typeId) must be unique
    const [existingTokenWithType] = await db
      .select()
      .from(schema.tokens)
      .where(and(eq(schema.tokens.symbol, symbol), eq(schema.tokens.typeId, typeId)))
      .limit(1);

    if (existingTokenWithType) {
      throw new Error(`Token ${symbol} with this type already exists in the database`);
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

    const [createdToken] = await db.insert(schema.tokens).values(tokenData).returning();

    if (!createdToken) {
      throw new Error('Failed to create token');
    }

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
        provider: z.enum(['finnhub', 'coingecko']),
      })
    )
    .mutation(async ({ input }) => {
      const { symbol, metadata, provider } = input;

      // Validate the metadata has the required fields
      if (!metadata.name || typeof metadata.name !== 'string') {
        throw new Error('External token metadata must include a name');
      }

      if (!metadata.type || typeof metadata.type !== 'string') {
        throw new Error('External token metadata must include a type');
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
        .where(and(eq(schema.tokens.symbol, symbol), eq(schema.tokens.typeId, tokenType.id)))
        .limit(1);

      if (existingToken) {
        // Return existing token instead of creating duplicate
        return existingToken;
      }

      // Create provider metadata
      const providerMetadata = JSON.stringify({
        provider,
        [provider]: metadata,
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

      const [createdToken] = await db.insert(schema.tokens).values(tokenData).returning();

      if (!createdToken) {
        throw new Error('Failed to create external token');
      }

      return createdToken;
    }),

  // Update private token (only private-company and other types can be updated)
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdatePrivateTokenSchema,
      })
    )
    .mutation(async ({ input }) => {
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
        .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .where(eq(schema.tokens.id, input.id))
        .limit(1);

      if (!currentTokenWithType) {
        throw new Error('Token not found');
      }

      // Only allow updating private tokens
      if (!currentTokenWithType.typeCode || !isPrivateToken(currentTokenWithType.typeCode)) {
        throw new Error('Only private company and other tokens can be updated');
      }

      // Update the token description if provided
      const now = new Date();
      let updatedToken: typeof schema.tokens.$inferSelect | undefined;

      if (input.data.description !== undefined) {
        // Update token description in providerMetadata
        const currentMetadata = JSON.parse(currentTokenWithType.providerMetadata || '{}');
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
          .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
          .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokenTypes.code, 'fiat')))
          .limit(1);

        if (!usdToken) {
          throw new Error('USD base token not found - required for manual pricing');
        }

        // Insert new price entry
        await db.insert(schema.tokenPrices).values({
          tokenId: input.id,
          baseTokenId: usdToken.tokens.id,
          price: input.data.manualPrice.toString(),
          timestamp: now,
          source: `manual_update - ${input.data.priceDescription || 'Price updated'}`,
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
        throw new Error('Token not found after update');
      }

      return {
        ...updatedToken,
        message: 'Token updated successfully',
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
      throw new Error('User or base currency not found');
    }

    const baseCurrency = await db
      .select({
        symbol: schema.tokens.symbol,
      })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, user[0].baseCurrencyId))
      .limit(1);

    if (!baseCurrency.length || !baseCurrency[0]?.symbol) {
      throw new Error('Base currency not found');
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
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
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

    const pricingService = new PricingService();

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
      const balance = new Decimal(row.holdingBalance || '0');
      summary.totalBalance = summary.totalBalance.add(balance);

      // Convert to base currency value
      try {
        let convertedValue: Decimal;
        if (row.symbol === baseCurrencySymbol) {
          // Same currency, no conversion needed
          convertedValue = balance;
        } else {
          // Get current price in base currency
          const price = await pricingService.getTokenPrice({
            tokenSymbol: row.symbol,
            baseCurrency: baseCurrencySymbol,
            timestamp: new Date(),
            live: true,
          });
          convertedValue = balance.mul(new Decimal(price));
        }
        summary.totalValue = summary.totalValue.add(convertedValue);
      } catch (error) {
        console.warn(`Failed to convert ${row.symbol} to base currency:`, error);
        // Skip this holding if price conversion fails
      }
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
