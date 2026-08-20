import { db } from '@scani/db/connection';
import {
  auditKrakenLedger,
  type KrakenLedgerEntry,
  type KrakenLedgerRow,
} from '@scani/providers/providers/kraken';
import { sql } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { HoldingCoverageRepository } from '../repositories/HoldingCoverageRepository';
import { sourceForProvider } from '../services/transactions/transaction-source';

/**
 * Read from the same map the import pipeline routes by, so this repair and
 * the runtime cannot disagree about what a Kraken row is tagged with. It
 * throws at module load rather than defaulting: a silent fallback here would
 * make the audit query match nothing and report a clean production.
 */
const KRAKEN_SOURCE = (() => {
  const source = sourceForProvider('kraken');
  if (!source) throw new Error('No source tag registered for the kraken provider');
  return source;
})();

/** One coverage row a retraction would move, named so the plan is readable. */
export interface KrakenClaimingHolding {
  holdingId: string;
  symbol: string;
  txCount: number;
}

/** One Kraken account whose stored ledger contradicts its coverage claim. */
export interface KrakenCoveragePlan {
  accountId: string;
  accountName: string;
  userId: string;
  /** Stored ledger entries the audit ran over. */
  entriesAudited: number;
  /** Breaks in Kraken's own running balance. */
  balanceChainBreaks: number;
  /** Legs of two-legged operations whose other side never arrived. */
  unpairedOperations: number;
  claimingHoldings: KrakenClaimingHolding[];
}

/**
 * An account whose claim can be neither confirmed nor contradicted. Never
 * repaired — reported, so the run stops instead of guessing.
 */
export interface KrakenCoverageBlocked {
  accountId: string;
  accountName: string;
  reason: string;
  claimingHoldings: KrakenClaimingHolding[];
}

export interface KrakenCoverageAudit {
  plans: KrakenCoveragePlan[];
  blocked: KrakenCoverageBlocked[];
}

/** Every field `auditKrakenLedger` reads. A payload missing one cannot be audited. */
const REQUIRED_ENTRY_FIELDS = ['refid', 'type', 'asset', 'amount', 'fee', 'balance', 'time'];

function isAuditableEntry(payload: unknown): payload is KrakenLedgerEntry {
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return REQUIRED_ENTRY_FIELDS.every(
    (field) => record[field] !== undefined && record[field] !== null
  );
}

/**
 * Retract `holding_coverage.has_complete_tx_history` on Kraken accounts whose
 * OWN STORED LEDGER proves the claim false (SC-395).
 *
 * WHY THERE IS A BACKLOG AT ALL. The code fix makes the paginator's verdict
 * reach the router, so the next `since`-less Kraken import writes the right
 * flag by itself. The nightly sync is not that import: it carries a `since`,
 * and since SC-360 an incremental run does not write the completeness column
 * unless the provider retracted. So a standing `true` on a Kraken holding
 * does NOT self-heal the way SC-319's tx bounds did — it waits for a full
 * re-import a person triggers by hand, and may wait forever.
 *
 * WHY IT NEEDS NO API CALL, which is the part worth reading. Kraken stamps a
 * running `balance` and an operation `refid` on every ledger entry, and the
 * importer stores each entry verbatim in `holding_transactions.raw_payload`.
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 * `auditKrakenLedger` over the stored copy reproduces the live result to the
 ***REMOVED***
 * this repair is in our own database, and no unanswered request has to be
 * read as agreement.
 *
 * WHAT SILENCE MEANS. An account with no stored Kraken rows, or with a row
 * whose payload is missing a field the audit reads, produces a `blocked`
 * entry and no plan. An audit that runs and finds the ledger CONSISTENT also
 * produces no plan — a claim this can't contradict is a claim that stands.
 * Only a contradiction retracts.
 */
@Service()
export class RetractKrakenCoverageClaimsUseCase {
  private readonly coverageRepository = Container.get(HoldingCoverageRepository);

  /**
   * Every Kraken account holding a live completeness claim, split into the
   * ones its stored ledger contradicts and the ones it cannot speak to.
   * `userId` narrows it; omitted, it is every user.
   */
  async audit(userId?: string): Promise<KrakenCoverageAudit> {
    const claiming = (await db.execute(sql`
      select
        h.account_id as account_id,
        a.name       as account_name,
        h.user_id    as user_id,
        c.holding_id as holding_id,
        t.symbol     as symbol,
        (select count(*) from holding_transactions ht where ht.holding_id = c.holding_id) as tx_count
      from holding_coverage c
      join holdings h on h.id = c.holding_id
      join tokens t on t.id = h.token_id
      join accounts a on a.id = h.account_id
      where c.has_complete_tx_history = true
        and ${KRAKEN_SOURCE}::text = any(c.tx_sources)
        ${userId ? sql`and h.user_id = ${userId}::uuid` : sql``}
      order by t.symbol asc
    `)) as unknown as Array<Record<string, unknown>>;

    const byAccount = new Map<
      string,
      { accountName: string; userId: string; holdings: KrakenClaimingHolding[] }
    >();
    for (const row of claiming) {
      const accountId = String(row.account_id);
      const entry = byAccount.get(accountId) ?? {
        accountName: String(row.account_name),
        userId: String(row.user_id),
        holdings: [],
      };
      entry.holdings.push({
        holdingId: String(row.holding_id),
        symbol: String(row.symbol),
        txCount: Number(row.tx_count),
      });
      byAccount.set(accountId, entry);
    }

    const plans: KrakenCoveragePlan[] = [];
    const blocked: KrakenCoverageBlocked[] = [];

    for (const [accountId, entry] of byAccount) {
      const stored = (await db.execute(sql`
        select ht.external_id as ledger_id, ht.raw_payload as payload
        from holding_transactions ht
        join holdings h on h.id = ht.holding_id
        where ht.source = ${KRAKEN_SOURCE}
          and h.account_id = ${accountId}::uuid
      `)) as unknown as Array<Record<string, unknown>>;

      if (stored.length === 0) {
        blocked.push({
          accountId,
          accountName: entry.accountName,
          reason: 'the account claims a complete Kraken history and stores no Kraken ledger rows',
          claimingHoldings: entry.holdings,
        });
        continue;
      }

      const unauditable = stored.filter((row) => !isAuditableEntry(row.payload)).length;
      if (unauditable > 0) {
        blocked.push({
          accountId,
          accountName: entry.accountName,
          reason: `${unauditable} of ${stored.length} stored Kraken rows are missing a field the audit reads (${REQUIRED_ENTRY_FIELDS.join(', ')})`,
          claimingHoldings: entry.holdings,
        });
        continue;
      }

      const rows: KrakenLedgerRow[] = stored.map((row) => ({
        ledgerId: String(row.ledger_id),
        entry: row.payload as KrakenLedgerEntry,
      }));
      const result = auditKrakenLedger(rows);
      if (result.isComplete) continue;

      plans.push({
        accountId,
        accountName: entry.accountName,
        userId: entry.userId,
        entriesAudited: rows.length,
        balanceChainBreaks: result.balanceChainBreaks.length,
        unpairedOperations: result.unpairedOperations.length,
        claimingHoldings: entry.holdings,
      });
    }

    return { plans, blocked };
  }

  /**
   * Retract one account's claim, through the same method a failed import
   * uses. It is scoped to `(account, source)` and to rows currently reading
   * `true`, which is exactly this plan's population — so a holding that
   * healed between the audit and the write is a no-op rather than a
   * conflict, and no coverage row is ever brought into existence.
   */
  async apply(plan: KrakenCoveragePlan): Promise<number> {
    return this.coverageRepository.retractCompleteHistoryClaim(plan.accountId, KRAKEN_SOURCE);
  }

  /** The post-state, read back from the table rather than assumed. */
  async verify(
    holdingIds: readonly string[]
  ): Promise<Array<{ holdingId: string; hasCompleteTxHistory: boolean }>> {
    if (holdingIds.length === 0) return [];
    const rows = (await db.execute(sql`
      select holding_id, has_complete_tx_history
      from holding_coverage
      where holding_id in (${sql.join(
        holdingIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      holdingId: String(row.holding_id),
      hasCompleteTxHistory: Boolean(row.has_complete_tx_history),
    }));
  }
}
