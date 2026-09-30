import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import type { HoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type {
  AnswerAttribution,
  AnsweredTransferReview,
  AnswerSource,
  BulkTransferApplied,
  BulkTransferDecision,
  BulkTransferEntry,
  BulkTransferPreview,
  BulkTransferRefusal,
  HiddenTransferReview,
  PendingTransferReview,
  TransferCandidate,
  TransferCandidateCombination,
  TransferCandidateReason,
  TransferDestination,
  TransferDestinationRef,
  TransferReviewDecision,
  TransferReviewSplit,
} from '@scani/shared';
import {
  answerSourceOf,
  answerWithdrawnBy,
  counterpartyFromPayload,
  explorerLinks,
  isBulkEligibleAnswer,
  MAX_BULK_TRANSFER_ROWS,
  normalizeCounterparty,
  RULE_ANSWER_SOURCE,
  RULE_ASSERTED_DECISION,
  splitSumMatches,
  TRANSFER_DESTINATION_RELEVANCE_ORDER,
  TRANSFER_REVIEW_CREATED_SOURCE,
  TRANSFER_REVIEW_SPLIT,
  transferReviewSplitSchema,
  txHashFromPayload,
} from '@scani/shared';
import Decimal from 'decimal.js';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import {
  arrivalMetadata,
  readCreatedDestination,
  readMovedDestinationAnchor,
} from '../lib/created-destination';
import { type DeclaredPairLegFacts, declaredPairLegs } from '../lib/declared-transfer';
import { holdingIsUntouched } from '../lib/holding-untouched';
import { ilikePattern } from '../lib/text-search';
import {
  arrivalCombinations,
  CANDIDATE_QTY_EPSILON,
  CANDIDATE_REASON_RANK,
  CANDIDATE_WINDOW_MS,
  INFLOW_KINDS,
  MATCH_WINDOW_MS,
  MAX_COMBINED_ARRIVALS,
  OUTFLOW_KINDS,
  QTY_MATCH_EPSILON,
  reviewPairClass,
  type TransferLeg,
} from '../lib/transfer-matching';
import {
  activeRuleJoin,
  counterpartyKeySql,
  pendingPredicate,
  ruleWritablePredicate,
} from '../lib/transfer-review-queue';
import {
  unlinkPairRefusal,
  type WithdrawRefusalReason,
  withdrawPairingRefusal,
} from '../lib/transfer-unlink';
import { upstreamEventKey } from '../lib/upstream-event';
import { HoldingCoverageRepository } from '../repositories/HoldingCoverageRepository';
// A service reaching for a use case, which nothing else in this layer does.
// The alternative was a second writer of `holdings.balance` for the undo in
// `undoDeclaredTransfer`, and SC-245 is what that costs. Resolved at the CALL
// SITE rather than in a class field on purpose: `UpdateHoldingUseCase` holds
// `Container.get(TransferReviewService)` in a field of its own, and two
// class-field `Container.get`s pointing at each other recurse forever, since
// typedi caches an instance only after its constructor returns.
import { UpdateHoldingUseCase } from '../use-cases/UpdateHoldingUseCase';
import {
  BalanceSyncOwnershipService,
  type SyncOwnableAccount,
} from './accounts/BalanceSyncOwnershipService';
import { type BalanceSyncSource, MANUAL_HOLDING_SOURCE } from './holdings/balance-sync-sources';
import { HOLDING_OPEN_OBSERVATION_SOURCE, HoldingService } from './holdings/HoldingService';
import { manualEditFeeExternalId } from './holdings/ManualBalanceEditService';
import { PriceGraphService } from './pricing/PriceGraphService';

/**
 * Why an answer was refused, in terms the API can turn into the right status.
 *
 * A union rather than a boolean because the failures are not interchangeable:
 * "no longer waiting" is an ordinary race with a second tab and the row should
 * simply disappear, while "that holding was deleted while the sheet was open"
 * sends the reader back to a picker rather than away from the queue.
 */
export type TransferResolveResult =
  | { ok: true }
  | { ok: false; reason: 'gone' }
  | { ok: false; reason: 'partner_gone' }
  | { ok: false; reason: 'destination_gone' }
  /**
   * The destination is real, is the caller's, and is on the other side of an
   * ownership boundary (SC-859). Its own reason rather than `destination_gone`
   * because that sentence — "that holding is no longer there" — is false about
   * a holding that is present and deliberately refused, and it would send the
   * reader back to a picker to choose the same account again.
   */
  | { ok: false; reason: 'own_wallet_destination'; address: string }
  /**
   * Deposits paired together whose total is not the withdrawal (SC-1365). The
   * same shape a split's arithmetic refusal takes, for the same reason: the
   * reader needs the number back.
   */
  | { ok: false; reason: 'sum'; expected: string };

/**
 * The same, plus the two ways a *division* can be refused: "the parts add up
 * to 3,900 and the transfer was 4,000" is the reader's own arithmetic and they
 * need the number back.
 */
export type SplitResolveResult =
  | TransferResolveResult
  | { ok: false; reason: 'invalid'; message: string };

/**
 * Breaking a matcher-made pairing (SC-350). `unlinked` carries every leg that
 * lost its group id, because the caller's next question is always "and what is
 * in the queue now that was not before".
 */
export type UnlinkPairResult =
  | { ok: true; unlinked: string[] }
  | { ok: false; reason: 'gone' }
  | { ok: false; reason: 'reviewed' };

/**
 * Withdrawing a pairing the system has since PROVEN false (SC-378).
 *
 * `cleared` is reported separately from `unlinked` because they are different
 * claims and the second one is the sensitive one: `unlinked` is "these legs
 * lost their group id", `cleared` is "these answers were taken off rows a
 * person had answered". A caller reporting this to the person whose answers
 * they were owes them the second list by name.
 */
export type WithdrawPairingResult =
  | { ok: true; unlinked: string[]; cleared: string[] }
  | { ok: false; reason: 'gone' }
  | { ok: false; reason: WithdrawRefusalReason; detail: string };

/**
 * The result of applying one answer to many transfers (SC-382).
 *
 * All or nothing, and the refusals come back by row. A bulk write that
 * silently drops the rows it could not take is indistinguishable from one that
 * lost them, and this is the area of the product that has already spent four
 * investigations on a write nobody could account for. So: either every id in
 * the batch is written, or none is and the caller is told which ones stood in
 * the way and why.
 *
 * `applied` carries the answer each row USED to have, which is the whole of the
 * undo — hand it straight back to `bulkResolve` and the batch is reversed
 * exactly. That is possible only because every eligible source and target state
 * is link-free (`BULK_ELIGIBLE_ANSWERS`): there is no deposit to re-create and
 * no group id to restore, so the reversal is the same column write in the other
 * direction rather than a repair.
 */
export type BulkResolveResult =
  | { ok: true; applied: BulkTransferApplied[] }
  | { ok: false; reason: 'refused'; refusals: BulkTransferRefusal[] };

/**
 * An answered outflow that realizes a disposal onto one of the user's own
 * wallets — a violation of the SC-350 invariant, wherever the answer came from.
 *
 * `answerSource` is reported rather than filtered on: it is what a reader needs
 * to know before deciding whether to correct the row, and it is exactly what
 * SC-350 wrongly used to decide whether to LOOK at it.
 */
export interface OwnWalletDisposal {
  transactionId: string;
  userId: string;
  holdingId: string;
  tokenId: string;
  kind: string;
  quantity: string;
  occurredAt: Date;
  /** The destination, from the column or the payload. Always a wallet the user
   *  registered — lowercased, which is the form the comparison happens in. */
  counterparty: string;
  /** `left_control`, or `split` when the disposal is one portion of an answer. */
  decision: string;
  answerSource: AnswerSource;
}

const CREATED_INFLOW_KIND = 'transfer_in';

/**
 * The identity facts `candidatePairClass` judges a pair on, as a projection
 * three queries here share (SC-336).
 *
 * They live on `tokens` and `accounts`, not on the transaction, which is why
 * every read that decides a pairing joins both. A `lookalike_of` row is given
 * no canonical key at all: a quarantined symbol must never become the reason
 * two lot chains merge, the same exclusion `findPricingSiblings` applies for
 * the same reason (SC-197 / SC-198).
 */
const transferLegFacts = {
  canonicalAssetKey: sql<
    string | null
  >`case when ${schema.tokens.lookalikeOf} is null then ${schema.tokens.providerMetadata}->'coingecko'->>'id' end`,
  walletId: sql<string | null>`${schema.accounts.metadata}->>'userWalletId'`,
  chainKey: sql<string | null>`${schema.accounts.metadata}->>'chainId'`,
  // The ownership boundary (SC-463). It belongs in this shared projection
  // rather than at one call site precisely because the projection is shared:
  // the queue must not OFFER a pairing the matcher is refusing, or the reader
  // completes it by hand and the refusal has bought nothing.
  entityId: schema.accounts.entityId,
} as const;

type TransferLegFacts = {
  canonicalAssetKey: string | null;
  walletId: string | null;
  chainKey: string | null;
  entityId: string | null;
};

function toTransferLeg(
  row: TransferLegFacts & {
    tx: Pick<HoldingTransaction, 'id' | 'holdingId' | 'tokenId' | 'quantity' | 'occurredAt'>;
  }
): TransferLeg {
  return {
    transactionId: row.tx.id,
    holdingId: row.tx.holdingId,
    tokenId: row.tx.tokenId,
    canonicalAssetKey: row.canonicalAssetKey,
    walletId: row.walletId,
    chainKey: row.chainKey,
    entityId: row.entityId,
    occurredAt: row.tx.occurredAt,
    quantityAbs: new Decimal(row.tx.quantity).abs(),
  };
}

/** One transaction's leg facts, or null when the row is gone. */
async function legFacts(
  database: typeof db | DatabaseTransaction,
  transactionId: string
): Promise<TransferLeg | null> {
  const [row] = await database
    .select({ tx: schema.holdingTransactions, ...transferLegFacts })
    .from(schema.holdingTransactions)
    .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
    .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
    .where(eq(schema.holdingTransactions.id, transactionId))
    .limit(1);
  return row ? toTransferLeg(row) : null;
}

/**
 * The answered list's ordering key, and the reason it is not a column (SC-241).
 *
 * `transfer_reviewed_at` alone is NULL on nearly every answered outflow in
 * production — they were inserted with `transfer_review` already set, by an
 * import that is no longer in the tree — and Postgres sorts NULLS FIRST under
 * DESC. So the undated rows filled every slot of the page limit and the
 * genuinely answered ones were not merely mis-ordered, they were **absent**,
 * from the one surface built to reach them.
 *
 * The coalesce gives every row the position it actually has: `updated_at` is
 * only ever written explicitly (the column has no `$onUpdate`), and
 * `created_at` is NOT NULL, so the key is total — measured, zero NULLs across
 * all 579. `id` breaks the ties the timestamps leave; without it the order of
 * equal keys is unguaranteed, which is exactly SC-193's root cause, and a
 * keyset cursor over a non-unique key would skip and repeat rows besides.
 */
const answeredSortKey = sql<
  Date | string
>`coalesce(${schema.holdingTransactions.transferReviewedAt}, ${schema.holdingTransactions.updatedAt}, ${schema.holdingTransactions.createdAt})`;

/** Page size when the caller does not say, and the ceiling when it does. */
const ANSWERED_PAGE_SIZE = 25;
const ANSWERED_MAX_PAGE_SIZE = 100;

export interface AnsweredTransferPage {
  items: AnsweredTransferReview[];
  /** Null on the last page. Opaque — see `encodeAnsweredCursor`. */
  nextCursor: string | null;
}

/**
 * A cursor the caller cannot act on, so the ordering stays ours to change.
 *
 * Encoded here rather than in the router — which is where `documents.list`
 * puts it — because that list pages on `createdAt`, a field its DTO already
 * carries, and this one pages on an expression that deliberately is not in the
 * DTO. Handing the router a sort key to encode would put it on the wire twice,
 * once named and once not.
 *
 * Base64 rather than signed: it encodes only the caller's own row position and
 * every query is scoped to `userId` regardless of what the cursor says.
 */
function encodeAnsweredCursor(sortKey: Date, id: string): string {
  return Buffer.from(`${sortKey.toISOString()}|${id}`, 'utf-8').toString('base64url');
}

/**
 * Throws rather than returning `undefined` on a cursor it cannot read.
 *
 * A malformed cursor falling back to "start from the beginning" would be the
 * absence-vs-refusal defect this ticket is an instance of: the caller asked for
 * page 7 and would silently receive page 1, which looks like an answer.
 */
function decodeAnsweredCursor(cursor: string): { sortKey: Date; id: string } {
  const [sortKey, id] = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
  const parsed = sortKey ? new Date(sortKey) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || !id) {
    throw new MalformedCursorError('Malformed cursor');
  }
  return { sortKey: parsed, id };
}

/** A cursor that did not decode. The API turns it into a 400, not a 500. */
export class MalformedCursorError extends Error {
  readonly name = 'MalformedCursorError';
}

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
   *
   * It writes nothing, and neither does `listPending` (SC-1071) — see
   * `applyDisposalMarks` for where rule answers are written instead.
   */
  async pendingSummary(userId: string): Promise<{ count: number; latestCreatedAt: Date | null }> {
    const [row] = await db
      .select({
        count: sql<number>`count(*)::int`,
        latestCreatedAt: sql<Date | null>`max(${schema.holdingTransactions.createdAt})`,
      })
      .from(schema.holdingTransactions)
      // The rule join is here and not only on the listing because the count
      // and the page have to be the same set (SC-375). A badge of 4 over a
      // page of 1 is exactly what a rule would produce if only one of them
      // knew about rules.
      .leftJoin(schema.transferReviewRules, activeRuleJoin(userId))
      .where(and(pendingPredicate(userId), notHiddenByRule()));
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
        // The chain the account lives on, for the explorer link (SC-346).
        // Only wallet accounts have one; an exchange withdrawal has no hash
        // to look up and gets nulls.
        accountMetadata: schema.accounts.metadata,
        // The user's own sentence about this destination, when they have
        // written one (SC-375). An `ask_me` rule rides along on the row it
        // annotates rather than being fetched by the client, so the pairing
        // "row → rule" is recomputed on every read and can never outlive the
        // rule.
        rule: schema.transferReviewRules,
        // What a rule authored from this row would be keyed on (SC-381).
        // Selected by the SAME expression the rule join matches with, so the
        // dialog cannot show one string while the rule is written on another.
        counterpartyKey: counterpartyKeySql,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .leftJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
      .leftJoin(schema.transferReviewRules, activeRuleJoin(userId))
      .where(and(pendingPredicate(userId), notHiddenByRule()))
      .orderBy(desc(schema.holdingTransactions.occurredAt))
      .limit(opts.limit ?? 200);

    if (outflows.length === 0) return [];

    const baseCurrencyCode = user?.baseCurrencyId
      ? await this.currencyCode(user.baseCurrencyId)
      : '';

    // Every address this user has registered, lowercased, fetched once for the
    // page rather than per row (SC-350). It is a handful of rows per user and
    // the comparison has to happen against the SAME string the reader is shown,
    // which for these transfers is the payload's `to` and not the
    // `counterparty` column — that column is NULL on all ten of the rows this
    // was built for, and a check against it would have reported "not yours"
    // about the wallet in the very next field.
    const ownWallets = await this.ownWalletAddresses(userId);

    const results: PendingTransferReview[] = [];
    for (const row of outflows) {
      const quantity = new Decimal(row.tx.quantity).abs();
      // Read from the payload when the column is still null: the backfill
      // that fills `counterparty` runs nightly (SC-329), so a wallet
      // imported between two sweeps would otherwise show a blank "to" on
      // exactly the rows this queue is asking about.
      const counterparty = counterpartyFromPayload(
        row.tx.kind,
        row.tx.rawPayload,
        row.tx.counterparty
      );
      const chainIdRaw = (row.accountMetadata as { chainId?: unknown } | null)?.chainId;
      const chainId =
        typeof chainIdRaw === 'number'
          ? chainIdRaw
          : typeof chainIdRaw === 'string' && chainIdRaw.trim() !== ''
            ? Number(chainIdRaw)
            : null;
      const links = explorerLinks(
        row.tx.source,
        Number.isFinite(chainId) ? chainId : null,
        txHashFromPayload(row.tx.rawPayload, row.tx.externalId),
        counterparty
      );
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
        counterparty,
        counterpartyKey: row.counterpartyKey,
        description: row.tx.description,
        explorerTxUrl: links.transactionUrl,
        explorerAddressUrl: links.addressUrl,
        counterpartyIsOwnWallet: isOwnWallet(counterparty, ownWallets),
        // A rule on a row in this list has NOT answered it, whatever its
        // verdict. `not_a_disposal` took its rows out of the list entirely, and
        // `always_a_disposal` answered its rows out of the queue — so its
        // verdict reaches here on a row the reader personally took the rule's
        // answer back on (SC-380), which is exactly the row that most needs to
        // say which rule it is exempt from. Since SC-1071 it can also reach here
        // briefly on a row one of the writers `applyDisposalMarks` leaves to the
        // nightly sweep made markable, until that sweep answers it.
        matchedRule: row.rule
          ? {
              ruleId: row.rule.id,
              note: row.rule.note,
              // Narrowed on the way out for the same reason `toDto` narrows it:
              // the column is text, and the safe reading of a verdict this
              // build does not know is the one that asks.
              verdict:
                row.rule.verdict === 'not_a_disposal'
                  ? 'not_a_disposal'
                  : row.rule.verdict === 'always_a_disposal'
                    ? 'always_a_disposal'
                    : 'ask_me',
            }
          : null,
        answerWithdrawnBy: answerWithdrawnBy(row.tx),
        marketValueInBase: user?.baseCurrencyId
          ? await this.marketValue(quantity, row.tx.tokenId, user.baseCurrencyId, row.tx.occurredAt)
          : null,
        baseCurrencyCode,
        ...(await this.candidateSetsFor(userId, {
          id: row.tx.id,
          tokenId: row.tx.tokenId,
          quantity,
          occurredAt: row.tx.occurredAt,
        })),
      });
    }
    return results;
  }

  async applyDisposalMarks(userId: string): Promise<number> {
    const candidates = await db
      .select({
        transactionId: schema.holdingTransactions.id,
        ruleId: schema.transferReviewRules.id,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.transferReviewRules, activeRuleJoin(userId))
      .where(
        and(
          ruleWritablePredicate(userId),
          eq(schema.transferReviewRules.verdict, 'always_a_disposal')
        )
      )
      .limit(MAX_BULK_TRANSFER_ROWS);
    if (candidates.length === 0) return 0;

    return db.transaction(async (tx) => {
      const { eligible } = await this.bulkClassify(
        tx,
        userId,
        candidates.map((row) => ({
          transactionId: row.transactionId,
          decision: RULE_ASSERTED_DECISION,
        }))
      );
      if (eligible.length === 0) return 0;

      const ruleFor = new Map(candidates.map((row) => [row.transactionId, row.ruleId]));
      // Grouped by rule, because the answer records WHICH rule gave it and one
      // reader can hold marks on several destinations at once.
      const byRule = new Map<string, string[]>();
      for (const row of eligible) {
        const ruleId = ruleFor.get(row.id);
        if (!ruleId) continue;
        const bucket = byRule.get(ruleId);
        if (bucket) bucket.push(row.id);
        else byRule.set(ruleId, [row.id]);
      }

      let written = 0;
      for (const [ruleId, ids] of byRule) {
        const updated = await tx
          .update(schema.holdingTransactions)
          .set({
            transferReview: RULE_ASSERTED_DECISION,
            transferReviewSplit: null,
            // Stamped, exactly as a repair is: the column records WHEN the
            // answer was written, and only `transferReviewSource` claims who.
            transferReviewedAt: sql`now()`,
            transferReviewSource: RULE_ANSWER_SOURCE,
            transferReviewRuleId: ruleId,
            updatedAt: sql`now()`,
          })
          .where(and(inArray(schema.holdingTransactions.id, ids), ruleWritablePredicate(userId)))
          .returning({ id: schema.holdingTransactions.id });
        written += updated.length;
      }
      return written;
    });
  }

  /**
   * The transfers a `not_a_disposal` rule is keeping out of the queue
   * (SC-375).
   *
   * A rule removes a question; it must not remove a row. Without this list the
   * only evidence a transfer existed would be a count that went down, which is
   * indistinguishable from an import that lost it — and this codebase has
   * spent four investigations on one write nobody could attribute.
   *
   * It is also where the undo is *demonstrated* rather than asserted: every
   * row here still has `transfer_review IS NULL` and is still answerable by
   * `resolve`, because `pendingPredicate` — the write path's gate — knows
   * nothing about rules. Revoking the rule moves these rows back to
   * `listPending` with nothing to un-write.
   *
   * Thin like the answered list, and for the same reason: the reader is
   * checking what a rule took, not making a judgement, so no candidate search
   * and no price lookup.
   */
  async listHiddenByRule(
    userId: string,
    opts: { limit?: number } = {}
  ): Promise<HiddenTransferReview[]> {
    const rows = await db
      .select({
        tx: schema.holdingTransactions,
        tokenSymbol: schema.tokens.symbol,
        accountName: schema.accounts.name,
        institutionName: schema.institutions.name,
        rule: schema.transferReviewRules,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .leftJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
      .innerJoin(schema.transferReviewRules, activeRuleJoin(userId))
      .where(
        and(pendingPredicate(userId), eq(schema.transferReviewRules.verdict, 'not_a_disposal'))
      )
      .orderBy(desc(schema.holdingTransactions.occurredAt))
      .limit(opts.limit ?? 200);

    return rows.map((row) => ({
      transactionId: row.tx.id,
      holdingId: row.tx.holdingId,
      tokenSymbol: row.tokenSymbol,
      accountName: row.accountName,
      institutionName: row.institutionName,
      kind: row.tx.kind,
      quantity: new Decimal(row.tx.quantity).abs().toString(),
      occurredAt: row.tx.occurredAt.toISOString(),
      counterparty: counterpartyFromPayload(row.tx.kind, row.tx.rawPayload, row.tx.counterparty),
      ruleId: row.rule.id,
      ruleNote: row.rule.note,
    }));
  }

  /**
   * The same set as `listHiddenByRule`, as bare ids, for a caller that is
   * counting rather than showing (SC-1067).
   *
   * `CostBasisService` produces the PnL caption's `transfersUnreviewed` from
   * `pendingPredicate`'s three columns and nothing else, so a row a
   * `not_a_disposal` rule had taken out of the queue was still counted as
   * understating realized PnL — the caption said four and the page it links to
   * showed none. SC-375 put the rule join on `pendingSummary` and
   * `TransferReviewRuleService`'s affected-row count for exactly this reason
   * and did not reach the third counter.
   *
   * It hands back ids rather than a count per holding because the walk is
   * already visiting the rows: intersecting by id needs no agreement about
   * which holding a row belongs to, and no second opinion about the `at`
   * cutoff — a row the walk never reaches cannot be subtracted twice.
   *
   * A rule-hidden row is not missing from realized PnL. The rule asserts the
   * destination is not a disposal, so there is no gain nobody booked, and a
   * caveat about it is a claim the queue cannot clear.
   */
  async ruleHiddenTransactionIds(
    userId: string,
    dbTx?: DatabaseTransaction
  ): Promise<ReadonlySet<string>> {
    const rows = await (dbTx ?? db)
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .innerJoin(schema.transferReviewRules, activeRuleJoin(userId))
      .where(
        and(pendingPredicate(userId), eq(schema.transferReviewRules.verdict, 'not_a_disposal'))
      );
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Record the user's answer.
   *
   * `paired` needs a partner and `internal` needs a destination; both write a
   * shared `transfer_group_id`, and the other two decide the row alone.
   * Everything happens in one transaction because a half-applied link — a
   * group id on one leg only — is worse than either outcome:
   * `CostBasisService` would buffer lots for a partner that never arrives.
   *
   * `gone` covers "not the caller's", "not an outflow" and "already answered"
   * alike. That last is not an error worth raising: two tabs open on the same
   * queue is an ordinary thing to do, and the second answer arriving to find
   * the question gone is the correct outcome.
   *
   * `opts.answerSource` defaults to `user` and only a repair passes anything
   * else — see `AnswerSource` for why a correction made on the user's behalf
   * must not be recorded as one they gave (SC-350). The API never sets it: an
   * answer arriving over an authenticated session IS the user's.
   */
  async resolve(
    userId: string,
    transactionId: string,
    decision: TransferReviewDecision,
    opts: {
      matchTransactionId?: string;
      /**
       * More deposits that are the same money as `matchTransactionId`, when it
       * arrived in parts — 4,000 recorded as 3,000 and 1,000 (SC-1365). All of
       * them join one group and their total must be the withdrawal's.
       */
      alsoMatchTransactionIds?: string[];
      destination?: TransferDestinationRef;
      /** Explains an observed historical event; existing destination balances already stand. */
      observedEvent?: boolean;
      receivedQuantity?: string;
      answerSource?: AnswerAttribution;
      /**
       * Settle the answer inside a transaction the CALLER owns (SC-606).
       *
       * The manual-edit path writes the outflow and its answer in one unit of
       * work, and it has to: without this the row would be visible, unanswered
       * and in the queue between two commits, which is a smaller version of
       * the cascade this is here to remove. It also makes the failure honest —
       * a destination that has gone rolls the edit back rather than leaving a
       * withdrawal nobody asked for.
       *
       * A caller passing its own transaction owns the rollback. Everything
       * else gets the `db.transaction` below unchanged, which is why this is
       * an option and not a required parameter.
       */
      transaction?: DatabaseTransaction;
    } = {}
  ): Promise<TransferResolveResult> {
    if (decision === 'paired' && !opts.matchTransactionId) {
      throw new Error('resolve: a "paired" decision requires matchTransactionId');
    }
    if (decision === 'internal' && !opts.destination) {
      throw new Error('resolve: an "internal" decision requires a destination');
    }

    const run = async (tx: DatabaseTransaction) => {
      const [outflow] = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(and(eq(schema.holdingTransactions.id, transactionId), pendingPredicate(userId)))
        .limit(1);
      if (!outflow) return { ok: false, reason: 'gone' } as const;

      const refused = await this.refuseOwnWalletDisposal(userId, outflow, [decision]);
      if (refused) return refused;

      let groupId: string | null = null;

      if (decision === 'paired' && opts.matchTransactionId) {
        groupId = crypto.randomUUID();
        const also = opts.alsoMatchTransactionIds ?? [];
        if (also.length > 0) {
          const refused = await claimInflowSet(
            tx,
            userId,
            outflow,
            [opts.matchTransactionId, ...also],
            groupId
          );
          if (refused) return refused;
        } else {
          const linked = await claimInflow(tx, userId, outflow, opts.matchTransactionId, groupId);
          if (!linked) return { ok: false, reason: 'partner_gone' } as const;
        }
      }

      if (decision === 'internal' && opts.destination) {
        groupId = crypto.randomUUID();
        const written = await writeInflow(tx, userId, outflow, {
          destination: opts.destination,
          observedEvent: opts.observedEvent,
          receivedQuantity: opts.receivedQuantity,
          quantity: new Decimal(outflow.quantity).abs(),
          groupId,
        });
        if (!written.ok) return written;
      }

      await tx
        .update(schema.holdingTransactions)
        .set({
          transferReview: decision,
          transferReviewedAt: sql`now()`,
          transferReviewSource: opts.answerSource ?? 'user',
          // A whole answer is a whole answer: any division that was here is
          // gone. Belt-and-braces — a pending row cannot carry one — but the
          // two columns must never disagree, and this is one of the two
          // places that writes them.
          transferReviewSplit: null,
          ...(groupId ? { transferGroupId: groupId } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.holdingTransactions.id, outflow.id));

      return { ok: true } as const;
    };

    return opts.transaction ? run(opts.transaction) : db.transaction(run);
  }

  async listDestinations(userId: string, transactionId: string): Promise<TransferDestination[]> {
    const [outflow] = await db
      .select({
        tokenId: schema.holdingTransactions.tokenId,
        holdingId: schema.holdingTransactions.holdingId,
      })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.id, transactionId),
          eq(schema.holdingTransactions.userId, userId)
        )
      )
      .limit(1);
    if (!outflow) return [];

    return this.destinationsFor(userId, outflow.tokenId, outflow.holdingId);
  }

  /**
   * The same list, for a balance edit that has not written its outflow yet
   * (SC-606).
   *
   * `listDestinations` above reads a TRANSACTION for two facts — which token
   * moved and which holding it left — and at edit time neither has a row yet:
   * the whole point is to answer before the outflow exists, so the answer can
   * be written with it in one transaction. The holding carries both facts
   * directly.
   *
   * Deliberately the same body rather than a second query shaped like it. The
   * picker's contract is subtle — every account appears, an account with no
   * position in the token appears once with a null `holdingId` meaning "create
   * one", and two same-token holdings in one account appear separately because
   * the balance and the source are the only things telling them apart. A
   * second implementation would be free to lose any of that, and it would lose
   * it silently: the reader sees a shorter list, not an error.
   */
  async listDestinationsForHolding(
    userId: string,
    holdingId: string,
    /**
     * Read inside a transaction the caller owns, so what this offers is
     * assertable under the rollback-per-test helper rather than only against a
     * live database (SC-614). The queue's `listDestinations` has no such
     * parameter because nothing has yet needed to assert it under one.
     */
    transaction?: DatabaseTransaction
  ): Promise<TransferDestination[]> {
    const database = transaction ?? db;
    const [holding] = await database
      .select({ tokenId: schema.holdings.tokenId })
      .from(schema.holdings)
      .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
      .limit(1);
    if (!holding) return [];

    // Every destination, both shapes — as the queue's list has always offered
    // (SC-614).
    //
    // It was scoped to accounts tracking NO position in this token while the
    // SC-614 mitigation stood, and the scope was right for as long as
    // `writeInflow` was the writer behind it: given a `holdingId` that
    // function inserts the arrival row and leaves `holdings.balance` alone,
    // which is correct in the queue and silently loses the money here. The
    // repair split the callers rather than the offer —
    // `UpdateHoldingUseCase.moveDeclaredTransfer` now writes both legs and
    // moves both anchors, so an existing holding is a destination a person can
    // pick, and it is the commoner one.
    //
    // Do not narrow this again without also removing that writer: a list this
    // surface cannot express is a reader hunting for an account that is
    // deliberately absent.
    return this.destinationsFor(userId, holding.tokenId, holdingId, transaction);
  }

  private async destinationsFor(
    userId: string,
    tokenId: string,
    excludeHoldingId: string,
    transaction?: DatabaseTransaction
  ): Promise<TransferDestination[]> {
    const database = transaction ?? db;
    const accounts = await database
      .select({
        accountId: schema.accounts.id,
        accountName: schema.accounts.name,
        institutionName: schema.institutions.name,
        chainKey: sql<string | null>`${schema.accounts.metadata}->>'chainId'`,
        // Everything `resolveSyncSource` reads, so the picker can say whether
        // answering here will move the balance (SC-856).
        userId: schema.accounts.userId,
        institutionId: schema.accounts.institutionId,
        metadata: schema.accounts.metadata,
        isActive: schema.accounts.isActive,
      })
      .from(schema.accounts)
      .leftJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
      .where(eq(schema.accounts.userId, userId));

    // The chain the money is leaving, so an account on it can be offered
    // before one that could not physically receive this token. Null for
    // anything that is not a wallet — a fiat account has no chain, and then no
    // destination is `same_network`, which is the correct answer rather than a
    // degraded one.
    const [sourceAccount] = await database
      .select({
        accountId: schema.accounts.id,
        chainKey: sql<string | null>`${schema.accounts.metadata}->>'chainId'`,
      })
      .from(schema.holdings)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .where(eq(schema.holdings.id, excludeHoldingId))
      .limit(1);
    const sourceChainKey = sourceAccount?.chainKey ?? null;
    const sourceAccountId = sourceAccount?.accountId ?? null;

    const holdings = await database
      .select({
        holdingId: schema.holdings.id,
        accountId: schema.holdings.accountId,
        balance: schema.holdings.balance,
        source: schema.holdings.source,
      })
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.userId, userId),
          eq(schema.holdings.tokenId, tokenId),
          ne(schema.holdings.id, excludeHoldingId)
        )
      );

    const byAccount = new Map<string, typeof holdings>();
    for (const holding of holdings) {
      const bucket = byAccount.get(holding.accountId);
      if (bucket) bucket.push(holding);
      else byAccount.set(holding.accountId, [holding]);
    }

    const destinations: TransferDestination[] = [];
    for (const account of accounts) {
      // NO ENTITY NARROWING HERE (SC-1151, reversing the offer half of SC-859).
      // The rule it enforced was "the queue must not offer what the writer is
      // refusing", and it was right about that — `writeInflow` no longer
      // refuses, so the same rule now says offer. Reading the two changes apart
      // is how this becomes a regression: a picker narrowed to a writer that
      // has been relaxed is the SC-859 defect with the surfaces swapped.
      //
      // Measured on the portfolio that reopened this (SC-929): 21 accounts, one
      // of them carrying an `entity_id`, and it was the SOURCE. So the guard
      // removed the other twenty and left the account the money had just left —
      // the one destination that cannot be right.
      const onSourceChain = Boolean(
        sourceChainKey && account.chainKey && account.chainKey === sourceChainKey
      );
      // Asked through the service the WRITE path asks, once per account, rather
      // than reconstructed in bulk from `user_wallets` and
      // `user_integration_credentials` (SC-856). A bulk query would be a second
      // implementation of "does a sync own this account", and the whole value
      // of this field is that the sentence over the button and the write agree.
      // The cost is bounded by the account count, and this is a picker.
      const accountSyncSource = await Container.get(BalanceSyncOwnershipService).resolveSyncSource(
        { ...account, id: account.accountId },
        database
      );
      const existing = byAccount.get(account.accountId) ?? [];
      if (existing.length === 0) {
        if (account.accountId === sourceAccountId) continue;
        destinations.push({
          accountId: account.accountId,
          holdingId: null,
          accountName: account.accountName,
          institutionName: account.institutionName,
          source: null,
          balance: null,
          // `openingOf`: an unsynced account gets the row AT the moved amount,
          // a sync-owned one gets it at zero for the sync to restate.
          movesBalance: accountSyncSource === null,
          relevance: onSourceChain ? 'same_network' : 'other',
        });
        continue;
      }
      for (const holding of existing) {
        destinations.push({
          accountId: account.accountId,
          holdingId: holding.holdingId,
          accountName: account.accountName,
          institutionName: account.institutionName,
          source: holding.source,
          balance: holding.balance,
          // The write path's own predicate, over a sync source already in
          // hand rather than re-asked per holding.
          movesBalance: anchorIsUnobserved(holding, accountSyncSource),
          relevance: 'holds_token',
        });
      }
    }

    return destinations.sort(
      (a, b) =>
        TRANSFER_DESTINATION_RELEVANCE_ORDER.indexOf(a.relevance) -
          TRANSFER_DESTINATION_RELEVANCE_ORDER.indexOf(b.relevance) ||
        a.accountName.localeCompare(b.accountName) ||
        (a.source ?? '').localeCompare(b.source ?? '')
    );
  }

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

      const refused = await this.refuseOwnWalletDisposal(
        userId,
        outflow,
        portions.map((p) => p.decision)
      );
      if (refused) return refused;

      const paired = portions.find((p) => p.decision === 'paired');
      const internal = portions.find((p) => p.decision === 'internal');
      let groupId: string | null = null;
      if (paired?.matchTransactionId) {
        groupId = crypto.randomUUID();
        const linked = await claimInflow(tx, userId, outflow, paired.matchTransactionId, groupId);
        if (!linked) return { ok: false, reason: 'partner_gone' } as const;
      }
      // The share that moved to a holding the user maintains by hand, and the
      // deposit that share needs in order to be a real pair rather than a
      // lookalike (SC-187). Its quantity is the PORTION's, not the row's:
      // 3,500 of a 4,000 withdrawal arrived, and writing 4,000 there would
      // trade an overstated gain for an overstated balance.
      if (internal?.destination) {
        groupId = crypto.randomUUID();
        const written = await writeInflow(tx, userId, outflow, {
          destination: internal.destination,
          quantity: new Decimal(internal.quantity).abs(),
          groupId,
        });
        if (!written.ok) return written;
      }

      await tx
        .update(schema.holdingTransactions)
        .set({
          transferReview: TRANSFER_REVIEW_SPLIT,
          transferReviewSplit: portions,
          transferReviewedAt: sql`now()`,
          transferReviewSource: 'user',
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
   * decided.
   *
   * **Keyset-paginated, never truncated (SC-241).** The first version ordered
   * by `transfer_reviewed_at` and cut at 200, which reached none of the rows it
   * was built for: see `answeredSortKey`. Paging is `(sort key, id)` and the
   * reply carries `nextCursor`, so the 379 rows that used to sit past the limit
   * are reachable rather than merely further down. It reads `limit + 1` rows to
   * tell "there is more" from "exactly full" without a second COUNT.
   */
  async listAnswered(
    userId: string,
    opts: { limit?: number; cursor?: string; search?: string } = {}
  ): Promise<AnsweredTransferPage> {
    const limit = Math.min(Math.max(opts.limit ?? ANSWERED_PAGE_SIZE, 1), ANSWERED_MAX_PAGE_SIZE);
    const cursor = opts.cursor ? decodeAnsweredCursor(opts.cursor) : undefined;
    const search = ilikePattern(opts.search);

    const rows = await db
      .select({
        tx: schema.holdingTransactions,
        tokenSymbol: schema.tokens.symbol,
        accountName: schema.accounts.name,
        institutionName: schema.institutions.name,
        // The note on the rule that answered it (SC-380). Joined by id rather
        // than by counterparty key, so it survives the rule being revoked —
        // revocation is a soft delete precisely because a row a rule answered
        // is still owed the explanation the reader wrote.
        ruleNote: schema.transferReviewRules.note,
        sortKey: answeredSortKey,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .leftJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
      .leftJoin(
        schema.transferReviewRules,
        eq(schema.transferReviewRules.id, schema.holdingTransactions.transferReviewRuleId)
      )
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          inArray(schema.holdingTransactions.kind, [...OUTFLOW_KINDS]),
          isNotNull(schema.holdingTransactions.transferReview),
          // The same four fields the surface used to search client-side, and
          // concatenated for the same reason it joined them: "kraken btc" is
          // one term the reader expects to match one row across two columns,
          // which four ORed predicates would not (SC-244).
          search
            ? sql`concat_ws(' ', ${schema.tokens.symbol}, ${schema.accounts.name}, ${schema.institutions.name}, ${schema.holdingTransactions.counterparty}) ilike ${search}`
            : undefined,
          cursor
            ? sql`(${answeredSortKey}, ${schema.holdingTransactions.id}) < (${cursor.sortKey.toISOString()}::timestamptz, ${cursor.id}::uuid)`
            : undefined
        )
      )
      .orderBy(sql`${answeredSortKey} desc`, desc(schema.holdingTransactions.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    // One query for the page, not one per row. See `declaredTransferGroups`:
    // the confirmation over Reopen is written BEFORE the action, and for a
    // declared pair the action is an undo rather than a return to the queue.
    const declaredGroups = await this.declaredTransferGroups(
      userId,
      page.map(({ tx }) => tx.transferGroupId)
    );
    const createdDestinations = await this.createdDestinationAnswers(
      userId,
      page.map(({ tx }) => tx.id)
    );

    return {
      items: page.map(({ tx, tokenSymbol, accountName, institutionName, ruleNote }) => {
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
          answerSource: answerSourceOf(tx),
          ruleNote,
          declared: tx.transferGroupId !== null && declaredGroups.has(tx.transferGroupId),
          createdDestination: createdDestinations.has(tx.id),
        } satisfies AnsweredTransferReview;
      }),
      nextCursor: hasMore && last ? encodeAnsweredCursor(new Date(last.sortKey), last.tx.id) : null,
    };
  }

  /**
   * What the queue would offer this ANSWERED row if it were reopened.
   *
   * Reopening blind is what SC-354 is repairing. Four bridge outflows were
   * answered `left_control` on 2026-08-17 by a reader the surface could not
   * show a cross-chain arrival to, and the obvious repair — put them back in
   * the queue — recreates the same trap unless the queue can now answer them.
   * `listAnswered` deliberately carries no candidates (it is the cheap read),
   * so before this there was no way to ask.
   *
   * **A lower bound, never an over-estimate.** It runs `candidatesFor` on the
   * row as it stands, and `reopen` only ever FREES legs — it deletes the
   * deposit an `internal` answer created and clears the group from both sides
   * — so the real reopened row can gain candidates but never lose one. A
   * caller gating a write on "at least one viable candidate" is therefore
   * never told yes when the answer is no.
   *
   * Empty for a row that carries no answer: there is nothing to reopen, and
   * `listPending` is where an unanswered row's candidates live.
   */
  async reopenPreview(userId: string, transactionId: string): Promise<TransferCandidate[]> {
    const [row] = await db
      .select({ tx: schema.holdingTransactions })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.id, transactionId),
          eq(schema.holdingTransactions.userId, userId)
        )
      )
      .limit(1);
    if (!row?.tx.transferReview) return [];
    return this.candidatesFor(userId, {
      id: row.tx.id,
      tokenId: row.tx.tokenId,
      quantity: new Decimal(row.tx.quantity).abs(),
      occurredAt: row.tx.occurredAt,
    });
  }

  async reopen(
    userId: string,
    transactionId: string,
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    const run = async (tx: DatabaseTransaction) => {
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
        const declared = declaredPairLegs(await this.groupLegs(tx, userId, row.transferGroupId));
        if (declared) {
          await this.undoDeclaredTransfer(tx, userId, declared);
          return true;
        }
      }

      // **The per-row undo of a rule's answer, and the reason it is durable**
      // (SC-380). Withdrawing an answer the reader gave themselves leaves the
      // source null: the row is exactly as unanswered as one nobody ever
      // answered, and nothing is owed to a later reader. Withdrawing a RULE's
      // answer cannot leave it null, because `ruleWritablePredicate` would
      // select the row on the very next read and the rule would put its answer
      // straight back — an undo the reader can watch fail. Leaving `'user'`
      // says "a person overruled the standing sentence on this transfer", which
      // is both true and exactly the state that predicate refuses to touch.
      //
      // It is sticky on purpose. Re-marking the destination does not reclaim
      // this row; answering it by hand does, because that is a person deciding
      // again.
      await this.clearAnswer(
        tx,
        userId,
        transactionId,
        row.transferReviewSource === RULE_ANSWER_SOURCE ? 'user' : null
      );

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

      return true;
    };
    const reopened = transaction ? await run(transaction) : await db.transaction(run);
    // An answer taken off a row is one of the writers that can bring it under a
    // destination rule, so it applies them here rather than leaving it to the
    // next read of the queue (SC-1071).
    if (reopened && !transaction) await this.applyDisposalMarks(userId);
    return reopened;
  }

  /**
   * Which of these transfer groups are transfers the OWNER DECLARED (SC-618).
   *
   * Batched over a set of group ids rather than asked one row at a time,
   * because `listAnswered` pays no per-row round trips on purpose — the
   * reader there is finding a row they already decided, not making a
   * judgement. One query for a page keeps that true.
   *
   * Public because three callers need the SAME answer and a second
   * implementation of the rule is how a projection comes to describe a write
   * that does something else: `listAnswered` (so the confirmation names the
   * right consequence), `reopen` itself, and
   * `scripts/reopen-transfer-answers.ts`, whose whole design principle is that
   * its preview asks the write path's own gate.
   */
  async declaredTransferGroups(
    userId: string,
    groupIds: readonly (string | null)[],
    transaction?: DatabaseTransaction
  ): Promise<Set<string>> {
    const ids = [...new Set(groupIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Set();

    const rows = await (transaction ?? db)
      .select({
        transferGroupId: schema.holdingTransactions.transferGroupId,
        id: schema.holdingTransactions.id,
        holdingId: schema.holdingTransactions.holdingId,
        quantity: schema.holdingTransactions.quantity,
        source: schema.holdingTransactions.source,
        externalId: schema.holdingTransactions.externalId,
      })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          inArray(schema.holdingTransactions.transferGroupId, ids)
        )
      );

    const byGroup = new Map<string, DeclaredPairLegFacts[]>();
    for (const row of rows) {
      if (!row.transferGroupId) continue;
      const legs = byGroup.get(row.transferGroupId);
      if (legs) legs.push(row);
      else byGroup.set(row.transferGroupId, [row]);
    }

    const declared = new Set<string>();
    for (const [groupId, legs] of byGroup) {
      if (declaredPairLegs(legs)) declared.add(groupId);
    }
    return declared;
  }

  /**
   * Which of these answered outflows had to CREATE the holding they deposited
   * into (SC-631).
   *
   * Batched over a page for the same reason `declaredTransferGroups` is: the
   * reader on the answered list is finding a row they already decided, and
   * per-row round trips there buy nothing.
   *
   * It returns what the MARKER says and nothing more. Whether the holding will
   * actually be removed is `holdingIsUntouched`'s question, asked inside the
   * writing transaction — and this deliberately does not ask it, because the
   * copy it feeds describes the rule ("unless something else has been recorded
   * against it since") rather than predicting the outcome. A projection that
   * predicted would be a second implementation of the delete condition, which
   * is exactly how a confirmation comes to describe a write that does
   * something else.
   *
   * `unrecorded` is absent from the result, alongside `reused`. Both mean "do
   * not promise a removal": one because there is nothing to remove, the other
   * because nobody wrote down which it was.
   */
  async createdDestinationAnswers(
    userId: string,
    transactionIds: readonly string[],
    transaction?: DatabaseTransaction
  ): Promise<Set<string>> {
    const ids = [...new Set(transactionIds)];
    if (ids.length === 0) return new Set();

    const rows = await (transaction ?? db)
      .select({
        externalId: schema.holdingTransactions.externalId,
        sourceMetadata: schema.holdingTransactions.sourceMetadata,
      })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          eq(schema.holdingTransactions.source, TRANSFER_REVIEW_CREATED_SOURCE),
          inArray(schema.holdingTransactions.externalId, ids)
        )
      );

    const created = new Set<string>();
    for (const row of rows) {
      if (row.externalId && readCreatedDestination(row.sourceMetadata) === 'created') {
        created.add(row.externalId);
      }
    }
    return created;
  }

  /** Every leg of one transfer group, in the shape `declaredPairLegs` reads. */
  private async groupLegs(
    tx: DatabaseTransaction,
    userId: string,
    transferGroupId: string
  ): Promise<DeclaredPairLegFacts[]> {
    return await tx
      .select({
        id: schema.holdingTransactions.id,
        holdingId: schema.holdingTransactions.holdingId,
        quantity: schema.holdingTransactions.quantity,
        source: schema.holdingTransactions.source,
        externalId: schema.holdingTransactions.externalId,
      })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          eq(schema.holdingTransactions.transferGroupId, transferGroupId)
        )
      );
  }

  private async undoDeclaredTransfer(
    tx: DatabaseTransaction,
    userId: string,
    legs: readonly [DeclaredPairLegFacts, DeclaredPairLegFacts]
  ): Promise<void> {
    const updateHolding = Container.get(UpdateHoldingUseCase);

    // The fee this declaration carved out of its own withdrawal, if it stated
    // one (SC-857). Found here rather than by the caller because the undo has
    // to be the exact inverse of the declaration, and the declaration wrote
    // THREE rows when a fee was named: the fee is part of what the owner said
    // happened, so withdrawing the sentence withdraws all of it.
    //
    // It carries no `transfer_group_id` and never has — a third row on the
    // group id would hand `CostBasisService`'s inflow branch a second
    // `transfer_in` to feed, which is the SC-150 defect — so it is reached
    // through the withdrawal's own `external_id` instead, the same natural key
    // `bulkUpsert` deduped it under.
    const feeRows = await this.declaredFeeRows(tx, userId, legs);

    for (const leg of [...legs, ...feeRows]) {
      const [holding] = await tx
        .select({ balance: schema.holdings.balance })
        .from(schema.holdings)
        .where(and(eq(schema.holdings.id, leg.holdingId), eq(schema.holdings.userId, userId)))
        .limit(1);
      if (!holding) throw new Error(`Declared transfer leg ${leg.id} has no holding to restore`);

      await updateHolding.execute(
        leg.holdingId,
        { balance: new Decimal(holding.balance).sub(leg.quantity).toString() },
        userId,
        tx
      );
    }

    await tx.delete(schema.holdingTransactions).where(
      and(
        eq(schema.holdingTransactions.userId, userId),
        inArray(
          schema.holdingTransactions.id,
          [...legs, ...feeRows].map((leg) => leg.id)
        )
      )
    );

    // The rows that defined this holding's covered interval are gone, so the
    // bound has to be restated — the same step `clearAnswer` takes after
    // deleting an `internal` answer's arrival.
    await Container.get(HoldingCoverageRepository).syncTxBoundsFromLedger(
      legs.map((leg) => leg.holdingId),
      tx
    );
  }

  /**
   * The `fee` rows a declared transfer carved out of its own withdrawal
   * (SC-857).
   *
   * Addressed by `(holding_id, source, external_id)` — the withdrawal's own
   * key with `:fee` appended, which is what `ManualBalanceEditService` wrote
   * it under and what `manualEditFeeExternalId` is the single assembly of. A
   * second spelling here is a key free to drift from that one, and the failure
   * would be silent in the worst direction: the undo would report success
   * having left a charge behind against an anchor it restored as though
   * nothing had been paid.
   *
   * Asked of BOTH legs rather than only the negative one. Nothing writes a fee
   * beside an arrival today, so the arrival's query is expected to return
   * nothing — but "expected to return nothing" is the assumption, not the
   * mechanism, and the cost of asking is one indexed lookup on a path that
   * already does several.
   */
  private async declaredFeeRows(
    tx: DatabaseTransaction,
    userId: string,
    legs: readonly DeclaredPairLegFacts[]
  ): Promise<{ id: string; holdingId: string; quantity: string }[]> {
    const found: { id: string; holdingId: string; quantity: string }[] = [];
    for (const leg of legs) {
      if (!leg.externalId || !leg.source) continue;
      const rows = await tx
        .select({
          id: schema.holdingTransactions.id,
          holdingId: schema.holdingTransactions.holdingId,
          quantity: schema.holdingTransactions.quantity,
        })
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, userId),
            eq(schema.holdingTransactions.holdingId, leg.holdingId),
            eq(schema.holdingTransactions.source, leg.source),
            eq(schema.holdingTransactions.externalId, manualEditFeeExternalId(leg.externalId))
          )
        );
      found.push(...rows);
    }
    return found;
  }

  /**
   * Which of these transfers one answer may be written to, and which may not
   * (SC-382).
   *
   * Four gates, and the order is the order the reasons stop being
   * interchangeable. Every one of them refuses rather than skips: a bulk write
   * that quietly drops rows is indistinguishable from one that lost them.
   *
   * 1. **It has to be an answerable outflow.** Same shape `pendingPredicate`
   *    requires — the caller's, an outflow kind, non-zero. The zero rows are
   *    the address-poisoning corpus and nobody can say where a zero went.
   * 2. **It must carry no `transfer_group_id`.** This gate is not implied by
   *    the answer column and is the one a reader is most likely to leave out:
   *    a minority of production's unanswered outflows carry a group id the
   *    matcher wrote, they are invisible to the queue, and `outflowPortions` reads
   *    `transferGroupId` BEFORE `isConfirmedDisposal` — so a `left_control`
   *    written onto one books nothing while reading as answered. The same gate
   *    is what keeps `paired` and `internal` answers out of a bulk write, since
   *    both always carry one.
   * 3. **Its current answer must be link-free** — `BULK_ELIGIBLE_ANSWERS`.
   *    Belt to gate 2's braces, and the one that names `split`, which carries
   *    no group id and still cannot be bulk-rewritten: its answer is amounts
   *    that sum to *this* row's quantity.
   * 4. **A `left_control` target may not point at the caller's own wallet** —
   *    the SC-365 refusal, hoisted to one query for the batch rather than one
   *    per row. This is the gate that matters most here: bulk is exactly the
   *    shape in which ten of these were answered in four minutes (SC-350).
   *
   * The deposit lookup is not redundant with gate 2. An `internal` answer's
   * created inflow is keyed `(source, external_id)` precisely so it survives
   * its group id being cleared by some other path, and a bulk write that
   * re-answered such a row would leave the arrival behind to be counted twice.
   */
  private async bulkClassify(
    tx: DatabaseTransaction,
    userId: string,
    entries: readonly BulkTransferEntry[]
  ): Promise<{ eligible: HoldingTransaction[]; refusals: BulkTransferRefusal[] }> {
    const ids = entries.map((entry) => entry.transactionId);

    const rows = await tx
      .select()
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          inArray(schema.holdingTransactions.id, ids)
        )
      );
    const byId = new Map(rows.map((row) => [row.id, row]));

    const wantsDisposal = entries.some((entry) => entry.decision === 'left_control');
    const ownWallets = wantsDisposal ? await this.ownWalletAddresses(userId) : new Set<string>();

    const created = await tx
      .select({ externalId: schema.holdingTransactions.externalId })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          eq(schema.holdingTransactions.source, TRANSFER_REVIEW_CREATED_SOURCE),
          inArray(schema.holdingTransactions.externalId, ids)
        )
      );
    const answered = new Set(
      created.map((row) => row.externalId).filter((id): id is string => id !== null)
    );

    const eligible: HoldingTransaction[] = [];
    const refusals: BulkTransferRefusal[] = [];
    for (const entry of entries) {
      const row = byId.get(entry.transactionId);
      if (
        !row ||
        !(OUTFLOW_KINDS as readonly string[]).includes(row.kind) ||
        new Decimal(row.quantity).isZero()
      ) {
        refusals.push({ transactionId: entry.transactionId, reason: 'gone', detail: null });
        continue;
      }
      if (row.transferGroupId !== null || answered.has(row.id)) {
        refusals.push({ transactionId: row.id, reason: 'linked', detail: null });
        continue;
      }
      if (!isBulkEligibleAnswer(row.transferReview)) {
        refusals.push({
          transactionId: row.id,
          reason: 'answered_otherwise',
          detail: row.transferReview,
        });
        continue;
      }
      if (entry.decision === 'left_control') {
        const address = ownWalletCounterparty(row, ownWallets);
        if (address !== null) {
          refusals.push({ transactionId: row.id, reason: 'own_wallet', detail: address });
          continue;
        }
      }
      eligible.push(row);
    }

    return { eligible, refusals };
  }

  /**
   * What applying one answer to these transfers would do, **in money**
   * (SC-382).
   *
   * The reason this is a server call rather than arithmetic on the client: the
   * answered list carries no price — `AnsweredTransferReview` is deliberately
   * the cheap read — and the operation SC-186 asked for starts there, on 219
   * rows that already book a disposal. A confirmation that could only state
   * money on one of the two surfaces would be silent on the more consequential
   * one.
   *
   * It reports both directions of the same figure. `proceedsInBase` is what a
   * `left_control` target books; `alreadyDisposedInBase` is the share of it
   * that is already booked, i.e. what an `untracked` target takes back off. One
   * pass, because the two are the same sum over overlapping subsets, and a
   * confirmation that quoted them from two queries could show a total smaller
   * than its own part.
   *
   * `decision` is taken because gate 4 depends on it: only a `left_control`
   * target can be refused for pointing at the caller's own wallet, and a
   * preview that ignored the target would either under-report the refusals for
   * that answer or invent them for the other.
   */
  async bulkPreview(
    userId: string,
    transactionIds: readonly string[],
    decision: BulkTransferDecision | null
  ): Promise<BulkTransferPreview> {
    const entries = transactionIds.map((transactionId) => ({ transactionId, decision }));

    const [user] = await db
      .select({ baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const baseCurrencyId = user?.baseCurrencyId ?? null;
    const baseCurrencyCode = baseCurrencyId ? await this.currencyCode(baseCurrencyId) : '';

    const { eligible, refusals } = await db.transaction(async (tx) =>
      this.bulkClassify(tx, userId, entries)
    );

    let proceeds: Decimal | null = null;
    let alreadyDisposed: Decimal | null = null;
    let unpricedCount = 0;
    let alreadyDisposedCount = 0;

    for (const row of eligible) {
      const isDisposal = row.transferReview === 'left_control';
      if (isDisposal) alreadyDisposedCount += 1;
      // The same call `listPending` makes for the "if it was a sale" column, so
      // the confirmation cannot quote a figure the queue never showed.
      const value = baseCurrencyId
        ? await this.marketValue(
            new Decimal(row.quantity).abs(),
            row.tokenId,
            baseCurrencyId,
            row.occurredAt
          )
        : null;
      // Null is "we have no price that day", which books nothing — counted
      // rather than folded into the total as a zero, because the two are
      // different claims and only one of them is checkable.
      if (value === null) {
        unpricedCount += 1;
        continue;
      }
      proceeds = (proceeds ?? new Decimal(0)).add(value);
      if (isDisposal) alreadyDisposed = (alreadyDisposed ?? new Decimal(0)).add(value);
    }

    return {
      eligible: eligible.map((row) => row.id),
      refusals,
      baseCurrencyCode,
      proceedsInBase: proceeds ? proceeds.toString() : null,
      unpricedCount,
      alreadyDisposedCount,
      alreadyDisposedInBase: alreadyDisposed ? alreadyDisposed.toString() : null,
    };
  }

  /**
   * Apply one answer to many transfers, or none of them (SC-382).
   *
   * **It stamps every row as the caller's own answer**, through the same two
   * columns `resolve` writes and with the same `'user'` source. That is the
   * entire reason this exists as a service method rather than as something an
   * operator runs by hand: on 2026-08-14 a raw `UPDATE` answered a whole
   * backlog of transfers in under half an hour and set neither column, and
   * days later most of production's answers still cannot be attributed to
   * anybody. A bulk apply
   * that wrote without attribution would not be a convenience — it would be
   * that incident with a button on it.
   *
   * **Atomic, and re-classified inside the transaction.** The preview the
   * reader confirmed is seconds old and the nightly matcher can have claimed a
   * row in between, so the gates run again here against the rows being written.
   * A single refusal fails the batch: partial application of a bulk write is
   * the state nobody can reason about afterwards.
   *
   * **The undo is the return value.** `applied` names each row's previous
   * answer, and handing that list straight back reverses the batch exactly. It
   * works because `bulkClassify` admits only link-free rows: there is no
   * created deposit to restore and no group id to re-attach, so the reversal is
   * the same column write in the other direction. `reopen` remains the durable
   * fallback for a reader who has closed the tab — every row this writes
   * carries a `transfer_review`, which is precisely what `reopen` requires, so
   * the path SC-378 found deadlocked is not the path this one uses.
   */
  async bulkResolve(
    userId: string,
    entries: readonly BulkTransferEntry[]
  ): Promise<BulkResolveResult> {
    const result = await db.transaction(async (tx) => {
      const { eligible, refusals } = await this.bulkClassify(tx, userId, entries);
      if (refusals.length > 0) return { ok: false, reason: 'refused', refusals } as const;

      const target = new Map(entries.map((entry) => [entry.transactionId, entry.decision]));
      const applied: BulkTransferApplied[] = eligible.map((row) => ({
        transactionId: row.id,
        previous: (row.transferReview as BulkTransferDecision | null) ?? null,
      }));

      // Grouped, so the write is at most three statements however many rows are
      // selected — a batch of 500 costs the same round trips as a batch of two.
      const byDecision = new Map<BulkTransferDecision | null, string[]>();
      for (const row of eligible) {
        const decision = target.get(row.id) ?? null;
        const bucket = byDecision.get(decision);
        if (bucket) bucket.push(row.id);
        else byDecision.set(decision, [row.id]);
      }

      for (const [decision, ids] of byDecision) {
        await tx
          .update(schema.holdingTransactions)
          .set(
            decision === null
              ? {
                  // The undo direction. Both columns nulled, exactly as
                  // `clearAnswer(…, null)` leaves a row the user reopened
                  // themselves: they took the answer back, so nothing is owed
                  // to a later reader. No deposit DELETE, because gate 2 has
                  // already refused every row that could have one.
                  transferReview: null,
                  transferReviewSplit: null,
                  transferReviewedAt: null,
                  transferReviewSource: null,
                  transferReviewRuleId: null,
                  updatedAt: sql`now()`,
                }
              : {
                  transferReview: decision,
                  transferReviewSplit: null,
                  transferReviewedAt: sql`now()`,
                  transferReviewSource: 'user',
                  // A rule's answer can reach this write — `left_control` is
                  // bulk-eligible and a marked destination's rows carry it — and
                  // the reader answering it here is the provenance going from
                  // `rule` to `user`, which is an upgrade and is allowed. What
                  // is NOT allowed is the pair disagreeing, so the rule id goes
                  // with the source it belonged to (SC-380). It also means the
                  // row is exempt from that rule from here on, which is the
                  // correct reading of a person having overruled it.
                  transferReviewRuleId: null,
                  updatedAt: sql`now()`,
                }
          )
          .where(
            and(
              eq(schema.holdingTransactions.userId, userId),
              inArray(schema.holdingTransactions.id, ids)
            )
          );
      }

      return { ok: true, applied } as const;
    });
    // The undo direction leaves rows unanswered with no source, which is a
    // writer bringing them under any destination rule (SC-1071).
    if (result.ok) await this.applyDisposalMarks(userId);
    return result;
  }

  async clearInapplicableAnswer(
    userId: string,
    transactionId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
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
      if (!row) return { ok: false, reason: 'not_found' } as const;
      if (row.transferReview === null) return { ok: false, reason: 'not_answered' } as const;
      if ((OUTFLOW_KINDS as readonly string[]).includes(row.kind)) {
        return { ok: false, reason: 'answerable_kind' } as const;
      }
      // A group id means lots carry across to a partner leg, and clearing the
      // answer without clearing the link would leave the row reading as
      // unanswered while `outflowPortions` still carries. `reopen` is the
      // operation for that, and it is a different one.
      if (row.transferGroupId !== null) return { ok: false, reason: 'linked' } as const;

      await this.clearAnswer(tx, userId, transactionId, 'repair');
      return { ok: true } as const;
    });
  }

  /**
   * Take an answer off a row and put the row back in the queue — the write
   * both `reopen` and `withdrawSameHoldingPairing` do, in one place because
   * the DELETE is the part that is easy to leave out.
   *
   * `attribution` is what `transfer_review_source` is left holding, and the
   * two callers want opposite things from it:
   *
   * - **`null` — `reopen`.** The user withdrew their own answer through the
   *   queue. The row is exactly as unanswered as one nobody ever answered,
   *   and nothing is owed to a later reader.
   * - **`'repair'` — `withdrawSameHoldingPairing`.** Scani withdrew it. The
   *   row is unanswered AND the reason it is unanswered is not the user, so
   *   `transfer_review IS NULL AND transfer_review_source = 'repair'` is the
   *   record of that. No other writer produces the pair: `resolve` and
   *   `resolveSplit` always set a decision alongside the source, and `reopen`
   *   nulls both. It survives until the row is answered again, which is
   *   exactly as long as the question it explains is open.
   *
   * `transfer_reviewed_at` is nulled either way and that is not an oversight:
   * the column means "when the caller answered it", and after this nobody
   * has. WHEN the withdrawal happened is `updated_at`, which this sets.
   */
  private async clearAnswer(
    tx: DatabaseTransaction,
    userId: string,
    transactionId: string,
    attribution: AnswerAttribution | null
  ): Promise<void> {
    const removed = await tx
      .delete(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          eq(schema.holdingTransactions.source, TRANSFER_REVIEW_CREATED_SOURCE),
          eq(schema.holdingTransactions.externalId, transactionId)
        )
      )
      .returning({
        holdingId: schema.holdingTransactions.holdingId,
        quantity: schema.holdingTransactions.quantity,
        sourceMetadata: schema.holdingTransactions.sourceMetadata,
      });

    // **The holding the answer had to create goes with it** (SC-631).
    //
    // Deleting the arrival alone left an account showing an amount of a token
    // it held none of before the answer, with nothing in the ledger to explain
    // it and the answer withdrawn — and `HoldingsSyncHelper` skips `manual`
    // rows, so no sync was ever allowed to correct the figure.
    //
    // Two facts have to line up before anything is deleted, and they come from
    // different places on purpose. The MARKER says this answer opened the row
    // — `reused` and `unrecorded` both stop here, the second because absence
    // is not a denial and a delete on it would be a guess. `holdingIsUntouched`
    // then says nothing else was ever recorded against it, which is a question
    // about six tables and not just the ledger: a `growth` balance edit leaves
    // an observation and no transaction at all.
    //
    // The arrival is already gone by this point, so it does not count itself.
    const survivors: string[] = [];
    const restore: { holdingId: string; quantity: string }[] = [];
    for (const row of removed) {
      if (
        readCreatedDestination(row.sourceMetadata) === 'created' &&
        (await holdingIsUntouched(tx, userId, row.holdingId))
      ) {
        await tx
          .delete(schema.holdings)
          .where(and(eq(schema.holdings.id, row.holdingId), eq(schema.holdings.userId, userId)));
        continue;
      }
      survivors.push(row.holdingId);
      // **The anchor this answer moved comes back with it** (SC-856).
      //
      // `writeInflow` moves a destination balance that no sync will ever
      // correct, so for those rows the sentence above — every queue answer
      // moves no balance — stopped being true, and a reopen that only deleted
      // the arrival would leave the money moved with nothing explaining it:
      // the shape SC-618 had to repair on the declared path.
      //
      // It acts on `moved` alone. `not_moved` is the answer that left the
      // balance to its sync, and `unrecorded` is every arrival written before
      // SC-856 — both would be a guess about somebody's money, and both are
      // already correct with no anchor to put back.
      if (readMovedDestinationAnchor(row.sourceMetadata) === 'moved') {
        restore.push({ holdingId: row.holdingId, quantity: row.quantity });
      }
    }
    // After the delete loop, so `holdingIsUntouched` above judges the holding
    // as the answer left it — the observation this write records would read as
    // somebody having touched the row.
    for (const entry of restore) {
      const [holding] = await tx
        .select({ balance: schema.holdings.balance })
        .from(schema.holdings)
        .where(and(eq(schema.holdings.id, entry.holdingId), eq(schema.holdings.userId, userId)))
        .limit(1);
      if (!holding) continue;
      await Container.get(UpdateHoldingUseCase).execute(
        entry.holdingId,
        { balance: new Decimal(holding.balance).sub(entry.quantity).toString() },
        userId,
        tx
      );
    }
    if (survivors.length > 0) {
      await Container.get(HoldingCoverageRepository).syncTxBoundsFromLedger(survivors, tx);
    }

    await tx
      .update(schema.holdingTransactions)
      .set({
        transferReview: null,
        transferReviewSplit: null,
        transferReviewedAt: null,
        transferReviewSource: attribution,
        // Required by the table's own CHECK, which allows a rule id only
        // alongside `transfer_review_source = 'rule'` — and required for the
        // reason the CHECK exists: a rule id surviving a withdrawal would let
        // the answered list go on naming a rule for an answer no longer there.
        transferReviewRuleId: null,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.holdingTransactions.id, transactionId));
  }

  /**
   * Break a pairing the MATCHER made, putting both legs back in the queue
   * (SC-350).
   *
   * This is the gap `reopen` does not cover, and it is a real one: `reopen`
   * refuses a row whose `transfer_review` is NULL, which is every pairing
   * `LinkTransferPairsUseCase` has ever written. So a wrong auto-pairing had no
   * undo at all — not for the user, not for a repair, not for anything. The
   * queue could be corrected and the matcher could not.
   *
   * The transfers that made this necessary: one own wallet sent USDC to another
   * own wallet and, minutes later, that one sent the same amount to a stranger.
   * Same token, ±1%, inside thirty minutes — so the matcher paired the ARRIVAL
   * with the unrelated DEPARTURE, both legs landing on one holding. The genuine
   * pairing, an arrival matched to the owner's own outflow on the same
   * transaction hash, could then never be recorded, because `claimInflow` will not take an
   * inflow that already carries a group id.
   *
   * Two refusals rather than one, because they mean different things:
   *
   * - **`gone`** — no such row, not this user's, or it carries no group id.
   * - **`reviewed`** — some leg of the group was answered by a person. That
   *   pairing is not the matcher's to break and not this method's either;
   *   `reopen` is the operation for it, and it knows to delete the deposit an
   *   `internal` answer wrote. Silently unlinking here would leave that deposit
   *   behind with no group, which is the double-count `reopen` exists to avoid.
   *   The one case where the answer itself is the thing that is wrong —
   *   a same-holding artifact, where no transfer happened for it to be about —
   *   is `withdrawSameHoldingPairing`, and it is gated on that proof rather
   *   than on the caller asking nicely.
   *
   * Unlinking books nothing. `isConfirmedDisposal` is `left_control` alone, so
   * a freed outflow with no answer is `hold` — it realizes nothing and instead
   * becomes a question in the queue, which is the honest state for a departure
   * only the user can explain.
   */
  async unlinkPair(userId: string, transactionId: string): Promise<UnlinkPairResult> {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.id, transactionId),
            eq(schema.holdingTransactions.userId, userId),
            isNotNull(schema.holdingTransactions.transferGroupId)
          )
        )
        .limit(1);
      if (!row?.transferGroupId) return { ok: false, reason: 'gone' } as const;

      const legs = await tx
        .select({
          id: schema.holdingTransactions.id,
          transferReview: schema.holdingTransactions.transferReview,
        })
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, userId),
            eq(schema.holdingTransactions.transferGroupId, row.transferGroupId)
          )
        );
      // The SAME predicate a projection calls before proposing the write, so
      // "would be unlinked" cannot mean something the write refuses (SC-376).
      const refusal = unlinkPairRefusal(legs);
      if (refusal) return { ok: false, reason: refusal.reason } as const;

      await tx
        .update(schema.holdingTransactions)
        .set({ transferGroupId: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.holdingTransactions.userId, userId),
            eq(schema.holdingTransactions.transferGroupId, row.transferGroupId)
          )
        );

      return { ok: true, unlinked: legs.map((leg) => leg.id) } as const;
    });
    // An unlinked outflow is back in the queue, so a destination rule it falls
    // under answers it now rather than at the next read (SC-1071).
    if (result.ok) await this.applyDisposalMarks(userId);
    return result;
  }

  async withdrawSameHoldingPairing(
    userId: string,
    transactionId: string
  ): Promise<WithdrawPairingResult> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.id, transactionId),
            eq(schema.holdingTransactions.userId, userId),
            isNotNull(schema.holdingTransactions.transferGroupId)
          )
        )
        .limit(1);
      if (!row?.transferGroupId) return { ok: false, reason: 'gone' } as const;

      const legRows = await tx
        .select({
          id: schema.holdingTransactions.id,
          holdingId: schema.holdingTransactions.holdingId,
          source: schema.holdingTransactions.source,
          externalId: schema.holdingTransactions.externalId,
          rawPayload: schema.holdingTransactions.rawPayload,
          transferReview: schema.holdingTransactions.transferReview,
        })
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, userId),
            eq(schema.holdingTransactions.transferGroupId, row.transferGroupId)
          )
        );
      const legs = legRows.map((leg) => ({
        id: leg.id,
        holdingId: leg.holdingId,
        source: leg.source,
        transferReview: leg.transferReview,
        eventKey: upstreamEventKey(leg.source, leg.externalId, leg.rawPayload),
      }));

      // The SAME predicate a projection calls before proposing the write, so
      // "would be withdrawn" cannot mean something the write refuses (SC-376).
      const refusal = withdrawPairingRefusal(legs);
      if (refusal) {
        return { ok: false, reason: refusal.reason, detail: refusal.detail } as const;
      }

      const cleared = legs.filter((leg) => leg.transferReview !== null);
      for (const leg of cleared) {
        await this.clearAnswer(tx, userId, leg.id, 'repair');
      }

      await tx
        .update(schema.holdingTransactions)
        .set({ transferGroupId: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.holdingTransactions.userId, userId),
            eq(schema.holdingTransactions.transferGroupId, row.transferGroupId)
          )
        );

      return {
        ok: true,
        unlinked: legs.map((leg) => leg.id),
        cleared: cleared.map((leg) => leg.id),
      } as const;
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
    return (await this.candidateSetsFor(userId, outflow)).candidates;
  }

  /**
   * `candidatesFor` and the deposit COMBINATIONS (SC-1365), from one read of
   * the inflows either could be drawn from. `listPending` asks for both on
   * every row, and two queries per row is the cost this avoids.
   */
  private async candidateSetsFor(
    userId: string,
    outflow: { id: string; tokenId: string; quantity: Decimal; occurredAt: Date }
  ): Promise<{ candidates: TransferCandidate[]; combinations: TransferCandidateCombination[] }> {
    const outflowLeg = await legFacts(db, outflow.id);
    const rows = await db
      .select({
        tx: schema.holdingTransactions,
        accountName: schema.accounts.name,
        institutionName: schema.institutions.name,
        tokenSymbol: schema.tokens.symbol,
        ...transferLegFacts,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .leftJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          // The same token row, OR the same asset — which for a bridge is the
          // only shape available, its two legs being two token rows (SC-336).
          // The predicate that decides is `candidatePairClass`, applied below
          // on the rows this net returns; the SQL only has to avoid reading
          // the whole table.
          or(
            eq(schema.holdingTransactions.tokenId, outflow.tokenId),
            outflowLeg?.canonicalAssetKey
              ? sql`${schema.tokens.providerMetadata}->'coingecko'->>'id' = ${outflowLeg.canonicalAssetKey}`
              : sql`false`
          ),
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

    // Identity and direction first, on the same rule the matcher uses. A
    // candidate this refuses is not a near miss the reader could settle — it
    // is a different asset, or an arrival that predates the departure.
    const reachable = rows.filter(
      ({ tx, accountName: _a, institutionName: _i, tokenSymbol: _t, ...facts }) =>
        outflowLeg !== null && reviewPairClass(outflowLeg, toTransferLeg({ tx, ...facts })) !== null
    );

    const scored = reachable.flatMap(({ tx, accountName, institutionName, tokenSymbol }) => {
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
          tokenSymbol,
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

    // `ambiguous` says another deposit matched too, which is only true when one
    // did. A lone match is in the queue because the matcher may not take it
    // alone — the deposit was typed by hand (SC-611), or it crosses an entity
    // boundary (SC-1364) — and telling that reader "so does another deposit"
    // sends them looking for a row that does not exist.
    const strictCount = scored.filter((c) => c.withinStrictTolerance).length;
    const labelled =
      strictCount === 1
        ? scored.map((c) =>
            c.withinStrictTolerance ? { ...c, reason: 'matches' as TransferCandidateReason } : c
          )
        : scored;

    const candidates = labelled
      .sort((a, b) => {
        const byReason =
          (CANDIDATE_REASON_RANK[a.reason] ?? 99) - (CANDIDATE_REASON_RANK[b.reason] ?? 99);
        if (byReason !== 0) return byReason;
        const byQty = Math.abs(a.quantityDeltaPct) - Math.abs(b.quantityDeltaPct);
        if (byQty !== 0) return byQty;
        return Math.abs(a.timeDeltaMs) - Math.abs(b.timeDeltaMs);
      })
      .slice(0, 8);

    const named = new Map(reachable.map((r) => [r.tx.id, r]));
    const combinations = arrivalCombinations(
      { quantityAbs: outflow.quantity, occurredAt: outflow.occurredAt },
      reachable.map(({ tx }) => ({
        transactionId: tx.id,
        holdingId: tx.holdingId,
        quantityAbs: new Decimal(tx.quantity).abs(),
        occurredAt: tx.occurredAt,
      }))
    ).flatMap((parts): TransferCandidateCombination[] => {
      const first = named.get(parts[0]?.transactionId ?? '');
      if (!first) return [];
      const total = parts.reduce((sum, p) => sum.add(p.quantityAbs), new Decimal(0));
      return [
        {
          holdingId: first.tx.holdingId,
          accountName: first.accountName,
          institutionName: first.institutionName,
          tokenSymbol: first.tokenSymbol,
          quantity: total.toString(),
          quantityDeltaPct: outflow.quantity.isZero()
            ? 0
            : total
                .minus(outflow.quantity)
                .div(outflow.quantity)
                .mul(100)
                .toDecimalPlaces(3)
                .toNumber(),
          parts: parts.map((p) => ({
            transactionId: p.transactionId,
            quantity: p.quantityAbs.toString(),
            occurredAt: p.occurredAt.toISOString(),
          })),
        },
      ];
    });

    return { candidates, combinations };
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
    const converted = await this.priceGraphService.convert(quantity, tokenId, baseCurrencyId, at, {
      tx: undefined,
    });
    return converted ? converted.amount.toString() : null;
  }

  /**
   * Every answered outflow that books a disposal onto an address the user
   * registered as their own — the SC-350 invariant, read over the WHOLE table
   * rather than over the answers anyone signed (SC-365).
   *
   * SC-350 corrected a handful of these and enforced nothing: it joined
   * `user_wallets` against the *stamped* answers only, so a `left_control` row
   * carrying no `transfer_review_source` was never in the population. One was,
   * and survived — a USDC outflow between two addresses in the same owner's
   * `user_wallets`. It is unattributed, i.e. it came from the raw `UPDATE` of
   * 2026-08-14 (SC-302), and most of production's answers are. **A repair scoped to the answers with provenance leaves the
   * majority of the table unchecked**, which is why this predicate deliberately
   * does not read `transfer_review_source` at all.
   *
   * Two things make a row qualify, and neither is "somebody said so":
   *
   * - It realizes. `isConfirmedDisposal` is `left_control` alone, so a plain
   *   `left_control` row qualifies; a `split` row qualifies when one of its
   *   portions is `left_control`, because `CostBasisService` realizes per
   *   portion and the split column is where that answer lives.
   * - Its counterparty is an address in this user's `user_wallets`, compared
   *   against `counterpartyFromPayload` rather than the `counterparty` column —
   *   which is still NULL on every `etherscan` row this was built for, so a
   *   column-only check reports "not yours" about the wallet in the next field.
   *
   * **Safe in the direction the data is untrustworthy.** `counterparty` is
   * adversary-writable — address poisoning sprays lookalike addresses through a
   * victim's history — but `user_wallets` is not: an attacker cannot register an
   * address there, and the only thing a match does here is *withhold* a
   * disposal. The failure mode is a disposal not booked, never one invented.
   */
  async ownWalletDisposals(userId: string): Promise<OwnWalletDisposal[]> {
    const ownWallets = await this.ownWalletAddresses(userId);
    if (ownWallets.size === 0) return [];

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          or(
            eq(schema.holdingTransactions.transferReview, 'left_control'),
            eq(schema.holdingTransactions.transferReview, TRANSFER_REVIEW_SPLIT)
          )
        )
      )
      .orderBy(desc(schema.holdingTransactions.occurredAt));

    const found: OwnWalletDisposal[] = [];
    for (const row of rows) {
      if (!realizesADisposal(row)) continue;
      const address = ownWalletCounterparty(row, ownWallets);
      if (address === null) continue;
      found.push({
        transactionId: row.id,
        userId: row.userId,
        holdingId: row.holdingId,
        tokenId: row.tokenId,
        kind: row.kind,
        quantity: row.quantity,
        occurredAt: row.occurredAt,
        counterparty: address,
        decision: row.transferReview ?? '',
        answerSource: answerSourceOf(row),
      });
    }
    return found;
  }

  private async refuseOwnWalletDisposal(
    userId: string,
    outflow: HoldingTransaction,
    decisions: readonly TransferReviewDecision[]
  ): Promise<{ ok: false; reason: 'own_wallet_destination'; address: string } | null> {
    if (!decisions.includes('left_control')) return null;
    const address = ownWalletCounterparty(outflow, await this.ownWalletAddresses(userId));
    if (address === null) return null;
    return { ok: false, reason: 'own_wallet_destination', address } as const;
  }

  /**
   * The user's own wallet addresses, lowercased for comparison (SC-350).
   *
   * Lowercased on both sides because EVM addresses travel in EIP-55 mixed case
   * and the two sides come from different places: `user_wallets` holds what the
   * user pasted when they added the wallet, and the counterparty comes out of a
   * chain payload. `0xc0ffE06a…14aB` and `0xc0ffe06a…14ab` are one address, and
   * a case-sensitive check would have gone on reporting "not yours" about
   * exactly the wallets this is for.
   *
   * Public because `TransferReviewRuleService` refuses to MARK a destination
   * that is one of these (SC-380), and the refusal has to be the same set the
   * write-path guard uses. Two copies of "the user's own addresses,
   * lowercased" is how a rule starts refusing an address the audit does not
   * flag, or the other way round.
   */
  async ownWalletAddresses(userId: string): Promise<Set<string>> {
    const rows = await db
      .select({ walletAddress: schema.userWallets.walletAddress })
      .from(schema.userWallets)
      .where(eq(schema.userWallets.userId, userId));
    return new Set(rows.map((row) => row.walletAddress.trim().toLowerCase()));
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
 * Claim an existing inflow as this outflow's partner — the `paired` answer's
 * write, shared by `resolve` and `resolveSplit`.
 *
 * The partner must still be unclaimed, must be an inflow belonging to the same
 * user, and must be able to be the same money — the same token row, or the same
 * asset on another chain (SC-336), on exactly the rule the matcher uses.
 * Re-checked here rather than trusted from the listing: the candidate list the
 * user chose from may be minutes old, and in between a nightly run can have
 * paired that very inflow to something else.
 *
 * The identity check is not a formality about a list the caller already saw. It
 * is the one place a `paired` answer is written, so dropping it in favour of
 * "the client sent an id" would make the API the way to merge the lot chains of
 * two unrelated assets — the exact damage the matcher's tolerances exist to
 * avoid, arriving through the door marked "a person decided".
 */
async function claimInflow(
  tx: DatabaseTransaction,
  userId: string,
  outflow: { id: string },
  matchTransactionId: string,
  groupId: string
): Promise<boolean> {
  const [inflow] = await tx
    .select()
    .from(schema.holdingTransactions)
    .where(
      and(
        eq(schema.holdingTransactions.id, matchTransactionId),
        eq(schema.holdingTransactions.userId, userId),
        inArray(schema.holdingTransactions.kind, [...INFLOW_KINDS]),
        isNull(schema.holdingTransactions.transferGroupId)
      )
    )
    .limit(1);
  if (!inflow) return false;

  const [outflowLeg, inflowLeg] = await Promise.all([
    legFacts(tx, outflow.id),
    legFacts(tx, inflow.id),
  ]);
  if (!outflowLeg || !inflowLeg) return false;
  if (reviewPairClass(outflowLeg, inflowLeg) === null) return false;

  await tx
    .update(schema.holdingTransactions)
    .set({ transferGroupId: groupId, updatedAt: sql`now()` })
    .where(eq(schema.holdingTransactions.id, inflow.id));
  return true;
}

/**
 * Claim SEVERAL inflows as one outflow's arrival (SC-1365) — the money landed
 * in parts. Null on success; otherwise the refusal to return, and the caller's
 * transaction rolls back whatever was claimed before it.
 *
 * Each part passes `claimInflow`'s own checks. Beyond them: no part may
 * predate the withdrawal, because the cost walk hands buffered lots only to
 * arrivals it reaches after the departure; and the parts must total the
 * withdrawal within the net the candidate list is drawn from, since a
 * combination is only ever offered inside it.
 */
async function claimInflowSet(
  tx: DatabaseTransaction,
  userId: string,
  outflow: HoldingTransaction,
  inflowIds: readonly string[],
  groupId: string
): Promise<Extract<TransferResolveResult, { ok: false }> | null> {
  if (new Set(inflowIds).size !== inflowIds.length || inflowIds.length > MAX_COMBINED_ARRIVALS) {
    return { ok: false, reason: 'partner_gone' };
  }
  const parts = await tx
    .select({
      quantity: schema.holdingTransactions.quantity,
      occurredAt: schema.holdingTransactions.occurredAt,
    })
    .from(schema.holdingTransactions)
    .where(
      and(
        inArray(schema.holdingTransactions.id, [...inflowIds]),
        eq(schema.holdingTransactions.userId, userId)
      )
    );
  if (parts.length !== inflowIds.length) return { ok: false, reason: 'partner_gone' };
  if (parts.some((p) => p.occurredAt.getTime() < outflow.occurredAt.getTime())) {
    return { ok: false, reason: 'partner_gone' };
  }
  const expected = new Decimal(outflow.quantity).abs();
  const total = parts.reduce((sum, p) => sum.add(new Decimal(p.quantity).abs()), new Decimal(0));
  if (total.minus(expected).abs().gt(expected.mul(CANDIDATE_QTY_EPSILON))) {
    return { ok: false, reason: 'sum', expected: expected.toString() };
  }
  for (const id of inflowIds) {
    if (!(await claimInflow(tx, userId, outflow, id, groupId))) {
      // A refusal is RETURNED, and the transaction around it commits — so the
      // parts claimed before this one are released here, or they would stay
      // linked to an outflow that was never answered.
      await tx
        .update(schema.holdingTransactions)
        .set({ transferGroupId: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.holdingTransactions.userId, userId),
            eq(schema.holdingTransactions.transferGroupId, groupId)
          )
        );
      return { ok: false, reason: 'partner_gone' };
    }
  }
  return null;
}

/**
 * What writing that arrival can refuse, in the two words the callers need.
 *
 * A boolean was enough while "gone" was the only refusal. It is not once a
 * present destination can be refused on a rule (SC-859): the two failures need
 * different sentences, and `resolve` and `resolveSplit` both surface this one
 * straight to a reader.
 */
type InflowWriteResult = { ok: true } | { ok: false; reason: 'destination_gone' };

async function writeInflow(
  tx: DatabaseTransaction,
  userId: string,
  outflow: HoldingTransaction,
  opts: {
    destination: TransferDestinationRef;
    quantity: Decimal;
    groupId: string;
    observedEvent?: boolean;
    receivedQuantity?: string;
  }
): Promise<InflowWriteResult> {
  const { destination, groupId } = opts;
  let quantity = opts.quantity;
  let arrivalTokenId = outflow.tokenId;
  if (opts.receivedQuantity && (!opts.observedEvent || !destination.holdingId))
    return { ok: false, reason: 'destination_gone' };

  const [account] = await tx
    .select({
      id: schema.accounts.id,
      userId: schema.accounts.userId,
      institutionId: schema.accounts.institutionId,
      metadata: schema.accounts.metadata,
      isActive: schema.accounts.isActive,
    })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, destination.accountId), eq(schema.accounts.userId, userId)))
    .limit(1);
  if (!account) return { ok: false, reason: 'destination_gone' };

  let holdingId = destination.holdingId;
  // Recorded on the arrival row below, on EVERY branch. See
  // `created-destination.ts`: `false` is written as deliberately as `true`,
  // because a reopen has to tell "this answer did not create it" from "nobody
  // said", and only one of those may delete a holding (SC-631).
  let createdDestination = false;
  // The destination this answer REUSED, or null where it opened one. Only a
  // reused row can have an anchor to move: a created one was opened at the
  // figure `openingOf` chose, which already accounts for the arrival wherever
  // it is the user's number to state (SC-856).
  let reused: { id: string; source: string; balance: string } | null = null;
  if (holdingId) {
    const [holding] = await tx
      .select({
        id: schema.holdings.id,
        tokenId: schema.holdings.tokenId,
        source: schema.holdings.source,
        balance: schema.holdings.balance,
      })
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.id, holdingId),
          eq(schema.holdings.userId, userId),
          eq(schema.holdings.accountId, destination.accountId),
          opts.receivedQuantity ? undefined : eq(schema.holdings.tokenId, outflow.tokenId),
          // Sending a transfer to the holding it left is not a destination,
          // it is a no-op that would leave the lots parked in a group with
          // both legs on one holding.
          ne(schema.holdings.id, outflow.holdingId)
        )
      )
      .limit(1);
    if (!holding) return { ok: false, reason: 'destination_gone' };
    if (opts.receivedQuantity) {
      const received = new Decimal(opts.receivedQuantity);
      if (!received.isFinite() || !received.gt(0) || holding.tokenId === outflow.tokenId)
        return { ok: false, reason: 'destination_gone' };
      quantity = received;
      arrivalTokenId = holding.tokenId;
    }
    reused = holding;
  } else {
    // "This account tracks no position in that token yet." Between the picker
    // rendering and this write, one may have appeared — an import ran, another
    // tab created it — and using it is the honest resolution of that race:
    // the reader chose the account, and a second holding for the same token in
    // it would be a duplicate nobody asked for.
    const [existing] = await tx
      .select({
        id: schema.holdings.id,
        source: schema.holdings.source,
        balance: schema.holdings.balance,
      })
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.userId, userId),
          eq(schema.holdings.accountId, destination.accountId),
          eq(schema.holdings.tokenId, outflow.tokenId),
          ne(schema.holdings.id, outflow.holdingId)
        )
      )
      .limit(1);
    if (existing) {
      holdingId = existing.id;
      reused = existing;
    } else {
      const opening = await openingOf(tx, account, quantity);
      // **Through the service, not a direct insert** (SC-641). This was the
      // last caller in the tree writing `holdings` itself, and it is the one
      // `HoldingService`'s docblock warned about — *"nothing stops the next
      // caller writing `holdings` directly"*. Going the long way is what
      // gets the opening on the record instead of a balance appearing with
      // nothing saying it had.
      const created = await Container.get(HoldingService).createHoldingWithEvent(
        {
          userId,
          accountId: destination.accountId,
          tokenId: outflow.tokenId,
          balance: opening.balance,
          source: opening.source,
          // A person was shown this account and picked it. That is the whole
          // of what `user_confirmed` claims, and it is true of the row on
          // either branch — only the balance's owner differs.
          arrival: 'user_confirmed',
          // **The two branches are asymmetric on purpose.** On a sync-owned
          // account the row opens at ZERO and the sync writes the real figure
          // on its next pass. An opening observation of 0 would pair with that
          // first sync observation into a gap the ledger cannot explain: the
          // arrival is dated at the TRANSFER's time, before the opening, and
          // `findGapCandidatesForUser` bridges only transactions occurring
          // INSIDE the interval. The owner would be asked to account for money
          // the ledger already accounts for. Where nobody syncs, the opening
          // IS a claim about the balance and belongs on the record.
          skipSyncCapture: opening.balance === '0',
          observationSource: HOLDING_OPEN_OBSERVATION_SOURCE,
        },
        tx
      );
      if (!created) return { ok: false, reason: 'destination_gone' };
      holdingId = created.id;
      createdDestination = true;
    }
  }

  const movedAnchor =
    reused && !opts.observedEvent
      ? await moveUnobservedAnchor(tx, userId, account, reused, quantity)
      : false;

  await tx
    .insert(schema.holdingTransactions)
    .values({
      userId,
      holdingId,
      tokenId: arrivalTokenId,
      kind: CREATED_INFLOW_KIND,
      quantity: quantity.toString(),
      occurredAt: outflow.occurredAt,
      source: TRANSFER_REVIEW_CREATED_SOURCE,
      externalId: outflow.id,
      transferGroupId: groupId,
      counterparty: outflow.counterparty,
      description: 'Arrival you recorded when reviewing the transfer it came from',
      sourceMetadata: arrivalMetadata({
        outflowTransactionId: outflow.id,
        createdDestination,
        movedDestinationAnchor: movedAnchor,
        outflowAt: outflow.occurredAt,
      }),
    })
    // Re-answering after a reopen deletes the previous row first, so a
    // conflict here means two writers for one question. The later one wins on
    // the fields that can differ — the amount, when a split was re-divided.
    .onConflictDoUpdate({
      target: [
        schema.holdingTransactions.holdingId,
        schema.holdingTransactions.source,
        schema.holdingTransactions.externalId,
      ],
      // `source_metadata` is deliberately NOT in this set. On a conflict the
      // destination necessarily exists NOW, so recomputing the marker here
      // would write `false` over the `true` left by the write that created
      // it, and the undo would then strand the holding this answer opened.
      // The FIRST write is the one that describes what the answer did.
      set: {
        quantity: quantity.toString(),
        occurredAt: outflow.occurredAt,
        transferGroupId: groupId,
        updatedAt: sql`now()`,
      },
    });

  // This is the one ledger write in the codebase that doesn't go through
  // `HoldingTransactionRepository.bulkUpsert`, so it states the coverage
  // bound itself. An arrival recorded here can predate everything else on
  // a freshly created destination holding (SC-307).
  await Container.get(HoldingCoverageRepository).syncTxBoundsFromLedger([holdingId], tx);

  return { ok: true };
}

function anchorIsUnobserved(
  holding: { source: string },
  accountSyncSource: BalanceSyncSource | null
): boolean {
  return holding.source === MANUAL_HOLDING_SOURCE || accountSyncSource === null;
}

/**
 * The same question with the account half still to resolve — what the WRITE
 * path asks, one destination at a time.
 *
 * `destinationsFor` calls `anchorIsUnobserved` directly instead, because it has
 * already resolved the account's sync source once for a whole page of
 * candidates. Both go through that one function on purpose: the sentence over
 * the button and the write behind it are the two things that must never
 * disagree, and two spellings of this rule is how they come to.
 */
async function arrivalMovesTheAnchor(
  tx: DatabaseTransaction,
  account: SyncOwnableAccount,
  holding: { source: string }
): Promise<boolean> {
  const syncSource = await Container.get(BalanceSyncOwnershipService).resolveSyncSource(
    account,
    tx
  );
  return anchorIsUnobserved(holding, syncSource);
}

/**
 * Move a destination anchor nobody else will, and say whether it did (SC-856).
 *
 * **Through `UpdateHoldingUseCase`, for the reason `undoDeclaredTransfer` gives
 * at length**: a second writer with its own `UPDATE holdings SET balance` is
 * what SC-245 was, and a balance moved without an observation does not degrade
 * `BalanceAtTimeService`, it makes it confidently wrong on every date after the
 * gap. `editCause` is omitted deliberately — that is what keeps this from
 * synthesizing a ledger row, which would be the double-count arriving by the
 * other door: the arrival row this answer writes IS the ledger entry.
 *
 * `balance + quantity` reads TODAY's anchor rather than the balance at the
 * transfer's date, and that is correct for the same reason the undo reads it:
 * `holdings.balance` is an anchor, not a sum, and any restatement made since
 * stands. Only this transfer's own contribution is added.
 *
 * The return value is what the arrival row records, so a reopen reverses
 * exactly what happened rather than re-deriving a predicate whose inputs move.
 */
async function moveUnobservedAnchor(
  tx: DatabaseTransaction,
  userId: string,
  account: SyncOwnableAccount,
  holding: { id: string; source: string; balance: string },
  quantity: Decimal
): Promise<boolean> {
  if (!(await arrivalMovesTheAnchor(tx, account, holding))) return false;
  await Container.get(UpdateHoldingUseCase).execute(
    holding.id,
    { balance: new Decimal(holding.balance).add(quantity).toString() },
    userId,
    tx
  );
  return true;
}

async function openingOf(
  tx: DatabaseTransaction,
  account: SyncOwnableAccount,
  quantity: Decimal
): Promise<{ balance: string; source: string }> {
  const syncSource = await Container.get(BalanceSyncOwnershipService).resolveSyncSource(
    account,
    tx
  );
  if (syncSource) return { balance: '0', source: syncSource };
  // Nobody syncs this account, so the amount that just moved in is the best
  // fact anyone has — and a holding at zero holding a 250 deposit would read
  // as 250 short from the day it was made.
  return { balance: quantity.toString(), source: 'manual' };
}

/**
 * Does this row realize anything? — the `isConfirmedDisposal` question, plus
 * the split case that predicate never sees (SC-365).
 *
 * `CostBasisService` realizes a plain `left_control` row whole, and a `split`
 * row per portion. So "books a disposal" is not one column: a split answer
 * carrying a `left_control` portion realizes exactly as much money as a whole
 * `left_control` answer for that portion's share, and an invariant that read
 * `transfer_review` alone would call it clean.
 *
 * A split that does not parse is treated as realizing NOTHING rather than
 * throwing: this runs over historical rows on behalf of an audit, and an audit
 * that dies on one malformed row reports nothing about the other 560.
 */
function realizesADisposal(tx: HoldingTransaction): boolean {
  if (tx.transferReview === 'left_control') return true;
  if (tx.transferReview !== TRANSFER_REVIEW_SPLIT) return false;
  const parsed = transferReviewSplitSchema.safeParse(tx.transferReviewSplit);
  return parsed.success && parsed.data.some((p) => p.decision === 'left_control');
}

/**
 * The half of the rule engine that changes what the queue shows: a
 * `not_a_disposal` match takes the row out of it (SC-375).
 *
 * Expressed against the LEFT JOIN rather than as its own EXISTS so that the
 * listing, the count and the hidden list are all reading one join and cannot
 * drift apart. `ask_me` deliberately does not appear here — that verdict
 * annotates a row and leaves it in the queue, which is the whole difference
 * between the two.
 */
function notHiddenByRule() {
  return or(
    isNull(schema.transferReviewRules.id),
    ne(schema.transferReviewRules.verdict, 'not_a_disposal')
  );
}

/**
 * True when this destination is one of the user's own registered wallets.
 *
 * Both sides go through `normalizeCounterparty` — the own-wallet comparison
 * form — rather than an inline `.trim().toLowerCase()` at each site. It is a
 * different normalization from the rule key's (`transfer_counterparty_key`,
 * which also strips a payment preamble) and deliberately so: a `user_wallets`
 * row holds an address a person pasted, and there is no preamble to strip.
 */
function isOwnWallet(counterparty: string | null, ownWallets: ReadonlySet<string>): boolean {
  const address = normalizeCounterparty(counterparty);
  return address !== null && ownWallets.has(address);
}

/**
 * The row's destination when it is one of `ownWallets`, normalized — otherwise
 * null.
 *
 * One function because the detector and the write-path guard must agree
 * exactly. Two copies of "read the payload when the column is null, lowercase
 * both sides" is how a queue starts refusing an answer the audit does not
 * flag, or the other way round.
 */
function ownWalletCounterparty(
  tx: HoldingTransaction,
  ownWallets: ReadonlySet<string>
): string | null {
  const counterparty = counterpartyFromPayload(tx.kind, tx.rawPayload, tx.counterparty);
  const address = normalizeCounterparty(counterparty);
  return address !== null && ownWallets.has(address) ? address : null;
}
