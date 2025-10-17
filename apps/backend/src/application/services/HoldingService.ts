import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { CreateHoldingInput, UpdateHoldingInput } from '../../domain/dtos/holding';
import type { Holding } from '../../domain/entities';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { BaseService } from './BaseService';

/**
 * HoldingService
 *
 * Handles holding operations.
 */
@Service()
export class HoldingService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);

  constructor() {
    super('HoldingService');
  }

  /**
   * Create a new holding
   */
  async createHolding(data: CreateHoldingInput, userId: string): Promise<Holding> {
    try {
      this.logInfo('Creating holding', {
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

      this.logInfo('Holding created successfully', { holdingId: holding.id });
      return holding;
    } catch (error) {
      throw this.handleError(error, 'createHolding');
    }
  }

  /**
   * Update a holding
   */
  async updateHolding(
    holdingId: string,
    data: UpdateHoldingInput,
    userId: string
  ): Promise<Holding> {
    try {
      this.logInfo('Updating holding', { holdingId, data });

      const existing = await this.holdingRepository.findById(holdingId);
      this.assertExists(existing, `Holding with ID ${holdingId} not found`);

      // Verify ownership through account
      const account = await this.accountRepository.findById(existing.accountId);
      this.assertExists(account, `Account not found for holding ${holdingId}`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Holding does not belong to user');
      }

      // Validate balance if provided
      if (data.balance !== undefined) {
        const balance = new Decimal(data.balance);
        if (balance.isNegative()) {
          throw new Error('Balance cannot be negative');
        }
      }

      const updated = await this.holdingRepository.update(holdingId, data);
      this.assertExists(updated, 'Failed to update holding');

      this.logInfo('Holding updated', { holdingId });
      return updated;
    } catch (error) {
      throw this.handleError(error, 'updateHolding');
    }
  }

  /**
   * Get holding by ID
   */
  async getHoldingById(holdingId: string, userId: string): Promise<Holding> {
    try {
      const holding = await this.holdingRepository.findById(holdingId);
      this.assertExists(holding, `Holding with ID ${holdingId} not found`);

      // Verify ownership
      const account = await this.accountRepository.findById(holding.accountId);
      this.assertExists(account, `Account not found for holding ${holdingId}`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Holding does not belong to user');
      }

      return holding;
    } catch (error) {
      throw this.handleError(error, 'getHoldingById');
    }
  }

  /**
   * Get holdings by account
   */
  async getHoldingsByAccountId(accountId: string, userId: string): Promise<Holding[]> {
    try {
      // Verify account ownership
      const account = await this.accountRepository.findById(accountId);
      this.assertExists(account, `Account with ID ${accountId} not found`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Account does not belong to user');
      }

      return await this.holdingRepository.findByAccount(accountId, userId);
    } catch (error) {
      throw this.handleError(error, 'getHoldingsByAccountId');
    }
  }

  /**
   * Get holdings by token
   */
  async getHoldingsByTokenId(tokenId: string, userId: string): Promise<Holding[]> {
    try {
      const holdings = await this.holdingRepository.findByToken(tokenId, userId);

      // Filter to only holdings owned by this user
      const userHoldings = [];
      for (const holding of holdings) {
        const account = await this.accountRepository.findById(holding.accountId);
        if (account && account.userId === userId) {
          userHoldings.push(holding);
        }
      }

      return userHoldings;
    } catch (error) {
      throw this.handleError(error, 'getHoldingsByTokenId');
    }
  }

  /**
   * Get holding with details (token, account)
   */
  async getHoldingWithDetails(holdingId: string, userId: string) {
    try {
      const holding = await this.holdingRepository.findWithDetails(holdingId, userId);
      this.assertExists(holding, `Holding with ID ${holdingId} not found`);

      // Verify ownership
      const account = await this.accountRepository.findById(holding.accountId);
      this.assertExists(account, `Account not found for holding ${holdingId}`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Holding does not belong to user');
      }

      return holding;
    } catch (error) {
      throw this.handleError(error, 'getHoldingWithDetails');
    }
  }

  /**
   * Delete a holding
   */
  async deleteHolding(holdingId: string, userId: string): Promise<boolean> {
    try {
      this.logInfo('Deleting holding', { holdingId });

      const existing = await this.holdingRepository.findById(holdingId);
      this.assertExists(existing, `Holding with ID ${holdingId} not found`);

      // Verify ownership
      const account = await this.accountRepository.findById(existing.accountId);
      this.assertExists(account, `Account not found for holding ${holdingId}`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Holding does not belong to user');
      }

      const deleted = await this.holdingRepository.delete(holdingId);
      this.logInfo('Holding deleted', { holdingId, deleted });
      return deleted;
    } catch (error) {
      throw this.handleError(error, 'deleteHolding');
    }
  }

  /**
   * Calculate total value of holdings for a user
   * (This would integrate with pricing service in full implementation)
   */
  async calculateHoldingValue(holdingId: string, userId: string): Promise<string> {
    try {
      const holding = await this.getHoldingById(holdingId, userId);

      // Placeholder: In full implementation, this would:
      // 1. Get latest price for token
      // 2. Multiply by balance
      // 3. Convert to user's base currency

      this.logDebug('Calculating holding value', {
        holdingId,
        balance: holding.balance,
      });
      return holding.balance; // Simplified for now
    } catch (error) {
      throw this.handleError(error, 'calculateHoldingValue');
    }
  }
}
