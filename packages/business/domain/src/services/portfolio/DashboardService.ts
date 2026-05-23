import type { Holding, Token } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { extractPriceMap } from '../../lib/price-map';
import { getOrComputeFromCache } from '../../lib/request-cache';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';
import { AssetAllocationService } from './AssetAllocationService';
import { PortfolioValuationService, type RequestCache } from './PortfolioValuationService';

type PortfolioValueResult = {
  totalValue: string;
  baseCurrency: string;
  holdings: Array<{
    tokenSymbol: string;
    balance: string;
    // See `PortfolioValuationService` — null when unpriceable.
    currentPrice: string | null;
    value: string | null;
    priceTimestamp?: Date;
    priceSource?: string;
  }>;
};

type HoldingWithDetails = {
  holding: Holding;
  token: Token & { typeCode: string; typeName: string };
  account: {
    id: string;
    name: string;
    institutionId: string;
    typeCode: string;
    typeName: string;
  };
  institution: {
    id: string;
    name: string;
    website: string | null;
    typeCode: string;
    typeName: string;
  };
};

export interface DashboardOverview {
  portfolioValue: {
    totalValue: string;
    baseCurrency: string;
  };
  counts: {
    institutions: number;
    accounts: number;
    holdings: number;
  };
  topHoldings: Array<{
    id: string;
    symbol: string;
    name: string;
    balance: string;
    value: string;
    currentPrice: string;
    tokenType: string;
    tokenTypeCode: string;
    accountId: string;
    accountName: string;
    accountTypeCode: string;
    institutionId: string;
    institutionName: string;
    institutionWebsite?: string;
  }>;
  /**
   * Asset allocation by token type (default dimension)
   * Included to avoid a separate API call on dashboard load
   */
  assetAllocation: {
    items: Array<{
      id: string;
      code: string;
      name: string;
      value: string;
      percentage: string;
    }>;
    totalValue: string;
    baseCurrency: string;
  };
}

@Service()
export class DashboardService extends BaseService {
  private readonly portfolioService = Container.get(PortfolioValuationService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly assetAllocationUseCase = Container.get(AssetAllocationService);

  constructor() {
    super('DashboardService');
  }

  /**
   * Get comprehensive dashboard overview for a user
   * Optimized with parallel queries and single joined query for holdings
   *
   * @param userId - The user's ID
   * @param userBaseCurrencyId - Optional user's base currency ID
   * @param requestCache - Optional cache from tRPC context for deduplication
   */
  async getDashboardOverview(
    userId: string,
    userBaseCurrencyId?: string,
    requestCache?: RequestCache
  ): Promise<DashboardOverview> {
    this.logger.debug({ userId }, 'Fetching dashboard overview');

    // PERFORMANCE FIX: Use request cache for holdings to avoid duplicate fetches
    // Holdings are also fetched in AssetAllocationService, so cache them
    const holdingsCacheKey = `holdings:${userId}:complete`;

    // Parallel fetch: portfolio value and holdings with complete details (with caching)
    const [portfolioValue, holdingsWithDetails] = await Promise.all([
      this.portfolioService.getUserPortfolioValue(
        userId,
        userBaseCurrencyId,
        undefined,
        requestCache
      ),
      getOrComputeFromCache(requestCache, holdingsCacheKey, () =>
        this.holdingRepository.findByUserWithFullDetails(userId)
      ),
    ]);

    // Filter active holdings for counts (exclude inactive holdings)
    const activeHoldings = holdingsWithDetails.filter((h) => h.holding.isActive);

    // Extract unique accounts and institutions from active holdings only
    const accountMap = new Map<string, { id: string; name: string; institutionId: string }>();
    const institutionSet = new Set<string>();

    activeHoldings.forEach(({ account, institution }) => {
      if (!accountMap.has(account.id)) {
        accountMap.set(account.id, account);
      }
      institutionSet.add(institution.id);
    });

    const counts = {
      institutions: institutionSet.size,
      accounts: accountMap.size,
      holdings: activeHoldings.length,
    };

    this.logger.debug({ userId, counts }, 'Counts calculated');

    // Parallel calculation: top holdings and default asset allocation (token_type)
    // Asset allocation reuses the already-fetched portfolio data
    const [topHoldings, assetAllocation] = await Promise.all([
      this.calculateTopHoldings(holdingsWithDetails, portfolioValue),
      this.assetAllocationUseCase.calculateFromFetchedData(
        userId,
        'token_type',
        portfolioValue,
        holdingsWithDetails
      ),
    ]);

    this.logger.debug({ userId, topHoldingsCount: topHoldings.length }, 'Top holdings calculated');

    return {
      portfolioValue: {
        totalValue: portfolioValue.totalValue,
        baseCurrency: portfolioValue.baseCurrency,
      },
      counts,
      topHoldings,
      assetAllocation,
    };
  }

  /**
   * Calculate top holdings from pre-fetched data
   */
  private async calculateTopHoldings(
    holdingsWithDetails: Array<HoldingWithDetails>,
    portfolioValue: PortfolioValueResult
  ): Promise<DashboardOverview['topHoldings']> {
    // Extract token prices using helper method
    const priceMap = extractPriceMap(portfolioValue);

    // Build holdings with values calculated individually. priceMap
    // contains only PRICEABLE tokens — an absent key means we couldn't
    // resolve the price, so the holding doesn't qualify for the
    // "top holdings" list. Skip it entirely rather than coerce its
    // price to '0', which would silently rank unpriceable holdings
    // alongside genuine zero-value ones.
    const holdingsWithValues = holdingsWithDetails
      .filter(({ holding }) => holding.isActive)
      .flatMap(({ holding, token, account, institution }) => {
        const currentPrice = priceMap.get(token.symbol);
        if (!currentPrice) return [];
        const balance = new Decimal(holding.balance);
        const value = balance.mul(new Decimal(currentPrice)).toString();
        return [
          {
            holding,
            token,
            account,
            institution,
            value,
            currentPrice,
          },
        ];
      })
      .filter((h) => new Decimal(h.value).greaterThan(0));

    // Sort and take top 5
    const topHoldings = holdingsWithValues
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)))
      .slice(0, 5)
      .map((h, index) => ({
        id: `${h.holding.id}-${index}`,
        symbol: h.token.symbol,
        name: h.token.name,
        balance: h.holding.balance,
        value: h.value,
        currentPrice: h.currentPrice,
        tokenType: h.token.typeName,
        tokenTypeCode: h.token.typeCode,
        accountId: h.account.id,
        accountName: h.account.name,
        accountTypeCode: h.account.typeCode,
        institutionId: h.institution.id,
        institutionName: h.institution.name,
        institutionWebsite: h.institution.website || undefined,
      }));

    return topHoldings;
  }
}
