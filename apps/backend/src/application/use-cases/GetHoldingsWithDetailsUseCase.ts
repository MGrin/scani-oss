import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { createComponentLogger } from '../../utils/logger';
import { PortfolioValuationService } from '../services/PortfolioValuationService';

const logger = createComponentLogger('use-case:get-holdings-with-details');

export interface HoldingWithDetails {
  id: string;
  token: {
    id: string;
    symbol: string;
    name: string;
    type: string;
    typeCode: string;
    iconUrl?: string | null;
  };
  amount: number;
  value: number;
  costBasis: number;
  price?: {
    value: string;
    timestamp: string;
    source?: string;
  };
  account: {
    id: string;
    name: string;
    type: string;
    typeCode: string;
    institutionId: string;
  };
  institution: {
    id: string;
    name: string;
    type: string;
    typeCode: string;
    website?: string | null;
  };
  lastUpdated: string;
  createdAt: string;
}

/**
 * Use case for getting all holdings with full details
 *
 * This use case aggregates data from multiple repositories and services to provide
 * comprehensive holding information for the frontend Holdings page.
 *
 * Note: Performance/P&L calculations are not included as accurate computation methods
 * are not currently available.
 *
 * @param userId - The user ID
 * @param baseCurrencyId - Optional base currency ID
 * @param accountId - Optional account ID to filter holdings by specific account
 */
@Service()
export class GetHoldingsWithDetailsUseCase {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  async execute(
    userId: string,
    baseCurrencyId?: string,
    accountId?: string
  ): Promise<HoldingWithDetails[]> {
    logger.debug({ userId, accountId }, 'Getting holdings with details');

    // Parallel fetch: optimized holdings query + portfolio valuation
    const [holdingsWithFullDetails, portfolioValue] = await Promise.all([
      this.holdingRepository.findByUserWithFullDetails(userId, accountId),
      this.portfolioValuationService.getUserPortfolioValue(userId, baseCurrencyId, accountId),
    ]);

    if (holdingsWithFullDetails.length === 0) {
      return [];
    }

    // Create maps for efficient lookups - get individual token prices
    const portfolioPriceMap = new Map(
      portfolioValue.holdings.map((h) => [h.tokenSymbol, h.currentPrice || '0'])
    );

    // Create price metadata map keyed by token symbol
    const priceMetadataMap = new Map(
      portfolioValue.holdings
        .filter((h) => h.priceTimestamp && h.priceSource)
        .map((h) => [
          h.tokenSymbol,
          {
            value: h.currentPrice || '0',
            timestamp: h.priceTimestamp!.toISOString(),
            source: h.priceSource,
          },
        ])
    );

    // Build detailed holdings from pre-fetched data
    const detailedHoldings: HoldingWithDetails[] = holdingsWithFullDetails.map(
      ({ holding, token, account, institution }) => {
        // Get current price and calculate individual holding value
        const currentPrice = portfolioPriceMap.get(token.symbol) || '0';
        const currentValue = new Decimal(holding.balance).mul(new Decimal(currentPrice)).toNumber();

        // For now, cost basis is the same as current value (simplified)
        const costBasis = currentValue;

        // Get price information from portfolio valuation service
        const priceInfo = priceMetadataMap.get(token.symbol);

        return {
          id: holding.id,
          token: {
            id: token.id,
            symbol: token.symbol,
            name: token.name,
            type: token.typeName,
            typeCode: token.typeCode,
            iconUrl: token.iconUrl,
          },
          amount: new Decimal(holding.balance).toNumber(),
          value: currentValue,
          costBasis: costBasis,
          price: priceInfo,
          account: {
            id: account.id,
            name: account.name,
            type: account.typeName,
            typeCode: account.typeCode,
            institutionId: account.institutionId,
          },
          institution: {
            id: institution.id,
            name: institution.name,
            type: institution.typeName,
            typeCode: institution.typeCode,
            website: institution.website,
          },
          lastUpdated: holding.lastUpdated.toISOString(),
          createdAt: holding.createdAt.toISOString(),
        };
      }
    );

    logger.debug(
      { userId, accountId, count: detailedHoldings.length },
      accountId ? 'Account holdings with details retrieved' : 'Holdings with details retrieved'
    );

    return detailedHoldings;
  }
}
