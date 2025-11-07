import type { AssetAllocationDimension, AssetAllocationItem } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { BaseService } from '../services/BaseService';
import { PortfolioValuationService } from '../services/PortfolioValuationService';

type PortfolioValueResult = {
  totalValue: string;
  baseCurrency: string;
  holdings: Array<{
    tokenSymbol: string;
    balance: string;
    currentPrice?: string;
    value?: string;
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
    website?: string;
    typeCode: string;
    typeName: string;
  };
};

@Service()
export class GetAssetAllocationUseCase extends BaseService {
  private readonly portfolioService = Container.get(PortfolioValuationService);
  private readonly holdingRepository = Container.get(HoldingRepository);

  constructor() {
    super('GetAssetAllocationUseCase');
  }

  /**
   * Extract token prices from portfolio value data
   */
  private extractPriceMap(portfolioValue: PortfolioValueResult): Map<string, string> {
    const priceMap = new Map<string, string>();
    for (const portfolioHolding of portfolioValue.holdings) {
      const balance = new Decimal(portfolioHolding.balance);
      const value = new Decimal(portfolioHolding.value || '0');
      if (balance.greaterThan(0) && !priceMap.has(portfolioHolding.tokenSymbol)) {
        const price = value.div(balance);
        priceMap.set(portfolioHolding.tokenSymbol, price.toString());
      }
    }
    return priceMap;
  }

  async execute(
    userId: string,
    dimension: AssetAllocationDimension,
    userBaseCurrencyId?: string
  ): Promise<{
    items: AssetAllocationItem[];
    totalValue: string;
    baseCurrency: string;
  }> {
    this.logger.debug({ userId, dimension }, 'Getting asset allocation');

    // Fetch portfolio value and holdings with complete details
    const [portfolioValue, holdingsWithDetails] = await Promise.all([
      this.portfolioService.getUserPortfolioValue(userId, userBaseCurrencyId),
      this.holdingRepository.findByUserWithCompleteDetails(userId),
    ]);

    // Extract token prices
    const priceMap = this.extractPriceMap(portfolioValue);

    // Calculate allocation based on dimension
    const items = this.calculateAllocationByDimension(
      holdingsWithDetails,
      priceMap,
      portfolioValue.totalValue,
      dimension
    );

    return {
      items,
      totalValue: portfolioValue.totalValue,
      baseCurrency: portfolioValue.baseCurrency,
    };
  }

  private calculateAllocationByDimension(
    holdingsWithDetails: HoldingWithCompleteDetails[],
    priceMap: Map<string, string>,
    totalValue: string,
    dimension: AssetAllocationDimension
  ): AssetAllocationItem[] {
    const aggregationMap = new Map<
      string,
      { id: string; code: string; name: string; value: Decimal }
    >();

    // Aggregate by dimension
    for (const { holding, token, account, institution } of holdingsWithDetails) {
      const price = priceMap.get(token.symbol) || '0';
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
        default:
          throw new Error(
            `Unknown dimension: ${dimension}. Valid dimensions are: token, token_type, account, account_type, institution, institution_type`
          );
      }

      if (!aggregationMap.has(key)) {
        aggregationMap.set(key, { id, code, name, value: new Decimal(0) });
      }

      const existing = aggregationMap.get(key)!;
      existing.value = existing.value.add(value);
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
}
