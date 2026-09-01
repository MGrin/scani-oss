import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { answerSourceOf } from '@scani/shared';
import Decimal from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { candidatePairClass, MATCH_WINDOW_MS, type TransferLeg } from '../lib/transfer-matching';
import {
  type GroupLegFacts,
  type SameHoldingGroupVerdict,
  sameHoldingGroupVerdict,
  upstreamEventKey,
} from '../lib/upstream-event';
import { TransferReviewService } from '../services/TransferReviewService';

/**
 * How far out an arrival is worth SHOWING, so a near miss is reported as a
 * refusal rather than vanishing from the population. Same reasoning as
 * `RepairMatchedOutflowsUseCase`; same numbers, deliberately.
 */
const CANDIDATE_QTY_EPSILON = new Decimal('0.05');
const CANDIDATE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * How far out an arrival is worth ACTING on. Tighter than
 * `RepairMatchedOutflowsUseCase`'s 2%, because a bridge is not the fixed-fee
 * shape that widening existed for: every bridge leg measured in this ledger
 * arrives short by a PERCENTAGE (-0.0128% to -1.084%), so the bound that fits
 * is a percentage and there is no reason to reach past it.
 */
const REPAIR_QTY_EPSILON = new Decimal('0.02');

/** The arrival a plan would claim, with the facts that justify claiming it. */
export interface BridgedArrival {
  transactionId: string;
  holdingId: string;
  accountName: string;
  chainKey: string | null;
  quantity: string;
  /** Signed, as a percentage of the departure. Negative means a fee was taken. */
  deltaPct: string;
  gapSeconds: number;
}

/** One leg of the group standing between a plan and its arrival. */
export interface BlockingLeg {
  transactionId: string;
  holdingId: string;
  quantity: string;
  occurredAt: Date;
  transferReview: string | null;
  /** Whose answer it is — `user` here is exactly what makes this expensive. */
  answerSource: string;
}

/**
 * The group that already holds this plan's arrival, and what freeing it costs.
 *
 * A first-class part of the plan rather than a reason to drop the row, because
 * the cost is a decision only the person whose answers they are can take. The
 * whole finding of SC-353 is that all four provable bridges land here.
 */
export interface ArrivalBlocker {
  groupId: string;
  /** Never acted on unless this says UNLINK — see `apply`. */
  verdict: SameHoldingGroupVerdict;
  /** Every leg of the group, so the reader sees what loses its group id. */
  legs: BlockingLeg[];
  /** The subset carrying an answer — the rows `apply` would reopen. */
  answeredLegs: BlockingLeg[];
}

/**
 * What to do about one `left_control` outflow that bridged to another chain.
 *
 * `blocked` is a first-class outcome. An outflow left as answered costs
 * nothing today; one repaired on a guess silently rewrites a tax position.
 */
export interface BridgedOutflowPlan {
  transactionId: string;
  userId: string;
  symbol: string;
  /** Absolute, so the amount reads as the amount that moved. */
  quantity: string;
  occurredAt: Date;
  holdingId: string;
  accountName: string;
  chainKey: string | null;
  /** Where it went on-chain, from the payload. The bridge contract. */
  destination: string | null;
  /** Whose answer this row currently rests on. */
  answerSource: string;
  action: 'bridged' | 'blocked';
  arrival: BridgedArrival | null;
  /** Set when the arrival is already claimed and would have to be freed. */
  blocker: ArrivalBlocker | null;
  blockedReason: string | null;
  candidateCount: number;
}

/**
 * Answer `paired` on the outflows that BRIDGED to another chain and were
 * answered `left_control` instead (SC-353).
 *
 * **What went wrong.** `left_control` is the only answer that books a disposal.
 * A bridge is not a disposal — the money left one chain and arrived on another,
 * still the user's. Until SC-336 the review surface could not offer a candidate
 * on another chain at all (`candidatesFor` tested `tokenId = outflow.tokenId`)
 * and `claimInflow` would have refused one, so a bridged outflow had no
 * available answer except a wrong one. Four rows in production were answered
 * that way on 2026-08-17 at 08:31, WITH a reviewer timestamp — which makes them
 * `answerSource: 'user'`, which makes `LinkTransferPairsUseCase` skip them
 * forever. They do not self-correct; that is why this exists.
 *
 * **Why it is separate from `RepairMatchedOutflowsUseCase`,** which already
 * pairs a `left_control` outflow with a free arrival. Two reasons, and both are
 * about keeping an authority narrow:
 *
 *   1. This population is `bridged_asset` ONLY. A same-chain, same-token pair
 *      is SC-328's question and is settled there; asking a second use case the
 *      same question is how two derivations of one fact start to disagree.
 *   2. This is the only repair that reaches past a `transfer_group_id` onto a
 *      leg somebody ANSWERED. That is a strictly larger authority than SC-328
 *      holds, and it must not leak into SC-328's population by being added to
 *      its class.
 *
 * **Why the arrivals are not free, which is the whole finding.** Each of the
 * four Base arrivals was paired — by a `user` answer at 15:08-15:09 the same
 * afternoon — with the Base DEPARTURE that followed it about a minute later, on
 * the SAME holding. A group whose two legs sit on one holding asserts a move
 * from a position to itself, which is not a thing that happens (SC-347), and
 * these four are the artifact kind rather than the real kind: two distinct
 * transaction hashes, so `sameHoldingGroupVerdict` returns UNLINK. Until one is
 * freed the bridge cannot be paired to it, because `claimInflow` refuses an
 * inflow that already carries a group id.
 *
 * **It frees the arrival with `reopen`, not `unlinkPair`.** `unlinkPair`
 * refuses a group any leg of which was answered — deliberately, because
 * reverting a reader's decision is not the matcher's to do — and `reopen` is
 * the operation that is: it clears the answer AND the group id from both legs,
 * and it deletes any deposit an `internal` answer wrote, which a bare unlink
 * would strand.
 *
 * **The freed departure is left UNANSWERED, on purpose.** It becomes a question
 * in the queue rather than an answer this repair invented. `isConfirmedDisposal`
 * is `left_control` alone, so an unanswered outflow with no group is `hold`: it
 * books nothing and asserts nothing. Writing `left_control` there would be this
 * repair guessing at a disposal, which is the one direction that costs real
 * money to get wrong.
 */
@Service()
export class RepairBridgedOutflowsUseCase {
  private readonly reviewService = Container.get(TransferReviewService);

  /**
   * Every `left_control` outflow with a cross-chain arrival near it, and what
   * the ledger says to do about each.
   *
   * The population is derived, never passed in. A caller that knows which ids
   * it expects passes them as an assertion — see
   * `scripts/repair-sc353-bridged-outflows.ts`.
   */
  async plansFor(userId: string): Promise<BridgedOutflowPlan[]> {
    const rows = await this.legRows(userId);
    const byId = new Map(rows.map((r) => [r.tx.id, r]));

    const inflows = rows.filter((r) => new Decimal(r.tx.quantity).gt(0));
    const groupLegs = new Map<string, LegRow[]>();
    for (const row of rows) {
      const groupId = row.tx.transferGroupId;
      if (groupId === null) continue;
      const bucket = groupLegs.get(groupId);
      if (bucket) bucket.push(row);
      else groupLegs.set(groupId, [row]);
    }

    const plans: BridgedOutflowPlan[] = [];
    for (const row of rows) {
      if (row.tx.transferReview !== 'left_control') continue;
      if (row.tx.transferGroupId !== null) continue;
      if (row.tx.kind !== 'transfer_out' && row.tx.kind !== 'withdraw') continue;

      const out = toLeg(row);
      const candidates = inflows
        .map((cand) => ({ row: cand, leg: toLeg(cand) }))
        // `bridged_asset` and nothing else. `same_token` across two holdings is
        // SC-328's population and is answered there.
        .filter(({ leg }) => candidatePairClass(out, leg) === 'bridged_asset')
        .filter(({ leg }) => {
          const gap = leg.occurredAt.getTime() - out.occurredAt.getTime();
          if (gap < 0 || gap > CANDIDATE_WINDOW_MS) return false;
          return leg.quantityAbs
            .minus(out.quantityAbs)
            .abs()
            .lte(out.quantityAbs.mul(CANDIDATE_QTY_EPSILON));
        });
      if (candidates.length === 0) continue;

      const base = {
        transactionId: out.transactionId,
        userId,
        symbol: row.symbol,
        quantity: out.quantityAbs.toString(),
        occurredAt: out.occurredAt,
        holdingId: out.holdingId,
        accountName: row.accountName,
        chainKey: row.chainKey,
        destination: row.destination,
        answerSource: answerSourceOf(row.tx),
        candidateCount: candidates.length,
      };
      const blocked = (why: string): BridgedOutflowPlan => ({
        ...base,
        action: 'blocked',
        arrival: null,
        blocker: null,
        blockedReason: why,
      });

      const measured = candidates.map((cand) => {
        const gapMs = cand.leg.occurredAt.getTime() - out.occurredAt.getTime();
        const delta = cand.leg.quantityAbs.minus(out.quantityAbs);
        return {
          ...cand,
          gapMs,
          delta,
          deltaPct: out.quantityAbs.isZero() ? new Decimal(0) : delta.div(out.quantityAbs).mul(100),
          inWindow: gapMs <= MATCH_WINDOW_MS,
          inBound: delta.abs().lte(out.quantityAbs.mul(REPAIR_QTY_EPSILON)),
        };
      });

      // **Ambiguity is judged on the arrivals that could actually be ACTED on,
      // not on everything the wider net showed.** The wide net exists so a near
      // miss is reported rather than vanishing; letting it veto a decision the
      // deciding bounds settle is the opposite of that, and it produced a
      // contradiction in production: one departure's "second candidate" is an
      // arrival over an hour away that a DIFFERENT departure claims seconds
      // after its own — one arrival counted as both settled and ambiguous.
      const actionable = measured.filter((c) => c.inWindow && c.inBound);
      if (actionable.length > 1) {
        plans.push(
          blocked(
            `${actionable.length} cross-chain arrivals inside the ` +
              `${Math.round(MATCH_WINDOW_MS / 60000)}-minute window and the ` +
              `${REPAIR_QTY_EPSILON.mul(100)}% bound — the ledger cannot say which one this became`
          )
        );
        continue;
      }

      const only = actionable[0];
      if (!only) {
        // Nothing actionable. The nearest miss is what the reader needs, and
        // the reason names the bound it failed rather than a count.
        const nearest = measured.reduce((best, c) => (c.gapMs < best.gapMs ? c : best));
        const reasons: string[] = [];
        if (!nearest.inWindow) {
          reasons.push(
            `${Math.round(nearest.gapMs / 60000)} min later, outside the ` +
              `${Math.round(MATCH_WINDOW_MS / 60000)}-minute window`
          );
        }
        if (!nearest.inBound) {
          reasons.push(
            `${nearest.deltaPct.toDecimalPlaces(4)}% apart, outside the ` +
              `${REPAIR_QTY_EPSILON.mul(100)}% bound`
          );
        }
        plans.push(
          blocked(
            `${measured.length} cross-chain arrival(s), none actionable — the nearest is ` +
              reasons.join(' and ')
          )
        );
        continue;
      }
      const gapSeconds = Math.round(only.gapMs / 1000);
      const deltaPct = only.deltaPct;

      const arrival: BridgedArrival = {
        transactionId: only.leg.transactionId,
        holdingId: only.leg.holdingId,
        accountName: only.row.accountName,
        chainKey: only.row.chainKey,
        quantity: only.leg.quantityAbs.toString(),
        deltaPct: deltaPct.toDecimalPlaces(4).toString(),
        gapSeconds,
      };

      const groupId = only.row.tx.transferGroupId;
      if (groupId === null) {
        plans.push({ ...base, action: 'bridged', arrival, blocker: null, blockedReason: null });
        continue;
      }

      const blocker = describeBlocker(groupId, groupLegs.get(groupId) ?? []);
      if (!blocker.verdict.unlink) {
        plans.push({
          ...blocked(
            `the arrival already belongs to group ${groupId.slice(0, 8)} and the ledger keeps it — ` +
              blocker.verdict.reason
          ),
          arrival,
          blocker,
        });
        continue;
      }
      plans.push({ ...base, action: 'bridged', arrival, blocker, blockedReason: null });
    }

    plans.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    // A single arrival cannot become two departures. Left as an assertion here
    // rather than a filter, because which one is wrong is not derivable.
    const claimed = new Map<string, string>();
    for (const plan of plans) {
      if (plan.action !== 'bridged' || plan.arrival === null) continue;
      const first = claimed.get(plan.arrival.transactionId);
      if (first !== undefined) {
        throw new Error(
          `${first} and ${plan.transactionId} both derive the arrival ${plan.arrival.transactionId}`
        );
      }
      claimed.set(plan.arrival.transactionId, plan.transactionId);
    }
    // Keeps `byId` load-bearing rather than decorative: a plan whose row went
    // missing between the two reads is a race, not a plan.
    for (const plan of plans) {
      if (!byId.has(plan.transactionId)) {
        throw new Error(`${plan.transactionId}: row vanished between reads`);
      }
    }
    return plans;
  }

  /**
   * Write one plan, through `TransferReviewService` and never around it.
   *
   * `allowReopeningAnswers` is a second authorisation, not a convenience flag.
   * Freeing an arrival means withdrawing an answer somebody made about a
   * DIFFERENT row than the one being repaired, and a repair that could do that
   * by default would be able to quietly widen its own mandate. The caller has
   * to have read which answers it costs and said yes to those.
   *
   * Throws rather than returning a result. A repair applies a plan that was
   * printed and read first, so a refusal here means the world moved under it
   * and continuing would leave a half-applied correction nobody chose.
   */
  async apply(
    plan: BridgedOutflowPlan,
    options: { allowReopeningAnswers?: boolean } = {}
  ): Promise<void> {
    if (plan.action === 'blocked' || plan.arrival === null) {
      throw new Error(
        `${plan.transactionId}: refusing to apply a blocked plan — ${plan.blockedReason}`
      );
    }

    if (plan.blocker !== null) {
      if (options.allowReopeningAnswers !== true) {
        throw new Error(
          `${plan.transactionId}: the arrival is held by group ${plan.blocker.groupId.slice(0, 8)}, ` +
            `freeing it withdraws ${plan.blocker.answeredLegs.length} answer(s) — ` +
            'pass allowReopeningAnswers to authorise that'
        );
      }
      // Re-derived from the live rows rather than trusted from the plan: the
      // verdict is the one claim here that, if stale, breaks a group that was
      // a real no-op and re-mints its arrival's lot at market (SC-344).
      const live = await this.groupLegsNow(plan.userId, plan.blocker.groupId);
      const verdict = sameHoldingGroupVerdict(live.map(toGroupLegFacts));
      if (!verdict.unlink) {
        throw new Error(
          `${plan.transactionId}: group ${plan.blocker.groupId.slice(0, 8)} no longer unlinkable — ${verdict.reason}`
        );
      }
      for (const leg of live) {
        if (leg.tx.transferReview === null) continue;
        const reopened = await this.reviewService.reopen(plan.userId, leg.tx.id);
        if (!reopened) throw new Error(`${leg.tx.id}: reopen of the blocking leg returned false`);
      }
      // `reopen` clears the group id from every leg it touches, so an
      // all-unanswered group would still be holding the arrival. Nothing in
      // production is that shape, and a silent skip would be the bug.
      const still = await this.groupLegsNow(plan.userId, plan.blocker.groupId);
      if (still.length > 0) {
        throw new Error(
          `${plan.transactionId}: group ${plan.blocker.groupId.slice(0, 8)} still holds ` +
            `${still.length} leg(s) after reopening every answered one`
        );
      }
    }

    const reopened = await this.reviewService.reopen(plan.userId, plan.transactionId);
    if (!reopened) throw new Error(`${plan.transactionId}: reopen returned false`);

    const result = await this.reviewService.resolve(plan.userId, plan.transactionId, 'paired', {
      answerSource: 'repair',
      matchTransactionId: plan.arrival.transactionId,
    });
    if (!result.ok) {
      throw new Error(`${plan.transactionId}: resolve('paired') failed — ${result.reason}`);
    }
  }

  private async legRows(userId: string): Promise<LegRow[]> {
    return db
      .select({
        tx: schema.holdingTransactions,
        symbol: schema.tokens.symbol,
        accountName: schema.accounts.name,
        canonicalAssetKey: sql<
          string | null
        >`case when ${schema.tokens.lookalikeOf} is null then ${schema.tokens.providerMetadata}->'coingecko'->>'id' end`,
        walletId: sql<string | null>`${schema.accounts.metadata}->>'userWalletId'`,
        chainKey: sql<string | null>`${schema.accounts.metadata}->>'chainId'`,
        entityId: schema.accounts.entityId,
        destination: sql<string | null>`${schema.holdingTransactions.rawPayload}->>'to'`,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .where(eq(schema.holdingTransactions.userId, userId));
  }

  private async groupLegsNow(userId: string, groupId: string): Promise<LegRow[]> {
    const rows = await this.legRows(userId);
    return rows.filter((r) => r.tx.transferGroupId === groupId);
  }
}

function describeBlocker(groupId: string, rows: ReadonlyArray<LegRow>): ArrivalBlocker {
  const legs = rows.map(
    (r): BlockingLeg => ({
      transactionId: r.tx.id,
      holdingId: r.tx.holdingId,
      quantity: r.tx.quantity,
      occurredAt: r.tx.occurredAt,
      transferReview: r.tx.transferReview,
      answerSource: r.tx.transferReview === null ? 'none' : answerSourceOf(r.tx),
    })
  );
  return {
    groupId,
    verdict: sameHoldingGroupVerdict(rows.map(toGroupLegFacts)),
    legs,
    answeredLegs: legs.filter((leg) => leg.transferReview !== null),
  };
}

function toGroupLegFacts(row: LegRow): GroupLegFacts {
  return {
    holdingId: row.tx.holdingId,
    source: row.tx.source,
    eventKey: upstreamEventKey(row.tx.source, row.tx.externalId, row.tx.rawPayload),
  };
}

interface LegRow {
  tx: typeof schema.holdingTransactions.$inferSelect;
  symbol: string;
  accountName: string;
  canonicalAssetKey: string | null;
  walletId: string | null;
  chainKey: string | null;
  entityId: string | null;
  destination: string | null;
}

function toLeg(row: LegRow): TransferLeg {
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
