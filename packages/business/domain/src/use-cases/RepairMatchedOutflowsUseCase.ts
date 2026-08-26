import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { mayBeUserAnswer, unstampedAnswerRefusal } from '@scani/shared';
import Decimal from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { candidatePairClass, MATCH_WINDOW_MS, type TransferLeg } from '../lib/transfer-matching';
import { TransferReviewService } from '../services/TransferReviewService';

/**
 * How far out an arrival is worth SHOWING. Wider than the bound that decides,
 * so a near miss is reported as a refusal rather than vanishing — the 78-minute
 * Polygon arrival in production is real and unproven, and a population that
 * silently excluded it would read as "nothing else to look at".
 */
const CANDIDATE_QTY_EPSILON = new Decimal('0.05');
const CANDIDATE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * How far out an arrival is worth ACTING on.
 *
 * Deliberately 2% where the matcher uses 1%. Two of production's pairs arrive
 * short by a fixed gas cost rather than a percentage — ~0.008 ETH, which is
 * 0.77% of 1.04 and 1.43% of 0.5 — so a 1% bound admits one of a matched pair
 * of identical events and refuses the other. The widening is safe only because
 * of what it sits on top of: one candidate, same asset, same direction, inside
 * the matcher's own 30-minute window.
 */
const REPAIR_QTY_EPSILON = new Decimal('0.02');

/** The arrival a plan would claim, with the facts that justify claiming it. */
export interface MatchedArrival {
  transactionId: string;
  holdingId: string;
  accountName: string;
  quantity: string;
  /** Signed, as a percentage of the departure. Negative means a fee was taken. */
  deltaPct: string;
  gapMinutes: number;
  pairClass: 'same_token' | 'bridged_asset';
}

/**
 * What to do about one `left_control` outflow that has an arrival near it.
 *
 * `blocked` is a first-class outcome, not an error. The 560 rows this repair
 * cleans up were written by a rule that had to produce an answer, and SC-347
 * then spent a ticket undoing 17 transfer groups produced the same way. Where
 * the ledger supports no verdict, saying so is the output.
 */
export interface MatchedOutflowPlan {
  transactionId: string;
  userId: string;
  symbol: string;
  /** Absolute, so the amount reads as the amount that moved. */
  quantity: string;
  occurredAt: Date;
  holdingId: string;
  accountName: string;
  action: 'paired' | 'blocked';
  arrival: MatchedArrival | null;
  blockedReason: string | null;
  /** How many arrivals fell in the wider net. Part of why a plan is blocked. */
  candidateCount: number;
}

/**
 * Answer `paired` on the outflows whose other leg is now in the ledger (SC-328).
 *
 * **What changed under this question.** SC-302 applied mgrin's own rule to 560
 * unattributed `left_control` rows — find the other leg; if the money did not
 * land in another holding, it genuinely left — and could not settle 33. Most of
 * that residue was an artefact of the data rather than the rule: 199 of 287 EVM
 * outflow rows were copies booked on an account that never sent the transaction
 * (SC-331), and the wallets whose history held the arrivals were never
 * imported, because one credential row served three of them. With that fixed
 * the arrivals exist and the rows are answerable.
 *
 * **Why a use case and not a script**, the same reason `RepairOwnWalletDisposals`
 * gives: the derivation is the part that can be wrong about money. Claiming an
 * arrival that is not this money merges two lot chains and moves cost basis
 * across a boundary it never crossed. So it is a service method with tests
 * around it, and the script is a printer.
 *
 * **It never writes an arrival.** Only `paired` is available here — the answer
 * that claims a leg the ledger already holds. `internal` writes one, and for
 * every row this covers the arrival is already imported, so an `internal`
 * answer would count the money twice.
 */
@Service()
export class RepairMatchedOutflowsUseCase {
  private readonly reviewService = Container.get(TransferReviewService);

  /**
   * Every `left_control` outflow with an arrival near it, and what the ledger
   * says to do about each.
   *
   * The population is derived, never passed in: a row is here because it
   * carries the answer that books a disposal TODAY. A caller that knows which
   * ids it expects passes them as an assertion — see
   * `scripts/repair-sc328-matched-outflows.ts`.
   */
  async plansFor(userId: string): Promise<MatchedOutflowPlan[]> {
    const rows = await db
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
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .where(eq(schema.holdingTransactions.userId, userId));

    // An inflow already carrying a `transfer_group_id` is another movement's
    // leg, and `claimInflow` refuses it — so a plan built on one would fail at
    // write time, after earlier rows had already been written.
    const free = rows.filter(
      (r) => new Decimal(r.tx.quantity).gt(0) && r.tx.transferGroupId === null
    );

    const plans: MatchedOutflowPlan[] = [];
    for (const row of rows) {
      if (row.tx.transferReview !== 'left_control') continue;
      if (row.tx.transferGroupId !== null) continue;
      if (row.tx.kind !== 'transfer_out' && row.tx.kind !== 'withdraw') continue;

      const out = toLeg(row);
      const candidates = free
        .map((cand) => ({ row: cand, leg: toLeg(cand) }))
        .filter(({ leg }) => {
          if (candidatePairClass(out, leg) === null) return false;
          // `candidatePairClass` applies this to bridges only, because two
          // vendors' clocks can disagree by a minute about one movement. Here
          // an outflow is being told which arrival it BECAME, so the direction
          // is asserted rather than tolerated.
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
        candidateCount: candidates.length,
      };
      const blocked = (why: string): MatchedOutflowPlan => ({
        ...base,
        action: 'blocked',
        arrival: null,
        blockedReason: why,
      });

      // A person decided this. Overruling a stamped answer is a different act
      // needing a different mandate — the same refusal `RepairSwapLegAnswers`
      // and `RepairProtocolDepositOutflows` already make, stated here so the
      // rule is a property of every repair rather than of the two written
      // after SC-350. `answerSourceOf` rather than a local reading of the two
      // columns, so this refusal and the queue's own attribution cannot drift
      // (SC-606).
      if (mayBeUserAnswer(row.tx)) {
        plans.push(blocked(unstampedAnswerRefusal(row.tx, 'overrule')));
        continue;
      }

      if (candidates.length > 1) {
        plans.push(
          blocked(
            `${candidates.length} arrivals of the same asset within 5% — the ledger cannot say which one this became`
          )
        );
        continue;
      }

      const only = candidates[0];
      if (!only) continue;
      const delta = only.leg.quantityAbs.minus(out.quantityAbs);
      const deltaPct = out.quantityAbs.isZero()
        ? new Decimal(0)
        : delta.div(out.quantityAbs).mul(100);
      const gapMinutes = Math.round(
        (only.leg.occurredAt.getTime() - out.occurredAt.getTime()) / 60000
      );

      if (only.leg.occurredAt.getTime() - out.occurredAt.getTime() > MATCH_WINDOW_MS) {
        plans.push(
          blocked(
            `the only arrival is ${gapMinutes} min later, outside the ${Math.round(MATCH_WINDOW_MS / 60000)}-minute window`
          )
        );
        continue;
      }
      if (delta.abs().gt(out.quantityAbs.mul(REPAIR_QTY_EPSILON))) {
        plans.push(
          blocked(
            `the only arrival is ${deltaPct.toDecimalPlaces(3)}% apart, outside the ${REPAIR_QTY_EPSILON.mul(100)}% bound`
          )
        );
        continue;
      }

      plans.push({
        ...base,
        action: 'paired',
        blockedReason: null,
        arrival: {
          transactionId: only.leg.transactionId,
          holdingId: only.leg.holdingId,
          accountName: only.row.accountName,
          quantity: only.leg.quantityAbs.toString(),
          deltaPct: deltaPct.toDecimalPlaces(3).toString(),
          gapMinutes,
          // Non-null: a candidate that failed this test was filtered out above.
          pairClass: candidatePairClass(out, only.leg) ?? 'same_token',
        },
      });
    }

    plans.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    return plans;
  }

  /**
   * Write one plan: `reopen` then `resolve`, through `TransferReviewService`
   * and never around it, so the group ids and the claimed leg stay that
   * service's business.
   *
   * Throws rather than returning a result. A repair applies a plan that was
   * printed and read first, so a refusal here means the world moved under it,
   * and continuing would leave a half-applied correction nobody chose.
   */
  async apply(plan: MatchedOutflowPlan): Promise<void> {
    if (plan.action === 'blocked' || plan.arrival === null) {
      throw new Error(
        `${plan.transactionId}: refusing to apply a blocked plan — ${plan.blockedReason}`
      );
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
}

function toLeg(row: {
  tx: Pick<
    typeof schema.holdingTransactions.$inferSelect,
    'id' | 'holdingId' | 'tokenId' | 'quantity' | 'occurredAt'
  >;
  canonicalAssetKey: string | null;
  walletId: string | null;
  chainKey: string | null;
  entityId: string | null;
}): TransferLeg {
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
