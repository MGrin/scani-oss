import { type DatabaseTransaction, withTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import type { User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { CostBasisMethodDto, UpdateUserInput } from '@scani/shared';
import { parseCostBasisMethod } from '@scani/shared';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TokenRepository } from '../../repositories/TokenRepository';
import { UserCostBasisMethodChangeRepository } from '../../repositories/UserCostBasisMethodChangeRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { BaseService } from '../BaseService';

/**
 * Minimal user lookups + the user's base-currency Token join used across
 * dashboards and portfolio valuation. Merged with the former
 * `UserContextService` so consumers have a single entry point for user-ish
 * reads instead of two tiny services with overlapping scope.
 */

/**
 * A base currency that is not an active fiat token (SC-1288).
 *
 * Every total in the app is priced in the base currency, and the picker offers
 * exactly the active fiat tokens (`users.getSupportedCurrencies`). The API
 * used to store any token id it was sent, so a crypto token, a stock or
 * someone else's private company could become the unit everything renders in.
 */
export class InvalidBaseCurrencyError extends Error {
  constructor() {
    super('The base currency must be a supported fiat currency');
    this.name = 'InvalidBaseCurrencyError';
  }
}

export interface BaseCurrencyToken {
  id: string;
  symbol: string;
  name: string;
}

/**
 * The only write path that changes `users.cost_basis_method`, named for the
 * `source` column's CHECK (SC-957). A second writer — a support tool, an admin
 * action — must add a value there in a migration, which is the loud step that a
 * nullable actor column would not have forced.
 */
export const COST_BASIS_METHOD_CHANGE_SOURCE = 'user_profile_update';

/** A cost-basis method change that actually moved figures, or `null`. */
export interface CostBasisMethodChange {
  readonly previousMethod: CostBasisMethodDto;
  readonly newMethod: CostBasisMethodDto;
}

/**
 * The updated row, plus whether this edit moved the cost-basis method.
 *
 * The second half is returned rather than acted on here: re-computation is a
 * queued job, and enqueueing inside the transaction that writes the row would
 * publish work for a change that may still roll back.
 */
export interface UpdateUserResult {
  readonly user: User;
  readonly costBasisMethodChange: CostBasisMethodChange | null;
}

@Service()
export class UserService extends BaseService {
  private readonly userRepository = Container.get(UserRepository);
  private readonly costBasisMethodChanges = Container.get(UserCostBasisMethodChangeRepository);
  private readonly tokenRepository = Container.get(TokenRepository);

  constructor() {
    super('UserService');
  }

  /**
   * Apply a profile edit, and RECORD it when it moved the cost-basis method
   * (SC-957).
   *
   * The method decides which lots a disposal is matched against, so changing it
   * changes every realized figure the account has already been shown. It is not
   * refused — mgrin weighed locking it, and locking only periods already shown,
   * and declined both on 2026-09-03: FIFO against HMRC-verified section 104 is
   * exactly the decision a new user gets wrong on day one, and a lock punishes
   * the person least equipped to have made it. What changes is that the change
   * stops being invisible.
   *
   * ## Why the row and the column are written in ONE transaction
   *
   * They are two halves of one fact. A column that moved with no row beside it
   * is precisely the state this ticket is about, and it is the half that
   * survives a partial failure if these are two statements — the user row is
   * written first because it is the one the caller waits on. Committed together,
   * the history cannot be missing an era.
   *
   * ## Why the caller is told, rather than this method acting
   *
   * Re-computing every figure the change moved is a queued job, and enqueueing
   * from inside a transaction publishes work for a row that may still roll back.
   * The change is returned; `users.updateCurrent` enqueues it after the commit.
   *
   * ## Why a no-op change records nothing
   *
   * Saving the same method again moved no figure, so a row for it would explain
   * nothing and dilute the only reading this table has — every row moved
   * somebody's numbers. `user_cost_basis_method_changes_is_a_change` refuses
   * such a row at the database as well, so this is not merely a habit here.
   */
  async updateUser(
    userId: string,
    data: UpdateUserInput,
    transaction?: DatabaseTransaction
  ): Promise<UpdateUserResult> {
    try {
      const existingUser = await this.userRepository.findById(userId, transaction);
      this.assertExists(existingUser, `User with ID ${userId} not found`);

      if (data.baseCurrencyId) {
        const token = await this.tokenRepository.findWithType(data.baseCurrencyId, transaction);
        if (!token?.isActive || token.typeCode !== 'fiat') {
          throw new InvalidBaseCurrencyError();
        }
      }

      // `parseCostBasisMethod` on the stored side because the column is `text`
      // with a CHECK, so the type system sees a string a database constraint
      // narrows. Comparing the raw column against a parsed input would compare
      // two differently-trusted values.
      const previousMethod = parseCostBasisMethod(existingUser.costBasisMethod);
      const nextMethod = data.costBasisMethod;
      const change =
        nextMethod !== undefined && nextMethod !== previousMethod
          ? { previousMethod, newMethod: nextMethod }
          : null;

      const write = async (tx: DatabaseTransaction): Promise<User> => {
        const updated = await this.userRepository.update(userId, data, tx);
        this.assertExists(updated, 'Failed to update user');
        if (change) {
          await this.costBasisMethodChanges.create(
            {
              userId,
              previousMethod: change.previousMethod,
              newMethod: change.newMethod,
              source: COST_BASIS_METHOD_CHANGE_SOURCE,
            },
            tx
          );
        }
        return updated;
      };
      // A caller already in a transaction JOINS it rather than opening a second
      // one: two transactions cannot commit together, which is the one property
      // the row and the column need from each other.
      const updatedUser = transaction
        ? await write(transaction)
        : await withTransaction(write, { name: 'updateUser' });

      return { user: updatedUser, costBasisMethodChange: change };
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
