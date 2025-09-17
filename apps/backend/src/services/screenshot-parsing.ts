import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import type { AIProviderManagerConfig, AIProviderType } from './ai/provider-manager';
import { AIProviderManager } from './ai/provider-manager';
import type { AIProviderResponse, ParsedHolding } from './ai/types';
import { TokenValidationService, type ValidationResult } from './token-validation';

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

    // Process each holding in a transaction
    for (const holding of holdings) {
      try {
        if (holding.errors.length > 0 && !options?.skipValidation) {
          errors.push({
            symbol: holding.symbol,
            error: `Validation errors: ${holding.errors.join(', ')}`,
          });
          continue;
        }

        let tokenId = holding.tokenId;

        // Create token if needed and allowed
        if (!holding.tokenExists && options?.createMissingTokens) {
          tokenId = await this.createTokenForHolding(holding);
        } else if (!holding.tokenExists) {
          errors.push({
            symbol: holding.symbol,
            error: 'Token does not exist and createMissingTokens is false',
          });
          continue;
        }

        if (!tokenId) {
          errors.push({
            symbol: holding.symbol,
            error: 'No valid token ID available',
          });
          continue;
        }

        // Create holding and opening balance transaction
        const result = await this.createHoldingWithTransaction(
          userId,
          accountId,
          tokenId,
          holding.balance,
          holding.notes
        );

        created.push({
          holdingId: result.holdingId,
          transactionId: result.transactionId,
          tokenSymbol: holding.symbol,
        });
      } catch (error) {
        errors.push({
          symbol: holding.symbol,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return { created, errors };
  }

  /**
   * Process holdings from parsed data - automatically determines create vs update
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
    // Get existing holdings for this account
    const existingHoldings = await db
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

    // Create a map of existing holdings by tokenId
    const existingHoldingsMap = new Map(existingHoldings.map((h) => [h.tokenId, h]));

    // Split holdings into create vs update
    const holdingsToCreate: ParsedHoldingWithValidation[] = [];
    const holdingsToUpdate: ParsedHoldingWithValidation[] = [];

    for (const holding of holdings) {
      if (holding.tokenExists && holding.tokenId && existingHoldingsMap.has(holding.tokenId)) {
        holdingsToUpdate.push(holding);
      } else {
        holdingsToCreate.push(holding);
      }
    }

    // Process creates
    const createResult = await this.createHoldingsFromParsing(
      userId,
      accountId,
      holdingsToCreate,
      options
    );

    // Process updates
    const updateResult = await this.updateHoldingsFromParsing(userId, accountId, holdingsToUpdate);

    // Combine results
    return {
      created: createResult.created,
      updated: updateResult.updated,
      errors: [...createResult.errors, ...updateResult.errors],
    };
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

    for (const parsedHolding of holdings) {
      try {
        if (!parsedHolding.tokenExists || !parsedHolding.tokenId) {
          errors.push({
            symbol: parsedHolding.symbol,
            error: 'Token not found for update',
          });
          continue;
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
          errors.push({
            symbol: parsedHolding.symbol,
            error: 'Existing holding not found',
          });
          continue;
        }

        const oldBalance = new Decimal(existingHolding.balance);
        const newBalance = new Decimal(parsedHolding.balance);
        const change = newBalance.minus(oldBalance);

        // Only update if there's a significant change
        if (change.abs().greaterThan('0.001')) {
          const result = await this.updateHoldingWithTransaction(
            existingHolding,
            newBalance.toString(),
            change.toString(),
            `Screenshot update: ${parsedHolding.notes || 'AI detected balance change'}`
          );

          updated.push({
            holdingId: existingHolding.id,
            transactionId: result?.transactionId,
            tokenSymbol: parsedHolding.symbol,
            change: change.toString(),
          });
        } else {
          // No significant change
          updated.push({
            holdingId: existingHolding.id,
            tokenSymbol: parsedHolding.symbol,
            change: '0',
          });
        }
      } catch (error) {
        errors.push({
          symbol: parsedHolding.symbol,
          error: error instanceof Error ? error.message : 'Unknown error',
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
          validation.warnings.push(
            `${providerValidation.similarMatches.length} similar tokens found in providers - user selection required`
          );
        } else if (providerValidation.noMatches) {
          validation.warnings.push(
            'No matches found in pricing providers - manual token selection required'
          );
        }
      }

      // Confidence validation
      if (holding.confidence < 0.5) {
        validation.warnings.push('Low confidence in AI extraction');
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
   * Returns validation result with exact matches and similar suggestions
   */
  private async validateTokenWithProviders(symbol: string): Promise<{
    exactMatch?: ValidationResult;
    similarMatches?: ValidationResult[];
    suggestedTokenType: string;
    noMatches: boolean;
  }> {
    const validationService = new TokenValidationService();

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

      // TODO: Add CoinGecko search when available
      // For now, we could search CoinGecko by doing a general search
    } catch (error) {
      console.warn('Error searching for similar tokens:', error);
    }

    // Determine suggested token type based on simple heuristics as fallback
    const suggestedTokenType = this.guessTokenTypeByHeuristics(symbol);

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
   * Simple heuristics for token type (fallback when provider validation fails)
   */
  private guessTokenTypeByHeuristics(symbol: string): string {
    // Simple heuristics for token type
    if (/^[A-Z]{3}$/.test(symbol) && ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'].includes(symbol)) {
      return 'fiat';
    }
    if (['BTC', 'ETH', 'ADA', 'DOT', 'LINK'].includes(symbol)) {
      return 'crypto';
    }
    if (symbol.length <= 5) {
      return 'stock'; // Most stock symbols are short
    }
    return 'other';
  }

  private async createTokenForHolding(holding: ParsedHoldingWithValidation): Promise<string> {
    // Get token type
    const tokenType = holding.suggestedTokenType || 'other';
    const [typeRecord] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, tokenType))
      .limit(1);

    if (!typeRecord) {
      throw new Error(`Token type ${tokenType} not found`);
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
    const [newToken] = await db
      .insert(schema.tokens)
      .values({
        symbol: holding.symbol.toUpperCase(),
        name: tokenName,
        typeId: typeRecord.id,
        decimals: 2, // Default precision
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
    notes?: string
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
        const [depositType] = await trx
          .select()
          .from(schema.transactionTypes)
          .where(eq(schema.transactionTypes.code, 'deposit'))
          .limit(1);

        if (!depositType) {
          throw new Error('Deposit transaction type not found');
        }

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

      if (change.abs().greaterThan('0.001')) {
        const transactionTypeCode = change.greaterThan(0) ? 'deposit' : 'withdrawal';

        const [transactionType] = await trx
          .select()
          .from(schema.transactionTypes)
          .where(eq(schema.transactionTypes.code, transactionTypeCode))
          .limit(1);

        if (!transactionType) {
          throw new Error(`Transaction type ${transactionTypeCode} not found`);
        }

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
