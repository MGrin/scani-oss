import type { CreateHoldingInput, HoldingWithDetails } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { Holding, User } from '../domain/entities';
import { AccountRepository } from '../repositories/AccountRepository';
import type { DatabaseTransaction } from '../repositories/BaseRepository';
import { GroupRepository } from '../repositories/GroupRepository';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { BaseService } from './BaseService';
import { PortfolioValuationService } from './PortfolioValuationService';

/**
 * HoldingService
 *
 * Handles holding operations.
 */
@Service()
export class HoldingService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly groupRepository = Container.get(GroupRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  constructor() {
    super('HoldingService');
  }

  async createHolding(data: CreateHoldingInput, userId: string): Promise<Holding> {
    try {
      this.logDebug('Creating holding', {
        accountId: data.accountId,
        tokenId: data.tokenId,
        balance: data.balance,
      });

      this.validateRequiredFields(data, ['accountId', 'tokenId', 'balance']);

      // Validate balance
      const balance = new Decimal(data.balance);
      if (balance.isNegative()) {
        throw new Error('Balance cannot be negative');
      }

      // Verify account exists and belongs to user
      const account = await this.accountRepository.findById(data.accountId);
      this.assertExists(account, `Account with ID ${data.accountId} not found`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Account does not belong to user');
      }

      // Check if holding already exists
      const existingHolding = await this.holdingRepository.findByAccountAndToken(
        data.accountId,
        data.tokenId,
        userId
      );

      if (existingHolding) {
        throw new Error('Holding already exists for this token in this account');
      }

      // Create the holding
      const holding = await this.holdingRepository.create({
        accountId: data.accountId,
        tokenId: data.tokenId,
        balance: data.balance,
        userId,
        lastUpdated: data.lastUpdated || new Date(),
      });

      this.assertExists(holding, 'Failed to create holding');

      this.logDebug('Holding created successfully', { holdingId: holding.id });
      return holding;
    } catch (error) {
      throw this.handleError(error, 'createHolding');
    }
  }

  async createManyHoldings(
    data: CreateHoldingInput[],
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Holding[]> {
    try {
      this.logDebug('Creating multiple holdings', { count: data.length });

      const createdHoldings: Holding[] = await this.holdingRepository.createMany(
        data.map((holdingInput) => ({
          ...holdingInput,
          userId,
        })),
        tx
      );

      this.logDebug('Multiple holdings created successfully', {
        count: createdHoldings.length,
      });
      return createdHoldings;
    } catch (error) {
      throw this.handleError(error, 'createManyHoldings');
    }
  }

  async getHoldingsByAccountIdWithDetails(
    user: User,
    accountId?: string
  ): Promise<HoldingWithDetails[]> {
    if (!user.baseCurrencyId) {
      throw new Error('User does not have a base currency set');
    }

    this.logger.debug({ userId: user.id, accountId }, 'Getting holdings with details');

    // Parallel fetch: optimized holdings query + portfolio valuation + groups
    const [holdingsWithFullDetails, portfolioValue] = await Promise.all([
      this.holdingRepository.findByUserWithFullDetails(user.id, accountId),
      this.portfolioValuationService.getUserPortfolioValue(user.id, user.baseCurrencyId, accountId),
    ]);

    if (holdingsWithFullDetails.length === 0) {
      return [];
    }

    // Fetch groups for all holdings in a single query
    const groupsMap = await this.groupRepository.findGroupsForHoldings(
      holdingsWithFullDetails.map(({ holding, account }) => ({
        id: holding.id,
        accountId: account.id,
      }))
    );

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
        let priceInfo = priceMetadataMap.get(token.symbol);

        // Synthesize price object for base currency holdings (always 1:1 conversion)
        if (!priceInfo && token.id === user.baseCurrencyId) {
          priceInfo = {
            value: '1',
            timestamp: new Date().toISOString(),
            source: 'Base Currency',
          };
        }

        // Get groups for this holding (both direct and account-level)
        const holdingGroups = groupsMap.get(holding.id) || [];

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
          groups: holdingGroups.map((g) => ({
            id: g.id,
            name: g.name,
            color: g.color,
          })),
          lastUpdated: holding.lastUpdated.toISOString(),
          createdAt: holding.createdAt.toISOString(),
          isActive: holding.isActive,
        };
      }
    );

    this.logger.debug(
      { userId: user.id, accountId, count: detailedHoldings.length },
      accountId ? 'Account holdings with details retrieved' : 'Holdings with details retrieved'
    );

    return detailedHoldings;
  }

  /**
   * Find holdings by account
   */
  async findByAccount(
    accountId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false
  ): Promise<Holding[]> {
    try {
      return await this.holdingRepository.findByAccount(accountId, transaction, includeHidden);
    } catch (error) {
      throw this.handleError(error, 'findByAccount');
    }
  }

  /**
   * Update holding balance
   */
  async updateHoldingBalance(
    holdingId: string,
    balance: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      // Note: Not logging individual balance updates to reduce log volume
      await this.holdingRepository.updateBalance(holdingId, balance, transaction);
    } catch (error) {
      throw this.handleError(error, 'updateHoldingBalance');
    }
  }

  /**
   * Delete holding
   */
  async deleteHolding(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      this.logDebug('Deleting holding', { holdingId });
      await this.holdingRepository.deleteById(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'deleteHolding');
    }
  }

  /**
   * Get distinct token IDs from all holdings
   */
  async getDistinctTokenIds(transaction?: DatabaseTransaction): Promise<string[]> {
    try {
      return await this.holdingRepository.getDistinctTokenIds(transaction);
    } catch (error) {
      throw this.handleError(error, 'getDistinctTokenIds');
    }
  }
}
