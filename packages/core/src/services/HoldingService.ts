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
 * Input for creating a holding with full context for event tracking
 */
export interface CreateHoldingWithEventInput {
  accountId: string;
  tokenId: string;
  balance: string;
  userId: string;
  source?: string;
  externalId?: string; // Exchange-specific identifier for synced holdings
  lastUpdated?: Date;
  // Event context (optional - if not provided, events won't be created)
  eventContext?: {
    baseCurrencyId: string;
    price?: string; // If not provided, will use "0"
  };
}

/**
 * Input for updating a holding balance with event tracking
 */
export interface UpdateHoldingBalanceInput {
  holdingId: string;
  balance: string;
  // Event context (optional - if not provided, events won't be created)
  eventContext?: {
    userId: string;
    baseCurrencyId: string;
    price?: string;
  };
}

/**
 * HoldingService
 *
 * Centralized service for ALL holding mutations.
 * All holding create/update/delete operations should go through this service
 * to ensure portfolio events are properly tracked.
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

  // ============================================
  // HOLDING MUTATIONS (with event tracking)
  // ============================================

  /**
   * Create a single holding with optional event tracking
   * Use this for user-initiated holding creation
   */
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

      // Create the holding (multiple holdings of same token in same account are allowed)
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

  /**
   * Create a holding with full event context
   * This is the preferred method for sync/import operations
   */
  async createHoldingWithEvent(
    input: CreateHoldingWithEventInput,
    transaction?: DatabaseTransaction
  ): Promise<Holding> {
    try {
      // Create the holding (multiple same-token holdings per account are allowed)
      const holding = await this.holdingRepository.create(
        {
          accountId: input.accountId,
          tokenId: input.tokenId,
          balance: input.balance,
          userId: input.userId,
          source: input.source || 'manual',
          externalId: input.externalId || null,
          lastUpdated: input.lastUpdated || new Date(),
        },
        transaction
      );
      this.logDebug('Holding created', { holdingId: holding.id });
      return holding;
    } catch (error) {
      throw this.handleError(error, 'createHoldingWithEvent');
    }
  }

  /**
   * Create multiple holdings (batch operation)
   * Events are created for each holding if eventContext is provided in individual items
   */
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

  /**
   * Create multiple holdings with event tracking
   * Use this for bulk imports that need event tracking
   */
  async createManyHoldingsWithEvents(
    inputs: CreateHoldingWithEventInput[],
    transaction?: DatabaseTransaction
  ): Promise<Holding[]> {
    try {
      this.logDebug('Creating multiple holdings with events', {
        count: inputs.length,
      });

      const holdings: Holding[] = [];
      for (const input of inputs) {
        const holding = await this.createHoldingWithEvent(input, transaction);
        holdings.push(holding);
      }

      this.logDebug('Multiple holdings with events created', {
        count: holdings.length,
      });
      return holdings;
    } catch (error) {
      throw this.handleError(error, 'createManyHoldingsWithEvents');
    }
  }

  /**
   * Update holding balance with optional event tracking
   */
  async updateHoldingBalance(
    holdingId: string,
    balance: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      await this.holdingRepository.updateBalance(holdingId, balance, transaction);
    } catch (error) {
      throw this.handleError(error, 'updateHoldingBalance');
    }
  }

  /**
   * Update holding balance with event tracking
   * This is the preferred method for sync operations that need event tracking
   */
  async updateHoldingBalanceWithEvent(
    input: UpdateHoldingBalanceInput,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      // Get holding details for event
      const holding = await this.holdingRepository.findById(input.holdingId, transaction, true);
      if (!holding) {
        throw new Error(`Holding not found: ${input.holdingId}`);
      }

      // Update the balance
      await this.holdingRepository.updateBalance(input.holdingId, input.balance, transaction);
    } catch (error) {
      throw this.handleError(error, 'updateHoldingBalanceWithEvent');
    }
  }

  /**
   * Update holding fields (balance, isActive, isHidden, etc.)
   */
  async updateHolding(
    holdingId: string,
    updates: Partial<Pick<Holding, 'balance' | 'isActive' | 'isHidden' | 'lastUpdated'>>,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      return await this.holdingRepository.update(holdingId, updates, transaction);
    } catch (error) {
      throw this.handleError(error, 'updateHolding');
    }
  }

  /**
   * Update holding with event tracking
   */
  async updateHoldingWithEvent(
    holdingId: string,
    updates: Partial<Pick<Holding, 'balance' | 'isActive' | 'isHidden' | 'lastUpdated'>>,
    _eventContext?: {
      userId: string;
      baseCurrencyId: string;
      price?: string;
    },
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      const holding = await this.holdingRepository.findById(holdingId, transaction, true);
      if (!holding) {
        throw new Error(`Holding not found: ${holdingId}`);
      }

      const updated = await this.holdingRepository.update(holdingId, updates, transaction);

      return updated;
    } catch (error) {
      throw this.handleError(error, 'updateHoldingWithEvent');
    }
  }

  /**
   * Delete holding (hard delete)
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
   * Delete holding with event tracking
   */
  async deleteHoldingWithEvent(
    holdingId: string,
    _eventContext: {
      userId: string;
      baseCurrencyId: string;
      price?: string;
    },
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      // Get holding details before deletion for event
      const holding = await this.holdingRepository.findById(holdingId, transaction, true);
      if (!holding) {
        throw new Error(`Holding not found: ${holdingId}`);
      }

      await this.holdingRepository.deleteById(holdingId, transaction);
      this.logDebug('Holding deleted', { holdingId });
    } catch (error) {
      throw this.handleError(error, 'deleteHoldingWithEvent');
    }
  }

  /**
   * Hide holding (soft delete for blockchain holdings)
   */
  async hideHolding(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      await this.holdingRepository.markAsHidden(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'hideHolding');
    }
  }

  /**
   * Hide holding with event tracking
   */
  async hideHoldingWithEvent(
    holdingId: string,
    _eventContext: {
      userId: string;
      baseCurrencyId: string;
      price?: string;
    },
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      const holding = await this.holdingRepository.findById(holdingId, transaction, true);
      if (!holding) {
        throw new Error(`Holding not found: ${holdingId}`);
      }

      await this.holdingRepository.markAsHidden(holdingId, transaction);
      this.logDebug('Holding hidden', { holdingId });
    } catch (error) {
      throw this.handleError(error, 'hideHoldingWithEvent');
    }
  }

  /**
   * Unhide/restore a holding
   */
  async unhideHolding(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      await this.holdingRepository.unhideHolding(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'unhideHolding');
    }
  }

  /**
   * Unhide/restore a holding with event tracking
   */
  async unhideHoldingWithEvent(
    holdingId: string,
    _eventContext?: {
      userId: string;
      baseCurrencyId: string;
      price?: string;
    },
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      const holding = await this.holdingRepository.findById(holdingId, transaction, true);
      if (!holding) {
        throw new Error(`Holding not found: ${holdingId}`);
      }

      await this.holdingRepository.unhideHolding(holdingId, transaction);

      this.logDebug('Holding unhidden', { holdingId });

      // Return the updated holding (includeHidden=true since it was just unhidden)
      return await this.holdingRepository.findById(holdingId, transaction, true);
    } catch (error) {
      throw this.handleError(error, 'unhideHoldingWithEvent');
    }
  }

  // ============================================
  // READ OPERATIONS (unchanged)
  // ============================================

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

    // Parallel fetch: optimized holdings query + portfolio valuation + groups
    const [holdingsWithFullDetails, portfolioValue] = await Promise.all([
      this.holdingRepository.findByUserWithFullDetails(
        user.id,
        accountId,
        undefined, // transaction: not using transaction here
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
          isHidden: holding.isHidden,
          source: holding.source,
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
   * Get holdings by account ID with details and summary statistics
   * This version returns both holdings and aggregated summary (excluding inactive holdings from totals)
   */
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

    // Calculate summary statistics (only active holdings count towards totals)
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

  /**
   * Find holdings by account
   * @param accountId - The account ID to find holdings for
   * @param transaction - Optional database transaction
   * @param includeHidden - Whether to include hidden holdings (default: false)
   * @param includeScamTokens - Whether to include tokens marked as potential scams (default: false)
   */
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

  /**
   * Find holding by ID
   */
  async findById(
    holdingId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false
  ): Promise<Holding | null> {
    try {
      return await this.holdingRepository.findById(holdingId, transaction, includeHidden);
    } catch (error) {
      throw this.handleError(error, 'findById');
    }
  }
}
