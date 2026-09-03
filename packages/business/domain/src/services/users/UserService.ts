import { type DatabaseTransaction, withTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import type { User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { CostBasisMethodDto, ObservedBurnAnswerInput, UpdateUserInput } from '@scani/shared';
import { parseCostBasisMethod } from '@scani/shared';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
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
 * The answer was given in a currency the account is not in (SC-661).
 *
 * Raised rather than corrected. Stamping the server's own base currency over
 * the disagreement would record the user as having agreed to a figure in a unit
 * they were never shown — the same defect
 * `users.observed_burn_confirmed_currency_id` exists to prevent, moved one
 * layer up. The client re-reads its profile and asks again.
 */
export class ObservedBurnAnswerCurrencyMismatch extends Error {
  constructor() {
    super('The observed-burn answer must be given in the account base currency');
    this.name = 'ObservedBurnAnswerCurrencyMismatch';
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

      /**
       * THE CURRENCY IS THE USER'S OWN, CHECKED RATHER THAN TRUSTED (SC-661).
       *
       * The client sends it because it is what gets STORED — an answer that
       * carries no currency is silently reinterpreted the day the account's
       * base currency changes, which is why the column exists. But a client
       * reading a cached profile can send the currency the account has just
       * LEFT, and that write would land as an answer nobody can display: it
       * decodes as `currencyChanged` the instant it is read back.
       *
       * Refused rather than corrected. Stamping the server's own value over a
       * disagreement would record agreement with a figure in a unit the user
       * was never shown, which is the same defect the column prevents, one
       * layer up.
       */
      if (input.kind !== 'clear' && input.currencyTokenId !== existingUser.baseCurrencyId) {
        throw new ObservedBurnAnswerCurrencyMismatch();
      }

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
