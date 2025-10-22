import Container, { Service } from "typedi";
import { HoldingRepository } from "../../infrastructure/repositories/HoldingRepository";
import { TokenRepository } from "../../infrastructure/repositories/TokenRepository";
import { createComponentLogger } from "../../utils/logger";
import { AIService } from "../services/AIService";

const logger = createComponentLogger("use-case:parse-screenshot");

/**
 * Check if two symbols are similar (for fuzzy matching)
 * Uses simple heuristics: substring matching, common variations
 */
function areSymbolsSimilar(
  screenshotSymbol: string,
  dbSymbol: string
): boolean {
  const screenshot = screenshotSymbol.toLowerCase().trim();
  const db = dbSymbol.toLowerCase().trim();

  // Exact match (case insensitive)
  if (screenshot === db) {
    return true;
  }

  // One is substring of the other
  if (screenshot.includes(db) || db.includes(screenshot)) {
    return true;
  }

  // Handle common variations
  const variations: Array<[RegExp, string]> = [
    // Remove common suffixes/prefixes
    [/\.eth$/, ""], // Remove .eth suffix
    [/^eth\./, ""], // Remove eth. prefix
    [/-eth$/, ""], // Remove -eth suffix
    [/^eth-/, ""], // Remove eth- prefix
    [/\.com$/, ""], // Remove .com suffix
    [/\.org$/, ""], // Remove .org suffix
    [/\.io$/, ""], // Remove .io suffix
    [/\.ai$/, ""], // Remove .ai suffix
    [/\.fi$/, ""], // Remove .fi suffix
  ];

  for (const [pattern, replacement] of variations) {
    const normalizedScreenshot = screenshot.replace(pattern, replacement);
    const normalizedDb = db.replace(pattern, replacement);

    if (normalizedScreenshot === normalizedDb) {
      return true;
    }

    // Check substring after normalization
    if (
      normalizedScreenshot.includes(normalizedDb) ||
      normalizedDb.includes(normalizedScreenshot)
    ) {
      return true;
    }
  }

  return false;
}

export interface ParseScreenshotInput {
  imageBase64: string;
  provider?: "openai" | "perplexity" | "deepseek";
  accountType?: string;
  expectedCurrency?: string;
  context?: string;
  minConfidence?: number;
  accountId?: string; // Account ID to check for existing holdings
  userId: string; // User ID for security and scoping
}

export interface EnrichedParsedHolding {
  /** Token symbol (e.g., 'AAPL', 'BTC', 'USD') */
  symbol: string;
  /** Token name if identifiable (e.g., 'Apple Inc.', 'Bitcoin') */
  name?: string;
  /** Balance amount as string for Decimal.js precision */
  balance: string;
  /** Confidence level 0-1 for this extraction */
  confidence: number;
  /** Additional notes or context from the AI */
  notes?: string;
  /** Token ID from database if exactly one match found */
  tokenId?: string;
  /** Existing holding ID if a matching holding exists for this account */
  holdingId?: string;
  /** Existing holding balance if a matching holding exists */
  existingBalance?: string;
}

export interface ParseScreenshotResult {
  /** List of holdings found in the screenshot with optional token IDs */
  holdings: EnrichedParsedHolding[];
  /** Overall confidence in the parsing results */
  overallConfidence: number;
  /** General context or notes about the screenshot */
  context?: string;
  /** Currency detected as primary in the screenshot */
  detectedCurrency?: string;
}

/**
 * Use case for parsing screenshots and enriching holdings with database token IDs
 *
 * This use case:
 * - Parses screenshots using AI service
 * - Searches database for existing tokens by symbol
 * - Enriches holdings with token IDs when exactly one match is found
 */
@Service()
export class ParseScreenshotUseCase {
  private readonly aiService = Container.get(AIService);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);

  async execute(input: ParseScreenshotInput): Promise<ParseScreenshotResult> {
    logger.info(
      {
        provider: input.provider,
        accountType: input.accountType,
        expectedCurrency: input.expectedCurrency,
        accountId: input.accountId,
        userId: input.userId,
      },
      "Starting screenshot parsing and token enrichment"
    );

    // Parse screenshot using AI service
    const portfolio = await this.aiService.parseScreenshot(input.imageBase64, {
      provider: input.provider,
      accountType: input.accountType,
      expectedCurrency: input.expectedCurrency,
      context: input.context,
      minConfidence: input.minConfidence,
    });

    logger.info(
      {
        holdingsCount: portfolio.holdings.length,
        overallConfidence: portfolio.overallConfidence,
      },
      "AI parsing completed, enriching with token and holding data"
    );

    // Enrich holdings with token IDs and existing holding IDs
    const enrichedHoldings = await this.enrichHoldingsWithTokenAndHoldingData(
      portfolio.holdings,
      input.accountId,
      input.userId
    );

    const result: ParseScreenshotResult = {
      holdings: enrichedHoldings,
      overallConfidence: portfolio.overallConfidence,
      context: portfolio.context,
      detectedCurrency: portfolio.detectedCurrency,
    };

    logger.info(
      {
        enrichedHoldingsCount: enrichedHoldings.length,
        holdingsWithTokenId: enrichedHoldings.filter((h) => h.tokenId).length,
        holdingsWithHoldingId: enrichedHoldings.filter((h) => h.holdingId)
          .length,
      },
      "Screenshot parsing and enrichment completed"
    );

    return result;
  }

  /**
   * Enrich holdings with token IDs and existing holding IDs
   */
  private async enrichHoldingsWithTokenAndHoldingData(
    parsedHoldings: Array<{
      symbol: string;
      name?: string;
      balance: string;
      confidence: number;
      notes?: string;
    }>,
    accountId?: string,
    userId?: string
  ): Promise<EnrichedParsedHolding[]> {
    // Get existing holdings for the account if accountId is provided
    let existingHoldings: Array<{
      holding: { id: string; tokenId: string; balance: string };
      token: { id: string; symbol: string; name: string };
    }> = [];

    if (accountId && userId) {
      try {
        existingHoldings =
          await this.holdingRepository.findByUserWithFullDetails(
            userId,
            accountId
          );
        logger.debug(
          { accountId, userId, existingHoldingsCount: existingHoldings.length },
          "Retrieved existing holdings for account"
        );
      } catch (error) {
        logger.warn(
          {
            accountId,
            userId,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Failed to retrieve existing holdings"
        );
      }
    }

    // Group existing holdings by token ID for efficient lookup
    const holdingsByTokenId = new Map<string, typeof existingHoldings>();
    existingHoldings.forEach((holding) => {
      const tokenId = holding.holding.tokenId;
      if (!holdingsByTokenId.has(tokenId)) {
        holdingsByTokenId.set(tokenId, []);
      }
      holdingsByTokenId.get(tokenId)!.push(holding);
    });

    // Group existing holdings by token symbol for fallback matching
    const holdingsBySymbol = new Map<string, typeof existingHoldings>();
    existingHoldings.forEach((holding) => {
      const symbol = holding.token.symbol.toLowerCase();
      if (!holdingsBySymbol.has(symbol)) {
        holdingsBySymbol.set(symbol, []);
      }
      holdingsBySymbol.get(symbol)!.push(holding);
    });

    // Process each parsed holding
    const enrichedHoldings: EnrichedParsedHolding[] = [];

    for (const holding of parsedHoldings) {
      const enrichedHolding: EnrichedParsedHolding = { ...holding };

      try {
        // First, try to find token by symbol in database
        const token = await this.tokenRepository.findBySymbol(holding.symbol);

        if (token) {
          enrichedHolding.tokenId = token.id;
          logger.debug(
            {
              symbol: holding.symbol,
              tokenId: token.id,
              tokenName: token.name,
            },
            "Token found for holding"
          );

          // If we have existing holdings for this account, try to match by token ID
          if (accountId && holdingsByTokenId.has(token.id)) {
            const matchingHoldings = holdingsByTokenId.get(token.id)!;
            // Map first parsed holding to first existing holding, second to second, etc.
            const holdingIndex = enrichedHoldings.filter(
              (h) => h.tokenId === token.id
            ).length;
            if (
              holdingIndex < matchingHoldings.length &&
              matchingHoldings[holdingIndex]
            ) {
              enrichedHolding.holdingId =
                matchingHoldings[holdingIndex].holding.id;
              enrichedHolding.existingBalance =
                matchingHoldings[holdingIndex].holding.balance;
              logger.debug(
                {
                  symbol: holding.symbol,
                  tokenId: token.id,
                  holdingId: enrichedHolding.holdingId,
                  existingBalance: enrichedHolding.existingBalance,
                  holdingIndex,
                },
                "Matched existing holding by token ID"
              );
            }
          }
        }

        // Try symbol-based matching for existing holdings (regardless of whether token was found)
        if (accountId && !enrichedHolding.holdingId) {
          const symbolLower = holding.symbol.toLowerCase();

          // First try exact symbol match
          if (holdingsBySymbol.has(symbolLower)) {
            const matchingHoldings = holdingsBySymbol.get(symbolLower)!;
            // Map first parsed holding to first existing holding, second to second, etc.
            const holdingIndex = enrichedHoldings.filter(
              (h) => h.symbol.toLowerCase() === symbolLower && h.holdingId
            ).length;
            if (
              holdingIndex < matchingHoldings.length &&
              matchingHoldings[holdingIndex]
            ) {
              const matchingHolding = matchingHoldings[holdingIndex];
              enrichedHolding.tokenId = matchingHolding.token.id;
              enrichedHolding.holdingId = matchingHolding.holding.id;
              enrichedHolding.existingBalance = matchingHolding.holding.balance;
              logger.debug(
                {
                  symbol: holding.symbol,
                  matchedSymbol: matchingHolding.token.symbol,
                  tokenId: enrichedHolding.tokenId,
                  holdingId: enrichedHolding.holdingId,
                  existingBalance: enrichedHolding.existingBalance,
                  holdingIndex,
                },
                "Matched existing holding by exact symbol match"
              );
            }
          } else {
            // Try fuzzy symbol matching
            for (const [
              existingSymbol,
              matchingHoldings,
            ] of holdingsBySymbol.entries()) {
              if (
                areSymbolsSimilar(holding.symbol, existingSymbol) &&
                matchingHoldings.length > 0
              ) {
                // Use the first matching holding
                const matchingHolding = matchingHoldings[0];
                if (matchingHolding) {
                  enrichedHolding.tokenId = matchingHolding.token.id;
                  enrichedHolding.holdingId = matchingHolding.holding.id;
                  enrichedHolding.existingBalance =
                    matchingHolding.holding.balance;
                  logger.debug(
                    {
                      symbol: holding.symbol,
                      matchedSymbol: matchingHolding.token.symbol,
                      tokenId: enrichedHolding.tokenId,
                      holdingId: enrichedHolding.holdingId,
                      existingBalance: enrichedHolding.existingBalance,
                    },
                    "Matched existing holding by fuzzy symbol similarity"
                  );
                  break; // Stop after first match
                }
              }
            }
          }
        }
      } catch (error) {
        logger.warn(
          {
            symbol: holding.symbol,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Error enriching holding with token and holding data"
        );
        // Continue without tokenId/holdingId if enrichment fails
      }

      enrichedHoldings.push(enrichedHolding);
    }

    return enrichedHoldings;
  }
}
