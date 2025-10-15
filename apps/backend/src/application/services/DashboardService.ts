import Decimal from "decimal.js";
import { Container, Service } from "typedi";
import type { Holding, Token } from "../../domain/entities";
import { TransactionTypeRepository } from "../../infrastructure/repositories/EnumRepositories";
import { HoldingRepository } from "../../infrastructure/repositories/HoldingRepository";
import { TokenRepository } from "../../infrastructure/repositories/TokenRepository";
import { TransactionRepository } from "../../infrastructure/repositories/TransactionRepository";
import { BaseService } from "./BaseService";
import { PortfolioValuationService } from "./PortfolioValuationService";

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

type HoldingWithDetails = {
  holding: Holding;
  token: Token & { typeCode: string; typeName: string };
  account: { id: string; name: string; institutionId: string };
  institution: { id: string; name: string };
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
    institutionId: string;
    institutionName: string;
  }>;
  assetAllocation: Array<{
    type: string;
    code: string;
    value: string;
    percentage: string;
  }>;
}

export interface RecentActivity {
  id: string;
  type: string;
  typeCode: string;
  tokenSymbol: string;
  amount: string;
  date: string;
  notes: string | null;
}

@Service()
export class DashboardService extends BaseService {
  private readonly portfolioService = Container.get(PortfolioValuationService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly transactionRepository = Container.get(TransactionRepository);
  private readonly transactionTypeRepository = Container.get(
    TransactionTypeRepository
  );

  constructor() {
    super("DashboardService");
  }

  /**
   * Get comprehensive dashboard overview for a user
   * Optimized with parallel queries and single joined query for holdings
   */
  async getDashboardOverview(
    userId: string,
    userBaseCurrencyId?: string
  ): Promise<DashboardOverview> {
    this.logger.debug({ userId }, "Fetching dashboard overview");

    // Parallel fetch: portfolio value and holdings with complete details
    const [portfolioValue, holdingsWithDetails] = await Promise.all([
      this.portfolioService.getUserPortfolioValue(userId, userBaseCurrencyId),
      this.holdingRepository.findByUserWithCompleteDetails(userId),
    ]);

    // Extract unique accounts and institutions from holdings data
    const accountMap = new Map<
      string,
      { id: string; name: string; institutionId: string }
    >();
    const institutionSet = new Set<string>();

    holdingsWithDetails.forEach(({ account, institution }) => {
      if (!accountMap.has(account.id)) {
        accountMap.set(account.id, account);
      }
      institutionSet.add(institution.id);
    });

    const counts = {
      institutions: institutionSet.size,
      accounts: accountMap.size,
      holdings: holdingsWithDetails.length,
    };

    this.logger.debug({ userId, counts }, "Counts calculated");

    // Parallel calculation of top holdings and asset allocation
    const [topHoldings, assetAllocation] = await Promise.all([
      this.calculateTopHoldings(holdingsWithDetails, portfolioValue),
      this.calculateAssetAllocation(holdingsWithDetails, portfolioValue),
    ]);

    this.logger.debug(
      { userId, topHoldingsCount: topHoldings.length },
      "Top holdings calculated"
    );
    this.logger.debug(
      { userId, assetAllocationCount: assetAllocation.length },
      "Asset allocation calculated"
    );

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
  ): Promise<DashboardOverview["topHoldings"]> {
    // Create maps from portfolio value data
    const portfolioValueMap = new Map(
      portfolioValue.holdings.map((h) => [h.tokenSymbol, h.value || "0"])
    );
    const portfolioPriceMap = new Map(
      portfolioValue.holdings.map((h) => [h.tokenSymbol, h.currentPrice || "0"])
    );

    // Build holdings with values
    const holdingsWithValues = holdingsWithDetails
      .map(({ holding, token, account, institution }) => {
        const value = portfolioValueMap.get(token.symbol) || "0";
        const currentPrice = portfolioPriceMap.get(token.symbol) || "0";

        return {
          holding,
          token,
          account,
          institution,
          value,
          currentPrice,
        };
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
        institutionId: h.institution.id,
        institutionName: h.institution.name,
      }));

    return topHoldings;
  }

  /**
   * Calculate asset allocation from pre-fetched data
   */
  private async calculateAssetAllocation(
    holdingsWithDetails: Array<HoldingWithDetails>,
    portfolioValue: PortfolioValueResult
  ): Promise<DashboardOverview["assetAllocation"]> {
    // Create value map from portfolio data
    const holdingValueMap = new Map(
      portfolioValue.holdings.map((h) => [h.tokenSymbol, h.value || "0"])
    );

    // Group by token type and calculate totals
    const typeAggregation = holdingsWithDetails.reduce((acc, { token }) => {
      const value = holdingValueMap.get(token.symbol) || "0";
      const decimalValue = new Decimal(value);

      if (!acc[token.typeCode]) {
        acc[token.typeCode] = {
          typeCode: token.typeCode,
          typeName: token.typeName,
          value: new Decimal(0),
        };
      }

      acc[token.typeCode]!.value = acc[token.typeCode]!.value.add(decimalValue);
      return acc;
    }, {} as Record<string, { typeCode: string; typeName: string; value: Decimal }>);

    const totalValue = new Decimal(portfolioValue.totalValue);
    const assetAllocation = Object.values(typeAggregation)
      .map((allocation) => ({
        type: allocation.typeName,
        code: allocation.typeCode,
        value: allocation.value.toString(),
        percentage: totalValue.greaterThan(0)
          ? allocation.value.div(totalValue).mul(100).toFixed(2)
          : "0",
      }))
      .filter((a) => new Decimal(a.value).greaterThan(0))
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)));

    return assetAllocation;
  }

  /**
   * Get recent transaction activity for a user
   */
  async getRecentActivity(
    userId: string,
    limit: number = 10
  ): Promise<RecentActivity[]> {
    this.logger.debug({ userId, limit }, "Fetching recent activity");

    const transactions = await this.transactionRepository.findByUser(userId);
    const limitedTransactions = transactions.slice(0, limit);

    if (limitedTransactions.length === 0) {
      return [];
    }

    // Get all holdings for these transactions to find tokenIds
    const holdingIds = [
      ...new Set(limitedTransactions.map((tx) => tx.holdingId)),
    ];
    const holdings = await this.holdingRepository.findByIds(holdingIds);
    const holdingMap = new Map(holdings.map((h) => [h.id, h]));

    // Get all unique token IDs
    const tokenIds = [...new Set(holdings.map((h) => h.tokenId))];
    const tokens = await this.tokenRepository.findByIds(tokenIds);
    const tokenMap = new Map(tokens.map((t) => [t.id, t]));

    // Get all unique transaction type IDs
    const typeIds = [...new Set(limitedTransactions.map((tx) => tx.typeId))];
    const transactionTypes = await this.transactionTypeRepository.findByIds(
      typeIds
    );
    const typeMap = new Map(transactionTypes.map((tt) => [tt.id, tt]));

    const activities: RecentActivity[] = limitedTransactions
      .map((tx) => {
        const holding = holdingMap.get(tx.holdingId);
        const token = holding ? tokenMap.get(holding.tokenId) : null;
        const txType = typeMap.get(tx.typeId);

        return {
          id: tx.id,
          type: txType?.name || "Unknown",
          typeCode: txType?.code || "unknown",
          tokenSymbol: token?.symbol || "Unknown",
          amount: tx.amount,
          date: tx.timestamp.toISOString(),
          notes: tx.description || null,
        };
      })
      .filter((activity) => activity.tokenSymbol !== "Unknown");

    this.logger.debug(
      { userId, activityCount: activities.length },
      "Recent activity fetched"
    );

    return activities;
  }
}
