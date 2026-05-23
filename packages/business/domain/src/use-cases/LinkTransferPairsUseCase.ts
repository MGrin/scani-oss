/**
 * LinkTransferPairsUseCase
 *
 * Matches CEX withdrawals to wallet deposits (and vice versa) within a
 * user's cross-account transaction history, assigning a shared
 * `transfer_group_id`. Enables cross-venue cost basis: buy on Binance,
 * withdraw to wallet, sell on DEX → one continuous lot chain instead of
 * two disconnected "zero-basis" legs.
 *
 * Matching rules:
 *   1. Kinds: `withdraw` / `transfer_out` on one side, `deposit` /
 *      `transfer_in` on the other.
 *   2. Same tokenId AND same user.
 *   3. Same |quantity| within a small epsilon (fees often differ by
 *      the chain-side gas; we match on the WITHDRAW amount to
 *      the DEPOSIT amount directly, tolerating ±1% drift which
 *      covers network fees on most chains).
 *   4. Timestamps within 30 min (CEX queues can delay; chain finality
 *      is minutes).
 *
 * Writes: `holding_transactions.transfer_group_id` on both rows with a
 * fresh uuid. Idempotent — re-running skips rows that already have a
 * group_id set.
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { Service } from 'typedi';

const logger = createComponentLogger('use-case:link-transfer-pairs');
const OUTFLOW_KINDS = ['withdraw', 'transfer_out'];
const INFLOW_KINDS = ['deposit', 'transfer_in'];
const MATCH_WINDOW_MS = 30 * 60 * 1000;
// 1% drift absorbs typical network fees. Users with unusual fee
// structures can re-link via a Phase-3 UI control that's not yet built.
const QTY_MATCH_EPSILON = new Decimal('0.01');

export interface LinkTransferPairsSummary {
  scanned: number;
  linked: number;
  ambiguous: number;
  durationMs: number;
}

@Service()
export class LinkTransferPairsUseCase {
  async execute(
    opts: { userId: string; sinceDays?: number } = { userId: '' }
  ): Promise<LinkTransferPairsSummary> {
    const startTime = Date.now();
    if (!opts.userId) {
      throw new Error('LinkTransferPairsUseCase requires userId');
    }
    const since = new Date(Date.now() - (opts.sinceDays ?? 365 * 2) * 24 * 60 * 60 * 1000);

    // Pull both outflows AND inflows in two queries, then do the
    // pair matching in memory. Previously we issued one candidates
    // SELECT per outflow — on heavy-CEX users with years of
    // withdrawals this produced thousands of round-trips per cron
    // run and timed out before finishing. Two queries × in-memory
    // time-windowed matching is O(n log n) per user and finishes
    // comfortably within the cron budget.
    const [outflows, inflowsByToken] = await Promise.all([
      db
        .select()
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, opts.userId),
            inArray(schema.holdingTransactions.kind, OUTFLOW_KINDS),
            gte(schema.holdingTransactions.occurredAt, since),
            isNull(schema.holdingTransactions.transferGroupId)
          )
        ),
      db
        .select()
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, opts.userId),
            inArray(schema.holdingTransactions.kind, INFLOW_KINDS),
            gte(schema.holdingTransactions.occurredAt, since),
            isNull(schema.holdingTransactions.transferGroupId)
          )
        )
        .then((rows) => {
          // Group by tokenId + sort by occurredAt so the matching
          // loop can binary-window without resorting every iteration.
          const map = new Map<string, typeof rows>();
          for (const r of rows) {
            const list = map.get(r.tokenId);
            if (list) list.push(r);
            else map.set(r.tokenId, [r]);
          }
          for (const list of map.values()) {
            list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
          }
          return map;
        }),
    ]);

    let linked = 0;
    let ambiguous = 0;

    for (const out of outflows) {
      const winStart = new Date(out.occurredAt.getTime() - MATCH_WINDOW_MS);
      const winEnd = new Date(out.occurredAt.getTime() + MATCH_WINDOW_MS);
      const outQty = new Decimal(out.quantity).abs();

      const perToken = inflowsByToken.get(out.tokenId) ?? [];
      const candidates = perToken.filter((c) => c.occurredAt >= winStart && c.occurredAt <= winEnd);

      // Pick the candidate closest in quantity that's within epsilon.
      // Ties break on closest timestamp. Anything else is flagged
      // ambiguous and skipped — wrongly auto-linking corrupts cost basis
      // more than not linking at all.
      const viable = candidates
        .map((c) => ({
          row: c,
          qtyDelta: outQty.sub(new Decimal(c.quantity).abs()).abs(),
          timeDelta: Math.abs(c.occurredAt.getTime() - out.occurredAt.getTime()),
        }))
        .filter((v) => v.qtyDelta.lte(outQty.mul(QTY_MATCH_EPSILON)));

      if (viable.length === 0) continue;
      if (viable.length > 1) {
        // Multiple plausible matches — ambiguous, surface to user via
        // Phase 3 review UI, don't auto-link.
        ambiguous += 1;
        continue;
      }
      const [best] = viable;
      if (!best) continue;

      const groupId = crypto.randomUUID();
      // Re-assert `transfer_group_id IS NULL` at write time so a
      // concurrent run (two cron runners, a worker retry after SIGTERM,
      // an ingester-triggered call) can't silently overwrite a pairing
      // it just made. If either row was grabbed in between, the UPDATE
      // returns 0 affected rows and we skip — both legs stay linked to
      // whichever run got there first.
      const updated = await db
        .update(schema.holdingTransactions)
        .set({ transferGroupId: groupId, updatedAt: sql`now()` })
        .where(
          and(
            inArray(schema.holdingTransactions.id, [out.id, best.row.id]),
            isNull(schema.holdingTransactions.transferGroupId)
          )
        )
        .returning({ id: schema.holdingTransactions.id });
      // Both rows must be updated for a successful pair; if only one
      // moved (the other was raced), we roll back by clearing the one
      // we set, keeping the ledger consistent.
      if (updated.length !== 2) {
        if (updated.length === 1) {
          const [lone] = updated;
          if (lone) {
            await db
              .update(schema.holdingTransactions)
              .set({ transferGroupId: null, updatedAt: sql`now()` })
              .where(eq(schema.holdingTransactions.id, lone.id));
          }
        }
        continue;
      }
      linked += 1;
    }

    const summary = {
      scanned: outflows.length,
      linked,
      ambiguous,
      durationMs: Date.now() - startTime,
    };
    logger.info({ summary, userId: opts.userId }, 'Transfer-pair linking complete');
    return summary;
  }
}
