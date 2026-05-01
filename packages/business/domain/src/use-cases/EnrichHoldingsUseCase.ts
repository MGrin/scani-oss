import { createComponentLogger } from '@scani/logging';
import Container, { Service } from 'typedi';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { TokenRepository } from '../repositories/TokenRepository';

const logger = createComponentLogger('use-case:enrich-holdings');

/**
 * Check if two symbols are similar (for fuzzy matching)
 * Uses simple heuristics: substring matching, common variations
 */
function areSymbolsSimilar(screenshotSymbol: string, dbSymbol: string): boolean {
  const screenshot = screenshotSymbol.toLowerCase().trim();
  const db = dbSymbol.toLowerCase().trim();

  if (screenshot === db) return true;
  if (screenshot.includes(db) || db.includes(screenshot)) return true;

  const variations: Array<[RegExp, string]> = [
    [/\.eth$/, ''],
    [/^eth\./, ''],
    [/-eth$/, ''],
    [/^eth-/, ''],
    [/\.com$/, ''],
    [/\.org$/, ''],
    [/\.io$/, ''],
    [/\.ai$/, ''],
    [/\.fi$/, ''],
  ];

  for (const [pattern, replacement] of variations) {
    const normalizedScreenshot = screenshot.replace(pattern, replacement);
    const normalizedDb = db.replace(pattern, replacement);

    if (normalizedScreenshot === normalizedDb) return true;
    if (
      normalizedScreenshot.includes(normalizedDb) ||
      normalizedDb.includes(normalizedScreenshot)
    ) {
      return true;
    }
  }

  return false;
}

export interface EnrichHoldingsInput {
  holdings: Array<{
    symbol: string;
    name?: string;
    balance: string;
    confidence: number;
    notes?: string;
  }>;
  accountId?: string;
  userId: string;
}

export interface EnrichedParsedHolding {
  symbol: string;
  name?: string;
  balance: string;
  confidence: number;
  notes?: string;
  tokenId?: string;
  holdingId?: string;
  existingBalance?: string;
}

/**
 * Enriches parsed holdings with token IDs and existing holding IDs from the database.
 * Shared by both screenshot parsing and file import pipelines.
 */
@Service()
export class EnrichHoldingsUseCase {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);

  async execute(input: EnrichHoldingsInput): Promise<EnrichedParsedHolding[]> {
    logger.info(
      {
        holdingsCount: input.holdings.length,
        accountId: input.accountId,
        userId: input.userId,
      },
      'Enriching holdings with token and holding data'
    );

    // Get existing holdings for the account if accountId is provided
    let existingHoldings: Array<{
      holding: { id: string; tokenId: string; balance: string };
      token: { id: string; symbol: string; name: string };
    }> = [];

    if (input.accountId && input.userId) {
      try {
        existingHoldings = await this.holdingRepository.findByUserWithFullDetails(
          input.userId,
          input.accountId
        );
        logger.debug(
          { accountId: input.accountId, existingHoldingsCount: existingHoldings.length },
          'Retrieved existing holdings for account'
        );
      } catch (error) {
        logger.warn(
          {
            accountId: input.accountId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to retrieve existing holdings'
        );
      }
    }

    // Group existing holdings by token ID and symbol for efficient lookup
    const holdingsByTokenId = new Map<string, typeof existingHoldings>();
    const holdingsBySymbol = new Map<string, typeof existingHoldings>();
    for (const holding of existingHoldings) {
      const tokenId = holding.holding.tokenId;
      if (!holdingsByTokenId.has(tokenId)) holdingsByTokenId.set(tokenId, []);
      holdingsByTokenId.get(tokenId)!.push(holding);

      const symbol = holding.token.symbol.toLowerCase();
      if (!holdingsBySymbol.has(symbol)) holdingsBySymbol.set(symbol, []);
      holdingsBySymbol.get(symbol)!.push(holding);
    }

    // Process each parsed holding
    const enrichedHoldings: EnrichedParsedHolding[] = [];

    for (const holding of input.holdings) {
      const enrichedHolding: EnrichedParsedHolding = { ...holding };

      try {
        // First, try to find token by symbol in database
        const token = await this.tokenRepository.findBySymbol(holding.symbol);

        if (token) {
          enrichedHolding.tokenId = token.id;
          logger.debug({ symbol: holding.symbol, tokenId: token.id }, 'Token found for holding');

          // Match by token ID to existing holdings
          if (input.accountId && holdingsByTokenId.has(token.id)) {
            const matchingHoldings = holdingsByTokenId.get(token.id)!;
            const holdingIndex = enrichedHoldings.filter((h) => h.tokenId === token.id).length;
            if (holdingIndex < matchingHoldings.length && matchingHoldings[holdingIndex]) {
              enrichedHolding.holdingId = matchingHoldings[holdingIndex].holding.id;
              enrichedHolding.existingBalance = matchingHoldings[holdingIndex].holding.balance;
            }
          }
        }

        // Try symbol-based matching for existing holdings
        if (input.accountId && !enrichedHolding.holdingId) {
          const symbolLower = holding.symbol.toLowerCase();

          if (holdingsBySymbol.has(symbolLower)) {
            const matchingHoldings = holdingsBySymbol.get(symbolLower)!;
            const holdingIndex = enrichedHoldings.filter(
              (h) => h.symbol.toLowerCase() === symbolLower && h.holdingId
            ).length;
            if (holdingIndex < matchingHoldings.length && matchingHoldings[holdingIndex]) {
              const matchingHolding = matchingHoldings[holdingIndex];
              enrichedHolding.tokenId = matchingHolding.token.id;
              enrichedHolding.holdingId = matchingHolding.holding.id;
              enrichedHolding.existingBalance = matchingHolding.holding.balance;
            }
          } else {
            // Fuzzy symbol matching
            for (const [existingSymbol, matchingHoldings] of holdingsBySymbol.entries()) {
              if (
                areSymbolsSimilar(holding.symbol, existingSymbol) &&
                matchingHoldings.length > 0 &&
                matchingHoldings[0]
              ) {
                enrichedHolding.tokenId = matchingHoldings[0].token.id;
                enrichedHolding.holdingId = matchingHoldings[0].holding.id;
                enrichedHolding.existingBalance = matchingHoldings[0].holding.balance;
                break;
              }
            }
          }
        }
      } catch (error) {
        logger.warn(
          {
            symbol: holding.symbol,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Error enriching holding'
        );
      }

      enrichedHoldings.push(enrichedHolding);
    }

    logger.info(
      {
        total: enrichedHoldings.length,
        withTokenId: enrichedHoldings.filter((h) => h.tokenId).length,
        withHoldingId: enrichedHoldings.filter((h) => h.holdingId).length,
      },
      'Holdings enrichment completed'
    );

    return enrichedHoldings;
  }
}
