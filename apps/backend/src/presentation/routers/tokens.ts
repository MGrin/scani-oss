import { manualPriceMinimum, privateTokenUpdateSchema } from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import type { PricingService } from '../../application/services/PricingService';
import type { TokenValidationService } from '../../application/services/TokenValidationService';
import { CreateTokenUseCase } from '../../application/use-cases/CreateTokenUseCase';
import { UpdateTokenUseCase } from '../../application/use-cases/UpdateTokenUseCase';
import { ValidateTokenUseCase } from '../../application/use-cases/ValidateTokenUseCase';
import type { DbType } from '../../infrastructure/database/connection';
import type * as schema from '../../infrastructure/database/schema';
import type { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import type { TokenTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import type { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import type { TokenPriceRepository } from '../../infrastructure/repositories/TokenPriceRepository';
import type { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import type { UserRepository } from '../../infrastructure/repositories/UserRepository';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { getUserId } from '../../middleware/auth';
import { createComponentLogger } from '../../utils/logger';
import { protectedProcedure, router } from '../trpc';

const tokensLogger = createComponentLogger('router:tokens');

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

// Helper function to map provider token types to database token types
// Note: 'stock' type covers Stock/ETF/Equity/Commodity as per seed data
function mapProviderTypeToDbType(providerType: string): string {
  switch (providerType) {
    case 'Equity':
    case 'ETF':
    case 'Mutual Fund':
    case 'Bond':
    case 'Commodity':
      // All equity-like instruments map to 'stock' type
      return 'stock';
    case 'Crypto':
    case 'Cryptocurrency':
      return 'crypto';
    default:
      return 'stock'; // Default fallback for unknown types
  }
}

/**
 * Factory function to create the tokens router with injected dependencies
 */
export function createTokensRouter(
  db: DbType,
  schemaObj: typeof schema,
  _tokenRepository: TokenRepository,
  _tokenTypeRepository: TokenTypeRepository,
  _tokenPriceRepository: TokenPriceRepository,
  _userRepository: UserRepository,
  _accountRepository: AccountRepository,
  _holdingRepository: HoldingRepository,
  pricingService: PricingService,
  tokenValidationService: TokenValidationService
) {
  return router({
    // Get all active tokens with their types
    getAll: protectedProcedure.query(async () => {
      const tokens = await db
        .select({
          id: schemaObj.tokens.id,
          symbol: schemaObj.tokens.symbol,
          name: schemaObj.tokens.name,
          typeId: schemaObj.tokens.typeId,
          type: schemaObj.tokenTypes.code,
          typeName: schemaObj.tokenTypes.name,
          decimals: schemaObj.tokens.decimals,
          iconUrl: schemaObj.tokens.iconUrl,
          isActive: schemaObj.tokens.isActive,
          createdAt: schemaObj.tokens.createdAt,
          updatedAt: schemaObj.tokens.updatedAt,
        })
        .from(schemaObj.tokens)
        .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
        .where(eq(schemaObj.tokens.isActive, true))
        .orderBy(schemaObj.tokens.symbol);
      return tokens;
    }),

    // Get tokens where the current user has holdings
    getByUserId: protectedProcedure.query(async ({ ctx }) => {
      const userId = getUserId(ctx);

      const tokens = await db
        .selectDistinct({
          id: schemaObj.tokens.id,
          symbol: schemaObj.tokens.symbol,
          name: schemaObj.tokens.name,
          typeId: schemaObj.tokens.typeId,
          type: schemaObj.tokenTypes.code,
          typeName: schemaObj.tokenTypes.name,
          decimals: schemaObj.tokens.decimals,
          iconUrl: schemaObj.tokens.iconUrl,
          isActive: schemaObj.tokens.isActive,
          createdAt: schemaObj.tokens.createdAt,
          updatedAt: schemaObj.tokens.updatedAt,
        })
        .from(schemaObj.tokens)
        .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
        .innerJoin(schemaObj.holdings, eq(schemaObj.tokens.id, schemaObj.holdings.tokenId))
        .innerJoin(
          schemaObj.accounts,
          and(
            eq(schemaObj.holdings.accountId, schemaObj.accounts.id),
            eq(schemaObj.accounts.userId, userId),
            eq(schemaObj.accounts.isActive, true)
          )
        )
        .where(eq(schemaObj.tokens.isActive, true))
        .orderBy(schemaObj.tokens.symbol);
      return tokens;
    }),

    // Get basic token info for lookups (lightweight)
    getBasicInfo: protectedProcedure.query(async () => {
      const tokens = await db
        .select({
          id: schemaObj.tokens.id,
          symbol: schemaObj.tokens.symbol,
          name: schemaObj.tokens.name,
          type: schemaObj.tokenTypes.code,
        })
        .from(schemaObj.tokens)
        .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
        .where(eq(schemaObj.tokens.isActive, true))
        .orderBy(schemaObj.tokens.symbol);
      return tokens;
    }),

    // Get fiat currencies (tokens with type 'fiat')
    getCurrencies: protectedProcedure.query(async () => {
      const currencies = await db
        .select({
          id: schemaObj.tokens.id,
          symbol: schemaObj.tokens.symbol,
          name: schemaObj.tokens.name,
          decimals: schemaObj.tokens.decimals,
          iconUrl: schemaObj.tokens.iconUrl,
        })
        .from(schemaObj.tokens)
        .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
        .where(and(eq(schemaObj.tokens.isActive, true), eq(schemaObj.tokenTypes.code, 'fiat')))
        .orderBy(schemaObj.tokens.symbol);
      return currencies;
    }),

    // Get tokens by type code
    getByTypeCode: protectedProcedure
      .input(z.object({ typeCode: z.string() }))
      .query(async ({ input }) => {
        const tokens = await db
          .select({
            id: schemaObj.tokens.id,
            symbol: schemaObj.tokens.symbol,
            name: schemaObj.tokens.name,
            typeId: schemaObj.tokens.typeId,
            type: schemaObj.tokenTypes.code,
            typeName: schemaObj.tokenTypes.name,
            decimals: schemaObj.tokens.decimals,
            iconUrl: schemaObj.tokens.iconUrl,
            isActive: schemaObj.tokens.isActive,
            createdAt: schemaObj.tokens.createdAt,
            updatedAt: schemaObj.tokens.updatedAt,
          })
          .from(schemaObj.tokens)
          .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
          .where(
            and(eq(schemaObj.tokenTypes.code, input.typeCode), eq(schemaObj.tokens.isActive, true))
          )
          .orderBy(schemaObj.tokens.symbol);
        return tokens;
      }),

    // Get token by ID
    getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
      const [token] = await db
        .select({
          id: schemaObj.tokens.id,
          symbol: schemaObj.tokens.symbol,
          name: schemaObj.tokens.name,
          typeId: schemaObj.tokens.typeId,
          type: schemaObj.tokenTypes.code,
          typeName: schemaObj.tokenTypes.name,
          decimals: schemaObj.tokens.decimals,
          iconUrl: schemaObj.tokens.iconUrl,
          isActive: schemaObj.tokens.isActive,
          createdAt: schemaObj.tokens.createdAt,
          updatedAt: schemaObj.tokens.updatedAt,
        })
        .from(schemaObj.tokens)
        .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
        .where(eq(schemaObj.tokens.id, input.id))
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
            id: schemaObj.tokens.id,
            symbol: schemaObj.tokens.symbol,
            name: schemaObj.tokens.name,
            typeId: schemaObj.tokens.typeId,
            type: schemaObj.tokenTypes.code,
            typeName: schemaObj.tokenTypes.name,
            decimals: schemaObj.tokens.decimals,
            iconUrl: schemaObj.tokens.iconUrl,
            isActive: schemaObj.tokens.isActive,
            createdAt: schemaObj.tokens.createdAt,
            updatedAt: schemaObj.tokens.updatedAt,
          })
          .from(schemaObj.tokens)
          .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
          .where(eq(schemaObj.tokens.symbol, input.symbol.toUpperCase()))
          .limit(1);

        if (!token) {
          throw new Error('Token not found');
        }
        return token;
      }),

    // Validate token against appropriate provider (Finnhub or CoinGecko)
    validate: protectedProcedure.input(ValidateTokenSchema).query(async ({ input }) => {
      const validateUseCase = Container.get(ValidateTokenUseCase);
      const result = await validateUseCase.execute({
        symbol: input.symbol,
        typeCode: input.typeCode,
      });

      if (!result.isValid) {
        throw new Error(result.error || 'Token validation failed');
      }

      return result;
    }),

    // Validate a specific token by CoinGecko ID (for user-selected tokens)
    validateByCoinGeckoId: protectedProcedure
      .input(ValidateTokenByCoinGeckoIdSchema)
      .query(async ({ input }) => {
        const validateUseCase = Container.get(ValidateTokenUseCase);
        const result = await validateUseCase.execute({
          symbol: '', // Will be ignored when coinGeckoId is provided
          coinGeckoId: input.coinGeckoId,
        });

        if (!result.isValid) {
          throw new Error(result.error || 'Token validation failed');
        }

        return result;
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
            id: schemaObj.tokens.id,
            symbol: schemaObj.tokens.symbol,
            name: schemaObj.tokens.name,
            typeId: schemaObj.tokens.typeId,
            type: schemaObj.tokenTypes.code,
            typeName: schemaObj.tokenTypes.name,
            decimals: schemaObj.tokens.decimals,
            iconUrl: schemaObj.tokens.iconUrl,
            isActive: schemaObj.tokens.isActive,
            source: sql<'database'>`'database'`.as('source'),
          })
          .from(schemaObj.tokens)
          .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
          .where(
            and(
              eq(schemaObj.tokens.isActive, true),
              sql`(UPPER(${schemaObj.tokens.symbol}) LIKE ${`%${query}%`} OR UPPER(${
                schemaObj.tokens.name
              }) LIKE ${`%${query}%`})`
            )
          )
          .orderBy(schemaObj.tokens.symbol)
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
            // Search both Finnhub and CoinGecko concurrently
            const [finnhubResults, coinGeckoResults] = await Promise.all([
              tokenValidationService.searchFinnhubTokens(query),
              tokenValidationService.searchCoinGeckoTokens(query),
            ]);

            // Combine and prioritize results: crypto tokens first for exact symbol matches
            const allProviderResults = [
              ...coinGeckoResults.map((r) => ({
                ...r,
                priority: r.metadata?.symbol.toLowerCase() === query.toLowerCase() ? 1 : 2,
              })),
              ...finnhubResults.map((r) => ({
                ...r,
                priority: r.metadata?.symbol.toLowerCase() === query.toLowerCase() ? 1 : 3,
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
                    token.symbol.toUpperCase() === providerResult.metadata!.symbol.toUpperCase()
                );

                const alreadyExistsInResults = results.some(
                  (token) =>
                    token.symbol.toUpperCase() === providerResult.metadata!.symbol.toUpperCase()
                );

                if (!alreadyExistsInDb && !alreadyExistsInResults) {
                  results.push({
                    symbol: providerResult.metadata.symbol,
                    name: providerResult.metadata.name,
                    type: mapProviderTypeToDbType(providerResult.metadata.type),
                    decimals: providerResult.metadata.type === 'Crypto' ? 18 : 2,
                    source: 'external' as const,
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
              const fallbackResult = await tokenValidationService.validateToken(query);
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
                    decimals: fallbackResult.metadata.type === 'Crypto' ? 18 : 2,
                    source: 'external' as const,
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
                  error instanceof Error ? { name: error.name, message: error.message } : error,
              },
              'External provider search failed'
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
          .from(schemaObj.tokenTypes)
          .where(eq(schemaObj.tokenTypes.code, input.code))
          .limit(1);

        if (!tokenType) {
          throw new Error(`Token type '${input.code}' not found`);
        }

        return tokenType;
      }),

    // Create new token with validation
    create: protectedProcedure.input(CreateTokenSchema).mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);

      // Use CreateTokenUseCase for business logic
      const createTokenUseCase = Container.get(CreateTokenUseCase);
      const result = await createTokenUseCase.execute({
        symbol: input.symbol,
        name: input.name,
        typeId: input.typeId,
        decimals: input.decimals,
        iconUrl: input.iconUrl,
        isActive: input.isActive,
        manualPrice: input.manualPrice,
        priceDescription: input.priceDescription,
        description: input.description,
        coinGeckoId: input.coinGeckoId,
      });

      // Emit real-time update
      emitEntityChange({
        type: 'entity_changed',
        entityType: 'token',
        operationType: 'create',
        entityId: result.token.id,
        userId,
        data: {
          symbol: result.token.symbol,
          typeId: result.token.typeId,
          isPrivate: result.isPrivate,
          provider: result.provider,
        },
      });

      return result.token;
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
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
        const { symbol, metadata, provider } = input;

        tokensLogger.info(
          {
            symbol,
            provider,
            metadata,
          },
          'Creating token from external provider'
        );

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
          .from(schemaObj.tokenTypes)
          .where(eq(schemaObj.tokenTypes.code, mappedTypeCode))
          .limit(1);

        if (!tokenType) {
          throw new Error(`Token type '${mappedTypeCode}' not found in database`);
        }

        // Check if token already exists with this symbol and type
        const [existingToken] = await db
          .select()
          .from(schemaObj.tokens)
          .where(
            and(eq(schemaObj.tokens.symbol, symbol), eq(schemaObj.tokens.typeId, tokenType.id))
          )
          .limit(1);

        if (existingToken) {
          tokensLogger.info(
            { tokenId: existingToken.id, symbol, typeCode: mappedTypeCode },
            'Token already exists, returning existing token'
          );
          // Return existing token instead of creating duplicate
          return existingToken;
        }

        // CRITICAL FIX: Create proper provider metadata structure for pricing service
        // The pricing service expects nested provider-specific data with proper identifiers
        let providerSpecificData: Record<string, unknown> = {};

        if (provider === 'coingecko') {
          // CoinGecko needs the 'id' field for pricing lookups
          const coinGeckoId =
            (metadata.providerMetadata as Record<string, unknown>)?.id ||
            (metadata as Record<string, unknown>).coinGeckoId ||
            (metadata as Record<string, unknown>).id;

          if (coinGeckoId && typeof coinGeckoId === 'string') {
            providerSpecificData = {
              id: coinGeckoId,
              symbol: symbol,
              name: metadata.name,
            };
            tokensLogger.info(
              { symbol, coinGeckoId },
              'Structured CoinGecko metadata with ID for pricing'
            );
          } else {
            // Fallback: use symbol as lowercase ID (CoinGecko convention)
            providerSpecificData = {
              id: symbol.toLowerCase(),
              symbol: symbol,
              name: metadata.name,
            };
            tokensLogger.warn(
              { symbol },
              'CoinGecko ID not found in metadata, using lowercase symbol as fallback'
            );
          }
        } else if (provider === 'finnhub') {
          // Finnhub needs the 'symbol' field for pricing lookups
          const finnhubSymbol =
            (metadata.providerMetadata as Record<string, unknown>)?.symbol ||
            (metadata as Record<string, unknown>).finnhubSymbol ||
            symbol;

          providerSpecificData = {
            symbol: finnhubSymbol,
            name: metadata.name,
            type: metadata.type,
          };
          tokensLogger.info({ symbol, finnhubSymbol }, 'Structured Finnhub metadata for pricing');
        }

        // Create the complete provider metadata structure
        // This structure is what the pricing service expects to read
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
          decimals: mappedTypeCode === 'crypto' ? 18 : 2, // Crypto tokens typically use 18 decimals
          iconUrl: null,
          providerMetadata,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        };

        tokensLogger.debug(
          {
            symbol,
            typeCode: mappedTypeCode,
            providerMetadata,
          },
          'Creating token with structured metadata'
        );

        const [createdToken] = await db.insert(schemaObj.tokens).values(tokenData).returning();

        if (!createdToken) {
          tokensLogger.error({ symbol, provider, typeId: tokenType.id }, 'Database insert failed');
          throw new Error('Failed to create external token - database insert returned no data');
        }

        if (!createdToken.id) {
          tokensLogger.error(
            { symbol, provider, createdToken },
            'Token created but has no ID - critical database error'
          );
          throw new Error('Failed to create external token - no ID assigned by database');
        }

        tokensLogger.info(
          {
            tokenId: createdToken.id,
            symbol: createdToken.symbol,
            name: createdToken.name,
            provider,
            typeId: tokenType.id,
          },
          'External token created successfully with valid ID'
        );

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'token',
          operationType: 'create',
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

        // Use UpdateTokenUseCase for business logic
        const updateTokenUseCase = Container.get(UpdateTokenUseCase);
        const updatedToken = await updateTokenUseCase.execute({
          id: input.id,
          description: input.data.description,
          manualPrice: input.data.manualPrice,
          priceDescription: input.data.priceDescription,
        });

        // Emit real-time update
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'token',
          operationType: 'update',
          entityId: updatedToken.id,
          userId,
          data: {
            symbol: updatedToken.symbol,
            typeId: updatedToken.typeId,
          },
        });

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
          baseCurrencyId: schemaObj.users.baseCurrencyId,
        })
        .from(schemaObj.users)
        .where(eq(schemaObj.users.id, userId))
        .limit(1);

      if (!user.length || !user[0]?.baseCurrencyId) {
        throw new Error('User or base currency not found');
      }

      const baseCurrency = await db
        .select({
          symbol: schemaObj.tokens.symbol,
        })
        .from(schemaObj.tokens)
        .where(eq(schemaObj.tokens.id, user[0].baseCurrencyId))
        .limit(1);

      if (!baseCurrency.length || !baseCurrency[0]?.symbol) {
        throw new Error('Base currency not found');
      }

      const baseCurrencySymbol = baseCurrency[0].symbol;

      // Get tokens with their holdings and calculate total values
      const tokensWithHoldings = await db
        .select({
          id: schemaObj.tokens.id,
          symbol: schemaObj.tokens.symbol,
          name: schemaObj.tokens.name,
          typeId: schemaObj.tokens.typeId,
          type: schemaObj.tokenTypes.code,
          typeName: schemaObj.tokenTypes.name,
          decimals: schemaObj.tokens.decimals,
          iconUrl: schemaObj.tokens.iconUrl,
          isActive: schemaObj.tokens.isActive,
          createdAt: schemaObj.tokens.createdAt,
          updatedAt: schemaObj.tokens.updatedAt,
          holdingBalance: schemaObj.holdings.balance,
          accountId: schemaObj.holdings.accountId,
        })
        .from(schemaObj.tokens)
        .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
        .innerJoin(schemaObj.holdings, eq(schemaObj.tokens.id, schemaObj.holdings.tokenId))
        .innerJoin(
          schemaObj.accounts,
          and(
            eq(schemaObj.holdings.accountId, schemaObj.accounts.id),
            eq(schemaObj.accounts.userId, userId),
            eq(schemaObj.accounts.isActive, true)
          )
        )
        .where(eq(schemaObj.tokens.isActive, true))
        .orderBy(schemaObj.tokens.symbol);

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
        const balance = new Decimal(row.holdingBalance || '0');
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

      const tokensToPrice = uniqueSymbols.filter((symbol) => symbol !== baseCurrencySymbol);

      // Get full token objects for pricing service
      const tokens =
        tokensToPrice.length > 0
          ? await db
              .select()
              .from(schemaObj.tokens)
              .where(inArray(schemaObj.tokens.symbol, tokensToPrice))
          : [];

      let prices = new Map<string, string>();
      if (tokens.length > 0) {
        const now = new Date();
        prices = await pricingService.getTokenPrices(tokens, baseCurrencySymbol, now);
      }

      // Now calculate values using the batch-fetched prices
      for (const row of tokensWithHoldings) {
        const tokenId = row.id;
        const summary = tokenSummaries.get(tokenId)!;
        const balance = new Decimal(row.holdingBalance || '0');

        // Convert to base currency value
        let convertedValue: Decimal;
        if (row.symbol === baseCurrencySymbol) {
          // Same currency, no conversion needed
          convertedValue = balance;
        } else {
          // Use batch-fetched price - find token ID first
          const token = tokens.find((t) => t.symbol === row.symbol);
          const price = token ? prices.get(token.id) || '0' : '0';
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
}

// Legacy export for backwards compatibility - will be removed after migration
// biome-ignore lint/suspicious/noExplicitAny: Temporary null export for backwards compatibility during migration
export const tokensRouter = null as any; // Placeholder - actual router created via factory
