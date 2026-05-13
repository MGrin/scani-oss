import type { AssetAllocationDimension, AssetAllocationItem } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { extractPriceMap } from '../../lib/price-map';
import { getOrComputeFromCache } from '../../lib/request-cache';
import { GroupRepository } from '../../repositories/GroupRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';
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

type HoldingWithCompleteDetails = {
  holding: {
    id: string;
    userId: string;
    accountId: string;
    tokenId: string;
    balance: string;
    source: string;
    isHidden: boolean;
    isActive: boolean;
    lastUpdated: Date;
    createdAt: Date;
  };
  token: {
    id: string;
    symbol: string;
    name: string;
    typeId: string;
    typeCode: string;
    typeName: string;
  };
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

@Service()
export class AssetAllocationService extends BaseService {
  private readonly portfolioService = Container.get(PortfolioValuationService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly groupRepository = Container.get(GroupRepository);

  constructor() {
    super('AssetAllocationService');
  }

  async execute(
    userId: string,
    dimension: AssetAllocationDimension,
    userBaseCurrencyId?: string,
    requestCache?: RequestCache
  ): Promise<{
    items: AssetAllocationItem[];
    totalValue: string;
    baseCurrency: string;
  }> {
    this.logger.debug({ userId, dimension }, 'Getting asset allocation');

    // PERFORMANCE FIX: Use request cache for holdings to avoid duplicate fetches
    // Holdings are fetched in DashboardService too, so cache them
    const holdingsCacheKey = `holdings:${userId}:complete`;

    // Fetch portfolio value and holdings with complete details (with caching)
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

    return this.calculateFromFetchedData(userId, dimension, portfolioValue, holdingsWithDetails);
  }

  /**
   * Calculate asset allocation from already-fetched data
   * Used internally to avoid duplicate fetches when called from dashboard
   */
  async calculateFromFetchedData(
    userId: string,
    dimension: AssetAllocationDimension,
    portfolioValue: PortfolioValueResult,
    holdingsWithDetails: HoldingWithCompleteDetails[]
  ): Promise<{
    items: AssetAllocationItem[];
    totalValue: string;
    baseCurrency: string;
  }> {
    // Extract token prices
    const priceMap = extractPriceMap(portfolioValue);

    // Calculate allocation based on dimension
    const items = await this.calculateAllocationByDimension(
      holdingsWithDetails,
      priceMap,
      portfolioValue.totalValue,
      dimension,
      userId
    );

    return {
      items,
      totalValue: portfolioValue.totalValue,
      baseCurrency: portfolioValue.baseCurrency,
    };
  }

  private async calculateAllocationByDimension(
    holdingsWithDetails: HoldingWithCompleteDetails[],
    priceMap: Map<string, string>,
    totalValue: string,
    dimension: AssetAllocationDimension,
    userId: string
  ): Promise<AssetAllocationItem[]> {
    const aggregationMap = new Map<
      string,
      { id: string; code: string; name: string; value: Decimal }
    >();

    // Aggregate by dimension - only include active holdings
    for (const { holding, token, account, institution } of holdingsWithDetails) {
      // Skip inactive holdings from allocation calculations
      if (!holding.isActive) {
        continue;
      }
      // priceMap only contains priceable tokens — an absent key means
      // we couldn't resolve the price. Skip such holdings from the
      // allocation (the corresponding slice would be 0 anyway, but
      // skipping makes the intent explicit and avoids confusing
      // "unpriceable" with "worth zero").
      const price = priceMap.get(token.symbol);
      if (!price) continue;
      const balance = new Decimal(holding.balance);
      const value = balance.mul(new Decimal(price));

      let key: string;
      let id: string;
      let code: string;
      let name: string;

      switch (dimension) {
        case 'token':
          key = token.id;
          id = token.id;
          code = token.symbol;
          name = token.name;
          break;
        case 'token_type':
          key = token.typeCode;
          id = token.typeId;
          code = token.typeCode;
          name = token.typeName;
          break;
        case 'account':
          key = account.id;
          id = account.id;
          code = account.name;
          name = account.name;
          break;
        case 'account_type':
          key = account.typeCode;
          id = account.typeCode;
          code = account.typeCode;
          name = account.typeName;
          break;
        case 'institution':
          key = institution.id;
          id = institution.id;
          code = institution.name;
          name = institution.name;
          break;
        case 'institution_type':
          key = institution.typeCode;
          id = institution.typeCode;
          code = institution.typeCode;
          name = institution.typeName;
          break;
        case 'group':
          // Skip - will be handled separately after the loop
          continue;
        default:
          throw new Error(
            `Unknown dimension: ${dimension}. Valid dimensions are: token, token_type, account, account_type, institution, institution_type, group`
          );
      }

      if (!aggregationMap.has(key)) {
        aggregationMap.set(key, { id, code, name, value: new Decimal(0) });
      }

      const existing = aggregationMap.get(key)!;
      existing.value = existing.value.add(value);
    }

    // Handle group dimension separately
    if (dimension === 'group') {
      return await this.calculateGroupAllocation(holdingsWithDetails, priceMap, totalValue, userId);
    }

    // Convert to array and calculate percentages
    const totalValueDecimal = new Decimal(totalValue);
    const items = Array.from(aggregationMap.values())
      .map((item) => ({
        id: item.id,
        code: item.code,
        name: item.name,
        value: item.value.toString(),
        percentage: totalValueDecimal.greaterThan(0)
          ? item.value.div(totalValueDecimal).mul(100).toFixed(2)
          : '0',
      }))
      .filter((item) => new Decimal(item.value).greaterThan(0))
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)));

    return items;
  }

  private async calculateGroupAllocation(
    holdingsWithDetails: HoldingWithCompleteDetails[],
    priceMap: Map<string, string>,
    totalValue: string,
    userId: string
  ): Promise<AssetAllocationItem[]> {
    // Get all groups for the user
    const groups = await this.groupRepository.findByUser(userId);

    // Create a map to aggregate values by group
    const groupAggregationMap = new Map<
      string,
      { id: string; code: string; name: string; color: string; value: Decimal }
    >();

    // Track holdings that have been assigned to at least one group
    const holdingsInGroups = new Set<string>();

    // For each group, get its holdings and calculate value
    for (const group of groups) {
      const holdingIds = await this.groupRepository.getHoldingsByGroupId(group.id);
      let groupValue = new Decimal(0);

      for (const holdingId of holdingIds) {
        const holdingWithDetails = holdingsWithDetails.find(
          (h) => h.holding.id === holdingId && h.holding.isActive
        );

        if (holdingWithDetails) {
          holdingsInGroups.add(holdingId);
          const { holding, token } = holdingWithDetails;
          const price = priceMap.get(token.symbol);
          if (!price) continue;
          const balance = new Decimal(holding.balance);
          const value = balance.mul(new Decimal(price));
          groupValue = groupValue.add(value);
        }
      }

      // Also get account-level groups
      const accountIds = await this.groupRepository.getAccountsByGroupId(group.id);
      for (const accountId of accountIds) {
        // Find all holdings in this account
        const accountHoldings = holdingsWithDetails.filter(
          (h) => h.holding.accountId === accountId && h.holding.isActive
        );

        for (const holdingWithDetails of accountHoldings) {
          const holdingId = holdingWithDetails.holding.id;
          // Only add if not already counted from direct holding assignment
          if (!holdingsInGroups.has(holdingId)) {
            holdingsInGroups.add(holdingId);
            const { holding, token } = holdingWithDetails;
            const price = priceMap.get(token.symbol);
            if (!price) continue;
            const balance = new Decimal(holding.balance);
            const value = balance.mul(new Decimal(price));
            groupValue = groupValue.add(value);
          }
        }
      }

      if (groupValue.greaterThan(0)) {
        groupAggregationMap.set(group.id, {
          id: group.id,
          code: group.name,
          name: group.name,
          color: group.color,
          value: groupValue,
        });
      }
    }

    // Add "Ungrouped" category for holdings not in any group
    let ungroupedValue = new Decimal(0);
    for (const { holding, token } of holdingsWithDetails) {
      if (!holding.isActive || holdingsInGroups.has(holding.id)) {
        continue;
      }

      const price = priceMap.get(token.symbol);
      if (!price) continue;
      const balance = new Decimal(holding.balance);
      const value = balance.mul(new Decimal(price));
      ungroupedValue = ungroupedValue.add(value);
    }

    if (ungroupedValue.greaterThan(0)) {
      groupAggregationMap.set('ungrouped', {
        id: 'ungrouped',
        code: 'Ungrouped',
        name: 'Ungrouped',
        color: '#64748b', // slate color for ungrouped
        value: ungroupedValue,
      });
    }

    // Convert to array and calculate percentages
    const totalValueDecimal = new Decimal(totalValue);
    const items = Array.from(groupAggregationMap.values())
      .map((item) => ({
        id: item.id,
        code: item.code,
        name: item.name,
        value: item.value.toString(),
        percentage: totalValueDecimal.greaterThan(0)
          ? item.value.div(totalValueDecimal).mul(100).toFixed(2)
          : '0',
      }))
      .filter((item) => new Decimal(item.value).greaterThan(0))
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)));

    return items;
  }
}
