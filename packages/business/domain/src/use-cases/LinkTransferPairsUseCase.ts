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
 *   2. Same user, and either the same tokenId or the SAME ASSET ON ANOTHER
 *      CHAIN — see `candidatePairClass` for what makes two token rows the
 *      same asset, and for the four conditions a bridge has to satisfy that
 *      a same-token pair does not (SC-336).
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
 *
 * What it does NOT do (SC-150): resolve anything it is unsure about. A row
 * with several plausible matches, or none, is left alone for the review queue
 * — `TransferReviewService` reads exactly the set this pass declines to touch
 * — and the tolerances above stay narrow on purpose. Widening them to empty
 * the queue would trade a visible question for a silent wrong pairing, which
 * is the more expensive of the two: an unlinked transfer overstates a gain and
 * says so, a mislinked one merges two unrelated lot chains and does not.
 *
 * It also never overrules a person. Once a human has answered a row
 * (`transfer_review IS NOT NULL`) this pass skips it forever, including the
 * ones they said left their control — otherwise the next nightly run would
 * find a coincidental inflow and quietly un-answer the question.
 *
 * **That skip is why the bridge rule below changes nothing in production
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 */

import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import {
  candidatePairClass,
  INFLOW_KINDS,
  MATCH_WINDOW_MS,
  OUTFLOW_KINDS,
  QTY_MATCH_EPSILON,
  type TransferLeg,
} from '../lib/transfer-matching';

const logger = createComponentLogger('use-case:link-transfer-pairs');

export interface LinkTransferPairsSummary {
  scanned: number;
  linked: number;
  ambiguous: number;
  /** Of `linked`, how many joined two chains rather than two accounts. */
  bridged: number;
  durationMs: number;
}

/**
 * The identity facts a pair is judged on, read alongside the rows.
 *
 * `metadata` on a wallet account carries `userWalletId` and `chainId` (written
 * by the wallet importer); an exchange account has neither, which is exactly
 * the right answer for it — an exchange has no chain to bridge from.
 */
const legColumns = {
  id: schema.holdingTransactions.id,
  holdingId: schema.holdingTransactions.holdingId,
  tokenId: schema.holdingTransactions.tokenId,
  quantity: schema.holdingTransactions.quantity,
  occurredAt: schema.holdingTransactions.occurredAt,
  canonicalAssetKey: sql<
    string | null
  >`case when ${schema.tokens.lookalikeOf} is null then ${schema.tokens.providerMetadata}->'coingecko'->>'id' end`,
  walletId: sql<string | null>`${schema.accounts.metadata}->>'userWalletId'`,
  chainKey: sql<string | null>`${schema.accounts.metadata}->>'chainId'`,
} as const;

type LegRow = {
  id: string;
  holdingId: string;
  tokenId: string;
  quantity: string;
  occurredAt: Date;
  canonicalAssetKey: string | null;
  walletId: string | null;
  chainKey: string | null;
};

function toLeg(row: LegRow): TransferLeg {
  return {
    transactionId: row.id,
    holdingId: row.holdingId,
    tokenId: row.tokenId,
    canonicalAssetKey: row.canonicalAssetKey,
    walletId: row.walletId,
    chainKey: row.chainKey,
    occurredAt: row.occurredAt,
    quantityAbs: new Decimal(row.quantity).abs(),
  };
}

@Service()
export class LinkTransferPairsUseCase {
  /**
   * Link two legs the OWNER declared, rather than two this pass guessed at
   * (SC-607).
   *
   * ## Why a declared pair does not go through `execute`
   *
   * Everything below this method exists to decide whether two rows nobody
   * connected are the same money: a ±1% quantity window, a ±30-minute time
   * window, a refusal when more than one candidate fits. Those tolerances are
   * evidence-weighing, and there is no evidence to weigh here — the pair was
   * stated, and both rows were written by the statement.
   *
   * Re-deriving it would be strictly worse than useless. A second movement of
   * the same size within half an hour makes the declared pair *ambiguous*, and
   * `execute` correctly declines an ambiguous pair — so the transfer the owner
   * just recorded would arrive unlinked, in the review queue, asking them the
   * question they had already answered. That is the exact outcome SC-607
   * exists to prevent, reached by way of the code meant to prevent it.
   *
   * ## What it still refuses
   *
   * `transfer_group_id IS NULL` is re-asserted on the UPDATE, and both rows
   * must move or neither does — the same guard `execute` uses, for the same
   * reason: a concurrent writer must not have a pairing silently overwritten.
   * A declared pair is certain about WHICH rows; it is not thereby entitled to
   * clobber a group id that arrived first.
   *
   * Returns the group id both legs now share, or `null` when either row was
   * already spoken for.
   */
  async linkDeclaredPair(
    pair: {
      outflow: { holdingId: string; source: string; externalId: string };
      inflow: { holdingId: string; source: string; externalId: string };
      userId: string;
    },
    tx: DatabaseTransaction
  ): Promise<string | null> {
    const groupId = crypto.randomUUID();
    const leg = (key: { holdingId: string; source: string; externalId: string }) =>
      and(
        eq(schema.holdingTransactions.userId, pair.userId),
        eq(schema.holdingTransactions.holdingId, key.holdingId),
        eq(schema.holdingTransactions.source, key.source),
        eq(schema.holdingTransactions.externalId, key.externalId)
      );

    const updated = await tx
      .update(schema.holdingTransactions)
      .set({ transferGroupId: groupId, updatedAt: sql`now()` })
      .where(
        and(
          or(leg(pair.outflow), leg(pair.inflow)),
          isNull(schema.holdingTransactions.transferGroupId)
        )
      )
      .returning({ id: schema.holdingTransactions.id });

    // The answer is written in the SAME method that writes the group id, not
    // by the caller afterwards, and that is the fix for how this went wrong
    // once: the group id alone already keeps the row out of the queue, so a
    // caller that forgot the stamp produced a correct prompt count and a row
    // whose provenance read `unattributed` — an owner-DECLARED transfer
    // indistinguishable from one the nightly matcher guessed at, and fair game
    // for every repair pass gating on the answer having come from a person.
    //
    // Nothing detected that, because there was no disagreement to detect: a
    // step was simply absent, and an absent step leaves no artefact. Folding
    // it into the one method that cannot be skipped is what makes it
    // unskippable rather than merely tested for.
    //
    // `paired` rather than `internal`: both legs exist, because the caller
    // wrote them. `internal` is the answer that has to write the arrival
    // itself, and it does not move an existing destination's balance.

    if (updated.length !== 2) {
      // One leg moved and the other did not, so the pairing is half-made.
      // Throwing rolls the caller's transaction back rather than leaving a
      // transfer whose money left one holding and arrived in another with
      // nothing recording that they are the same money.
      throw new Error(
        `Declared transfer pairing affected ${updated.length} rows, expected 2 — refusing a half-linked pair`
      );
    }

    await tx
      .update(schema.holdingTransactions)
      .set({
        transferReview: 'paired',
        transferReviewedAt: new Date(),
        transferReviewSource: 'user',
      })
      .where(leg(pair.outflow));

    logger.info({ userId: pair.userId, groupId }, 'Linked a declared transfer pair');
    return groupId;
  }

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
    const [outflows, inflows] = await Promise.all([
      db
        .select(legColumns)
        .from(schema.holdingTransactions)
        .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
        .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
        .where(
          and(
            eq(schema.holdingTransactions.userId, opts.userId),
            inArray(schema.holdingTransactions.kind, [...OUTFLOW_KINDS]),
            gte(schema.holdingTransactions.occurredAt, since),
            isNull(schema.holdingTransactions.transferGroupId),
            // A row someone has already answered is not a candidate, whatever
            // they answered. See the class doc.
            isNull(schema.holdingTransactions.transferReview)
          )
        )
        .then((rows) => rows.map(toLeg)),
      db
        .select(legColumns)
        .from(schema.holdingTransactions)
        .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
        .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
        .where(
          and(
            eq(schema.holdingTransactions.userId, opts.userId),
            inArray(schema.holdingTransactions.kind, [...INFLOW_KINDS]),
            gte(schema.holdingTransactions.occurredAt, since),
            isNull(schema.holdingTransactions.transferGroupId)
          )
        )
        .then((rows) => {
          // Indexed twice — by token row for a same-token pair, and by
          // canonical asset for a bridge, whose two legs are two token rows by
          // definition. One arrival can sit in both indexes, so the matching
          // loop de-duplicates by transaction id before counting: a native
          // asset's bridge is BOTH (ETH is one token row across chains), and
          // counting it twice would read as ambiguity and refuse a pair the
          // evidence is unanimous about.
          const byToken = new Map<string, TransferLeg[]>();
          const byAsset = new Map<string, TransferLeg[]>();
          const push = (map: Map<string, TransferLeg[]>, key: string, leg: TransferLeg): void => {
            const list = map.get(key);
            if (list) list.push(leg);
            else map.set(key, [leg]);
          };
          for (const row of rows) {
            const leg = toLeg(row);
            push(byToken, leg.tokenId, leg);
            if (leg.canonicalAssetKey !== null) push(byAsset, leg.canonicalAssetKey, leg);
          }
          for (const map of [byToken, byAsset]) {
            for (const list of map.values()) {
              list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
            }
          }
          return { byToken, byAsset };
        }),
    ]);

    let linked = 0;
    let ambiguous = 0;
    let bridged = 0;

    for (const out of outflows) {
      const winStart = out.occurredAt.getTime() - MATCH_WINDOW_MS;
      const winEnd = out.occurredAt.getTime() + MATCH_WINDOW_MS;
      const outQty = out.quantityAbs;

      const seen = new Set<string>();
      const candidates: Array<{ leg: TransferLeg; bridge: boolean }> = [];
      for (const list of [
        inflows.byToken.get(out.tokenId) ?? [],
        out.canonicalAssetKey === null ? [] : (inflows.byAsset.get(out.canonicalAssetKey) ?? []),
      ]) {
        for (const leg of list) {
          const at = leg.occurredAt.getTime();
          if (at < winStart || at > winEnd) continue;
          // Both legs on ONE holding is not a transfer (SC-350) — the guard
          // that used to sit HERE, as a second copy of `candidatePairClass`'s
          // condition 4. It moved into that predicate (SC-347) because the copy
          // protected this matcher and nothing else: `candidatesFor` and
          // `claimInflow` share the predicate and had no copy, so the review
          // queue went on offering same-holding arrivals and a reader answered
          // `paired` on one. A rule that has to be restated at every call site
          // is a rule that is enforced at some of them.
          if (seen.has(leg.transactionId)) continue;
          const pairClass = candidatePairClass(out, leg);
          if (pairClass === null) continue;
          seen.add(leg.transactionId);
          candidates.push({ leg, bridge: pairClass === 'bridged_asset' });
        }
      }

      // Pick the candidate closest in quantity that's within epsilon.
      // Ties break on closest timestamp. Anything else is flagged
      // ambiguous and skipped — wrongly auto-linking corrupts cost basis
      // more than not linking at all.
      const viable = candidates
        .map((c) => ({
          row: { id: c.leg.transactionId },
          bridge: c.bridge,
          qtyDelta: outQty.sub(c.leg.quantityAbs).abs(),
          timeDelta: Math.abs(c.leg.occurredAt.getTime() - out.occurredAt.getTime()),
        }))
        .filter((v) => v.qtyDelta.lte(outQty.mul(QTY_MATCH_EPSILON)));

      if (viable.length === 0) continue;
      if (viable.length > 1) {
        // Multiple plausible matches. Don't auto-link — the row stays
        // `transfer_group_id IS NULL AND transfer_review IS NULL`, which is
        // the review queue's definition, so it reaches the user through
        // `TransferReviewService` without needing a second table to sit in.
        // The counter is for the job summary only.
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
            inArray(schema.holdingTransactions.id, [out.transactionId, best.row.id]),
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
      if (best.bridge) bridged += 1;
    }

    const summary = {
      scanned: outflows.length,
      linked,
      ambiguous,
      bridged,
      durationMs: Date.now() - startTime,
    };
    logger.info({ summary, userId: opts.userId }, 'Transfer-pair linking complete');
    return summary;
  }
}
