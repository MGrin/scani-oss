import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { NewUserPortfolioEvent, UserPortfolioEvent } from '../database/schema';
import type { DatabaseTransaction } from '../repositories/BaseRepository';
import {
  type UserPortfolioEventFilters,
  UserPortfolioEventRepository,
} from '../repositories/UserPortfolioEventRepository';
import { BaseService } from './BaseService';

export type HoldingEventType = 'holding_create' | 'holding_update' | 'holding_delete';

export interface CreateHoldingEventInput {
  userId: string;
  holdingId: string;
  accountId: string;
  institutionId: string | null;
  tokenId: string;
  tokenSymbol: string;
  tokenName: string;
  balance: string;
  price: string;
  baseCurrencyId: string;
  timestamp?: Date;
  source?: string;
}

export interface CreatePriceUpdateEventsInput {
  tokenId: string;
  price: string;
  baseCurrencyId: string;
  timestamp?: Date;
}

/**
 * UserPortfolioEventService
 *
 * Handles creation and querying of portfolio events.
 * Events are created at write-time when holdings change or prices update.
 */
@Service()
export class UserPortfolioEventService extends BaseService {
  private readonly eventRepository = Container.get(UserPortfolioEventRepository);

  constructor() {
    super('UserPortfolioEventService');
  }

  /**
   * Create a holding event (create, update, or delete)
   */
  private async createHoldingEvent(
    eventType: HoldingEventType,
    input: CreateHoldingEventInput,
    transaction?: DatabaseTransaction
  ): Promise<UserPortfolioEvent> {
    try {
      const balance = new Decimal(input.balance);
      const price = new Decimal(input.price);
      const value = balance.times(price);

      const event: NewUserPortfolioEvent = {
        userId: input.userId,
        timestamp: input.timestamp || new Date(),
        eventType,
        holdingId: input.holdingId,
        accountId: input.accountId,
        institutionId: input.institutionId,
        tokenId: input.tokenId,
        tokenSymbol: input.tokenSymbol,
        tokenName: input.tokenName,
        balance: input.balance,
        price: input.price,
        value: value.toString(),
        baseCurrencyId: input.baseCurrencyId,
        source: input.source,
      };

      const created = await this.eventRepository.create(event, transaction);

      this.logDebug(`Created ${eventType} event`, {
        eventId: created.id,
        holdingId: input.holdingId,
        tokenSymbol: input.tokenSymbol,
      });

      return created;
    } catch (error) {
      throw this.handleError(error, `createHoldingEvent:${eventType}`);
    }
  }

  /**
   * Create a holding_create event when a new holding is added
   */
  async createHoldingCreateEvent(
    input: CreateHoldingEventInput,
    transaction?: DatabaseTransaction
  ): Promise<UserPortfolioEvent> {
    return this.createHoldingEvent('holding_create', input, transaction);
  }

  /**
   * Create a holding_update event when a holding's balance changes
   */
  async createHoldingUpdateEvent(
    input: CreateHoldingEventInput,
    transaction?: DatabaseTransaction
  ): Promise<UserPortfolioEvent> {
    return this.createHoldingEvent('holding_update', input, transaction);
  }

  /**
   * Create a holding_delete event when a holding is removed
   */
  async createHoldingDeleteEvent(
    input: CreateHoldingEventInput,
    transaction?: DatabaseTransaction
  ): Promise<UserPortfolioEvent> {
    return this.createHoldingEvent('holding_delete', input, transaction);
  }

  /**
   * Create price_update events for all users who hold a token
   * Called when a new price is recorded
   */
  async createPriceUpdateEvents(
    input: CreatePriceUpdateEventsInput,
    transaction?: DatabaseTransaction
  ): Promise<number> {
    try {
      // Debug: Check if eventRepository is properly initialized
      if (!this.eventRepository) {
        this.logError('eventRepository is undefined in createPriceUpdateEvents');
        return 0;
      }

      // Find all users who have active holdings for this token
      const userHoldings = await this.eventRepository.findUserHoldingsForToken(
        input.tokenId,
        input.baseCurrencyId,
        transaction
      );

      if (userHoldings.length === 0) {
        this.logDebug('No users hold this token, skipping price_update events', {
          tokenId: input.tokenId,
        });
        return 0;
      }

      const timestamp = input.timestamp || new Date();
      const price = new Decimal(input.price);

      // Create events for each user holding
      const events: NewUserPortfolioEvent[] = userHoldings.map((holding) => {
        const balance = new Decimal(holding.balance);
        const value = balance.times(price);

        return {
          userId: holding.userId,
          timestamp,
          eventType: 'price_update' as const,
          holdingId: holding.holdingId,
          accountId: holding.accountId,
          institutionId: holding.institutionId,
          tokenId: input.tokenId,
          tokenSymbol: holding.tokenSymbol,
          tokenName: holding.tokenName,
          balance: holding.balance,
          price: input.price,
          value: value.toString(),
          baseCurrencyId: input.baseCurrencyId,
        };
      });

      // Batch insert all events
      await this.eventRepository.createMany(events, transaction);

      this.logDebug('Created price_update events', {
        tokenId: input.tokenId,
        userCount: events.length,
      });

      return events.length;
    } catch (error) {
      throw this.handleError(error, 'createPriceUpdateEvents');
    }
  }

  /**
   * Get paginated portfolio events for a user
   */
  async getEvents(
    userId: string,
    options: {
      limit: number;
      offset: number;
      filters?: UserPortfolioEventFilters;
    }
  ): Promise<{
    events: UserPortfolioEvent[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      const result = await this.eventRepository.findByUserIdPaginated(userId, options);

      return {
        events: result.items,
        total: result.total,
        hasMore: result.hasMore,
      };
    } catch (error) {
      throw this.handleError(error, 'getEvents');
    }
  }

  /**
   * Get events for a date range (for chart data)
   */
  async getEventsInDateRange(
    userId: string,
    startDate: Date,
    endDate: Date,
    baseCurrencyId: string
  ): Promise<UserPortfolioEvent[]> {
    try {
      return await this.eventRepository.findByUserIdInDateRange(
        userId,
        startDate,
        endDate,
        baseCurrencyId
      );
    } catch (error) {
      throw this.handleError(error, 'getEventsInDateRange');
    }
  }

  /**
   * Delete all events for a user (for cleanup)
   */
  async deleteUserEvents(userId: string): Promise<number> {
    try {
      const count = await this.eventRepository.deleteByUserId(userId);
      this.logDebug('Deleted user portfolio events', { userId, count });
      return count;
    } catch (error) {
      throw this.handleError(error, 'deleteUserEvents');
    }
  }
}
