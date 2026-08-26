import { db } from '@scani/db/connection';
import type { User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { ObservedBurnAnswerInput, UpdateUserInput } from '@scani/shared';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { UserRepository } from '../../repositories/UserRepository';
import { BaseService } from '../BaseService';

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

  /**
   * Record the IANA zone the browser reported (SC-226).
   *
   * Separate from `updateUser` because it is not a preference anyone typed: it
   * is a fact about the device, reported whenever the app is opened. Routing
   * it through the profile mutation would make every app launch look like a
   * profile edit — including to the `user:update` realtime event, which exists
   * to refetch every screen that renders money.
   *
   * **Writes only on a real change.** The app reports on every load, so this
   * is the difference between one row touched when someone flies somewhere new
   * and one write per session per user, forever.
   */
  async reportTimezone(userId: string, timezone: string): Promise<{ changed: boolean }> {
    try {
      const existingUser = await this.userRepository.findById(userId);
      this.assertExists(existingUser, `User with ID ${userId} not found`);
      if (existingUser.timezone === timezone) return { changed: false };
      const updated = await this.userRepository.update(userId, { timezone });
      this.assertExists(updated, 'Failed to record timezone');
      return { changed: true };
    } catch (error) {
      throw this.handleError(error, 'reportTimezone');
    }
  }

  /**
   * Record what the user says about the MEASURED monthly drain (SC-661):
   * override it, confirm it, or withdraw whichever they said before.
   *
   * ## Why one method and not three
   *
   * The three are mutually exclusive and the database enforces it
   * (`users_observed_burn_one_answer`). Split across three verbs, every one of
   * them would have to remember to clear the other pair, and forgetting is a
   * row with two authoritative answers — which is this ticket's own defect
   * moved into one row. Here the patch is total by construction: all six
   * columns are written on every call, so there is no path that leaves a stale
   * half behind.
   *
   * ## Why `confirm` stores the value
   *
   * Not for the record. It is the amount that must STILL MATCH for the
   * confirmation to mean anything — the drain is recomputed whenever the window
   * moves, and a confirmation kept as a bare timestamp goes on reading as
   * agreement after the figure it agreed with has changed. That is the same
   * defect SC-673 is fixing one layer up, where `answerSourceOf` infers who
   * answered from a timestamp.
   *
   * The timestamp is re-stamped even when nothing changed: it records when the
   * user last stood behind the answer, not when the answer last differed.
   */
  async setObservedBurnAnswer(userId: string, input: ObservedBurnAnswerInput): Promise<User> {
    try {
      const existingUser = await this.userRepository.findById(userId);
      this.assertExists(existingUser, `User with ID ${userId} not found`);

      const cleared = {
        observedBurnOverride: null,
        observedBurnOverrideCurrencyId: null,
        observedBurnOverrideAt: null,
        observedBurnConfirmedValue: null,
        observedBurnConfirmedCurrencyId: null,
        observedBurnConfirmedAt: null,
      };
      const patch =
        input.kind === 'override'
          ? {
              ...cleared,
              observedBurnOverride: input.amount,
              observedBurnOverrideCurrencyId: input.currencyTokenId,
              observedBurnOverrideAt: new Date(),
            }
          : input.kind === 'confirm'
            ? {
                ...cleared,
                observedBurnConfirmedValue: input.value,
                observedBurnConfirmedCurrencyId: input.currencyTokenId,
                observedBurnConfirmedAt: new Date(),
              }
            : cleared;

      const updated = await this.userRepository.update(userId, patch);
      this.assertExists(updated, 'Failed to record the observed-burn answer');
      return updated;
    } catch (error) {
      throw this.handleError(error, 'setObservedBurnAnswer');
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
