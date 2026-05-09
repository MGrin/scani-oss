import type { DatabaseTransaction } from '@scani/db';
import type { Holding, User } from '@scani/db/schema';
import type { HoldingWithDetails } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { GroupRepository } from '../../repositories/GroupRepository';
import { HoldingApyConfigRepository } from '../../repositories/HoldingApyConfigRepository';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';
import { PortfolioValuationService } from '../portfolio/PortfolioValuationService';

// HoldingQueryService — read-only queries against holdings. Mutations
// live in HoldingService; splitting them keeps each class focused on a
// single responsibility (CLAUDE.md / SOLID).
@Service()
export class HoldingQueryService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly groupRepository = Container.get(GroupRepository);
  private readonly holdingApyConfigRepository = Container.get(HoldingApyConfigRepository);
  private readonly holdingCoverageRepository = Container.get(HoldingCoverageRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  constructor() {
    super('HoldingQueryService');
  }

  async getHoldingsByAccountIdWithDetails(
    user: User,
    accountId?: string,
    includeHidden = false,
    requestCache?: Map<string, unknown>
  ): Promise<HoldingWithDetails[]> {
    if (!user.baseCurrencyId) {
      throw new Error('User does not have a base currency set');
    }

    this.logger.debug(
      { userId: user.id, accountId, includeHidden },
      'Getting holdings with details'
    );

    const [holdingsWithFullDetails, portfolioValue] = await Promise.all([
      this.holdingRepository.findByUserWithFullDetails(
        user.id,
        accountId,
        undefined,
        includeHidden
      ),
      this.portfolioValuationService.getUserPortfolioValue(
        user.id,
        user.baseCurrencyId,
        accountId,
        requestCache
      ),
    ]);

    if (holdingsWithFullDetails.length === 0) {
      return [];
    }

    const holdingIds = holdingsWithFullDetails.map(({ holding }) => holding.id);
    const [groupsMap, apyConfigsMap, coverageMap] = await Promise.all([
      this.groupRepository.findGroupsForHoldings(
        holdingsWithFullDetails.map(({ holding, account }) => ({
          id: holding.id,
          accountId: account.id,
        }))
      ),
      this.holdingApyConfigRepository.findByHoldingIds(holdingIds),
      this.holdingCoverageRepository.findManyByHoldingIds(holdingIds),
    ]);

    const portfolioPriceMap = new Map(
      portfolioValue.holdings.map((h) => [h.tokenSymbol, h.currentPrice || '0'])
    );

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

    const detailedHoldings: HoldingWithDetails[] = holdingsWithFullDetails.map(
      ({ holding, token, account, institution }) => {
        const currentPrice = portfolioPriceMap.get(token.symbol) || '0';
        // The `HoldingWithDetails` wire contract is `number`, so we must
        // convert. To make precision loss deterministic we round to a
        // bounded number of decimals before .toNumber():
        //   - quantity → 8 dp (industry standard for crypto satoshi-tier
        //     precision; equity quantities never exceed 4 dp anyway).
        //   - monetary value → 4 dp (1/100 of a cent — more than the UI
        //     ever renders).
        // Without this, large quantities × small prices (or vice versa)
        // can land on IEEE-754 representations whose decimal expansion
        // differs from the user's mental model. Bounded rounding is
        // worse-than-Decimal but better-than-unspecified.
        const currentValue = new Decimal(holding.balance)
          .mul(new Decimal(currentPrice))
          .toDecimalPlaces(4)
          .toNumber();

        // Cost basis is intentionally `currentValue` — a simplified
        // placeholder. Real FIFO cost basis lives in
        // `BalanceAtTimeService.getCostBasisFIFO` and is too expensive for
        // the list view. Using `opening_balance × currentPrice` here as a
        // proxy would produce near-zero gain/loss for every historical
        // holding, which is *more* misleading than the honest stub.
        const costBasis = currentValue;

        let priceInfo = priceMetadataMap.get(token.symbol);

        if (!priceInfo && token.id === user.baseCurrencyId) {
          priceInfo = {
            value: '1',
            timestamp: new Date().toISOString(),
            source: 'Base Currency',
          };
        }

        const holdingGroups = groupsMap.get(holding.id) || [];
        const apyConfig = apyConfigsMap.get(holding.id);

        const result: HoldingWithDetails = {
          id: holding.id,
          token: {
            id: token.id,
            symbol: token.symbol,
            name: token.name,
            type: token.typeName,
            typeCode: token.typeCode,
            iconUrl: token.iconUrl,
            isScamProbability: token.isScamProbability ?? 0,
          },
          amount: new Decimal(holding.balance).toDecimalPlaces(8).toNumber(),
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
          groups: holdingGroups.map((g) => ({
            id: g.id,
            name: g.name,
            color: g.color,
          })),
          lastUpdated: holding.lastUpdated.toISOString(),
          createdAt: holding.createdAt.toISOString(),
          isActive: holding.isActive,
          isHidden: holding.isHidden,
          source: holding.source,
        };

        if (apyConfig) {
          result.apyConfig = {
            id: apyConfig.id,
            annualRatePct: apyConfig.annualRatePct,
            payoutFrequency: apyConfig.payoutFrequency,
            payoutDayOfWeek: apyConfig.payoutDayOfWeek,
            payoutDayOfMonth: apyConfig.payoutDayOfMonth,
            payoutMonth: apyConfig.payoutMonth,
            lastPayoutAt: apyConfig.lastPayoutAt?.toISOString() ?? null,
            isActive: apyConfig.isActive,
          };
        }

        // Surface the reconciliation gap stamped by the import flow:
        // a synthesized negative `opening_balance_quantity` means the
        // ledger doesn't reach back far enough to explain the user's
        // current balance. The chart's `BalanceAtTimeService.clamp`
        // hides this by flooring at zero — the badge tells the user.
        const coverage = coverageMap.get(holding.id);
        if (coverage?.openingBalanceQuantity != null) {
          const opening = new Decimal(coverage.openingBalanceQuantity);
          if (opening.lt(0)) {
            result.dataIntegrity = {
              incompleteHistory: true,
              missingQuantity: opening.toString(),
              ...(coverage.reconciliationNotes ? { note: coverage.reconciliationNotes } : {}),
            };
          }
        }

        return result;
      }
    );

    this.logger.debug(
      { userId: user.id, accountId, count: detailedHoldings.length },
      accountId ? 'Account holdings with details retrieved' : 'Holdings with details retrieved'
    );

    return detailedHoldings;
  }

  async getHoldingsByAccountIdWithSummary(
    user: User,
    accountId?: string,
    includeHidden = false,
    requestCache?: Map<string, unknown>
  ): Promise<{
    holdings: HoldingWithDetails[];
    summary: {
      totalCount: number;
      activeCount: number;
      totalValue: string;
    };
  }> {
    const holdings = await this.getHoldingsByAccountIdWithDetails(
      user,
      accountId,
      includeHidden,
      requestCache
    );

    const activeHoldings = holdings.filter((h) => h.isActive);
    const totalValue = activeHoldings.reduce((sum, h) => sum + h.value, 0);

    return {
      holdings,
      summary: {
        totalCount: holdings.length,
        activeCount: activeHoldings.length,
        totalValue: totalValue.toString(),
      },
    };
  }

  async findByAccount(
    accountId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
    includeScamTokens = false
  ): Promise<Holding[]> {
    try {
      return await this.holdingRepository.findByAccount(
        accountId,
        transaction,
        includeHidden,
        includeScamTokens
      );
    } catch (error) {
      throw this.handleError(error, 'findByAccount');
    }
  }

  async getDistinctTokenIds(transaction?: DatabaseTransaction): Promise<string[]> {
    try {
      return await this.holdingRepository.getDistinctTokenIds(transaction);
    } catch (error) {
      throw this.handleError(error, 'getDistinctTokenIds');
    }
  }

  // `findByIdVisible` applies the dashboard's hidden-filter; the
  // unfiltered variant is `findById`.
  async findByIdVisible(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      return await this.holdingRepository.findByIdVisible(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'findByIdVisible');
    }
  }

  async findById(holdingId: string, transaction?: DatabaseTransaction): Promise<Holding | null> {
    try {
      return await this.holdingRepository.findById(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'findById');
    }
  }
}
