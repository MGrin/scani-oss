import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { FeedMatchRule, NewFeedMatchRule } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Service } from 'typedi';

/**
 * A rule as classification reads it. A counterparty rule carries its pattern's
 * key, put through `transfer_counterparty_key` by the database, so the pattern
 * and the entries it is compared with are normalised by one implementation.
 */
export type MatchRule = Pick<
  FeedMatchRule,
  'id' | 'matchField' | 'pattern' | 'destinationAccountId' | 'ledgerKind'
> & { counterpartyKey: string | null };

/** A person's standing rules about one feed input (foundation D-10, step 3). */
@Service()
export class FeedMatchRuleRepository extends BaseRepository<FeedMatchRule, NewFeedMatchRule> {
  protected readonly table = schema.feedMatchRules;
  protected readonly tableName = 'feed_match_rules';

  /** The input's rules, oldest first. */
  async findForInput(
    userId: string,
    inputId: string,
    tx: DatabaseTransaction
  ): Promise<MatchRule[]> {
    const r = schema.feedMatchRules;
    return this.getDb(tx)
      .select({
        id: r.id,
        matchField: r.matchField,
        pattern: r.pattern,
        destinationAccountId: r.destinationAccountId,
        ledgerKind: r.ledgerKind,
        counterpartyKey: sql<string | null>`CASE WHEN ${r.matchField} = 'counterparty'
          THEN transfer_counterparty_key(${r.pattern}) END`,
      })
      .from(r)
      .where(and(eq(r.userId, userId), eq(r.inputId, inputId)))
      .orderBy(asc(r.createdAt), asc(r.id));
  }

  /** Each counterparty's `transfer_counterparty_key`, computed by the database. */
  async counterpartyKeys(
    counterparties: readonly string[],
    tx: DatabaseTransaction
  ): Promise<Map<string, string | null>> {
    const unique = [...new Set(counterparties)];
    if (unique.length === 0) return new Map();
    const rows = (await this.getDb(tx).execute(sql`
      SELECT v AS counterparty, transfer_counterparty_key(v) AS key
      FROM unnest(ARRAY[${sql.join(
        unique.map((v) => sql`${v}`),
        sql`, `
      )}]::text[]) AS v
    `)) as unknown as Array<{ counterparty: string; key: string | null }>;
    return new Map(rows.map((row) => [row.counterparty, row.key]));
  }
}
