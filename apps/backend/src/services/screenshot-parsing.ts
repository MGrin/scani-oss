import type { TokenMetadata, TokenValidationResult as ValidationResult } from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { createComponentLogger } from '../utils/logger';
import type { AIProviderManagerConfig, AIProviderType } from './ai/provider-manager';
import { AIProviderManager } from './ai/provider-manager';
import type { AIProviderResponse, ParsedHolding } from './ai/types';
import { pricingService } from './pricing';
import { tokenValidationService } from './token-validation';
import { userContextService } from './user-context-enhanced';

// Configuration constants to replace hardcoded values
const PARSING_CONFIG = {
  // Confidence thresholds
  MIN_CONFIDENCE_THRESHOLD: 0.4, // Configurable minimum confidence instead of hardcoded 0.5
  SIMILARITY_THRESHOLD: 0.3, // For database similarity queries

  // Transaction amount thresholds
  SIGNIFICANT_CHANGE_THRESHOLD: '0.000001', // For detecting significant balance changes
  UPDATE_CHANGE_THRESHOLD: '0.001', // For update operations

  // Default token decimals by type (only seeded types)
  DEFAULT_DECIMALS: {
    fiat: 2,
    stock: 8, // Covers Stock/ETF/Equity/Commodity
    crypto: 8,
    'private-company': 8,
    other: 8,
  } as const,

  // Price fetching settings
  PRICE_FETCH_RETRIES: 3,
  PRICE_FETCH_TIMEOUT: 10000, // 10 seconds

  // Concurrency limits
  MAX_CONCURRENT_OPERATIONS: 5,
} as const;

export interface ScreenshotParsingOptions {
  accountId: string;
  expectedCurrency?: string;
  context?: string;
}

export interface ParsedHoldingWithValidation extends ParsedHolding {
  /** Whether the token exists in our database */
  tokenExists: boolean;
  /** Token ID if found */
  tokenId?: string;
  /** Suggested token type if new */
  suggestedTokenType?: string;
  /** Validation errors */
  errors: string[];
  /** Warnings that don't prevent creation */
  warnings: string[];
  /** Whether this holding requires user selection from similar provider tokens */
  requiresUserSelection: boolean;
  /** Provider validation result */
  providerValidation?: {
    /** Exact match found in providers */
    exactMatch?: ValidationResult;
    /** Similar matches from providers */
    similarMatches?: ValidationResult[];
    /** True if no matches found at all */
    noMatches?: boolean;
  };
}

export interface ScreenshotParsingResult {
  /** Original AI response */
  aiResponse: AIProviderResponse;
  /** Validated and enriched holdings */
  holdings: ParsedHoldingWithValidation[];
  /** Account information */
  account: {
    id: string;
    name: string;
    institutionName: string;
  };
  /** Summary statistics */
  summary: {
    totalHoldings: number;
    existingTokens: number;
    newTokensRequired: number;
    averageConfidence: number;
    hasErrors: boolean;
    hasWarnings: boolean;
  };
}

export class ScreenshotParsingService {
  private aiManager: AIProviderManager;
  private readonly logger = createComponentLogger('screenshot-parsing');

  constructor() {
    // Initialize AI provider manager with configuration from environment
    const config: AIProviderManagerConfig = {
      defaultProvider: (process.env.DEFAULT_AI_PROVIDER as AIProviderType) || 'openai',
      providers: {
        ...(process.env.OPENAI_API_KEY && {
          openai: {
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.OPENAI_VISION_MODEL,
          },
        }),
        ...(process.env.PERPLEXITY_API_KEY && {
          perplexity: {
            apiKey: process.env.PERPLEXITY_API_KEY,
            model: process.env.PERPLEXITY_VISION_MODEL,
          },
        }),
        ...(process.env.DEEPSEEK_API_KEY && {
          deepseek: {
            apiKey: process.env.DEEPSEEK_API_KEY,
            model: process.env.DEEPSEEK_VISION_MODEL,
          },
        }),
      },
    };

    this.aiManager = new AIProviderManager(config);
  }

  /**
   * Parse a screenshot and return validated holdings data
   */
  async parseScreenshot(
    imageBase64: string,
    userId: string,
    options: ScreenshotParsingOptions
  ): Promise<ScreenshotParsingResult> {
    // Validate account belongs to user
    const account = await this.validateAccount(options.accountId, userId);

    // Parse with AI (using default provider)
    const aiResponse = await this.aiManager.parseScreenshot(imageBase64, {
      accountType: account.type?.name,
      expectedCurrency: options.expectedCurrency || account.baseCurrency?.symbol,
      context: `${options.context || ''} Account: ${account.name} at ${account.institution.name}`,
    });

    // Validate and enrich holdings
    const validatedHoldings = await this.validateHoldings(aiResponse.portfolio.holdings);

    // Calculate summary statistics
    const summary = this.calculateSummary(validatedHoldings);

    // Debug: Check what we're returning
    console.log('=== PARSE SCREENSHOT RETURN DEBUG ===');
    const holdingsWithProviderData = validatedHoldings.filter(
      (h) => h.providerValidation?.similarMatches && h.providerValidation.similarMatches.length > 0
    );
    if (holdingsWithProviderData.length > 0) {
      console.log(`Found ${holdingsWithProviderData.length} holdings with provider validation`);
      holdingsWithProviderData.forEach((h) => {
        console.log(`\nHolding: ${h.symbol}`);
        h.providerValidation?.similarMatches?.forEach((match, i) => {
          console.log(`  Match ${i + 1}:`, JSON.stringify(match.metadata, null, 2));
        });
      });
    }
    console.log('=== END PARSE SCREENSHOT RETURN DEBUG ===');

    return {
      aiResponse,
      holdings: validatedHoldings,
      account: {
        id: account.id,
        name: account.name,
        institutionName: account.institution.name,
      },
      summary,
    };
  }

  /**
   * Process holdings from parsed data - automatically determines create vs update
   * Uses a single atomic transaction with bulk operations for optimal performance
   */
  async processHoldingsFromParsing(
    userId: string,
    accountId: string,
    holdings: ParsedHoldingWithValidation[],
    options?: {
      createMissingTokens?: boolean;
      skipValidation?: boolean;
    }
  ): Promise<{
    created: Array<{
      holdingId: string;
      transactionId: string;
      tokenSymbol: string;
    }>;
    updated: Array<{
      holdingId: string;
      transactionId?: string;
      tokenSymbol: string;
      change: string;
    }>;
    errors: Array<{ symbol: string; error: string }>;
  }> {
    const created: Array<{
      holdingId: string;
      transactionId: string;
      tokenSymbol: string;
    }> = [];
    const updated: Array<{
      holdingId: string;
      transactionId?: string;
      tokenSymbol: string;
      change: string;
    }> = [];
    const errors: Array<{ symbol: string; error: string }> = [];

    // Re-check token existence for all symbols (user may have selected different symbols from providers)
    const allSymbols = [...new Set(holdings.map((h) => h.symbol.toUpperCase()))];
    const existingTokensCheck =
      allSymbols.length > 0
        ? await db.select().from(schema.tokens).where(inArray(schema.tokens.symbol, allSymbols))
        : [];

    const existingTokenMap = new Map(
      existingTokensCheck.map((token) => [token.symbol.toUpperCase(), token])
    );

    // Update holdings with correct token existence info and fix provider metadata
    for (const holding of holdings) {
      const existingToken = existingTokenMap.get(holding.symbol.toUpperCase());
      if (existingToken) {
        holding.tokenExists = true;
        holding.tokenId = existingToken.id;
        holding.requiresUserSelection = false;
        holding.errors = [];
        holding.warnings = [];

        // Check if existing token needs provider metadata update
        const exactMatch = holding.providerValidation?.exactMatch;
        if (
          exactMatch?.metadata &&
          this.shouldUpdateTokenMetadata(existingToken, exactMatch.metadata)
        ) {
          try {
            await this.updateTokenWithProviderMetadata(existingToken.id, exactMatch.metadata);
            this.logger.debug(
              {
                tokenId: existingToken.id,
                symbol: existingToken.symbol,
              },
              'Updated provider metadata for existing token'
            );
          } catch (error) {
            this.logger.warn(
              {
                tokenId: existingToken.id,
                symbol: existingToken.symbol,
                error:
                  error instanceof Error ? { name: error.name, message: error.message } : error,
              },
              'Failed to update provider metadata for existing token'
            );
          }
        }
      } else {
        // Fix suggestedTokenType from provider metadata if available
        const exactMatch = holding.providerValidation?.exactMatch;
        if (exactMatch?.metadata?.provider === 'coingecko') {
          // CoinGecko tokens are always crypto, regardless of metadata type
          holding.suggestedTokenType = 'crypto';
        } else if (exactMatch?.metadata?.type) {
          const providerType = exactMatch.metadata.type;
          holding.suggestedTokenType = this.mapProviderTypeToTokenType(providerType);
        } else if (exactMatch?.metadata && 'metadata' in exactMatch.metadata) {
          // Handle nested metadata structure from the request
          const nestedMetadata = exactMatch.metadata.metadata as Record<string, unknown>;
          if (nestedMetadata?.type && typeof nestedMetadata.type === 'string') {
            const providerType = nestedMetadata.type;
            holding.suggestedTokenType = this.mapProviderTypeToTokenType(providerType);
          }
        }
      }
    }

    // Validate holdings first
    const validHoldings: ParsedHoldingWithValidation[] = [];

    for (const holding of holdings) {
      // Basic field validation
      if (!holding.symbol || holding.symbol.trim() === '') {
        errors.push({
          symbol: holding.symbol || 'UNKNOWN',
          error: 'Symbol is required and cannot be empty',
        });
        continue;
      }

      if (!holding.balance || holding.balance.trim() === '') {
        errors.push({
          symbol: holding.symbol,
          error: 'Balance is required and cannot be empty',
        });
        continue;
      }

      // Validate balance is a positive number
      try {
        const balanceDecimal = new Decimal(holding.balance);
        if (balanceDecimal.isNaN() || !balanceDecimal.isFinite() || balanceDecimal.lte(0)) {
          errors.push({
            symbol: holding.symbol,
            error: 'Balance must be a positive number',
          });
          continue;
        }
      } catch {
        errors.push({
          symbol: holding.symbol,
          error: 'Balance must be a valid number',
        });
        continue;
      }

      // Check for tokens requiring user selection (highest priority)
      if (holding.requiresUserSelection && !options?.skipValidation) {
        errors.push({
          symbol: holding.symbol,
          error: `User selection required: ${holding.errors.join(', ')}`,
        });
        continue;
      }

      if (holding.errors.length > 0 && !options?.skipValidation) {
        errors.push({
          symbol: holding.symbol,
          error: `Validation errors: ${holding.errors.join(', ')}`,
        });
        continue;
      }

      // If holding has a tokenId, treat it as having an existing token
      if (holding.tokenId) {
        holding.tokenExists = true;
        holding.requiresUserSelection = false;
      }

      if (!holding.tokenExists && !holding.tokenId && !options?.createMissingTokens) {
        errors.push({
          symbol: holding.symbol,
          error: 'Token does not exist and createMissingTokens is false',
        });
        continue;
      }

      validHoldings.push(holding);
    }

    if (validHoldings.length === 0) {
      return { created, updated, errors };
    }

    const existingTokens = await db
      .select()
      .from(schema.tokens)
      .where(
        inArray(
          schema.tokens.id,
          validHoldings.filter((h) => h.tokenId).map((h) => h.tokenId!)
        )
      )
      .execute();
    const existingTokensMap = new Map(existingTokens.map((t) => [t.id, t]));

    const newTokens = validHoldings
      .filter((h) => !h.tokenExists && !h.tokenId)
      .map((h) => {
        // Ensure suggestedTokenType is valid for screenshot parsing
        let suggestedType = h.suggestedTokenType;

        // CRITICAL: Screenshot parsing should NEVER create 'other' or 'private-company' tokens
        // These types must be manually created by users
        if (!suggestedType || suggestedType === 'other' || suggestedType === 'private-company') {
          this.logger.warn(
            {
              symbol: h.symbol,
              originalType: suggestedType,
            },
            'Invalid token type for screenshot parsing, defaulting to stock'
          );
          suggestedType = 'stock';
        }

        return {
          symbol: h.symbol,
          suggestedType,
          exists: h.tokenExists,
          providerData: h.providerValidation,
        };
      });

    // Get user's base currency for price fetching
    const baseCurrency = await userContextService.getBaseCurrency(userId);

    // WORKAROUND: Re-validate CoinGecko tokens if providerMetadata is missing
    // This handles the case where frontend loses the nested providerMetadata during state management
    this.logger.info('Checking for tokens with missing CoinGecko metadata...');
    for (const nt of newTokens) {
      const metadata = nt.providerData?.exactMatch?.metadata;
      if (
        metadata &&
        metadata.provider === 'coingecko' &&
        (!metadata.providerMetadata || Object.keys(metadata.providerMetadata).length === 0)
      ) {
        this.logger.warn(
          {
            symbol: metadata.symbol,
            name: metadata.name,
          },
          'CoinGecko token missing providerMetadata - re-validating to fetch ID'
        );

        try {
          // Re-validate to get the CoinGecko ID
          const validationService = tokenValidationService;
          const revalidated = await validationService.validateToken(metadata.symbol, 'crypto');

          if (revalidated.isValid && revalidated.metadata?.providerMetadata) {
            // Merge the recovered metadata
            metadata.providerMetadata = revalidated.metadata.providerMetadata;
            this.logger.info(
              {
                symbol: metadata.symbol,
                coinGeckoId: (revalidated.metadata.providerMetadata as Record<string, unknown>).id,
              },
              'Successfully recovered CoinGecko ID via re-validation'
            );
          } else {
            this.logger.error(
              {
                symbol: metadata.symbol,
                error: revalidated.error,
              },
              'Failed to recover CoinGecko metadata - token will not be priceable'
            );
          }
        } catch (error) {
          this.logger.error(
            {
              symbol: metadata.symbol,
              error: error instanceof Error ? error.message : String(error),
            },
            'Exception during CoinGecko metadata recovery'
          );
        }
      }
    }

    const now = new Date();
    // Only fetch prices for tokens we actually created/updated, not all existing tokens
    const tokensToFetchPricesFor: (typeof schema.tokens.$inferSelect)[] = [];
    // Execute everything in a single atomic transaction
    const result = await db
      .transaction(async (trx) => {
        const tokenTypes = await trx
          .select()
          .from(schema.tokenTypes)
          .where(eq(schema.tokenTypes.isActive, true));

        const tokenTypeMap = new Map(tokenTypes.map((tt) => [tt.code.toLowerCase(), tt]));

        const newTokensInsert = newTokens.map((nt) => {
          const type = nt.suggestedType;
          if (!type) {
            throw new Error(`Cannot create token ${nt.symbol} without a suggested type`);
          }

          console.log('=== TOKEN CREATION DEBUG ===');
          console.log('Symbol:', nt.symbol);
          console.log('Type:', type);
          console.log('Has provider data:', !!nt.providerData);
          console.log('Has exact match:', !!nt.providerData?.exactMatch);
          if (nt.providerData?.exactMatch?.metadata) {
            console.log('Provider:', nt.providerData.exactMatch.metadata.provider);
            console.log(
              'Full metadata:',
              JSON.stringify(nt.providerData.exactMatch.metadata, null, 2)
            );
            console.log(
              'Provider metadata field:',
              JSON.stringify(nt.providerData.exactMatch.metadata.providerMetadata, null, 2)
            );
          } else {
            console.log('NO METADATA FOUND');
          }
          console.log('=== END TOKEN CREATION DEBUG ===');

          this.logger.info(
            {
              symbol: nt.symbol,
              type,
              hasProviderData: !!nt.providerData,
              hasExactMatch: !!nt.providerData?.exactMatch,
            },
            'Creating new token from parsing - checking provider data'
          );

          // Extract name from provider metadata structure
          const exactMatch = nt.providerData?.exactMatch;
          let tokenName = nt.symbol;

          if (exactMatch?.metadata?.name) {
            tokenName = exactMatch.metadata.name;
          } else if (exactMatch?.metadata && 'metadata' in exactMatch.metadata) {
            const nestedMetadata = exactMatch.metadata.metadata as Record<string, unknown>;
            if (nestedMetadata?.name && typeof nestedMetadata.name === 'string') {
              tokenName = nestedMetadata.name;
            }
          }

          const data: typeof schema.tokens.$inferInsert = {
            symbol: nt.symbol,
            name: tokenName,
            typeId: tokenTypeMap.get(type.toLowerCase())!.id,
            decimals:
              PARSING_CONFIG.DEFAULT_DECIMALS[
                (
                  nt.suggestedType || 'other'
                ).toLowerCase() as keyof typeof PARSING_CONFIG.DEFAULT_DECIMALS
              ] || 2,
            iconUrl: null,
            providerMetadata: this.buildProviderMetadata(nt.providerData?.exactMatch?.metadata),
            isActive: true,
            createdAt: now,
            updatedAt: now,
          };

          return data;
        });

        const createdTokens =
          newTokensInsert.length > 0
            ? await trx.insert(schema.tokens).values(newTokensInsert).returning()
            : [];

        tokensToFetchPricesFor.push(...createdTokens);
        // Get existing holdings for this account
        const existingHoldings = await trx
          .select({
            id: schema.holdings.id,
            tokenId: schema.holdings.tokenId,
            balance: schema.holdings.balance,
            token: {
              id: schema.tokens.id,
              symbol: schema.tokens.symbol,
            },
          })
          .from(schema.holdings)
          .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
          .where(and(eq(schema.holdings.userId, userId), eq(schema.holdings.accountId, accountId)));
        const existingHoldingsById = new Map(existingHoldings.map((h) => [h.id, h]));
        const existingHoldingsByTokenId = new Map<
          string,
          Array<(typeof existingHoldings)[number]>
        >();

        for (const holding of existingHoldings) {
          const items = existingHoldingsByTokenId.get(holding.tokenId);
          if (items) {
            items.push(holding);
          } else {
            existingHoldingsByTokenId.set(holding.tokenId, [holding]);
          }
        }

        const consumedExistingHoldingIds = new Set<string>();

        // Get appropriate transaction type using user context service
        const depositType = await userContextService.getTransactionType('deposit');

        // Process holdings: separate creates and updates
        const holdingsToCreate: Array<{
          holding: ParsedHoldingWithValidation;
          tokenId: string;
        }> = [];
        const holdingsToUpdate: Array<{
          holding: ParsedHoldingWithValidation;
          existingHolding: (typeof existingHoldings)[0];
        }> = [];

        for (const holding of validHoldings) {
          let token = holding.tokenId ? existingTokensMap.get(holding.tokenId) : undefined;

          // If tokenId is not set, it must be a newly created token
          if (!token) {
            const createdToken = createdTokens.find((t) => t.symbol === holding.symbol);
            if (createdToken) {
              token = createdToken;
            } else {
              // This should not happen due to prior validation
              errors.push({
                symbol: holding.symbol,
                error: 'Internal error: Token ID not found after creation',
              });
              continue;
            }

            holdingsToCreate.push({ holding, tokenId: token.id });
            continue;
          }

          const explicitHoldingId = holding.existingHoldingId;
          if (explicitHoldingId) {
            const targetHolding = existingHoldingsById.get(explicitHoldingId);
            if (!targetHolding) {
              errors.push({
                symbol: holding.symbol,
                error: 'Selected existing holding could not be found for update',
              });
              continue;
            }

            if (targetHolding.tokenId !== token.id) {
              errors.push({
                symbol: holding.symbol,
                error: 'Selected holding uses a different token than the parsed holding',
              });
              continue;
            }

            holdingsToUpdate.push({ holding, existingHolding: targetHolding });
            consumedExistingHoldingIds.add(targetHolding.id);
            continue;
          }

          const candidates = existingHoldingsByTokenId.get(token.id) ?? [];
          const availableCandidates = candidates.filter(
            (candidate) => !consumedExistingHoldingIds.has(candidate.id)
          );

          if (availableCandidates.length === 1) {
            const [targetHolding] = availableCandidates;
            if (!targetHolding) {
              holdingsToCreate.push({ holding, tokenId: token.id });
              continue;
            }

            holdingsToUpdate.push({ holding, existingHolding: targetHolding });
            consumedExistingHoldingIds.add(targetHolding.id);
          } else if (availableCandidates.length === 0) {
            // Token exists but no existing holding - treat as new holding
            holdingsToCreate.push({ holding, tokenId: token.id });
          } else {
            // Multiple holdings share this token and no explicit selection exists - create a new holding
            holdingsToCreate.push({ holding, tokenId: token.id });
          }
        }

        // Bulk create new holdings

        if (holdingsToCreate.length > 0) {
          const holdingsToInsert = holdingsToCreate.map(({ holding, tokenId }) => ({
            userId,
            accountId,
            tokenId,
            balance: holding.balance,
            lastUpdated: new Date(),
          }));

          const createdHoldings = await trx
            .insert(schema.holdings)
            .values(holdingsToInsert)
            .returning()
            .execute();

          // Bulk create transactions for new holdings
          const transactionsToInsert = createdHoldings
            .map((createdHolding, index) => {
              const holdingData = holdingsToCreate[index];
              if (holdingData && new Decimal(holdingData.holding.balance).greaterThan(0)) {
                return {
                  userId,
                  holdingId: createdHolding.id,
                  typeId: depositType.id,
                  amount: holdingData.holding.balance,
                  fee: '0',
                  description: holdingData.holding.notes || 'Opening balance from screenshot',
                  timestamp: new Date(),
                };
              }
              return null;
            })
            .filter((tx): tx is NonNullable<typeof tx> => tx !== null);

          const createdTransactions =
            transactionsToInsert.length > 0
              ? await trx.insert(schema.transactions).values(transactionsToInsert).returning()
              : [];

          // Map results
          let transactionIndex = 0;
          for (let i = 0; i < createdHoldings.length; i++) {
            const holdingData = holdingsToCreate[i];
            const createdHolding = createdHoldings[i];

            if (!holdingData || !createdHolding) continue;

            let transactionId = '';
            if (new Decimal(holdingData.holding.balance).greaterThan(0)) {
              transactionId = createdTransactions[transactionIndex++]?.id || '';
            }

            created.push({
              holdingId: createdHolding.id,
              transactionId,
              tokenSymbol: holdingData.holding.symbol,
            });
          }
        }

        // Bulk update existing holdings
        if (holdingsToUpdate.length > 0) {
          const updatePromises = holdingsToUpdate.map(async ({ holding, existingHolding }) => {
            const oldBalance = new Decimal(existingHolding.balance);
            const newBalance = new Decimal(holding.balance);
            const change = newBalance.minus(oldBalance);

            // Update the holding
            await trx
              .update(schema.holdings)
              .set({
                balance: holding.balance,
                lastUpdated: new Date(),
              })
              .where(eq(schema.holdings.id, existingHolding.id));

            let transactionId = '';

            // Create transaction for the change if significant
            if (change.abs().greaterThan(PARSING_CONFIG.SIGNIFICANT_CHANGE_THRESHOLD)) {
              const [transaction] = await trx
                .insert(schema.transactions)
                .values({
                  userId,
                  holdingId: existingHolding.id,
                  typeId: depositType.id,
                  amount: change.toString(),
                  fee: '0',
                  description: `Balance adjustment from screenshot: ${
                    change.greaterThan(0) ? '+' : ''
                  }${change.toString()}`,
                  timestamp: new Date(),
                })
                .returning();

              transactionId = transaction?.id || '';
            }

            updated.push({
              holdingId: existingHolding.id,
              transactionId,
              tokenSymbol: holding.symbol,
              change: change.toString(),
            });
          });

          await Promise.all(updatePromises);
        }

        const finalResult = { created, updated, errors };

        return finalResult;
      })
      .catch((error) => {
        throw error;
      });

    await pricingService.getTokenPrices(tokensToFetchPricesFor, baseCurrency.symbol, now);
    return result;
  }

  /**
   * Check if screenshot parsing is available
   */
  isAvailable(): boolean {
    return this.aiManager.hasAvailableProvider();
  }

  // Private helper methods
  private async validateAccount(accountId: string, userId: string) {
    const [account] = await db
      .select({
        id: schema.accounts.id,
        name: schema.accounts.name,
        type: {
          id: schema.accountTypes.id,
          name: schema.accountTypes.name,
          code: schema.accountTypes.code,
        },
        institution: {
          id: schema.institutions.id,
          name: schema.institutions.name,
        },
        baseCurrency: {
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
        },
      })
      .from(schema.accounts)
      .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
      .leftJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
      .leftJoin(schema.users, eq(schema.accounts.userId, schema.users.id))
      .leftJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
      .where(
        and(
          eq(schema.accounts.id, accountId),
          eq(schema.accounts.userId, userId),
          eq(schema.accounts.isActive, true)
        )
      )
      .limit(1);

    if (!account) {
      throw new Error('Account not found or access denied');
    }

    return account;
  }

  private async validateHoldings(
    holdings: ParsedHolding[]
  ): Promise<ParsedHoldingWithValidation[]> {
    const validated: ParsedHoldingWithValidation[] = [];

    // Batch query for all token symbols to avoid N+1 queries
    const uniqueSymbols = [...new Set(holdings.map((h) => h.symbol.toUpperCase()))];
    const existingTokens =
      uniqueSymbols.length > 0
        ? await db.select().from(schema.tokens).where(inArray(schema.tokens.symbol, uniqueSymbols))
        : [];

    const tokenMap = new Map(existingTokens.map((token) => [token.symbol.toUpperCase(), token]));

    // Batch provider validation for missing tokens
    const missingSymbols = uniqueSymbols.filter((symbol) => !tokenMap.has(symbol));
    const providerValidationMap = new Map<
      string,
      {
        exactMatch?: ValidationResult;
        similarMatches?: ValidationResult[];
        suggestedTokenType: string;
        noMatches: boolean;
      }
    >();

    // Process provider validations in parallel (limited concurrency)
    if (missingSymbols.length > 0) {
      const batchSize = PARSING_CONFIG.MAX_CONCURRENT_OPERATIONS;
      for (let i = 0; i < missingSymbols.length; i += batchSize) {
        const batch = missingSymbols.slice(i, i + batchSize);
        const batchPromises = batch.map(async (symbol) => {
          try {
            const validation = await this.validateTokenWithProviders(symbol);
            return { symbol, validation };
          } catch (error) {
            this.logger.warn(
              {
                symbol,
                error:
                  error instanceof Error ? { name: error.name, message: error.message } : error,
              },
              'Provider validation failed'
            );
            return { symbol, validation: null };
          }
        });

        const batchResults = await Promise.allSettled(batchPromises);
        batchResults.forEach((result) => {
          if (result.status === 'fulfilled' && result.value.validation) {
            providerValidationMap.set(result.value.symbol, result.value.validation);
          }
        });
      }
    }

    for (const holding of holdings) {
      const validation: ParsedHoldingWithValidation = {
        ...holding,
        tokenExists: false,
        errors: [],
        warnings: [],
        requiresUserSelection: false,
      };

      // Validate balance format
      try {
        const balance = new Decimal(holding.balance);
        if (balance.isNaN() || !balance.isFinite()) {
          validation.errors.push('Invalid balance format');
        }
      } catch {
        validation.errors.push('Balance is not a valid number');
      }

      // Check if token exists using our batched lookup
      const existingToken = tokenMap.get(holding.symbol.toUpperCase());

      if (existingToken) {
        validation.tokenExists = true;
        validation.tokenId = existingToken.id;
      } else {
        validation.warnings.push('Token not found in database - will need to be created');

        // Use batched provider validation
        const providerValidation = providerValidationMap.get(holding.symbol.toUpperCase());
        if (providerValidation) {
          validation.suggestedTokenType = providerValidation.suggestedTokenType;
          validation.providerValidation = providerValidation;

          // Add appropriate warnings/errors based on provider validation
          if (providerValidation.exactMatch) {
            // Exact match found - auto-create the token
            validation.warnings.push(
              `Exact match found in ${providerValidation.exactMatch.metadata?.provider} - will be created automatically`
            );
          } else if (
            providerValidation.similarMatches &&
            providerValidation.similarMatches.length > 0
          ) {
            const similarCount = providerValidation.similarMatches.length;

            // Check if similar matches come from different providers (ambiguity indicator)
            const providers = new Set(
              providerValidation.similarMatches
                .map((m: ValidationResult) => m.metadata?.provider)
                .filter(Boolean)
            );

            const hasMultipleProviders = providers.size > 1;

            // ALWAYS require user selection when we have similar matches but no exact match
            // This prevents misclassification (e.g., "ETH" as stock vs crypto)
            validation.requiresUserSelection = true;

            const matchList = providerValidation.similarMatches
              .slice(0, 5) // Show max 5 options
              .map((m: ValidationResult) => {
                const symbol = m.metadata?.symbol || 'unknown';
                const name = m.metadata?.name || '';
                const provider = m.metadata?.provider || '';
                return `${symbol}${name ? ` (${name})` : ''}${provider ? ` [${provider}]` : ''}`;
              })
              .join(', ');

            if (hasMultipleProviders) {
              // Cross-provider ambiguity (e.g., ETH in both stock and crypto providers)
              validation.errors.push(
                `Symbol "${holding.symbol}" is ambiguous - found in multiple asset types. Please select the correct one from: ${matchList}`
              );
            } else if (similarCount === 1) {
              // Single similar match but not exact - could still be wrong
              validation.errors.push(
                `Token "${holding.symbol}" not found exactly. Found similar: ${matchList}. Please confirm this is correct.`
              );
            } else {
              // Multiple similar matches from same provider
              validation.errors.push(
                `Token "${holding.symbol}" not found exactly. Please select from ${similarCount} similar matches: ${matchList}`
              );
            }
          } else if (providerValidation.noMatches) {
            validation.errors.push(
              'Token not found in database or pricing providers - cannot proceed without manual token selection'
            );
          }
        } else {
          validation.errors.push(
            'Token validation failed - cannot proceed without manual token selection'
          );
        }
      }

      // Confidence validation - use configurable threshold
      if (holding.confidence < PARSING_CONFIG.MIN_CONFIDENCE_THRESHOLD) {
        validation.warnings.push(
          `Low confidence in AI extraction (${(holding.confidence * 100).toFixed(1)}%)`
        );
      }

      validated.push(validation);
    }

    return validated;
  }

  private calculateSummary(holdings: ParsedHoldingWithValidation[]) {
    const totalHoldings = holdings.length;
    const existingTokens = holdings.filter((h) => h.tokenExists).length;
    const newTokensRequired = totalHoldings - existingTokens;
    const averageConfidence =
      holdings.reduce((sum, h) => sum + h.confidence, 0) / totalHoldings || 0;
    const hasErrors = holdings.some((h) => h.errors.length > 0);
    const hasWarnings = holdings.some((h) => h.warnings.length > 0);

    return {
      totalHoldings,
      existingTokens,
      newTokensRequired,
      averageConfidence,
      hasErrors,
      hasWarnings,
    };
  }

  /**
   * Enhanced token type guessing using provider validation
   *
   * Token validation flow:
   * 1. Check if symbol exists in database (handled in validateHoldings)
   * 2. Try exact validation against Finnhub and CoinGecko APIs
   * 3. If no exact match, search both providers for similar symbols
   * 4. If search finds exact symbol match (case-insensitive), treat as exact
   * 5. If only one similar match found, use it automatically (user can verify later)
   * 6. If multiple similar matches, require user selection
   * 7. If no matches at all, return error
   *
   * This handles cases like:
   * - AAPL → finds exact match in Finnhub search (even if quote needs AAPL.US)
   * - XEQT → finds XEQT.TO in similar matches (user selects from similar)
   * - BTC → finds exact match in CoinGecko
   * - INVALID → no matches found (error)
   *
   * Returns validation result with exact matches and similar suggestions
   */
  private async validateTokenWithProviders(symbol: string): Promise<{
    exactMatch?: ValidationResult;
    similarMatches?: ValidationResult[];
    suggestedTokenType: string;
    noMatches: boolean;
  }> {
    // Use singleton validation service
    const validationService = tokenValidationService;

    // CRITICAL: We need to check BOTH providers to detect ambiguity
    // Don't use validateToken() as it returns early on first match
    // Instead, explicitly validate with both Finnhub and CoinGecko

    const finnhubExact = await validationService.validateToken(symbol, 'stock');
    const coinGeckoExact = await validationService.validateToken(symbol, 'crypto');

    const hasFinnhubExact = finnhubExact.isValid && finnhubExact.metadata;
    const hasCoinGeckoExact = coinGeckoExact.isValid && coinGeckoExact.metadata;

    // Check for ambiguity: both providers have exact matches
    if (hasFinnhubExact && hasCoinGeckoExact) {
      this.logger.info(
        {
          symbol,
          finnhub: finnhubExact.metadata?.name,
          coingecko: coinGeckoExact.metadata?.name,
        },
        'AMBIGUOUS: Symbol found in both Finnhub and CoinGecko - requiring user selection'
      );

      // Return both as similar matches for user selection
      return {
        exactMatch: undefined,
        similarMatches: [finnhubExact, coinGeckoExact],
        suggestedTokenType: 'crypto', // Suggest crypto as more likely for exact match
        noMatches: false,
      };
    }

    // Only one provider has exact match - use it
    if (hasFinnhubExact) {
      const tokenType = this.mapProviderTypeToTokenType(finnhubExact.metadata!.type);
      return {
        exactMatch: finnhubExact,
        similarMatches: [],
        suggestedTokenType: tokenType,
        noMatches: false,
      };
    }

    if (hasCoinGeckoExact) {
      return {
        exactMatch: coinGeckoExact,
        similarMatches: [],
        suggestedTokenType: 'crypto',
        noMatches: false,
      };
    }

    // No exact matches found, let's search for similar matches
    const similarMatches: ValidationResult[] = [];

    try {
      // Search Finnhub for similar tokens
      const finnhubMatches = await validationService.searchFinnhubTokens(symbol);

      // Check if any Finnhub match is an exact symbol match (case-insensitive)
      const finnhubExactMatch = finnhubMatches.find(
        (match) => match.metadata?.symbol.toUpperCase() === symbol.toUpperCase()
      );

      if (finnhubExactMatch) {
        // Found exact match in search results - treat it as exact match
        const tokenType = this.mapProviderTypeToTokenType(
          finnhubExactMatch.metadata?.type || 'Equity'
        );
        return {
          exactMatch: finnhubExactMatch,
          similarMatches: [],
          suggestedTokenType: tokenType,
          noMatches: false,
        };
      }

      similarMatches.push(...finnhubMatches.slice(0, 5)); // Limit to 5 suggestions

      // Search CoinGecko for similar tokens
      const coinGeckoMatches = await validationService.searchCoinGeckoTokens(symbol);

      // Check if any CoinGecko match is an exact symbol match (case-insensitive)
      const coinGeckoExactMatch = coinGeckoMatches.find(
        (match) => match.metadata?.symbol.toUpperCase() === symbol.toUpperCase()
      );

      if (coinGeckoExactMatch) {
        // Found exact match in CoinGecko search results

        // CRITICAL: Check if we also have Finnhub matches - this indicates ambiguity!
        // Example: "ETH" could be Ethereum (crypto) OR a stock ticker
        if (finnhubMatches.length > 0) {
          // Ambiguous symbol - require user selection between stock and crypto
          this.logger.info(
            {
              symbol,
              finnhubMatches: finnhubMatches.length,
              coinGeckoMatches: coinGeckoMatches.length,
            },
            'Ambiguous symbol found in both Finnhub and CoinGecko - requiring user selection'
          );

          // Return all matches for user to choose from
          similarMatches.push(...coinGeckoMatches.slice(0, 5));

          return {
            exactMatch: undefined,
            similarMatches, // Includes both Finnhub and CoinGecko matches
            suggestedTokenType: 'crypto', // Suggest crypto as it's more likely for exact symbol match
            noMatches: false,
          };
        }

        // No ambiguity - only CoinGecko has matches, treat as exact crypto match
        return {
          exactMatch: coinGeckoExactMatch,
          similarMatches: [],
          suggestedTokenType: 'crypto',
          noMatches: false,
        };
      }

      similarMatches.push(...coinGeckoMatches.slice(0, 5)); // Limit to 5 suggestions
    } catch (error) {
      this.logger.warn(
        {
          symbol,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Error searching for similar tokens'
      );
    }

    // Determine suggested token type from similar matches or intelligent fallback
    const suggestedTokenType = await this.determineBestTokenType(symbol, similarMatches);

    return {
      exactMatch: undefined,
      similarMatches,
      suggestedTokenType,
      noMatches: similarMatches.length === 0,
    };
  }

  /**
   * Map provider token types to our internal token types
   * Note: Only maps to seeded types: fiat, crypto, stock, private-company, other
   * 'stock' type covers Stock/ETF/Equity/Commodity as per seed data
   * For screenshot parsing, unknown provider types default to 'stock'
   */
  private mapProviderTypeToTokenType(providerType: string): string {
    switch (providerType.toLowerCase()) {
      case 'equity':
      case 'etp': // Exchange Traded Product (includes ETFs)
      case 'etf':
      case 'mutual fund':
      case 'bond':
      case 'commodity':
      case 'stock':
        // All equity-like instruments map to 'stock' type
        return 'stock';
      case 'crypto':
      case 'cryptocurrency':
        return 'crypto';
      case 'fiat':
      case 'currency':
        return 'fiat';
      default:
        // For screenshot parsing, unknown provider types should default to 'stock'
        // since assets in screenshots are tradeable instruments
        this.logger.debug(
          { providerType },
          'Unknown provider type, defaulting to stock for screenshot parsing'
        );
        return 'stock';
    }
  }

  /**
   * Intelligently determine the best token type from provider matches or use smart fallback
   */
  private async determineBestTokenType(
    symbol: string,
    similarMatches: ValidationResult[]
  ): Promise<string> {
    // First, try to determine from similar matches
    if (similarMatches && similarMatches.length > 0) {
      // Check if any matches come from CoinGecko - if so, it's definitely crypto
      const hasCoinGeckoMatches = similarMatches.some(
        (match) => match.metadata?.provider === 'coingecko'
      );

      if (hasCoinGeckoMatches) {
        return 'crypto'; // CoinGecko only provides crypto tokens
      }

      // Count token types from similar matches to find the most common
      const typeCount = new Map<string, number>();

      for (const match of similarMatches) {
        if (match.metadata?.type) {
          const mappedType = this.mapProviderTypeToTokenType(match.metadata.type);
          typeCount.set(mappedType, (typeCount.get(mappedType) || 0) + 1);
        }
      }

      // Return the most common type from similar matches
      if (typeCount.size > 0) {
        const entries = Array.from(typeCount.entries()).sort((a, b) => b[1] - a[1]);
        if (entries.length > 0 && entries[0]) {
          return entries[0][0];
        }
      }
    }

    // Fallback: Try to determine from database patterns
    // Check if symbol matches any existing tokens in our database to infer type
    return await this.inferTokenTypeFromDatabase(symbol);
  }

  /**
   * Infer token type by looking at existing similar symbols in our database
   */
  private async inferTokenTypeFromDatabase(symbol: string): Promise<string> {
    try {
      // Look for tokens with similar symbols in our database
      const existingTokens = await db
        .select({
          typeCode: schema.tokenTypes.code,
          count: sql<number>`count(*)`.as('count'),
        })
        .from(schema.tokens)
        .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .where(
          sql`similarity(${schema.tokens.symbol}, ${symbol.toUpperCase()}) > ${
            PARSING_CONFIG.SIMILARITY_THRESHOLD
          }`
        )
        .groupBy(schema.tokenTypes.code)
        .orderBy(sql`count(*) desc`)
        .limit(1);

      if (existingTokens.length > 0 && existingTokens[0]) {
        return existingTokens[0].typeCode;
      }
    } catch (error) {
      // If similarity search fails (not all databases support it), fall back to basic logic
      this.logger.warn(
        {
          symbol,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Database similarity search failed, using basic fallback'
      );
    }

    // Final intelligent fallback based on symbol characteristics
    return this.intelligentTokenTypeFallback(symbol);
  }

  /**
   * Smart fallback for screenshot parsing - should only return fiat, crypto, or stock
   * NEVER returns 'other' or 'private-company' as those are not suitable for screenshot parsing
   */
  private intelligentTokenTypeFallback(symbol: string): string {
    const symbolUpper = symbol.toUpperCase();

    // Check for common crypto tokens (top 100+ cryptocurrencies by market cap)
    // This is a safety net if CoinGecko API fails or doesn't find the token
    const commonCryptoSymbols = [
      'BTC',
      'ETH',
      'USDT',
      'BNB',
      'SOL',
      'USDC',
      'XRP',
      'DOGE',
      'TON',
      'ADA',
      'SHIB',
      'AVAX',
      'TRX',
      'DOT',
      'LINK',
      'MATIC',
      'BCH',
      'NEAR',
      'UNI',
      'LTC',
      'DAI',
      'ICP',
      'APT',
      'FET',
      'STX',
      'ARB',
      'OP',
      'INJ',
      'IMX',
      'MNT',
      'HBAR',
      'VET',
      'ATOM',
      'FIL',
      'OKB',
      'XLM',
      'CRO',
      'GRT',
      'ALGO',
      'ETC',
      'WLD',
      'RUNE',
      'AAVE',
      'SNX',
      'MKR',
      'THETA',
      'FTM',
      'XMR',
      'EGLD',
      'SAND',
      'MANA',
      'CHZ',
      'ZEC',
      'KAVA',
      'FLOW',
      'TUSD',
      'XTZ',
      'AXS',
      'EOS',
      'NEO',
      'CAKE',
      'BSV',
      'QNT',
      'FXS',
      'DASH',
      'RNDR',
      'GALA',
      'ZIL',
      'ENJ',
      'BAT',
      '1INCH',
      'COMP',
      'LDO',
      'CRV',
      'SUSHI',
      'YFI',
      'CELO',
      'RVN',
      'WAVES',
      'ZRX',
      'MINA',
      'QTUM',
      'ROSE',
      'KSM',
      'SUI',
      'SEI',
      'PEPE',
      'FLOKI',
      'BONK',
      'WIF',
    ];

    if (commonCryptoSymbols.includes(symbolUpper)) {
      return 'crypto';
    }

    // Check for common fiat currency codes (3-letter ISO codes)
    // Note: This is a heuristic - fiat currencies should ideally already be in DB
    const commonFiatCodes = [
      'USD',
      'EUR',
      'GBP',
      'JPY',
      'CNY',
      'CAD',
      'AUD',
      'CHF',
      'INR',
      'KRW',
      'BRL',
      'MXN',
      'ARS',
      'RUB',
      'ZAR',
      'SGD',
      'HKD',
      'NZD',
      'SEK',
      'NOK',
      'DKK',
      'PLN',
      'TRY',
      'THB',
    ];

    if (/^[A-Z]{3}$/.test(symbolUpper) && commonFiatCodes.includes(symbolUpper)) {
      // 3-letter symbol matching common fiat codes
      return 'fiat';
    }

    // For screenshot parsing, if we can't determine the type:
    // - Alphabetic symbols (1-5 chars) are most likely stocks/ETFs
    // - This includes 3-letter stock tickers (e.g., IBM, AMD, AMD)
    // - Default to 'stock' rather than 'other' since screenshots contain tradeable assets
    if (/^[A-Z]{1,5}$/.test(symbolUpper)) {
      return 'stock';
    }

    // Longer alphanumeric symbols are likely fund identifiers or complex tickers
    if (/^[A-Z0-9]{6,}$/.test(symbolUpper)) {
      return 'stock';
    }

    // Symbols with dots or hyphens (e.g., BRK.B, XEQT.TO) are stocks
    if (/^[A-Z0-9.-]+$/.test(symbolUpper)) {
      return 'stock';
    }

    // Default to stock for screenshot parsing - assets in screenshots are tradeable
    // NEVER default to 'other' or 'private-company' in screenshot context
    return 'stock';
  }

  /**
   * Build provider metadata in the format expected by the pricing service
   *
   * The pricing service expects:
   * {
   *   "coingecko": { "id": "ethereum" },
   *   "finnhub": { "symbol": "AAPL" }
   * }
   *
   * But token validation returns:
   * {
   *   "symbol": "ETH",
   *   "provider": "coingecko",
   *   "providerMetadata": { "id": "ethereum" }
   * }
   */
  private buildProviderMetadata(metadata?: TokenMetadata): string {
    console.log('=== BUILD PROVIDER METADATA DEBUG ===');

    if (!metadata) {
      console.log('NO METADATA PROVIDED');
      this.logger.debug('buildProviderMetadata: No metadata provided, returning empty object');
      return '{}';
    }

    console.log('Metadata received:', JSON.stringify(metadata, null, 2));
    console.log('Provider:', metadata.provider);
    console.log('Symbol:', metadata.symbol);
    console.log('Provider metadata field:', JSON.stringify(metadata.providerMetadata, null, 2));

    this.logger.debug(
      {
        provider: metadata.provider,
        symbol: metadata.symbol,
        hasProviderMetadata: !!metadata.providerMetadata,
      },
      'buildProviderMetadata: Processing metadata'
    );

    const result: Record<string, unknown> = {};

    // Extract provider-specific data based on the provider
    if (metadata.provider === 'coingecko') {
      const coinGeckoData = metadata.providerMetadata as
        | { id?: string; coinGeckoData?: unknown }
        | undefined;

      console.log('CoinGecko data extracted:', JSON.stringify(coinGeckoData, null, 2));
      console.log('CoinGecko ID:', coinGeckoData?.id);

      this.logger.info(
        {
          symbol: metadata.symbol,
          coinGeckoId: coinGeckoData?.id,
        },
        'Building CoinGecko metadata for token'
      );

      result.coingecko = {
        id: coinGeckoData?.id,
        name: metadata.name,
        symbol: metadata.symbol,
        type: metadata.type,
      };
      // Also add as legacy coinGeckoId for backwards compatibility
      if (coinGeckoData?.id) {
        result.coinGeckoId = coinGeckoData.id;
        console.log('Set coinGeckoId to:', coinGeckoData.id);
      } else {
        console.log('WARNING: No CoinGecko ID found in metadata!');
      }
    } else if (metadata.provider === 'finnhub') {
      this.logger.info(
        {
          symbol: metadata.symbol,
          finnhubSymbol: metadata.symbol,
        },
        'Building Finnhub metadata for token'
      );

      result.finnhub = {
        symbol: metadata.symbol,
        name: metadata.name,
        type: metadata.type,
        exchange: metadata.exchange,
        currency: metadata.currency,
      };
    }

    // Keep original metadata for reference
    result._original = metadata;

    const resultString = JSON.stringify(result);

    console.log('Final result object:', JSON.stringify(result, null, 2));
    console.log('Has coinGeckoId:', !!result.coinGeckoId);
    console.log('coinGeckoId value:', result.coinGeckoId);
    console.log('=== END BUILD PROVIDER METADATA DEBUG ===');

    this.logger.info(
      {
        symbol: metadata.symbol,
        provider: metadata.provider,
        hasCoinGeckoId: !!result.coinGeckoId,
      },
      'Built provider metadata for token'
    );

    return resultString;
  }

  /**
   * Check if an existing token should be updated with new provider metadata
   */
  private shouldUpdateTokenMetadata(
    existingToken: schema.Token,
    newMetadata: TokenMetadata
  ): boolean {
    try {
      // Parse existing provider metadata
      const existingMetadata = JSON.parse(existingToken.providerMetadata || '{}');

      // Check if the token has no provider metadata or incomplete metadata
      const hasNoProviderData = Object.keys(existingMetadata).length === 0;

      // Check if we have new provider data that's different/better
      const newProvider = newMetadata.provider;

      // Update if:
      // 1. Token has no existing provider metadata, OR
      // 2. Token doesn't have this specific provider's data
      return (
        hasNoProviderData || !existingMetadata[newProvider] || !existingMetadata[newProvider]?.id
      );
    } catch (error) {
      this.logger.warn(
        {
          tokenId: existingToken.id,
          symbol: existingToken.symbol,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Error parsing existing provider metadata'
      );
      return true; // Update on parse error to fix corrupted metadata
    }
  }

  /**
   * Update an existing token with new provider metadata
   */
  private async updateTokenWithProviderMetadata(
    tokenId: string,
    newMetadata: TokenMetadata
  ): Promise<void> {
    try {
      // Get current token data
      const [currentToken] = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.id, tokenId))
        .limit(1);

      if (!currentToken) {
        throw new Error(`Token ${tokenId} not found`);
      }

      // Parse existing metadata
      const existingMetadata = JSON.parse(currentToken.providerMetadata || '{}');

      // Add new provider data
      const provider = newMetadata.provider;
      if (provider && newMetadata.providerMetadata) {
        existingMetadata[provider] = {
          id: newMetadata.providerMetadata.id || newMetadata.providerMetadata.coinGeckoId,
          symbol: newMetadata.symbol,
          name: newMetadata.name,
          ...newMetadata.providerMetadata,
        };
      }

      // Update token in database
      await db
        .update(schema.tokens)
        .set({
          providerMetadata: JSON.stringify(existingMetadata),
        })
        .where(eq(schema.tokens.id, tokenId));

      this.logger.info(
        {
          tokenId: currentToken.id,
          symbol: currentToken.symbol,
          provider,
        },
        'Updated provider metadata for token'
      );
    } catch (error) {
      this.logger.error(
        {
          tokenId,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Failed to update token provider metadata'
      );
      throw error;
    }
  }
}
