import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import type {
  AnsweredTransferReview,
  PendingTransferReview,
  TransferCandidate,
  TransferCandidateReason,
  TransferReviewDecision,
  TransferReviewSplit,
} from '@scani/shared';
import { splitSumMatches, TRANSFER_REVIEW_SPLIT, transferReviewSplitSchema } from '@scani/shared';
import Decimal from 'decimal.js';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import {
  CANDIDATE_QTY_EPSILON,
  CANDIDATE_REASON_RANK,
  CANDIDATE_WINDOW_MS,
  INFLOW_KINDS,
  MATCH_WINDOW_MS,
  OUTFLOW_KINDS,
  QTY_MATCH_EPSILON,
} from '../lib/transfer-matching';
import { PriceGraphService } from './pricing/PriceGraphService';

/**
 * Why a split was refused, in terms the API can turn into the right status.
 *
 * A union rather than a boolean because the failures are not interchangeable:
 * "no longer waiting" is an ordinary race with a second tab and the row should
 * simply disappear, while "the parts add up to 3,900 and the transfer was
 * 4,000" is the reader's own arithmetic and they need the number back.
 */
export type SplitResolveResult =
  | { ok: true }
  | { ok: false; reason: 'gone' }
  | { ok: false; reason: 'partner_gone' }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'sum'; expected: string };

/**
 * The transfer-review queue (SC-150) — the surface behind
 * `LinkTransferPairsUseCase`'s "surface to user" comment, which for a long
 * time pointed at nothing.
 *
 * The queue is not a table. It is the set of rows the matcher declined to
 * touch — `kind` is an outflow, `transfer_group_id IS NULL`,
 * `transfer_review IS NULL` — which means it cannot drift out of step with
 * what the matcher actually did, and a row leaves the queue by exactly two
 * routes: a later nightly run pairs it, or a person answers it. There is no
 * third state to reconcile and no enqueue step that can be missed.
 *
 * Two rules this service exists to hold:
 *
 * 1. **It never resolves anything itself.** `listPending` widens the search
 *    for *candidates to show* well past the matcher's tolerances
 *    (`CANDIDATE_*` vs `QTY_MATCH_EPSILON` / `MATCH_WINDOW_MS`) and marks each
 *    one with why the matcher refused it. Not one of them is auto-linked. A
 *    queue that empties itself by guessing is the original defect wearing a
 *    different hat — it just moves the invented gain behind a progress bar.
 * 2. **A human's answer outranks the machine's.** `resolve` stamps
 *    `transfer_review`, which the matcher then treats as untouchable forever.
 *
 * SC-181 adds a third: **an answer can apply to part of a transaction.** The
 * three above are about the whole row, so a withdrawal that was partly a move
 * and partly a disposal could only be answered wrongly, in one direction or
 * the other. `resolveSplit` divides it; the parts must sum exactly to the
 * transaction, and the row is either wholly answered or still in the queue.
 */
@Service()
export class TransferReviewService {
  private readonly priceGraphService = Container.get(PriceGraphService);

  /**
   * How many outflows are waiting, and when the queue last gained one.
   *
   * Its own query rather than `listPending().length`, and deliberately a
   * cheap one: the review feed reads this on every page load, while the full
   * listing does a price lookup and a candidate search per row. One indexed
   * aggregate against `idx_holding_tx_transfer_review_pending`.
   */
  async pendingSummary(userId: string): Promise<{ count: number; latestCreatedAt: Date | null }> {
    const [row] = await db
      .select({
        count: sql<number>`count(*)::int`,
        latestCreatedAt: sql<Date | null>`max(${schema.holdingTransactions.createdAt})`,
      })
      .from(schema.holdingTransactions)
      .where(pendingPredicate(userId));
    return {
      count: row?.count ?? 0,
      latestCreatedAt: row?.latestCreatedAt ? new Date(row.latestCreatedAt) : null,
    };
  }

  /**
   * Every unpaired outflow with the context needed to judge it.
   *
   * Ordered newest first, matching every other list in the app. It is
   * tempting to order by `marketValueInBase` — the biggest invented gain is
   * the most worth answering — but the reader's own memory is the scarce
   * input here, and they remember last week's withdrawal, not the largest one
   * of 2023. The value is on the row so they can see it either way, and the
   * list is sortable by it in the UI.
   */
  async listPending(
    userId: string,
    opts: { limit?: number } = {}
  ): Promise<PendingTransferReview[]> {
    const [user] = await db
      .select({ baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    const outflows = await db
      .select({
        tx: schema.holdingTransactions,
        tokenSymbol: schema.tokens.symbol,
        tokenName: schema.tokens.name,
        accountName: schema.accounts.name,
        institutionName: schema.institutions.name,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .leftJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
      .where(pendingPredicate(userId))
      .orderBy(desc(schema.holdingTransactions.occurredAt))
      .limit(opts.limit ?? 200);

    if (outflows.length === 0) return [];

    const baseCurrencyCode = user?.baseCurrencyId
      ? await this.currencyCode(user.baseCurrencyId)
      : '';

    const results: PendingTransferReview[] = [];
    for (const row of outflows) {
      const quantity = new Decimal(row.tx.quantity).abs();
      results.push({
        transactionId: row.tx.id,
        holdingId: row.tx.holdingId,
        tokenSymbol: row.tokenSymbol,
        tokenName: row.tokenName,
        accountName: row.accountName,
        institutionName: row.institutionName,
        kind: row.tx.kind,
        quantity: quantity.toString(),
        occurredAt: row.tx.occurredAt.toISOString(),
        counterparty: row.tx.counterparty,
        description: row.tx.description,
        marketValueInBase: user?.baseCurrencyId
          ? await this.marketValue(quantity, row.tx.tokenId, user.baseCurrencyId, row.tx.occurredAt)
          : null,
        baseCurrencyCode,
        candidates: await this.candidatesFor(userId, {
          id: row.tx.id,
          tokenId: row.tx.tokenId,
          quantity,
          occurredAt: row.tx.occurredAt,
        }),
      });
    }
    return results;
  }

  /**
   * Record the user's answer.
   *
   * `paired` needs a partner and writes a shared `transfer_group_id` on both
   * legs; the other two decide the row alone. Everything happens in one
   * transaction because a half-applied pairing — a group id on one leg only —
   * is worse than either outcome: `CostBasisService` would buffer lots for a
   * partner that never arrives.
   *
   * Returns false when the row is not the caller's, is not an outflow, or has
   * already been answered. That last case is not an error worth raising: two
   * tabs open on the same queue is an ordinary thing to do, and the second
   * answer arriving to find the question gone is the correct outcome.
   */
  async resolve(
    userId: string,
    transactionId: string,
    decision: TransferReviewDecision,
    matchTransactionId?: string
  ): Promise<boolean> {
    if (decision === 'paired' && !matchTransactionId) {
      throw new Error('resolve: a "paired" decision requires matchTransactionId');
    }

    return db.transaction(async (tx) => {
      const [outflow] = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(and(eq(schema.holdingTransactions.id, transactionId), pendingPredicate(userId)))
        .limit(1);
      if (!outflow) return false;

      const groupId = decision === 'paired' ? crypto.randomUUID() : null;

      if (decision === 'paired' && matchTransactionId) {
        // The partner must still be unclaimed and must be an inflow of the
        // same token belonging to the same user. Re-checked here rather than
        // trusted from the listing: the candidate list the user chose from
        // may be minutes old, and in between a nightly run can have paired
        // that very inflow to something else.
        const [inflow] = await tx
          .select()
          .from(schema.holdingTransactions)
          .where(
            and(
              eq(schema.holdingTransactions.id, matchTransactionId),
              eq(schema.holdingTransactions.userId, userId),
              eq(schema.holdingTransactions.tokenId, outflow.tokenId),
              inArray(schema.holdingTransactions.kind, [...INFLOW_KINDS]),
              isNull(schema.holdingTransactions.transferGroupId)
            )
          )
          .limit(1);
        if (!inflow) return false;

        await tx
          .update(schema.holdingTransactions)
          .set({ transferGroupId: groupId, updatedAt: sql`now()` })
          .where(eq(schema.holdingTransactions.id, inflow.id));
      }

      await tx
        .update(schema.holdingTransactions)
        .set({
          transferReview: decision,
          transferReviewedAt: sql`now()`,
          // A whole answer is a whole answer: any division that was here is
          // gone. Belt-and-braces — a pending row cannot carry one — but the
          // two columns must never disagree, and this is one of the two
          // places that writes them.
          transferReviewSplit: null,
          ...(groupId ? { transferGroupId: groupId } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.holdingTransactions.id, outflow.id));

      return true;
    });
  }

  /**
   * Record an answer that applies to PARTS of the transaction (SC-181).
   *
   * The reported shape: a 4,000 USD Airwallex withdrawal of which 3,500 moved
   * to an account Scani cannot see and 500 genuinely left. Every SC-150 answer
   * is about the whole row, so the only options were to overstate the gain by
   * 3,500 or understate it by 500 — wrong in a direction either way, which is
   * the error family SC-149/150/151/166 have all been about.
   *
   * Three rules it enforces that the form also enforces, because the form is
   * not the only caller and a split that does not add up is a new way to be
   * wrong about money:
   *
   * - **The parts sum EXACTLY to the row's quantity.** Checked here, against
   *   the row this transaction actually is, inside the same transaction that
   *   writes it — not against a quantity the client sent, which is the number
   *   under dispute.
   * - **Whole or nothing.** There is no partially-answered state to persist:
   *   `transfer_review` goes to `'split'` in the same statement as the parts,
   *   so the queue predicate keeps working and the count still reaches zero.
   * - **A `paired` part re-checks its partner**, exactly as `resolve` does,
   *   and for the same reason: the candidate list is minutes old and a nightly
   *   run can have claimed that inflow in between.
   *
   * Nothing is inferred. The division comes from the person; this refuses
   * anything that does not add up rather than making it add up.
   */
  async resolveSplit(
    userId: string,
    transactionId: string,
    split: TransferReviewSplit
  ): Promise<SplitResolveResult> {
    const parsed = transferReviewSplitSchema.safeParse(split);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Invalid',
      };
    }
    const portions = parsed.data;

    return db.transaction(async (tx) => {
      const [outflow] = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(and(eq(schema.holdingTransactions.id, transactionId), pendingPredicate(userId)))
        .limit(1);
      if (!outflow) return { ok: false, reason: 'gone' } as const;

      const expected = new Decimal(outflow.quantity).abs();
      if (!splitSumMatches(portions, outflow.quantity)) {
        return { ok: false, reason: 'sum', expected: expected.toString() } as const;
      }

      const paired = portions.find((p) => p.decision === 'paired');
      let groupId: string | null = null;
      if (paired?.matchTransactionId) {
        const [inflow] = await tx
          .select()
          .from(schema.holdingTransactions)
          .where(
            and(
              eq(schema.holdingTransactions.id, paired.matchTransactionId),
              eq(schema.holdingTransactions.userId, userId),
              eq(schema.holdingTransactions.tokenId, outflow.tokenId),
              inArray(schema.holdingTransactions.kind, [...INFLOW_KINDS]),
              isNull(schema.holdingTransactions.transferGroupId)
            )
          )
          .limit(1);
        if (!inflow) return { ok: false, reason: 'partner_gone' } as const;

        groupId = crypto.randomUUID();
        await tx
          .update(schema.holdingTransactions)
          .set({ transferGroupId: groupId, updatedAt: sql`now()` })
          .where(eq(schema.holdingTransactions.id, inflow.id));
      }

      await tx
        .update(schema.holdingTransactions)
        .set({
          transferReview: TRANSFER_REVIEW_SPLIT,
          transferReviewSplit: portions,
          transferReviewedAt: sql`now()`,
          ...(groupId ? { transferGroupId: groupId } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.holdingTransactions.id, outflow.id));

      return { ok: true } as const;
    });
  }

  /**
   * The answers already given, newest first — the route back (SC-181).
   *
   * It exists because of a specific fact rather than for symmetry: 573
   * transfers were answered `left_control` in one bulk pass, and any of them
   * that were partly a move between the user's own accounts are now
   * overstated. Shipping the split with no way to reach an answered row would
   * leave the very withdrawal that prompted it unfixable, because it is
   * already answered.
   *
   * Deliberately NOT folded into the pending queue. The queue's whole value is
   * that its count reaches zero and means something; a list that also holds
   * every answered row can never reach zero and stops being a queue. This is a
   * separate read with one action on it — reopen — after which the row IS a
   * pending row and carries candidates, a price and the full answer surface.
   *
   * Cheap on purpose: no candidate search and no price lookup, the two
   * per-row round trips `listPending` pays. Those are for making a judgement,
   * and nobody is making one here — they are finding a row they already
   * decided. One indexed read.
   */
  async listAnswered(
    userId: string,
    opts: { limit?: number } = {}
  ): Promise<AnsweredTransferReview[]> {
    const rows = await db
      .select({
        tx: schema.holdingTransactions,
        tokenSymbol: schema.tokens.symbol,
        accountName: schema.accounts.name,
        institutionName: schema.institutions.name,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .leftJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          inArray(schema.holdingTransactions.kind, [...OUTFLOW_KINDS]),
          isNotNull(schema.holdingTransactions.transferReview)
        )
      )
      .orderBy(desc(schema.holdingTransactions.transferReviewedAt))
      .limit(opts.limit ?? 200);

    return rows.map(({ tx, tokenSymbol, accountName, institutionName }) => {
      const split = transferReviewSplitSchema.safeParse(tx.transferReviewSplit);
      return {
        transactionId: tx.id,
        holdingId: tx.holdingId,
        tokenSymbol,
        accountName,
        institutionName,
        kind: tx.kind,
        quantity: new Decimal(tx.quantity).abs().toString(),
        occurredAt: tx.occurredAt.toISOString(),
        counterparty: tx.counterparty,
        decision: tx.transferReview ?? '',
        split: split.success ? split.data : null,
        reviewedAt: tx.transferReviewedAt?.toISOString() ?? null,
      } satisfies AnsweredTransferReview;
    });
  }

  /**
   * Undo an answer, putting the row back in the queue.
   *
   * A review surface without this one is a trap: every decision here is a
   * judgement made from partial memory, and "I picked the wrong deposit" has
   * to be recoverable or the careful reader stops answering at all. Clearing
   * a `paired` decision also clears the group id from BOTH legs, otherwise
   * the pairing survives its own reversal.
   *
   * It clears a split the same way, which is what makes a division reversible
   * — including back to a whole answer (SC-181). There is no separate unsplit
   * operation: reopening returns the row to the queue, where all four shapes
   * of answer are available again.
   */
  async reopen(userId: string, transactionId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.id, transactionId),
            eq(schema.holdingTransactions.userId, userId)
          )
        )
        .limit(1);
      if (!row?.transferReview) return false;

      if (row.transferGroupId) {
        await tx
          .update(schema.holdingTransactions)
          .set({ transferGroupId: null, updatedAt: sql`now()` })
          .where(
            and(
              eq(schema.holdingTransactions.userId, userId),
              eq(schema.holdingTransactions.transferGroupId, row.transferGroupId)
            )
          );
      }

      await tx
        .update(schema.holdingTransactions)
        .set({
          transferReview: null,
          transferReviewSplit: null,
          transferReviewedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.holdingTransactions.id, transactionId));

      return true;
    });
  }

  /**
   * Inflows that might be the same money, under a net deliberately wider than
   * the matcher's — see `CANDIDATE_WINDOW_MS` for why widening what a person
   * is *shown* is the opposite of widening what the machine *decides*.
   *
   * `withinStrictTolerance` is computed against the matcher's own constants,
   * so a candidate marked "would have matched" really would have; that is the
   * whole content of the `ambiguous` case, where several did and the matcher
   * therefore took none.
   */
  private async candidatesFor(
    userId: string,
    outflow: { id: string; tokenId: string; quantity: Decimal; occurredAt: Date }
  ): Promise<TransferCandidate[]> {
    const rows = await db
      .select({
        tx: schema.holdingTransactions,
        accountName: schema.accounts.name,
        institutionName: schema.institutions.name,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .leftJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          eq(schema.holdingTransactions.tokenId, outflow.tokenId),
          inArray(schema.holdingTransactions.kind, [...INFLOW_KINDS]),
          isNull(schema.holdingTransactions.transferGroupId),
          ne(schema.holdingTransactions.id, outflow.id),
          gte(
            schema.holdingTransactions.occurredAt,
            new Date(outflow.occurredAt.getTime() - CANDIDATE_WINDOW_MS)
          ),
          lte(
            schema.holdingTransactions.occurredAt,
            new Date(outflow.occurredAt.getTime() + CANDIDATE_WINDOW_MS)
          )
        )
      );

    const scored = rows.flatMap(({ tx, accountName, institutionName }) => {
      const inQty = new Decimal(tx.quantity).abs();
      const delta = inQty.minus(outflow.quantity);
      // Percentage of the OUTFLOW, not of the inflow: the outflow is the row
      // being judged and the one whose amount the reader is looking at.
      const deltaPct = outflow.quantity.isZero()
        ? new Decimal(0)
        : delta.div(outflow.quantity).mul(100);
      const timeDeltaMs = tx.occurredAt.getTime() - outflow.occurredAt.getTime();

      const qtyOk = delta.abs().lte(outflow.quantity.mul(QTY_MATCH_EPSILON));
      const timeOk = Math.abs(timeDeltaMs) <= MATCH_WINDOW_MS;
      const withinCandidateQty = delta.abs().lte(outflow.quantity.mul(CANDIDATE_QTY_EPSILON));
      // A row that fails the wide quantity net is a different amount of a
      // different thing, not a near miss. Showing it would pad the list with
      // rows whose only claim is "same token, same fortnight".
      if (!withinCandidateQty) return [];

      const reason: TransferCandidateReason =
        qtyOk && timeOk
          ? 'ambiguous'
          : qtyOk
            ? 'time_outside_window'
            : timeOk
              ? 'quantity_outside_tolerance'
              : 'both_outside';

      return [
        {
          transactionId: tx.id,
          holdingId: tx.holdingId,
          accountName,
          institutionName,
          kind: tx.kind,
          quantity: inQty.toString(),
          occurredAt: tx.occurredAt.toISOString(),
          reason,
          quantityDeltaPct: deltaPct.toDecimalPlaces(3).toNumber(),
          timeDeltaMs,
          withinStrictTolerance: qtyOk && timeOk,
        } satisfies TransferCandidate,
      ];
    });

    return scored
      .sort((a, b) => {
        const byReason =
          (CANDIDATE_REASON_RANK[a.reason] ?? 99) - (CANDIDATE_REASON_RANK[b.reason] ?? 99);
        if (byReason !== 0) return byReason;
        const byQty = Math.abs(a.quantityDeltaPct) - Math.abs(b.quantityDeltaPct);
        if (byQty !== 0) return byQty;
        return Math.abs(a.timeDeltaMs) - Math.abs(b.timeDeltaMs);
      })
      .slice(0, 8);
  }

  /**
   * What realizing this row at market would book — the number that says why
   * the question is worth answering.
   *
   * Null on no priceable route, and null is rendered as "unknown" rather than
   * as zero. SC-151 is making `stale` mean something; when it does, this is
   * one of the callers that should refuse rather than round.
   */
  private async marketValue(
    quantity: Decimal,
    tokenId: string,
    baseCurrencyId: string,
    at: Date
  ): Promise<string | null> {
    const converted = await this.priceGraphService.convert(quantity, tokenId, baseCurrencyId, at);
    return converted ? converted.amount.toString() : null;
  }

  private async currencyCode(tokenId: string): Promise<string> {
    const [row] = await db
      .select({ symbol: schema.tokens.symbol })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, tokenId))
      .limit(1);
    return row?.symbol ?? '';
  }
}

/**
 * The queue, as a predicate. Defined once because three callers ask the same
 * question and a badge that disagrees with its own page is the failure
 * `useReviewFeed` was written to end.
 */
function pendingPredicate(userId: string) {
  return and(
    eq(schema.holdingTransactions.userId, userId),
    inArray(schema.holdingTransactions.kind, [...OUTFLOW_KINDS]),
    isNull(schema.holdingTransactions.transferGroupId),
    isNull(schema.holdingTransactions.transferReview)
  );
}
