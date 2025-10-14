import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import {
  TokenTypeRepository,
  TransactionTypeRepository,
} from '../../infrastructure/repositories/EnumRepositories';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { TransactionRepository } from '../../infrastructure/repositories/TransactionRepository';
import { BaseService } from './BaseService';
import { PortfolioValuationService } from './PortfolioValuationService';

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
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly transactionRepository = Container.get(TransactionRepository);
  private readonly transactionTypeRepository = Container.get(TransactionTypeRepository);

  constructor() {
    super('DashboardService');
  }

  /**
   * Get comprehensive dashboard overview for a user
   */
  async getDashboardOverview(
    userId: string,
    userBaseCurrencyId?: string
  ): Promise<DashboardOverview> {
    this.logger.debug({ userId }, 'Fetching dashboard overview');

    // Get portfolio value with holdings (already optimized)
    const portfolioValue = await this.portfolioService.getUserPortfolioValue(
      userId,
      userBaseCurrencyId
    );

    // Get counts using repository methods
    const [accounts, holdings] = await Promise.all([
      this.accountRepository.findByUser(userId),
      this.holdingRepository.findByUser(userId),
    ]);

    // Get distinct institutions from user's accounts
    const distinctInstitutionIds = new Set(accounts.map((acc) => acc.institutionId));
    const institutionsCount = distinctInstitutionIds.size;

    const counts = {
      institutions: institutionsCount,
      accounts: accounts.length,
      holdings: holdings.length,
    };

    this.logger.debug({ userId, counts }, 'Counts calculated');

    // Calculate top holdings (top 5 by value)
    // First, create a map of token symbols to their values from portfolio calculation
    const portfolioValueMap = new Map(
      portfolioValue.holdings.map((h) => [h.tokenSymbol, h.value || '0'])
    );
    const portfolioPriceMap = new Map(
      portfolioValue.holdings.map((h) => [h.tokenSymbol, h.currentPrice || '0'])
    );

    // Get all holding records with their relationships
    const uniqueTokenIds = [...new Set(holdings.map((h) => h.tokenId))];
    const uniqueAccountIds = [...new Set(holdings.map((h) => h.accountId))];

    const [batchTokens, batchAccounts] = await Promise.all([
      this.tokenRepository.findByIds(uniqueTokenIds),
      this.accountRepository.findByIds(uniqueAccountIds),
    ]);

    const tokenMap = new Map(batchTokens.map((t) => [t.id, t]));
    const accountMap = new Map(batchAccounts.map((a) => [a.id, a]));

    const holdingsWithRelations = holdings.map((holding) => {
      const token = tokenMap.get(holding.tokenId);
      const account = accountMap.get(holding.accountId);

      if (!token || !account) {
        return null;
      }

      const value = portfolioValueMap.get(token.symbol) || '0';
      const currentPrice = portfolioPriceMap.get(token.symbol) || '0';

      return {
        holding,
        token,
        account,
        value,
        currentPrice,
      };
    });

    // Filter out null values and sort by value
    const validHoldingsWithRelations = holdingsWithRelations.filter(
      (h): h is NonNullable<typeof h> => h !== null && new Decimal(h.value).greaterThan(0)
    );

    const topValidHoldings = validHoldingsWithRelations
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)))
      .slice(0, 5);

    // Get token types and institutions for top holdings
    const uniqueTokenTypeIds = new Set(topValidHoldings.map((h) => h.token.typeId));
    const uniqueInstitutionIds = new Set(topValidHoldings.map((h) => h.account.institutionId));

    const [topTokenTypes, topInstitutions] = await Promise.all([
      this.tokenTypeRepository.findByIds([...uniqueTokenTypeIds]),
      this.institutionRepository.findByIds([...uniqueInstitutionIds]),
    ]);

    const topTokenTypeMap = new Map(topTokenTypes.map((tt) => [tt.id, tt]));
    const institutionDetailsMap = new Map(topInstitutions.map((inst) => [inst.id, inst]));

    // Build final top holdings array with all required information
    const topHoldings = topValidHoldings.map((h, index) => {
      const tokenType = topTokenTypeMap.get(h.token.typeId);
      const institution = institutionDetailsMap.get(h.account.institutionId);

      return {
        id: `${h.holding.id}-${index}`,
        symbol: h.token.symbol,
        name: h.token.name,
        balance: h.holding.balance,
        value: h.value,
        currentPrice: h.currentPrice,
        tokenType: tokenType?.name || 'Unknown',
        tokenTypeCode: tokenType?.code || 'UNKNOWN',
        accountId: h.account.id,
        accountName: h.account.name,
        institutionId: h.account.institutionId,
        institutionName: institution?.name || 'Unknown',
      };
    });

    this.logger.debug({ userId, topHoldingsCount: topHoldings.length }, 'Top holdings calculated');

    // Calculate asset allocation by token type
    const uniqueTokenIdsForAllocation = [...new Set(holdings.map((h) => h.tokenId))];
    const tokensForAllocation = await this.tokenRepository.findByIds(uniqueTokenIdsForAllocation);
    const tokenMapForAllocation = new Map(tokensForAllocation.map((t) => [t.id, t]));

    const holdingsWithTokens = holdings.map((holding) => {
      const token = tokenMapForAllocation.get(holding.tokenId);
      return { holding, token };
    });

    // Map holdings to their values from portfolio calculation
    const holdingValueMap = new Map(
      portfolioValue.holdings.map((h) => [h.tokenSymbol, h.value || '0'])
    );

    // Group by token type and calculate percentages
    const typeAggregation = holdingsWithTokens.reduce(
      (acc, { token }) => {
        if (!token) return acc;

        const value = holdingValueMap.get(token.symbol) || '0';
        const decimalValue = new Decimal(value);

        // Get token type - we'll need to fetch it
        const typeKey = token.typeId;

        if (!acc[typeKey]) {
          acc[typeKey] = {
            typeId: token.typeId,
            value: new Decimal(0),
          };
        }

        acc[typeKey].value = acc[typeKey].value.add(decimalValue);
        return acc;
      },
      {} as Record<
        string,
        {
          typeId: string;
          value: Decimal;
        }
      >
    );

    // Fetch token type details for all unique type IDs
    const typeIds = Object.values(typeAggregation).map((a) => a.typeId);
    const tokenTypes = await this.tokenTypeRepository.findByIds(typeIds);
    const tokenTypeMap = new Map(tokenTypes.map((tt) => [tt.id, tt]));

    const totalValue = new Decimal(portfolioValue.totalValue);
    const assetAllocation = Object.entries(typeAggregation)
      .map(([, allocation]) => {
        const tokenType = tokenTypeMap.get(allocation.typeId);
        return {
          type: tokenType?.name || 'Unknown',
          code: tokenType?.code || 'unknown',
          value: allocation.value.toString(),
          percentage: totalValue.greaterThan(0)
            ? allocation.value.div(totalValue).mul(100).toFixed(2)
            : '0',
        };
      })
      .filter((a) => new Decimal(a.value).greaterThan(0))
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)));

    this.logger.debug(
      { userId, assetAllocationCount: assetAllocation.length },
      'Asset allocation calculated'
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
   * Get recent transaction activity for a user
   */
  async getRecentActivity(userId: string, limit: number = 10): Promise<RecentActivity[]> {
    this.logger.debug({ userId, limit }, 'Fetching recent activity');

    const transactions = await this.transactionRepository.findByUser(userId);
    const limitedTransactions = transactions.slice(0, limit);

    if (limitedTransactions.length === 0) {
      return [];
    }

    // Get all holdings for these transactions to find tokenIds
    const holdingIds = [...new Set(limitedTransactions.map((tx) => tx.holdingId))];
    const holdings = await this.holdingRepository.findByIds(holdingIds);
    const holdingMap = new Map(holdings.map((h) => [h.id, h]));

    // Get all unique token IDs
    const tokenIds = [...new Set(holdings.map((h) => h.tokenId))];
    const tokens = await this.tokenRepository.findByIds(tokenIds);
    const tokenMap = new Map(tokens.map((t) => [t.id, t]));

    // Get all unique transaction type IDs
    const typeIds = [...new Set(limitedTransactions.map((tx) => tx.typeId))];
    const transactionTypes = await this.transactionTypeRepository.findByIds(typeIds);
    const typeMap = new Map(transactionTypes.map((tt) => [tt.id, tt]));

    const activities: RecentActivity[] = limitedTransactions
      .map((tx) => {
        const holding = holdingMap.get(tx.holdingId);
        const token = holding ? tokenMap.get(holding.tokenId) : null;
        const txType = typeMap.get(tx.typeId);

        return {
          id: tx.id,
          type: txType?.name || 'Unknown',
          typeCode: txType?.code || 'unknown',
          tokenSymbol: token?.symbol || 'Unknown',
          amount: tx.amount,
          date: tx.timestamp.toISOString(),
          notes: tx.description || null,
        };
      })
      .filter((activity) => activity.tokenSymbol !== 'Unknown');

    this.logger.debug({ userId, activityCount: activities.length }, 'Recent activity fetched');

    return activities;
  }
}
