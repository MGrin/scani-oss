import { db } from '@scani/db/connection';
import type { User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { UpdateUserInput } from '@scani/shared';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { UserRepository } from '../repositories/UserRepository';
import { BaseService } from './BaseService';

/**
 * Minimal user lookups + the user's base-currency Token join used across
 * dashboards and portfolio valuation. Merged with the former
 * `UserContextService` so consumers have a single entry point for user-ish
 * reads instead of two tiny services with overlapping scope.
 */
export interface BaseCurrencyToken {
  id: string;
  symbol: string;
  name: string;
}

@Service()
export class UserService extends BaseService {
  private readonly userRepository = Container.get(UserRepository);

  constructor() {
    super('UserService');
  }

  async updateUser(userId: string, data: UpdateUserInput): Promise<User> {
    try {
      const existingUser = await this.userRepository.findById(userId);
      this.assertExists(existingUser, `User with ID ${userId} not found`);
      const updatedUser = await this.userRepository.update(userId, data);
      this.assertExists(updatedUser, 'Failed to update user');
      return updatedUser;
    } catch (error) {
      throw this.handleError(error, 'updateUser');
    }
  }

  async getUserById(userId: string): Promise<User | null> {
    try {
      return await this.userRepository.findById(userId);
    } catch (error) {
      throw this.handleError(error, 'getUserById');
    }
  }

  /**
   * Resolve the user's base-currency Token in a single join query. Called
   * by PortfolioValuationService on every dashboard request — the join is
   * deliberate (skip two round-trips).
   */
  async getBaseCurrency(userId: string): Promise<BaseCurrencyToken> {
    const [row] = await db
      .select({
        userId: schema.users.id,
        baseCurrencyId: schema.tokens.id,
        baseCurrencySymbol: schema.tokens.symbol,
        baseCurrencyName: schema.tokens.name,
      })
      .from(schema.users)
      .innerJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!row) {
      throw new Error(`User ${userId} not found or has no base currency set`);
    }

    return {
      id: row.baseCurrencyId,
      symbol: row.baseCurrencySymbol,
      name: row.baseCurrencyName,
    };
  }
}
