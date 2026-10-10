import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { LiabilityTerms, NewLiabilityTerms } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Service } from 'typedi';

@Service()
export class LiabilityTermsRepository extends BaseRepository<LiabilityTerms, NewLiabilityTerms> {
  protected readonly table = schema.liabilityTerms;
  protected readonly tableName = 'liability_terms';

  async findByAccount(accountId: string, tx?: DatabaseTransaction): Promise<LiabilityTerms | null> {
    const [row] = await this.getDb(tx)
      .select()
      .from(schema.liabilityTerms)
      .where(eq(schema.liabilityTerms.accountId, accountId));
    return row ?? null;
  }

  /** One row per account: a second save replaces every term, so a cleared field clears. */
  async upsert(values: NewLiabilityTerms, tx?: DatabaseTransaction): Promise<LiabilityTerms> {
    const { accountId: _accountId, ...terms } = values;
    const [row] = await this.getDb(tx)
      .insert(schema.liabilityTerms)
      .values(values)
      .onConflictDoUpdate({
        target: schema.liabilityTerms.accountId,
        set: { ...terms, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error('liability_terms upsert returned no row');
    return row;
  }
}
