import type { DatabaseTransaction } from '@scani/db';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { type SQL, sql } from 'drizzle-orm';
import { Service } from 'typedi';

const logger = createComponentLogger('learned-category-rules');

export type PlannedCategory = { transactionId: string; categoryId: string; key: string };

type Scope = { fromIds?: readonly string[] };

/**
 * Spreads a person's category to their other rows with the same payee
 * (SC-1695). A rule is learned, never stored: for each payee key, the category
 * on at least two thirds of the rows a person or an import categorized. A tie
 * can never reach two thirds, so it teaches nothing.
 *
 * It writes only rows nobody categorized and rows an earlier rule did, so a
 * correction moves that payee's guesses with it, and a person's pick, a
 * person's clear and an import's category are never touched. Each call is one statement on the per-user payee
 * key index (`transaction_payee_key`, migration 20261010112916).
 */
@Service()
export class LearnedCategoryRules {
  async plan(
    userId: string,
    tx: DatabaseTransaction,
    scope: Scope = {}
  ): Promise<PlannedCategory[]> {
    const rows = (await tx.execute(sql`
      ${this.rules(userId, scope)}
      select h.id as "transactionId", r.category_id as "categoryId", r.key
      from holding_transactions h
      join rules r on r.key = transaction_payee_key(h.counterparty, h.description)
      where ${this.targets(userId)}
      order by h.occurred_at desc, h.id`)) as unknown as PlannedCategory[];
    return Array.from(rows);
  }

  async apply(
    userId: string,
    tx: DatabaseTransaction,
    scope: Scope = {}
  ): Promise<{ categorized: number }> {
    return { categorized: (await this.write(userId, tx, scope)).length };
  }

  /**
   * A person's pick, spread to the same payees in the pick's own transaction.
   * Returns how many other rows took the picked category; rows the evidence
   * sent elsewhere are moved too, but are not this pick's to announce.
   */
  async spreadFrom(
    userId: string,
    tx: DatabaseTransaction,
    ids: readonly string[],
    categoryId: string | null
  ): Promise<number> {
    const written = await this.write(userId, tx, { fromIds: ids });
    return categoryId ? written.filter((row) => row.category_id === categoryId).length : 0;
  }

  private async write(
    userId: string,
    tx: DatabaseTransaction,
    scope: Scope
  ): Promise<Array<{ category_id: string }>> {
    return (await tx.execute(sql`
      ${this.rules(userId, scope)}
      update holding_transactions h
      set category_id = r.category_id, category_set_by = 'rule', updated_at = now()
      from rules r
      where r.key = transaction_payee_key(h.counterparty, h.description)
        and ${this.targets(userId)}
      returning h.category_id`)) as unknown as Array<{ category_id: string }>;
  }

  /**
   * The whole-user spread an import runs once its rows are committed. Only
   * worker jobs call it: it reads every row the user has. A failure is logged
   * and swallowed, because the imported rows are already safe and the next
   * import or pick spreads whatever this missed.
   */
  async afterImport(userId: string): Promise<void> {
    try {
      await withTransaction((tx) => this.apply(userId, tx), {
        name: 'learned-category-rules',
        timeout: 60_000,
      });
    } catch (error) {
      logger.warn(
        { userId, error: error instanceof Error ? error.message : error },
        'Spreading learned categories after an import failed; the next import will'
      );
    }
  }

  /** Rows an automatic step may write: nobody's, or an earlier rule's, and not already right. */
  private targets(userId: string): SQL {
    return sql`h.user_id = ${userId}
      and (h.category_set_by is null or h.category_set_by = 'rule')
      and h.category_id is distinct from r.category_id`;
  }

  private rules(userId: string, { fromIds }: Scope): SQL {
    const scoped =
      fromIds && fromIds.length > 0
        ? sql`and transaction_payee_key(counterparty, description) in (
            select transaction_payee_key(counterparty, description) from holding_transactions
            where user_id = ${userId} and id in (${sql.join(
              fromIds.map((id) => sql`${id}::uuid`),
              sql`, `
            )}))`
        : sql``;
    return sql`with evidence as (
        select transaction_payee_key(counterparty, description) as key, category_id, count(*)::int as n
        from holding_transactions
        where user_id = ${userId}
          and category_set_by in ('person', 'import')
          and transaction_payee_key(counterparty, description) is not null
          ${scoped}
        group by 1, 2
      ), ranked as (
        select key, category_id, n, sum(n) over (partition by key) as total,
          row_number() over (partition by key order by n desc) as rn
        from evidence
      ), rules as (
        select key, category_id from ranked where rn = 1 and n * 3 >= total * 2
      )`;
  }
}
