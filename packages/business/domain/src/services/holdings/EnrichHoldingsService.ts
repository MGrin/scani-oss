import type { Token } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import Container, { Service } from 'typedi';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import type { ParsedAssetType } from '../ai/AIRouter';

const logger = createComponentLogger('service:enrich-holdings');

// Fuzzy symbol matching: substring + common suffix-stripping (e.g. .eth, .com).
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
    assetType?: ParsedAssetType;
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
  assetType?: ParsedAssetType;
  balance: string;
  confidence: number;
  notes?: string;
  tokenId?: string;
  holdingId?: string;
  existingBalance?: string;
}

// Resolves parsed-holding symbols to (tokenId, existing-holdingId) tuples.
// Shared by both screenshot parsing and file import pipelines.
@Service()
export class EnrichHoldingsService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);

  /**
   * Resolve a parsed symbol to a token row. When the parse step
   * classified an `assetType`, prefer the row of that exact type — a
   * fiat `USD` must resolve to the fiat US Dollar, not a same-named
   * stock ticker. Falls back to the type-blind `findBySymbol` when no
   * typed row exists or the holding wasn't classified.
   */
  private async resolveToken(symbol: string, assetType?: ParsedAssetType): Promise<Token | null> {
    if (assetType) {
      const tokenType = await this.tokenTypeRepository.findByCode(assetType);
      if (tokenType) {
        const typed = await this.tokenRepository.findBySymbolAndType(symbol, tokenType.id);
        if (typed) return typed;
      }
    }
    return this.tokenRepository.findBySymbol(symbol);
  }

  async enrich(input: EnrichHoldingsInput): Promise<EnrichedParsedHolding[]> {
    logger.info(
      {
        holdingsCount: input.holdings.length,
        accountId: input.accountId,
        userId: input.userId,
      },
      'Enriching holdings with token and holding data'
    );

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

    const enrichedHoldings: EnrichedParsedHolding[] = [];

    // Token resolution is independent per holding — resolve them all in
    // parallel up front. The matching loop below still runs sequentially
    // because its duplicate-index bookkeeping depends on prior iterations.
    const resolvedTokens = await Promise.all(
      input.holdings.map((h) =>
        this.resolveToken(h.symbol, h.assetType).catch((error) => {
          logger.warn(
            { symbol: h.symbol, error: error instanceof Error ? error.message : 'Unknown error' },
            'Error resolving token for holding'
          );
          return null;
        })
      )
    );

    for (const [index, holding] of input.holdings.entries()) {
      const enrichedHolding: EnrichedParsedHolding = { ...holding };

      try {
        const token = resolvedTokens[index] ?? null;

        if (token) {
          enrichedHolding.tokenId = token.id;
          // The resolved token is the row that will actually be created
          // for this holding — adopt its canonical symbol/name so the
          // review card never shows a stale or wrong-typed label (e.g. a
          // fiat USD row mislabelled with a stock ETF name).
          enrichedHolding.symbol = token.symbol;
          enrichedHolding.name = token.name;
          logger.debug({ symbol: holding.symbol, tokenId: token.id }, 'Token found for holding');

          if (input.accountId && holdingsByTokenId.has(token.id)) {
            const matchingHoldings = holdingsByTokenId.get(token.id)!;
            const holdingIndex = enrichedHoldings.filter((h) => h.tokenId === token.id).length;
            if (holdingIndex < matchingHoldings.length && matchingHoldings[holdingIndex]) {
              enrichedHolding.holdingId = matchingHoldings[holdingIndex].holding.id;
              enrichedHolding.existingBalance = matchingHoldings[holdingIndex].holding.balance;
            }
          }
        }

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
