import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { Decimal, TRANSFER_REVIEW_CREATED_SOURCE, type UntrackedArrivalKey } from '@scani/shared';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Container, Service } from 'typedi';
import { INFLOW_KINDS, OUTFLOW_KINDS, QTY_MATCH_EPSILON } from '../lib/transfer-matching';
import { TransferReviewService } from './TransferReviewService';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long after the departure an arrival may be dated. */
const UNTRACKED_ARRIVAL_WINDOW_DAYS = 7;
/** `source_metadata` key on the outflow: arrivals the owner said were not it, by inflow id. */
const UNTRACKED_ARRIVAL_DECLINED_KEY = 'untrackedArrivalDeclined';

export interface UntrackedArrivalQuestion {
  outflowId: string;
  inflowId: string;
  tokenSymbol: string;
  /** What left, unsigned. */
  quantity: string;
  /** What arrived, unsigned; within 1% of what left. */
  arrivedQuantity: string;
  sourceAccountName: string;
  destinationAccountName: string;
  sentAt: Date;
  arrivedAt: Date;
}

export type UntrackedArrivalAnswerResult =
  | { ok: true; sentAt: Date }
  | { ok: false; reason: 'gone' | 'refused' };

class Refused extends Error {
  constructor(readonly reason: 'gone' | 'refused') {
    super(reason);
  }
}

/**
 * "Was this the transfer to <account>?" (SC-1696).
 *
 * The matcher never revisits an answered outflow, and that rule stands: a
 * nightly run must not quietly un-answer a person. But `untracked` says the
 * money went to "an account Scani can't see", and an arrival of the same
 * amount in an account Scani does see is evidence against exactly that. So
 * Review asks once, and the answer stays `untracked` until the owner says yes.
 *
 * Asked only when the evidence is unanimous: one arrival fits the outflow, and
 * that arrival fits no other untracked outflow. Same token row, a different
 * holding, within 1% (a fee), dated at or after the departure and at most 7
 * days later.
 */
@Service()
export class UntrackedArrivalReviewService {
  private readonly reviews = Container.get(TransferReviewService);

  async listDue(userId: string, tx?: DatabaseTransaction): Promise<UntrackedArrivalQuestion[]> {
    return this.questions(userId, tx ?? db);
  }

  /** Yes: the outflow is paired with the arrival, through the queue's own `paired` answer. */
  async confirm(
    userId: string,
    key: UntrackedArrivalKey,
    tx?: DatabaseTransaction
  ): Promise<UntrackedArrivalAnswerResult> {
    return this.write(tx, async (t) => {
      const question = await this.asked(userId, key, t);
      if (!(await this.reviews.reopen(userId, key.outflowId, t))) throw new Refused('gone');
      const result = await this.reviews.resolve(userId, key.outflowId, 'paired', {
        matchTransactionId: key.inflowId,
        transaction: t,
      });
      if (!result.ok) throw new Refused('refused');
      return question.sentAt;
    });
  }

  /** No: the `untracked` answer stands, and this arrival is never offered for it again. */
  async decline(
    userId: string,
    key: UntrackedArrivalKey,
    tx?: DatabaseTransaction
  ): Promise<UntrackedArrivalAnswerResult> {
    return this.write(tx, async (t) => {
      const question = await this.asked(userId, key, t);
      const ht = schema.holdingTransactions;
      const declined = sql`${ht.sourceMetadata}->${UNTRACKED_ARRIVAL_DECLINED_KEY}`;
      await t
        .update(ht)
        .set({
          sourceMetadata: sql`coalesce(${ht.sourceMetadata}, '{}'::jsonb) || jsonb_build_object(${UNTRACKED_ARRIVAL_DECLINED_KEY}::text, (case when jsonb_typeof(${declined}) = 'object' then ${declined} else '{}'::jsonb end) || jsonb_build_object(${key.inflowId}::text, now()))`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(ht.id, key.outflowId), eq(ht.userId, userId)));
      return question.sentAt;
    });
  }

  /** The question `key` names, if it is still asked; the outflow row is locked for the answer. */
  private async asked(
    userId: string,
    key: UntrackedArrivalKey,
    tx: DatabaseTransaction
  ): Promise<UntrackedArrivalQuestion> {
    const ht = schema.holdingTransactions;
    await tx
      .select({ id: ht.id })
      .from(ht)
      .where(and(eq(ht.id, key.outflowId), eq(ht.userId, userId)))
      .for('update');
    const question = (await this.questions(userId, tx)).find(
      (q) => q.outflowId === key.outflowId && q.inflowId === key.inflowId
    );
    if (!question) throw new Refused('gone');
    return question;
  }

  private async questions(
    userId: string,
    tx: DatabaseTransaction | typeof db
  ): Promise<UntrackedArrivalQuestion[]> {
    const out = alias(schema.holdingTransactions, 'out');
    const arrival = alias(schema.holdingTransactions, 'arrival');
    const outHolding = alias(schema.holdings, 'out_holding');
    const arrivalHolding = alias(schema.holdings, 'arrival_holding');
    const outAccount = alias(schema.accounts, 'out_account');
    const arrivalAccount = alias(schema.accounts, 'arrival_account');
    const windowMs = UNTRACKED_ARRIVAL_WINDOW_DAYS * DAY_MS;

    const pairs = await tx
      .select({
        outflowId: out.id,
        inflowId: arrival.id,
        tokenSymbol: schema.tokens.symbol,
        quantity: out.quantity,
        arrivedQuantity: arrival.quantity,
        sourceAccountName: outAccount.name,
        destinationAccountName: arrivalAccount.name,
        sentAt: out.occurredAt,
        arrivedAt: arrival.occurredAt,
      })
      .from(out)
      .innerJoin(
        arrival,
        and(
          eq(arrival.userId, out.userId),
          eq(arrival.tokenId, out.tokenId),
          ne(arrival.holdingId, out.holdingId),
          inArray(arrival.kind, [...INFLOW_KINDS]),
          isNull(arrival.transferGroupId),
          ne(arrival.source, TRANSFER_REVIEW_CREATED_SOURCE),
          sql`${arrival.occurredAt} >= ${out.occurredAt}`,
          sql`extract(epoch from ${arrival.occurredAt} - ${out.occurredAt}) * 1000 <= ${windowMs}`,
          sql`abs(abs(${arrival.quantity}::numeric) - abs(${out.quantity}::numeric)) <= abs(${out.quantity}::numeric) * ${QTY_MATCH_EPSILON.toString()}::numeric`,
          sql`not coalesce(${out.sourceMetadata}->${UNTRACKED_ARRIVAL_DECLINED_KEY} ? ${arrival.id}::text, false)`
        )
      )
      .innerJoin(schema.tokens, eq(schema.tokens.id, out.tokenId))
      .innerJoin(outHolding, eq(outHolding.id, out.holdingId))
      .innerJoin(outAccount, eq(outAccount.id, outHolding.accountId))
      .innerJoin(arrivalHolding, eq(arrivalHolding.id, arrival.holdingId))
      .innerJoin(arrivalAccount, eq(arrivalAccount.id, arrivalHolding.accountId))
      .where(
        and(
          eq(out.userId, userId),
          inArray(out.kind, [...OUTFLOW_KINDS]),
          eq(out.transferReview, 'untracked'),
          isNull(out.transferGroupId),
          sql`${out.quantity}::numeric <> 0`
        )
      );

    // Unanimous only: an outflow two arrivals fit, or an arrival two outflows
    // fit, is a guess, and a guess is the review queue's to offer, not this.
    const perOutflow = countBy(pairs, (p) => p.outflowId);
    const perInflow = countBy(pairs, (p) => p.inflowId);
    return pairs
      .filter((p) => perOutflow.get(p.outflowId) === 1 && perInflow.get(p.inflowId) === 1)
      .map((p) => ({
        ...p,
        quantity: new Decimal(p.quantity).abs().toFixed(),
        arrivedQuantity: new Decimal(p.arrivedQuantity).abs().toFixed(),
      }))
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  private async write(
    tx: DatabaseTransaction | undefined,
    fn: (t: DatabaseTransaction) => Promise<Date>
  ): Promise<UntrackedArrivalAnswerResult> {
    try {
      const sentAt = tx ? await tx.transaction(fn) : await db.transaction(fn);
      return { ok: true, sentAt };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, reason: error.reason };
      throw error;
    }
  }
}

function countBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return counts;
}
