import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, sql } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { HoldingCoverageRepository } from '../repositories/HoldingCoverageRepository';

/** One coverage row whose stored tx bounds disagree with the ledger they summarize. */
export interface CoverageBoundsPlan {
  holdingId: string;
  userId: string;
  symbol: string;
  accountName: string;
  txCount: number;
  storedFirstTxAt: Date | null;
  storedLastTxAt: Date | null;
  ledgerFirstTxAt: Date | null;
  ledgerLastTxAt: Date | null;
  /** Whole days the stored start reaches back beyond the ledger's own oldest event. */
  firstEarlyDays: number;
  /** Whole days the stored end reaches past the ledger's own newest event. */
  lastLateDays: number;
}

const MS_PER_DAY = 86_400_000;

function wholeDaysBetween(from: Date | null, to: Date | null): number {
  if (!from || !to) return 0;
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value as string);
}

/**
 * Re-derive `holding_coverage.first_tx_at` / `last_tx_at` from the ledger for
 * the rows that still carry a RUN's bounds instead of their own (SC-308).
 *
 * WHY A BACKLOG AND NOT A JOB. #905 removed the source: the importer now
 * reports `null` for both bounds and `HoldingTransactionRepository.bulkUpsert`
 * derives them per holding at the write, so every holding self-heals the next
 * time anything writes its ledger. What it cannot reach is a holding nothing
 * writes to again — measured read-only on production 2026-08-18, nearly every
 * coverage row was re-derived by that morning's imports and a handful were
 * not, because those holdings received no event. Those keep whatever SC-308
 * stamped, and `LEAST`/`GREATEST` could only ever have widened it.
 *
 * WHY IT UPDATES AND NEVER INSERTS. The obvious statement — insert ... select
 * from `holdings`, on conflict update — would also CREATE a coverage row for
 * every holding that has none: 23 of production's 93. That is not a wider
 * repair, it is a different claim. `has_complete_tx_history` defaults to
 * `false`, and `CostBasisService.historyCompletenessOf` reads an absent row as
 * `'unrecorded'` and a present `false` one as `'incomplete'` — three states,
 * not two, precisely so that holdings nobody ever imported do not read as
 * deliberately-truncated ones. So the plan is drawn from `holding_coverage`,
 * and a holding without a row stays without one.
 *
 * The bounds themselves come from `syncTxBoundsFromLedger`, the same statement
 * the write path uses, rather than a second SQL expression that would have to
 * be kept saying the same thing.
 */
@Service()
export class RepairCoverageTxBoundsUseCase {
  private readonly coverageRepository = Container.get(HoldingCoverageRepository);

  /**
   * Every coverage row whose stored bounds differ from the ledger's, derived —
   * never read from a list. `userId` narrows it; omitted, it is every user.
   */
  async plansFor(userId?: string): Promise<CoverageBoundsPlan[]> {
    const rows = (await db.execute(sql`
      select
        c.holding_id      as holding_id,
        h.user_id         as user_id,
        t.symbol          as symbol,
        a.name            as account_name,
        coalesce(l.n, 0)  as tx_count,
        c.first_tx_at     as stored_first,
        c.last_tx_at      as stored_last,
        l.m               as ledger_first,
        l.x               as ledger_last
      from holding_coverage c
      join holdings h on h.id = c.holding_id
      join tokens t on t.id = h.token_id
      join accounts a on a.id = h.account_id
      left join (
        select holding_id, min(occurred_at) m, max(occurred_at) x, count(*) n
        from holding_transactions group by holding_id
      ) l on l.holding_id = c.holding_id
      where (c.first_tx_at is distinct from l.m or c.last_tx_at is distinct from l.x)
        ${userId ? sql`and h.user_id = ${userId}::uuid` : sql``}
      order by c.first_tx_at asc nulls last
    `)) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const storedFirstTxAt = toDate(row.stored_first);
      const storedLastTxAt = toDate(row.stored_last);
      const ledgerFirstTxAt = toDate(row.ledger_first);
      const ledgerLastTxAt = toDate(row.ledger_last);
      return {
        holdingId: String(row.holding_id),
        userId: String(row.user_id),
        symbol: String(row.symbol),
        accountName: String(row.account_name),
        txCount: Number(row.tx_count),
        storedFirstTxAt,
        storedLastTxAt,
        ledgerFirstTxAt,
        ledgerLastTxAt,
        firstEarlyDays: wholeDaysBetween(storedFirstTxAt, ledgerFirstTxAt),
        lastLateDays: wholeDaysBetween(ledgerLastTxAt, storedLastTxAt),
      };
    });
  }

  /**
   * Re-derive one row. Idempotent, and safe to re-run: the statement reads the
   * ledger every time, so a holding that has since healed writes itself the
   * value it already holds.
   */
  async apply(plan: CoverageBoundsPlan): Promise<void> {
    await this.coverageRepository.syncTxBoundsFromLedger([plan.holdingId]);
  }

  /** The post-state, read back from the table rather than assumed. */
  async verify(holdingIds: readonly string[]): Promise<CoverageBoundsPlan[]> {
    if (holdingIds.length === 0) return [];
    const remaining = await this.plansFor();
    const wanted = new Set(holdingIds);
    return remaining.filter((plan) => wanted.has(plan.holdingId));
  }

  /** Tokens whose backfill window moves, and by how many days at each end. */
  async windowShiftByToken(
    plans: readonly CoverageBoundsPlan[]
  ): Promise<Array<{ tokenId: string; symbol: string; startDaysEarlier: number }>> {
    if (plans.length === 0) return [];
    const tokenIds = new Set<string>();
    for (const plan of plans) {
      const [holding] = await db
        .select({ tokenId: schema.holdings.tokenId })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, plan.holdingId))
        .limit(1);
      if (holding) tokenIds.add(holding.tokenId);
    }

    const rows = (await db.execute(sql`
      with led as (
        select holding_id, min(occurred_at) m from holding_transactions group by holding_id
      )
      select
        h.token_id as token_id,
        t.symbol   as symbol,
        min(c.first_tx_at) as stored_first,
        min(l.m)           as ledger_first
      from holdings h
      join tokens t on t.id = h.token_id
      left join holding_coverage c on c.holding_id = h.id
      left join led l on l.holding_id = h.id
      where h.token_id in (${sql.join(
        [...tokenIds].map((id) => sql`${id}::uuid`),
        sql`, `
      )})
      group by h.token_id, t.symbol
    `)) as unknown as Array<Record<string, unknown>>;

    const out: Array<{ tokenId: string; symbol: string; startDaysEarlier: number }> = [];
    for (const row of rows) {
      const stored = toDate(row.stored_first);
      const ledger = toDate(row.ledger_first);
      const days = wholeDaysBetween(stored, ledger);
      if (days !== 0) {
        out.push({
          tokenId: String(row.token_id),
          symbol: String(row.symbol),
          startDaysEarlier: days,
        });
      }
    }
    return out.sort((a, b) => b.startDaysEarlier - a.startDaysEarlier);
  }
}
