import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewUserCostBasisMethodChange, UserCostBasisMethodChange } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { desc, eq } from 'drizzle-orm';
import { Service } from 'typedi';

/**
 * The record of what an account's cost-basis method has been (SC-957).
 *
 * Append-only. Nothing here updates or deletes a row — a correction to the
 * history would be the history saying something other than what happened, which
 * is the state this table exists to make impossible.
 */
@Service()
export class UserCostBasisMethodChangeRepository extends BaseRepository<
  UserCostBasisMethodChange,
  NewUserCostBasisMethodChange
> {
  protected readonly table = schema.userCostBasisMethodChanges;
  protected readonly tableName = 'user_cost_basis_method_changes';

  /**
   * Every method this account has had, newest first.
   *
   * Newest first because the question a moved figure raises is answered by
   * walking BACK from now: the newest row's `newMethod` is what is in force,
   * and each earlier row's `changedAt` is the instant the era before it ended.
   * An empty result means the method has never changed, so every figure the
   * account holds was computed under whatever `users.cost_basis_method` says.
   */
  async findByUserId(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<UserCostBasisMethodChange[]> {
    return this.getDb(transaction)
      .select()
      .from(schema.userCostBasisMethodChanges)
      .where(eq(schema.userCostBasisMethodChanges.userId, userId))
      .orderBy(desc(schema.userCostBasisMethodChanges.changedAt));
  }
}
