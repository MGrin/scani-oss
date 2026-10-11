import type { AssetAllocationDimension, AssetAllocationItem } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { aggregateAllocation, shareOf, splitDebt } from '../../lib/portfolio/allocation';
import { extractPriceMap } from '../../lib/price-map';
import { getOrComputeFromCache } from '../../lib/request-cache';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';
import { GroupValuationService } from './GroupValuationService';
import {
  PortfolioValuationService,
  type PortfolioValueResult,
  type RequestCache,
} from './PortfolioValuationService';

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
    class: 'asset' | 'liability';
  };
  institution: {
    id: string;
    name: string;
    website: string | null;
    typeCode: string;
    typeName: string;
  };
};

type AllocationResult = {
  items: AssetAllocationItem[];
  /** Signed: `"0"`, or the negative sum of the holdings kept out of `items`. */
  totalDebt: string;
  /** Signed: the part of `totalDebt` held on liability accounts (SC-1640). */
  liabilityDebt: string;
  totalValue: string;
  baseCurrency: string;
};

@Service()
export class AssetAllocationService extends BaseService {
  private readonly portfolioService = Container.get(PortfolioValuationService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly groupValuation = Container.get(GroupValuationService);

  constructor() {
    super('AssetAllocationService');
  }

  async execute(
    userId: string,
    dimension: AssetAllocationDimension,
    userBaseCurrencyId?: string,
    requestCache?: RequestCache
  ): Promise<AllocationResult> {
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
  ): Promise<AllocationResult> {
    const priceMap = extractPriceMap(portfolioValue);

    if (dimension === 'group') {
      const { assets, totalDebt, liabilityDebt } = splitDebt(holdingsWithDetails, priceMap);
      return {
        items: await this.calculateGroupAllocation(
          assets,
          priceMap,
          new Decimal(portfolioValue.totalValue).minus(totalDebt),
          userId
        ),
        totalDebt: totalDebt.toString(),
        liabilityDebt: liabilityDebt.toString(),
        totalValue: portfolioValue.totalValue,
        baseCurrency: portfolioValue.baseCurrency,
      };
    }

    const { items, totalDebt, liabilityDebt } = aggregateAllocation(
      holdingsWithDetails,
      priceMap,
      dimension
    );
    return {
      items,
      totalDebt: totalDebt.toString(),
      liabilityDebt: liabilityDebt.toString(),
      totalValue: portfolioValue.totalValue,
      baseCurrency: portfolioValue.baseCurrency,
    };
  }

  /**
   * The group cut is the one dimension whose buckets overlap — a holding can be
   * in several groups, and can reach one both directly and through its account
   * — so the summing lives in `GroupValuationService` and this method only
   * shapes what comes back. Sharing it is the point: the group's page, the
   * groups list and this cut are then the same number by construction rather
   * than by three implementations agreeing.
   */
  private async calculateGroupAllocation(
    holdingsWithDetails: HoldingWithCompleteDetails[],
    priceMap: Map<string, string>,
    grossAssets: Decimal,
    userId: string
  ): Promise<AssetAllocationItem[]> {
    const { groups, ungrouped } = await this.groupValuation.valueByGroup(
      userId,
      holdingsWithDetails,
      priceMap
    );

    return [
      ...groups.map(({ group, total }) => ({
        id: group.id,
        code: group.name,
        name: group.name,
        value: total.value,
      })),
      { id: 'ungrouped', code: 'Ungrouped', name: 'Ungrouped', value: ungrouped.value },
    ]
      .map((item) => ({ ...item, percentage: shareOf(item.value, grossAssets) }))
      .filter((item) => new Decimal(item.value).greaterThan(0))
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)));
  }
}
