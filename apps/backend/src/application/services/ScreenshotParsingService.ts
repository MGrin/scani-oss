import type { TokenValidationResult as ValidationResult } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type {
  AIProviderManagerConfig,
  AIProviderType,
} from '../../infrastructure/external-services/ai/provider-manager';
import { AIProviderManager } from '../../infrastructure/external-services/ai/provider-manager';
import type {
  AIProviderResponse,
  ParsedHolding,
} from '../../infrastructure/external-services/ai/types';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import { AccountService } from './AccountService';
import { BaseService } from './BaseService';
import { HoldingService } from './HoldingService';
import { PricingService } from './PricingService';
import { TokenService } from './TokenService';
import { TokenValidationService } from './TokenValidationService';
import { TransactionService } from './TransactionService';

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
  /** Explicit holding ID if user selected specific existing holding to update */
  existingHoldingId?: string;
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

/**
 * ScreenshotParsingService
 *
 * Refactored to use dependency injection and service layer
 * instead of direct database access
 */
@Service()
export class ScreenshotParsingService extends BaseService {
  private aiManager: AIProviderManager;
  private readonly tokenService = Container.get(TokenService);
  private readonly holdingService = Container.get(HoldingService);
  readonly _accountService = Container.get(AccountService);
  private readonly accountRepository = Container.get(AccountRepository);
  readonly _transactionService = Container.get(TransactionService);
  private readonly tokenValidationService = Container.get(TokenValidationService);
  readonly _pricingService = Container.get(PricingService);

  constructor() {
    super('ScreenshotParsingService');

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
    try {
      // Validate account belongs to user - get account with details from repository
      const account = await this.accountRepository.findWithDetails(options.accountId, userId);
      this.assertExists(account, 'Account not found or access denied');

      // Parse with AI (using default provider)
      const aiResponse = await this.aiManager.parseScreenshot(imageBase64, {
        accountType: account.typeName,
        expectedCurrency: options.expectedCurrency,
        context: `${options.context || ''} Account: ${account.name} at ${account.institutionName}`,
      });

      // Validate and enrich holdings
      const validatedHoldings = await this.validateHoldings(aiResponse.portfolio.holdings, userId);

      // Calculate summary statistics
      const summary = this.calculateSummary(validatedHoldings);

      return {
        aiResponse,
        holdings: validatedHoldings,
        account: {
          id: account.id,
          name: account.name,
          institutionName: account.institutionName,
        },
        summary,
      };
    } catch (error) {
      throw this.handleError(error, 'parseScreenshot');
    }
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
    try {
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

      // Re-check token existence for all symbols
      const allSymbols = [...new Set(holdings.map((h) => h.symbol.toUpperCase()))];
      const existingTokens = await this.tokenService.findTokensBySymbols(allSymbols);
      const existingTokenMap = new Map(
        existingTokens.map((token) => [token.symbol.toUpperCase(), token])
      );

      // Update holdings with correct token existence info
      for (const holding of holdings) {
        const existingToken = existingTokenMap.get(holding.symbol.toUpperCase());
        if (existingToken) {
          holding.tokenExists = true;
          holding.tokenId = existingToken.id;
          holding.requiresUserSelection = false;
          holding.errors = [];
          holding.warnings = [];
        } else {
          // Fix suggestedTokenType from provider metadata
          const exactMatch = holding.providerValidation?.exactMatch;
          if (exactMatch?.metadata?.provider === 'coingecko') {
            holding.suggestedTokenType = 'crypto';
          } else if (exactMatch?.metadata?.type) {
            holding.suggestedTokenType = this.mapProviderTypeToTokenType(exactMatch.metadata.type);
          }
        }
      }

      // Validate holdings first
      const validHoldings = this.validateHoldingsForProcessing(holdings, options);

      if (validHoldings.errors.length > 0) {
        errors.push(...validHoldings.errors);
      }

      if (validHoldings.holdings.length === 0) {
        return { created, updated, errors };
      }

      // Create missing tokens
      const tokensToCreate = validHoldings.holdings.filter((h) => !h.tokenExists && !h.tokenId);

      for (const holding of tokensToCreate) {
        try {
          const metadata = holding.providerValidation?.exactMatch?.metadata;
          const createdToken = await this.tokenService.createToken({
            symbol: holding.symbol,
            name: metadata?.name || holding.symbol,
            typeCode: holding.suggestedTokenType || 'stock',
            decimals:
              PARSING_CONFIG.DEFAULT_DECIMALS[
                (
                  holding.suggestedTokenType || 'other'
                ).toLowerCase() as keyof typeof PARSING_CONFIG.DEFAULT_DECIMALS
              ] || 8,
            providerMetadata: metadata
              ? {
                  provider: metadata.provider,
                  [metadata.provider]: {
                    symbol: metadata.symbol,
                    name: metadata.name,
                    ...(metadata.provider === 'coingecko' && {
                      // biome-ignore lint/suspicious/noExplicitAny: TokenValidationResponseDto metadata doesn't include id property for coingecko
                      id: (metadata as any).id || metadata.symbol,
                    }),
                    ...(metadata.provider === 'finnhub' && { type: metadata.type }),
                  },
                  validatedAt: new Date().toISOString(),
                }
              : undefined,
            isActive: true,
          });

          holding.tokenId = createdToken.id;
          holding.tokenExists = true;
        } catch (error) {
          errors.push({
            symbol: holding.symbol,
            error: `Failed to create token: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }

      // Get existing holdings for this account
      const existingHoldings = await this.holdingService.getHoldingsByAccountId(accountId, userId);
      const existingHoldingsById = new Map(existingHoldings.map((h) => [h.id, h]));
      const existingHoldingsByTokenId = new Map<string, typeof existingHoldings>();

      for (const holding of existingHoldings) {
        const items = existingHoldingsByTokenId.get(holding.tokenId) || [];
        items.push(holding);
        existingHoldingsByTokenId.set(holding.tokenId, items);
      }

      // Process holdings: separate creates and updates
      for (const holding of validHoldings.holdings) {
        if (!holding.tokenId) {
          errors.push({
            symbol: holding.symbol,
            error: 'Token ID not found after creation',
          });
          continue;
        }

        // Check if user explicitly selected an existing holding to update
        if (holding.existingHoldingId) {
          const targetHolding = existingHoldingsById.get(holding.existingHoldingId);
          if (!targetHolding) {
            errors.push({
              symbol: holding.symbol,
              error: 'Selected existing holding not found',
            });
            continue;
          }

          // Update existing holding
          try {
            await this.holdingService.updateHolding(
              targetHolding.id,
              { balance: holding.balance },
              userId
            );

            const change = new Decimal(holding.balance).minus(targetHolding.balance).toString();
            updated.push({
              holdingId: targetHolding.id,
              tokenSymbol: holding.symbol,
              change,
            });
          } catch (error) {
            errors.push({
              symbol: holding.symbol,
              error: `Failed to update holding: ${error instanceof Error ? error.message : 'Unknown error'}`,
            });
          }
        } else {
          // Check if holding already exists for this token
          const candidates = existingHoldingsByTokenId.get(holding.tokenId) || [];

          if (candidates.length === 1) {
            // Update existing holding
            const [targetHolding] = candidates;
            try {
              await this.holdingService.updateHolding(
                targetHolding!.id,
                { balance: holding.balance },
                userId
              );

              const change = new Decimal(holding.balance).minus(targetHolding!.balance).toString();
              updated.push({
                holdingId: targetHolding!.id,
                tokenSymbol: holding.symbol,
                change,
              });
            } catch (error) {
              errors.push({
                symbol: holding.symbol,
                error: `Failed to update holding: ${error instanceof Error ? error.message : 'Unknown error'}`,
              });
            }
          } else {
            // Create new holding
            try {
              const createdHolding = await this.holdingService.createHolding(
                {
                  accountId,
                  tokenId: holding.tokenId,
                  balance: holding.balance,
                  lastUpdated: new Date(),
                },
                userId
              );

              created.push({
                holdingId: createdHolding.id,
                transactionId: '', // Service handles transaction creation
                tokenSymbol: holding.symbol,
              });
            } catch (error) {
              errors.push({
                symbol: holding.symbol,
                error: `Failed to create holding: ${error instanceof Error ? error.message : 'Unknown error'}`,
              });
            }
          }
        }
      }

      return { created, updated, errors };
    } catch (error) {
      throw this.handleError(error, 'processHoldingsFromParsing');
    }
  }

  /**
   * Check if screenshot parsing is available
   */
  isAvailable(): boolean {
    return this.aiManager.hasAvailableProvider();
  }

  // Private helper methods

  private validateHoldingsForProcessing(
    holdings: ParsedHoldingWithValidation[],
    options?: { createMissingTokens?: boolean; skipValidation?: boolean }
  ): {
    holdings: ParsedHoldingWithValidation[];
    errors: Array<{ symbol: string; error: string }>;
  } {
    const validHoldings: ParsedHoldingWithValidation[] = [];
    const errors: Array<{ symbol: string; error: string }> = [];

    for (const holding of holdings) {
      // Basic field validation
      if (!holding.symbol || holding.symbol.trim() === '') {
        errors.push({
          symbol: holding.symbol || 'UNKNOWN',
          error: 'Symbol is required',
        });
        continue;
      }

      if (!holding.balance || holding.balance.trim() === '') {
        errors.push({
          symbol: holding.symbol,
          error: 'Balance is required',
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

      // Check for tokens requiring user selection
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

    return { holdings: validHoldings, errors };
  }

  private async validateHoldings(
    holdings: ParsedHolding[],
    _userId: string
  ): Promise<ParsedHoldingWithValidation[]> {
    const validated: ParsedHoldingWithValidation[] = [];

    // Batch query for all token symbols
    const uniqueSymbols = [...new Set(holdings.map((h) => h.symbol.toUpperCase()))];
    const existingTokens = await this.tokenService.findTokensBySymbols(uniqueSymbols);
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
            this.logWarning('Provider validation failed', { symbol, error });
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

      // Check if token exists
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
            validation.warnings.push(
              `Exact match found in ${providerValidation.exactMatch.metadata?.provider} - will be created automatically`
            );
          } else if (
            providerValidation.similarMatches &&
            providerValidation.similarMatches.length > 0
          ) {
            validation.requiresUserSelection = true;
            const matchList = providerValidation.similarMatches
              .slice(0, 5)
              .map((m: ValidationResult) => {
                const symbol = m.metadata?.symbol || 'unknown';
                const name = m.metadata?.name || '';
                const provider = m.metadata?.provider || '';
                return `${symbol}${name ? ` (${name})` : ''}${provider ? ` [${provider}]` : ''}`;
              })
              .join(', ');

            validation.errors.push(
              `Token "${holding.symbol}" not found exactly. Please select from similar matches: ${matchList}`
            );
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

      // Confidence validation
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

  private async validateTokenWithProviders(symbol: string): Promise<{
    exactMatch?: ValidationResult;
    similarMatches?: ValidationResult[];
    suggestedTokenType: string;
    noMatches: boolean;
  }> {
    // Check BOTH providers to detect ambiguity
    const finnhubExact = await this.tokenValidationService.validateToken(symbol, 'stock');
    const coinGeckoExact = await this.tokenValidationService.validateToken(symbol, 'crypto');

    const hasFinnhubExact = finnhubExact.isValid && finnhubExact.metadata;
    const hasCoinGeckoExact = coinGeckoExact.isValid && coinGeckoExact.metadata;

    // Check for ambiguity: both providers have exact matches
    if (hasFinnhubExact && hasCoinGeckoExact) {
      this.logInfo('Ambiguous symbol found in both providers', { symbol });
      return {
        exactMatch: undefined,
        similarMatches: [finnhubExact, coinGeckoExact],
        suggestedTokenType: 'crypto',
        noMatches: false,
      };
    }

    // Only one provider has exact match
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

    // No exact matches, search for similar
    const similarMatches: ValidationResult[] = [];

    try {
      const finnhubMatches = await this.tokenValidationService.searchFinnhubTokens(symbol);
      const coinGeckoMatches = await this.tokenValidationService.searchCoinGeckoTokens(symbol);

      // Check for exact symbol match in search results
      const finnhubExactMatch = finnhubMatches.find(
        (match) => match.metadata?.symbol.toUpperCase() === symbol.toUpperCase()
      );

      if (finnhubExactMatch) {
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

      similarMatches.push(...finnhubMatches.slice(0, 5));

      const coinGeckoExactMatch = coinGeckoMatches.find(
        (match) => match.metadata?.symbol.toUpperCase() === symbol.toUpperCase()
      );

      if (coinGeckoExactMatch) {
        if (finnhubMatches.length > 0) {
          // Ambiguous
          similarMatches.push(...coinGeckoMatches.slice(0, 5));
          return {
            exactMatch: undefined,
            similarMatches,
            suggestedTokenType: 'crypto',
            noMatches: false,
          };
        }

        return {
          exactMatch: coinGeckoExactMatch,
          similarMatches: [],
          suggestedTokenType: 'crypto',
          noMatches: false,
        };
      }

      similarMatches.push(...coinGeckoMatches.slice(0, 5));
    } catch (error) {
      this.logWarning('Error searching for similar tokens', { symbol, error });
    }

    // Determine suggested token type
    const suggestedTokenType = this.determineBestTokenType(symbol, similarMatches);

    return {
      exactMatch: undefined,
      similarMatches,
      suggestedTokenType,
      noMatches: similarMatches.length === 0,
    };
  }

  private mapProviderTypeToTokenType(providerType: string): string {
    switch (providerType.toLowerCase()) {
      case 'equity':
      case 'etp':
      case 'etf':
      case 'mutual fund':
      case 'bond':
      case 'commodity':
      case 'stock':
        return 'stock';
      case 'crypto':
      case 'cryptocurrency':
        return 'crypto';
      case 'fiat':
      case 'currency':
        return 'fiat';
      default:
        return 'stock';
    }
  }

  private determineBestTokenType(symbol: string, similarMatches: ValidationResult[]): string {
    if (similarMatches && similarMatches.length > 0) {
      const hasCoinGeckoMatches = similarMatches.some(
        (match) => match.metadata?.provider === 'coingecko'
      );

      if (hasCoinGeckoMatches) {
        return 'crypto';
      }

      const typeCount = new Map<string, number>();
      for (const match of similarMatches) {
        if (match.metadata?.type) {
          const mappedType = this.mapProviderTypeToTokenType(match.metadata.type);
          typeCount.set(mappedType, (typeCount.get(mappedType) || 0) + 1);
        }
      }

      if (typeCount.size > 0) {
        const entries = Array.from(typeCount.entries()).sort((a, b) => b[1] - a[1]);
        if (entries.length > 0 && entries[0]) {
          return entries[0][0];
        }
      }
    }

    return this.intelligentTokenTypeFallback(symbol);
  }

  private intelligentTokenTypeFallback(symbol: string): string {
    const symbolUpper = symbol.toUpperCase();

    // Common crypto symbols
    const commonCryptoSymbols = [
      'BTC',
      'ETH',
      'USDT',
      'BNB',
      'SOL',
      'USDC',
      'XRP',
      'DOGE',
      'ADA',
      'AVAX',
      'DOT',
      'MATIC',
      'LINK',
      'UNI',
      'LTC',
    ];

    if (commonCryptoSymbols.includes(symbolUpper)) {
      return 'crypto';
    }

    // Common fiat codes
    const commonFiatCodes = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'CHF', 'INR', 'KRW'];

    if (/^[A-Z]{3}$/.test(symbolUpper) && commonFiatCodes.includes(symbolUpper)) {
      return 'fiat';
    }

    // Default to stock for screenshot parsing
    return 'stock';
  }
}
