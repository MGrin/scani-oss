import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { answerSourceOf } from '@scani/shared';
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { OUTFLOW_KINDS } from '../lib/transfer-matching';
import { TransferReviewService } from '../services/TransferReviewService';

/** What to do about one row carrying an answer to a question it is not asked. */
export interface SwapLegAnswerPlan {
  transactionId: string;
  userId: string;
  symbol: string;
  /** Absolute, so the amount reads as the amount that moved. */
  quantity: string;
  occurredAt: Date;
  holdingId: string;
  accountName: string;
  kind: string;
  /** The answer being withdrawn — the thing that should not be there. */
  answer: string;
  /** Etherscan's ABI decode, restated as the evidence that this is a swap. */
  functionName: string | null;
  action: 'clear' | 'blocked';
  blockedReason: string | null;
}

/**
 * Withdraw the `transfer_review` answers that sit on rows the review queue
 * cannot ask about (SC-338).
 *
 * **How the state arises, and why no migration was needed to create it.**
 * SC-332 taught the EVM ingester to write a swap as two linked legs and #934
 ***REMOVED***
 * `price_native*` and `swap_group_id` through `ON CONFLICT`, so the backfill
 * this ticket was filed to do happened on its own — measured on production
 ***REMOVED***
 * `swap_group_id` and a price, and none is unpriced. `transfer_review` is
 * deliberately ABSENT from that conflict list, because it belongs to a person.
 ***REMOVED***
 * now `swap_out` and still carry the answer.
 *
 * **What that answer did, and why this repair ran.** Nothing to the books, and
 * something to the screen. `CostBasisService.walkComponent` tests
 * `OUTFLOW_SELL_KINDS` before `OUTFLOW_NEUTRAL_KINDS` and the sell branch
 * never reads `transferReview`, so a `swap_out` realizes on its kind alone;
 * `pendingPredicate`, `listAnswered`, `ruleWritablePredicate` and
 * `bulkClassify` all restrict `kind` to `OUTFLOW_KINDS`, so the row is on no
 * review surface either. `disposalAnswerSourceOf` was the one reader with no
 * kind gate: it returned `unattributed` for any answered row with no stamp,
 * and `RealizedLedger` rendered that as an "Answer not recorded" badge plus
 * *"Recorded as having left your portfolio, so this gain was booked. There is
 * no record of anyone answering it."* On a DEX swap both halves are false —
 * the gain was booked because it is a swap, and no answer is owed. Six wrong
 * sentences on a money screen was the whole harm, and the whole reason for
 * this repair: realized PnL did not move by a cent.
 *
 * **That sentence can no longer be printed** (SC-402). The kind gate is now in
 * `disposalAnswerSourceOf` and in the ledger's own copy, so a swap leg carrying
 * an answer renders silence whether or not this repair has run over it. What
 * remains here is the data half — a row still carrying an answer to a question
 * nobody asks about it — which is worth withdrawing on its own terms and is
 * the only thing a reader of `holding_transactions` can see. The repair was
 * never the containment; it stopped being the only thing standing between the
 * state and the screen.
 *
 * **The population is derived, never listed.** Any row carrying an answer
 * whose `kind` is outside `OUTFLOW_KINDS` is in this shape, whatever produced
 * it, so the next re-import that recognises another swap is covered without
 * editing anything. A caller that knows which ids it expects passes them as an
 * assertion — see `scripts/repair-sc338-swap-leg-answers.ts`.
 *
 * **Why a use case and not a script**, the reason `RepairMatchedOutflows` and
 * `RepairProtocolDepositOutflows` both give: the derivation is the part that
 * can be wrong about money, so it is a service method with tests around it and
 * the script is a printer.
 */
@Service()
export class RepairSwapLegAnswersUseCase {
  private readonly reviewService = Container.get(TransferReviewService);

  async plansFor(userId: string): Promise<SwapLegAnswerPlan[]> {
    const rows = await db
      .select({
        tx: schema.holdingTransactions,
        symbol: schema.tokens.symbol,
        accountName: schema.accounts.name,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          isNotNull(schema.holdingTransactions.transferReview),
          notInArray(schema.holdingTransactions.kind, [...OUTFLOW_KINDS])
        )
      )
      .orderBy(schema.holdingTransactions.occurredAt);

    return rows.map(({ tx, symbol, accountName }) => ({
      transactionId: tx.id,
      userId: tx.userId,
      symbol,
      quantity: tx.quantity.replace(/^-/, ''),
      occurredAt: tx.occurredAt,
      holdingId: tx.holdingId,
      accountName,
      kind: tx.kind,
      answer: tx.transferReview ?? '',
      functionName: functionNameOf(tx.rawPayload),
      ...verdict(tx),
    }));
  }

  async apply(plan: SwapLegAnswerPlan): Promise<void> {
    if (plan.action !== 'clear') {
      throw new Error(`${plan.transactionId}: refusing to apply a '${plan.action}' plan`);
    }
    const result = await this.reviewService.clearInapplicableAnswer(
      plan.userId,
      plan.transactionId
    );
    if (!result.ok) {
      throw new Error(`${plan.transactionId}: clearInapplicableAnswer failed — ${result.reason}`);
    }
  }
}

/**
 * The refusals, in the order the evidence narrows them.
 *
 * Every one is a `blocked` rather than a skip: a row that carries an answer to
 * a question nobody asks and is NOT repaired is exactly what a reader needs to
 * see before running `--commit`.
 */
function verdict(
  tx: typeof schema.holdingTransactions.$inferSelect
): Pick<SwapLegAnswerPlan, 'action' | 'blockedReason'> {
  const blocked = (why: string) => ({ action: 'blocked' as const, blockedReason: why });

  // A person decided this, about a row that was an answerable outflow when
  // they decided. Withdrawing it silently would delete a judgement, and the
  // fact that the question has since stopped applying is a thing to tell them
  // rather than a mandate to act for them. `answerSourceOf` rather than a local
  // reading of the two columns, so this refusal and the queue's own attribution
  // can never drift apart (SC-350).
  if (answerSourceOf(tx) === 'user') {
    return blocked('answered by a person — this repair does not withdraw a stamped answer');
  }
  // Lots carry across a group id, so an answer beside one is doing work.
  // `reopen` is the operation that unwinds that, and it is a different one.
  if (tx.transferGroupId !== null) {
    return blocked(`carries transfer_group_id ${tx.transferGroupId} — use reopen, not this`);
  }
  if (tx.transferReviewSplit !== null) {
    return blocked('carries a split answer, which this repair cannot withdraw in part');
  }
  // The swap linkage IS the reason the answer no longer applies. A `swap_out`
  // with no `swap_group_id` is a half-recognised row, and the honest reading of
  // it is that the ingester is mid-repair rather than that the answer is stale.
  if (isSwapKind(tx.kind) && tx.swapGroupId === null) {
    return blocked('swap leg carries no swap_group_id — the linkage is not there to rely on');
  }
  return { action: 'clear', blockedReason: null };
}

function isSwapKind(kind: string): boolean {
  return kind === 'swap_in' || kind === 'swap_out';
}

function functionNameOf(raw: unknown): string | null {
  const value = (raw as { functionName?: unknown } | null)?.functionName;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
