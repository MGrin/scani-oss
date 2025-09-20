import Decimal from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import type { AIProviderManagerConfig, AIProviderType } from './ai/provider-manager';
import { AIProviderManager } from './ai/provider-manager';
import type { AIProviderResponse, ParsedHolding } from './ai/types';
import { pricingService } from './pricing';
import { tokenValidationService, type ValidationResult } from './token-validation';
import { userContextService } from './user-context-enhanced';

// Configuration constants to replace hardcoded values
const PARSING_CONFIG = {
  // Confidence thresholds
  MIN_CONFIDENCE_THRESHOLD: 0.4, // Configurable minimum confidence instead of hardcoded 0.5
  SIMILARITY_THRESHOLD: 0.3, // For database similarity queries

  // Transaction amount thresholds
  SIGNIFICANT_CHANGE_THRESHOLD: '0.000001', // For detecting significant balance changes
  UPDATE_CHANGE_THRESHOLD: '0.001', // For update operations

  // Default token decimals by type
  DEFAULT_DECIMALS: {
    fiat: 2,
    stock: 2,
    crypto: 8,
    'mutual-fund': 4,
    bond: 2,
    commodity: 4,
    etf: 2,
    other: 2,
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
   * Create holdings from parsed data
   */
  async createHoldingsFromParsing(
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
    errors: Array<{ symbol: string; error: string }>;
  }> {
    const created: Array<{
      holdingId: string;
      transactionId: string;
      tokenSymbol: string;
    }> = [];
    const errors: Array<{ symbol: string; error: string }> = [];

    // Process each holding in parallel with controlled concurrency
    const processHolding = async (
      holding: ParsedHoldingWithValidation
    ): Promise<{
      success: boolean;
      result?: {
        holdingId: string;
        transactionId: string;
        tokenSymbol: string;
      };
      error?: string;
      symbol: string;
    }> => {
      try {
        if (holding.errors.length > 0 && !options?.skipValidation) {
          return {
            success: false,
            error: `Validation errors: ${holding.errors.join(', ')}`,
            symbol: holding.symbol,
          };
        }

        let tokenId = holding.tokenId;

        // Create token if needed and allowed
        if (!holding.tokenExists && options?.createMissingTokens) {
          tokenId = await this.createTokenForHolding(holding);
        } else if (!holding.tokenExists) {
          return {
            success: false,
            error: 'Token does not exist and createMissingTokens is false',
            symbol: holding.symbol,
          };
        }

        if (!tokenId) {
          return {
            success: false,
            error: 'No valid token ID available',
            symbol: holding.symbol,
          };
        }

        // Create holding and opening balance transaction with live price fetching
        const result = await this.createHoldingWithTransaction(
          userId,
          accountId,
          tokenId,
          holding.balance,
          holding.notes,
          true // Enable live price fetching
        );

        return {
          success: true,
          result: {
            holdingId: result.holdingId,
            transactionId: result.transactionId,
            tokenSymbol: holding.symbol,
          },
          symbol: holding.symbol,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          symbol: holding.symbol,
        };
      }
    };

    // Process holdings with controlled concurrency
    const concurrencyLimit = PARSING_CONFIG.MAX_CONCURRENT_OPERATIONS;
    const results: Array<Awaited<ReturnType<typeof processHolding>>> = [];

    for (let i = 0; i < holdings.length; i += concurrencyLimit) {
      const batch = holdings.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(batch.map(processHolding));
      results.push(...batchResults);
    }

    // Process results
    for (const result of results) {
      if (result.success && result.result) {
        created.push(result.result);
      } else {
        errors.push({
          symbol: result.symbol,
          error: result.error || 'Unknown error',
        });
      }
    }

    return { created, errors };
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

    // Validate holdings first
    const validHoldings: ParsedHoldingWithValidation[] = [];
    for (const holding of holdings) {
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

      if (!holding.tokenExists && !options?.createMissingTokens) {
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

    // Pre-fetch all token prices in parallel to avoid delays in the transaction
    const uniqueSymbols = [...new Set(validHoldings.map((h) => h.symbol))];

    // Get user's base currency for price fetching
    const baseCurrency = await userContextService.getBaseCurrency(userId);

    try {
      // Get full token objects for pricing
      const tokens = await db
        .select()
        .from(schema.tokens)
        .where(inArray(schema.tokens.symbol, uniqueSymbols));

      await Promise.all(
        tokens.map(async (token) => {
          try {
            await pricingService.getTokenPrice(token, baseCurrency.symbol, new Date());
          } catch (priceError) {
            console.warn(`Failed to fetch price for ${token.symbol}:`, priceError);
          }
        })
      );
    } catch {
      console.warn('Some price fetching failed, continuing with transaction');
    }

    // Execute everything in a single atomic transaction
    return await db.transaction(async (trx) => {
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

      const existingHoldingsMap = new Map(existingHoldings.map((h) => [h.tokenId, h]));

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

      // Create missing tokens if needed
      const tokenCreationPromises: Promise<string>[] = [];
      for (const holding of validHoldings) {
        if (!holding.tokenExists && options?.createMissingTokens) {
          tokenCreationPromises.push(this.createTokenForHolding(holding, trx));
        } else if (holding.tokenExists && holding.tokenId) {
          const existingHolding = existingHoldingsMap.get(holding.tokenId);
          if (existingHolding) {
            holdingsToUpdate.push({ holding, existingHolding });
          } else {
            holdingsToCreate.push({ holding, tokenId: holding.tokenId });
          }
        }
      }

      // Wait for all token creations to complete
      const createdTokenIds = await Promise.all(tokenCreationPromises);
      let tokenCreationIndex = 0;

      // Add newly created tokens to the create list
      for (const holding of validHoldings) {
        if (!holding.tokenExists && options?.createMissingTokens) {
          const tokenId = createdTokenIds[tokenCreationIndex++];
          if (tokenId) {
            holdingsToCreate.push({ holding, tokenId });
          } else {
            errors.push({
              symbol: holding.symbol,
              error: 'Failed to create token',
            });
          }
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
          .returning();

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

      return { created, updated, errors };
    });
  }

  /**
   * Update existing holdings from parsed data
   */
  async updateHoldingsFromParsing(
    userId: string,
    accountId: string,
    holdings: ParsedHoldingWithValidation[]
  ): Promise<{
    updated: Array<{
      holdingId: string;
      transactionId?: string;
      tokenSymbol: string;
      change: string;
    }>;
    errors: Array<{ symbol: string; error: string }>;
  }> {
    const updated: Array<{
      holdingId: string;
      transactionId?: string;
      tokenSymbol: string;
      change: string;
    }> = [];
    const errors: Array<{ symbol: string; error: string }> = [];

    // Process updates in parallel with controlled concurrency
    const processUpdate = async (
      parsedHolding: ParsedHoldingWithValidation
    ): Promise<{
      success: boolean;
      result?: {
        holdingId: string;
        transactionId?: string;
        tokenSymbol: string;
        change: string;
      };
      error?: string;
      symbol: string;
    }> => {
      try {
        if (!parsedHolding.tokenExists || !parsedHolding.tokenId) {
          return {
            success: false,
            error: 'Token not found for update',
            symbol: parsedHolding.symbol,
          };
        }

        // Find existing holding
        const [existingHolding] = await db
          .select()
          .from(schema.holdings)
          .where(
            and(
              eq(schema.holdings.userId, userId),
              eq(schema.holdings.accountId, accountId),
              eq(schema.holdings.tokenId, parsedHolding.tokenId)
            )
          )
          .limit(1);

        if (!existingHolding) {
          return {
            success: false,
            error: 'Existing holding not found',
            symbol: parsedHolding.symbol,
          };
        }

        const oldBalance = new Decimal(existingHolding.balance);
        const newBalance = new Decimal(parsedHolding.balance);
        const change = newBalance.minus(oldBalance);

        // Only update if there's a significant change
        if (change.abs().greaterThan(PARSING_CONFIG.UPDATE_CHANGE_THRESHOLD)) {
          const result = await this.updateHoldingWithTransaction(
            existingHolding,
            newBalance.toString(),
            change.toString(),
            `Screenshot update: ${parsedHolding.notes || 'AI detected balance change'}`
          );

          return {
            success: true,
            result: {
              holdingId: existingHolding.id,
              transactionId: result?.transactionId,
              tokenSymbol: parsedHolding.symbol,
              change: change.toString(),
            },
            symbol: parsedHolding.symbol,
          };
        } else {
          // No significant change
          return {
            success: true,
            result: {
              holdingId: existingHolding.id,
              tokenSymbol: parsedHolding.symbol,
              change: '0',
            },
            symbol: parsedHolding.symbol,
          };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          symbol: parsedHolding.symbol,
        };
      }
    };

    // Process updates with controlled concurrency
    const concurrencyLimit = PARSING_CONFIG.MAX_CONCURRENT_OPERATIONS;
    const results: Array<Awaited<ReturnType<typeof processUpdate>>> = [];

    for (let i = 0; i < holdings.length; i += concurrencyLimit) {
      const batch = holdings.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(batch.map(processUpdate));
      results.push(...batchResults);
    }

    // Process results
    for (const result of results) {
      if (result.success && result.result) {
        updated.push(result.result);
      } else {
        errors.push({
          symbol: result.symbol,
          error: result.error || 'Unknown error',
        });
      }
    }

    return { updated, errors };
  }

  /**
   * Get available AI providers
   */
  getAvailableProviders() {
    return this.aiManager.getAvailableProviders();
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

      // Check if token exists
      const [existingToken] = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, holding.symbol.toUpperCase()))
        .limit(1);

      if (existingToken) {
        validation.tokenExists = true;
        validation.tokenId = existingToken.id;
      } else {
        validation.warnings.push('Token not found in database - will need to be created');

        // Use enhanced provider validation
        const providerValidation = await this.validateTokenWithProviders(holding.symbol);
        validation.suggestedTokenType = providerValidation.suggestedTokenType;
        validation.providerValidation = providerValidation;

        // Add appropriate warnings/errors based on provider validation
        if (providerValidation.exactMatch) {
          validation.warnings.push(
            `Exact match found in ${providerValidation.exactMatch.metadata?.provider} - will be created automatically`
          );
        } else if (
          providerValidation.similarMatches &&
          providerValidation.similarMatches.length > 0
        ) {
          // FORCE user selection when similar matches exist but no exact match
          validation.requiresUserSelection = true;
          validation.errors.push(
            `Token "${holding.symbol}" not found in database. Please select from ${
              providerValidation.similarMatches.length
            } similar provider tokens: ${providerValidation.similarMatches
              .map((m) => m.metadata?.symbol || 'unknown')
              .join(', ')}`
          );
        } else if (providerValidation.noMatches) {
          validation.errors.push(
            'Token not found in database or pricing providers - cannot proceed without manual token selection'
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

  /**
   * Resolve a token selection by updating the holding with user-selected provider token
   */
  async resolveTokenSelection(
    holdingSymbol: string,
    selectedProviderToken: ValidationResult
  ): Promise<ParsedHoldingWithValidation> {
    if (!selectedProviderToken.metadata) {
      throw new Error('Selected provider token must have metadata');
    }

    // Create the token in our database based on the user's selection
    const tokenType = this.mapProviderTypeToTokenType(
      selectedProviderToken.metadata.type || 'other'
    );

    const [typeRecord] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, tokenType))
      .limit(1);

    if (!typeRecord) {
      throw new Error(`Token type ${tokenType} not found`);
    }

    const tokenSymbol =
      selectedProviderToken.metadata.symbol?.toUpperCase() || holdingSymbol.toUpperCase();

    // Check if token already exists with this symbol and type
    const [existingToken] = await db
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, tokenSymbol) && eq(schema.tokens.typeId, typeRecord.id))
      .limit(1);

    if (existingToken) {
      console.log(`Token ${tokenSymbol} already exists, using existing token for user selection`);
      // Return updated holding with existing token
      return {
        symbol: holdingSymbol,
        name: selectedProviderToken.metadata.name || holdingSymbol,
        balance: '0', // Will be set when creating holdings
        suggestedTokenType: tokenType,
        confidence: 1.0, // High confidence since user selected
        providerValidation: {
          exactMatch: selectedProviderToken,
          similarMatches: [],
        },
        requiresUserSelection: false,
        tokenExists: true,
        tokenId: existingToken.id,
        errors: [],
        warnings: [],
      };
    }

    // Create the token using the selected provider metadata
    const [newToken] = await db
      .insert(schema.tokens)
      .values({
        symbol: selectedProviderToken.metadata.symbol?.toUpperCase() || holdingSymbol.toUpperCase(),
        name: selectedProviderToken.metadata.name || holdingSymbol,
        typeId: typeRecord.id,
        decimals: this.getDefaultDecimals(tokenType),
        isActive: true,
        providerMetadata: JSON.stringify({
          createdBy: 'user_selection',
          selectedFrom: 'screenshot_parsing',
          [selectedProviderToken.metadata.provider]: {
            ...selectedProviderToken.metadata.providerMetadata,
            symbol: selectedProviderToken.metadata.symbol,
            name: selectedProviderToken.metadata.name,
            type: selectedProviderToken.metadata.type,
          },
          validatedAt: new Date().toISOString(),
        }),
      })
      .returning();

    if (!newToken) {
      throw new Error('Failed to create token from user selection');
    }

    // Return updated holding with resolved token
    return {
      symbol: holdingSymbol,
      name: selectedProviderToken.metadata.name || holdingSymbol,
      balance: '0', // Will be set when processing
      confidence: 1.0, // User-selected, so maximum confidence
      tokenExists: true,
      tokenId: newToken.id,
      suggestedTokenType: tokenType,
      errors: [],
      warnings: [],
      requiresUserSelection: false,
      providerValidation: {
        exactMatch: selectedProviderToken,
        similarMatches: [],
        noMatches: false,
      },
    };
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

    // First, try exact validation (this tries both Finnhub and CoinGecko)
    const exactMatch = await validationService.validateToken(symbol);

    if (exactMatch.isValid && exactMatch.metadata) {
      // We found an exact match - convert provider type to our token type
      const tokenType = this.mapProviderTypeToTokenType(exactMatch.metadata.type);
      return {
        exactMatch,
        similarMatches: [],
        suggestedTokenType: tokenType,
        noMatches: false,
      };
    }

    // No exact match found, let's search for similar matches
    const similarMatches: ValidationResult[] = [];

    try {
      // Search Finnhub for similar tokens
      const finnhubMatches = await validationService.searchFinnhubTokens(symbol);
      similarMatches.push(...finnhubMatches.slice(0, 5)); // Limit to 5 suggestions

      // Search CoinGecko for similar tokens
      const coinGeckoMatches = await validationService.searchCoinGeckoTokens(symbol);
      similarMatches.push(...coinGeckoMatches.slice(0, 5)); // Limit to 5 suggestions
    } catch (error) {
      console.warn('Error searching for similar tokens:', error);
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
   */
  private mapProviderTypeToTokenType(providerType: string): string {
    switch (providerType.toLowerCase()) {
      case 'equity':
        return 'stock';
      case 'etf':
        return 'etf';
      case 'mutual fund':
        return 'mutual-fund';
      case 'bond':
        return 'bond';
      case 'commodity':
        return 'commodity';
      case 'crypto':
        return 'crypto';
      default:
        return 'other';
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
      console.warn('Database similarity search failed, using basic fallback:', error);
    }

    // Final intelligent fallback based on symbol characteristics
    return this.intelligentTokenTypeFallback(symbol);
  }

  /**
   * Get appropriate decimal places for a token type
   */
  private getDefaultDecimals(tokenType: string): number {
    return (
      PARSING_CONFIG.DEFAULT_DECIMALS[tokenType as keyof typeof PARSING_CONFIG.DEFAULT_DECIMALS] ||
      PARSING_CONFIG.DEFAULT_DECIMALS.other
    );
  }

  /**
   * Smart fallback that doesn't make hardcoded assumptions
   */
  private intelligentTokenTypeFallback(symbol: string): string {
    // Check if it's a known fiat currency by consulting our token types
    // This is more reliable than hardcoding currencies
    const symbolUpper = symbol.toUpperCase();

    // Use symbol length and pattern analysis but be more flexible
    if (/^[A-Z]{3}$/.test(symbolUpper)) {
      // 3-letter symbols could be fiat, but also could be stocks or crypto
      // Default to 'other' unless we have more context
      return 'other';
    }

    if (/^[A-Z]{1,5}$/.test(symbolUpper) && symbolUpper.length <= 4) {
      // Short alphabetic symbols are likely stocks
      return 'stock';
    }

    if (/^[A-Z0-9]{6,}$/.test(symbolUpper)) {
      // Longer alphanumeric symbols might be fund identifiers
      return 'mutual-fund';
    }

    // Default to other for unknown patterns
    return 'other';
  }

  private async createTokenForHolding(
    holding: ParsedHoldingWithValidation,
    trx?: Parameters<Parameters<typeof db.transaction>[0]>[0]
  ): Promise<string> {
    const dbInstance = trx || db;

    // Get token type
    const tokenType = holding.suggestedTokenType || 'other';
    const [typeRecord] = await dbInstance
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, tokenType))
      .limit(1);

    if (!typeRecord) {
      throw new Error(`Token type ${tokenType} not found`);
    }

    // Check if token already exists with this symbol and type
    const [existingToken] = await dbInstance
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(
        eq(schema.tokens.symbol, holding.symbol.toUpperCase()) &&
          eq(schema.tokens.typeId, typeRecord.id)
      )
      .limit(1);

    if (existingToken) {
      console.log(
        `Token ${holding.symbol} already exists, returning existing ID:`,
        existingToken.id
      );
      return existingToken.id;
    }

    // Use provider metadata if available from exact match
    let tokenName = holding.name || holding.symbol;
    let providerMetadata: Record<string, unknown> = {
      createdBy: 'screenshot_parsing',
      confidence: holding.confidence,
    };

    // If we have an exact match from providers, use that rich metadata
    if (holding.providerValidation?.exactMatch?.metadata) {
      const providerData = holding.providerValidation.exactMatch.metadata;
      tokenName = providerData.name || tokenName;

      // Include provider-specific metadata for pricing
      providerMetadata = {
        ...providerMetadata,
        [providerData.provider]: {
          symbol: providerData.symbol,
          name: providerData.name,
          type: providerData.type,
          currency: providerData.currency,
          exchange: providerData.exchange,
          description: providerData.description,
          ...providerData.providerMetadata,
        },
        validatedAt: new Date().toISOString(),
      };
    }

    // Create token
    const [newToken] = await dbInstance
      .insert(schema.tokens)
      .values({
        symbol: holding.symbol.toUpperCase(),
        name: tokenName,
        typeId: typeRecord.id,
        decimals: this.getDefaultDecimals(tokenType),
        isActive: true,
        providerMetadata: JSON.stringify(providerMetadata),
      })
      .returning();

    if (!newToken) {
      throw new Error('Failed to create token');
    }

    return newToken.id;
  }

  private async createHoldingWithTransaction(
    userId: string,
    accountId: string,
    tokenId: string,
    balance: string,
    notes?: string,
    livePriceFetching: boolean = false
  ): Promise<{ holdingId: string; transactionId: string }> {
    return await db.transaction(async (trx) => {
      // Create holding
      const [holding] = await trx
        .insert(schema.holdings)
        .values({
          userId,
          accountId,
          tokenId,
          balance,
          lastUpdated: new Date(),
        })
        .returning();

      if (!holding) {
        throw new Error('Failed to create holding');
      }

      // Create opening balance transaction if balance > 0
      let transactionId = '';

      if (new Decimal(balance).greaterThan(0)) {
        // Get deposit transaction type using user context service
        const depositType = await userContextService.getTransactionType('deposit');

        const [transaction] = await trx
          .insert(schema.transactions)
          .values({
            userId,
            holdingId: holding.id,
            typeId: depositType.id,
            amount: balance,
            fee: '0',
            description: notes || 'Opening balance from screenshot',
            timestamp: new Date(),
          })
          .returning();

        if (!transaction) {
          throw new Error('Failed to create transaction');
        }

        transactionId = transaction.id;

        // Fetch live price for the token if livePriceFetching is enabled
        if (livePriceFetching) {
          try {
            // Get full token for price fetching
            const [token] = await trx
              .select()
              .from(schema.tokens)
              .where(eq(schema.tokens.id, tokenId))
              .limit(1);

            if (token) {
              // Get user's base currency for price fetching
              const baseCurrency = await userContextService.getBaseCurrency(userId);

              // Use singleton pricing service
              // Fetch live price to ensure it's cached for later use
              await pricingService.getTokenPrice(token, baseCurrency.symbol, new Date());
            }
          } catch (priceError) {
            // Log price fetching errors but don't fail the transaction
            console.warn(`Failed to fetch price for token ${tokenId}:`, priceError);
          }
        }
      }

      return { holdingId: holding.id, transactionId };
    });
  }

  private async updateHoldingWithTransaction(
    existingHolding: typeof schema.holdings.$inferSelect,
    newBalance: string,
    changeAmount: string,
    description: string
  ): Promise<{ transactionId?: string }> {
    return await db.transaction(async (trx) => {
      // Update holding balance
      await trx
        .update(schema.holdings)
        .set({
          balance: newBalance,
          lastUpdated: new Date(),
        })
        .where(eq(schema.holdings.id, existingHolding.id));

      // Create transaction for the change if significant
      const change = new Decimal(changeAmount);

      if (change.abs().greaterThan(PARSING_CONFIG.UPDATE_CHANGE_THRESHOLD)) {
        const transactionTypeCode = change.greaterThan(0) ? 'deposit' : 'withdrawal';

        // Get transaction type using user context service
        const transactionType = await userContextService.getTransactionType(transactionTypeCode);

        const [transaction] = await trx
          .insert(schema.transactions)
          .values({
            userId: existingHolding.userId,
            holdingId: existingHolding.id,
            typeId: transactionType.id,
            amount: change.abs().toString(),
            fee: '0',
            description,
            timestamp: new Date(),
          })
          .returning();

        if (!transaction) {
          throw new Error('Failed to create balance adjustment transaction');
        }

        return { transactionId: transaction.id };
      }

      return {};
    });
  }
}
