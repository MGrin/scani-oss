import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import {
  Decimal,
  TRANSFER_REVIEW_CREATED_SOURCE,
  type TransferReviewSplit,
  type TransferReviewSplitPortion,
  type TransitReviewKey,
  transferReviewSplitSchema,
} from '@scani/shared';
import { and, asc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { INFLOW_KINDS } from '../../lib/transfer-matching';
import { replaceTravelledPart } from '../../lib/transit-answer';
import { TRANSIT_RETURNED_KEY } from '../../lib/upstream-event';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { TRANSIT_ASK_AGAIN_KEY } from '../../repositories/TransitRepository';
import { HoldingCacheWriter } from '../feeds/HoldingCacheWriter';
import { TransferReviewService } from '../TransferReviewService';
import { InTransitService, type OpenTransit } from './InTransitService';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long money travels before Review asks about it, and again after "still waiting". */
export const TRANSIT_ASK_AFTER_DAYS = 7;

export interface TransitQuestion {
  outflowId: string;
  sourceHoldingId: string;
  destinationHoldingId: string;
  tokenId: string;
  tokenSymbol: string;
  sourceAccountName: string;
  destinationAccountName: string;
  sentAt: Date;
  quantity: string;
  /** When the question became due: 7 days after it left, or when "still waiting" said to ask again. */
  dueAt: Date;
}

export interface TransitCandidate {
  id: string;
  quantity: string;
  occurredAt: Date;
  source: string;
  counterparty: string | null;
  description: string | null;
}

export type TransitAnswerResult =
  | { ok: true; sentAt: Date }
  | { ok: false; reason: 'gone' | 'not_candidate' | 'refused' };

class Refused extends Error {
  constructor(readonly reason: 'gone' | 'not_candidate' | 'refused') {
    super(reason);
  }
}

/**
 * The day-7 question about a transfer still in transit, and its four answers
 * (SC-1675, #23729, rulings #23848), asked once per destination holding
 * (SC-1684). The money stays counted while it is asked.
 *
 * Every answer but "still waiting" first takes the `internal` answer off the
 * outflow through `TransferReviewService.reopen`, which removes the person's
 * arrival leg and refreshes the destination, then writes the new answer:
 * - **arrived**: paired with the provider's inflow; a shortfall is a fee part.
 * - **lost, or a fee**: answered `left_control` or `fee`.
 * - **came back**: paired with the refund on the source, marked so the
 *   same-holding repair keeps it as the round trip it was.
 *
 * A split whose parts went to several holdings is answered one part at a time
 * instead (`answerPart`): a reopen would rewrite the parts that already arrived.
 */
@Service()
export class TransitReviewService {
  private readonly transits = Container.get(InTransitService);
  private readonly reviews = Container.get(TransferReviewService);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);

  async listDue(
    userId: string,
    now: Date = new Date(),
    tx?: DatabaseTransaction
  ): Promise<TransitQuestion[]> {
    const due = (await this.travellingAt(userId, now, tx)).flatMap(({ open, quantity }) => {
      const dueAt =
        open.askAgainAt ??
        new Date(open.transit.sentAt.getTime() + TRANSIT_ASK_AFTER_DAYS * DAY_MS);
      return dueAt > now ? [] : [{ open, quantity, dueAt }];
    });
    if (due.length === 0) return [];
    const names = await this.names(
      userId,
      due.flatMap(({ open }) => [open.sourceHoldingId, open.destinationHoldingId]),
      tx ?? db
    );
    return due.map(({ open, quantity, dueAt }) => ({
      outflowId: open.outflowId,
      sourceHoldingId: open.sourceHoldingId,
      destinationHoldingId: open.destinationHoldingId,
      tokenId: open.tokenId,
      tokenSymbol: names.get(open.destinationHoldingId)?.symbol ?? '',
      sourceAccountName: names.get(open.sourceHoldingId)?.account ?? '',
      destinationAccountName: names.get(open.destinationHoldingId)?.account ?? '',
      sentAt: open.transit.sentAt,
      quantity,
      dueAt,
    }));
  }

  /** The provider inflows that could be the arrival, and the refunds that could be the money coming back. */
  async candidates(
    userId: string,
    key: TransitReviewKey,
    tx?: DatabaseTransaction
  ): Promise<{ arrivals: TransitCandidate[]; refunds: TransitCandidate[] }> {
    const found = (await this.travellingAt(userId, new Date(), tx)).find((t) =>
      asksAbout(t.open, key)
    );
    if (!found) return { arrivals: [], refunds: [] };
    return this.offered(userId, found.open, tx ?? db);
  }

  async arrived(
    userId: string,
    key: TransitReviewKey,
    inflowId: string,
    tx?: DatabaseTransaction
  ): Promise<TransitAnswerResult> {
    return this.write(tx, async (t) => {
      const open = await this.travelling(userId, key, t);
      const inflow = (await this.offered(userId, open, t)).arrivals.find((r) => r.id === inflowId);
      if (!inflow) throw new Refused('not_candidate');
      const sent = new Decimal(open.transit.sent);
      const arrived = new Decimal(inflow.quantity);
      const fee = { decision: 'fee' as const, quantity: sent.minus(arrived).toString() };
      const outflow = await this.outflow(t, userId, key.outflowId);
      if (severalHoldings(outflow)) {
        // The inflow becomes this part's arrival, as a provider takeover leaves
        // it: a split holds one `paired` part, and each part that arrives needs one.
        await this.answerPart(
          t,
          userId,
          open,
          outflow,
          (travelled) => [{ ...travelled, quantity: arrived.toString() }, fee],
          inflowId
        );
      } else {
        const parts = await this.replaced(t, userId, open, outflow, () => [
          { decision: 'paired', quantity: arrived.toString(), matchTransactionId: inflowId },
          fee,
        ]);
        await this.answerAgain(t, userId, key.outflowId, parts);
      }
      return open.transit.sentAt;
    });
  }

  async lost(
    userId: string,
    key: TransitReviewKey,
    decision: 'fee' | 'left_control',
    tx?: DatabaseTransaction
  ): Promise<TransitAnswerResult> {
    return this.write(tx, async (t) => {
      const open = await this.travelling(userId, key, t);
      const outflow = await this.outflow(t, userId, key.outflowId);
      const replace = (travelled: TransferReviewSplitPortion) => [
        { decision, quantity: travelled.quantity },
      ];
      if (severalHoldings(outflow)) {
        await this.answerPart(t, userId, open, outflow, replace);
      } else {
        const parts = await this.replaced(t, userId, open, outflow, replace);
        await this.answerAgain(t, userId, key.outflowId, parts);
      }
      return open.transit.sentAt;
    });
  }

  async cameBack(
    userId: string,
    key: TransitReviewKey,
    refundId: string,
    tx?: DatabaseTransaction
  ): Promise<TransitAnswerResult> {
    return this.write(tx, async (t) => {
      const open = await this.travelling(userId, key, t);
      const refund = (await this.offered(userId, open, t)).refunds.find((r) => r.id === refundId);
      if (!refund) throw new Refused('not_candidate');
      const outflow = await this.outflow(t, userId, key.outflowId);
      if (severalHoldings(outflow)) {
        await this.answerPart(
          t,
          userId,
          open,
          outflow,
          (travelled) => [
            { decision: 'paired', quantity: travelled.quantity, matchTransactionId: refundId },
          ],
          refundId
        );
        return open.transit.sentAt;
      }
      // A same-holding pair cannot go through `resolve`, which refuses one; and
      // a split would leave the rest of its parts to rewrite by hand.
      if (outflow.transferReview !== 'internal') throw new Refused('refused');
      if (!(await this.reviews.reopen(userId, key.outflowId, t))) throw new Refused('gone');

      const ht = schema.holdingTransactions;
      const groupId = crypto.randomUUID();
      const claimed = await t
        .update(ht)
        .set({ transferGroupId: groupId, updatedAt: sql`now()` })
        .where(and(eq(ht.id, refundId), eq(ht.userId, userId), isNull(ht.transferGroupId)))
        .returning({ id: ht.id });
      if (claimed.length !== 1) throw new Refused('not_candidate');
      await t
        .update(ht)
        .set({
          transferReview: 'paired',
          transferReviewSplit: null,
          transferReviewedAt: sql`now()`,
          transferReviewSource: 'user',
          transferGroupId: groupId,
          sourceMetadata: sql`(coalesce(${ht.sourceMetadata}, '{}'::jsonb) - ${TRANSIT_ASK_AGAIN_KEY}) || jsonb_build_object(${TRANSIT_RETURNED_KEY}::text, ${refundId}::text)`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(ht.id, key.outflowId), eq(ht.userId, userId)));
      await this.ledger.relabelEntries(userId, [key.outflowId, refundId], t);
      await this.cacheWriter.refresh(userId, [open.sourceHoldingId, open.destinationHoldingId], t);
      return open.transit.sentAt;
    });
  }

  async stillWaiting(
    userId: string,
    key: TransitReviewKey,
    now: Date = new Date(),
    tx?: DatabaseTransaction
  ): Promise<TransitAnswerResult> {
    return this.write(tx, async (t) => {
      const open = await this.travelling(userId, key, t, now);
      const askAgainAt = new Date(now.getTime() + TRANSIT_ASK_AFTER_DAYS * DAY_MS).toISOString();
      const ht = schema.holdingTransactions;
      const asked = sql`${ht.sourceMetadata}->${TRANSIT_ASK_AGAIN_KEY}`;
      await t
        .update(ht)
        .set({
          sourceMetadata: sql`coalesce(${ht.sourceMetadata}, '{}'::jsonb) || jsonb_build_object(${TRANSIT_ASK_AGAIN_KEY}::text, (case when jsonb_typeof(${asked}) = 'object' then ${asked} else '{}'::jsonb end) || jsonb_build_object(${key.destinationHoldingId}::text, ${askAgainAt}::text))`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(ht.id, key.outflowId), eq(ht.userId, userId)));
      return open.transit.sentAt;
    });
  }

  private async travellingAt(
    userId: string,
    at: Date,
    tx?: DatabaseTransaction
  ): Promise<{ open: OpenTransit; quantity: string }[]> {
    const open = await this.transits.openTransits(userId, tx);
    if (open.length === 0) return [];
    const amounts = await this.transits.amountsAt(userId, [at], tx);
    const out: { open: OpenTransit; quantity: string }[] = [];
    for (const o of open) {
      const amount = amounts.find(
        (a) => a.outflowId === o.outflowId && a.destinationHoldingId === o.destinationHoldingId
      );
      if (amount) out.push({ open: o, quantity: amount.quantity.toFixed() });
    }
    return out;
  }

  private async travelling(
    userId: string,
    key: TransitReviewKey,
    tx: DatabaseTransaction,
    at: Date = new Date()
  ): Promise<OpenTransit> {
    const found = (await this.travellingAt(userId, at, tx)).find((t) => asksAbout(t.open, key));
    if (!found) throw new Refused('gone');
    return found.open;
  }

  private async offered(
    userId: string,
    open: OpenTransit,
    tx: DatabaseTransaction | typeof db
  ): Promise<{ arrivals: TransitCandidate[]; refunds: TransitCandidate[] }> {
    const ht = schema.holdingTransactions;
    const sent = open.transit.sent;
    const columns = {
      id: ht.id,
      quantity: ht.quantity,
      occurredAt: ht.occurredAt,
      source: ht.source,
      counterparty: ht.counterparty,
      description: ht.description,
    };
    const unclaimed = (holdingId: string) =>
      and(
        eq(ht.userId, userId),
        eq(ht.holdingId, holdingId),
        inArray(ht.kind, [...INFLOW_KINDS]),
        ne(ht.source, TRANSFER_REVIEW_CREATED_SOURCE),
        isNull(ht.transferGroupId),
        gte(ht.occurredAt, open.transit.sentAt)
      );
    const arrivals = await tx
      .select(columns)
      .from(ht)
      .where(
        and(
          unclaimed(open.destinationHoldingId),
          sql`${ht.quantity}::numeric > 0`,
          sql`${ht.quantity}::numeric <= ${sent}::numeric`
        )
      )
      .orderBy(asc(ht.occurredAt), asc(ht.id));
    const refunds = await tx
      .select(columns)
      .from(ht)
      .where(and(unclaimed(open.sourceHoldingId), sql`${ht.quantity}::numeric = ${sent}::numeric`))
      .orderBy(asc(ht.occurredAt), asc(ht.id));
    return { arrivals, refunds };
  }

  private async names(
    userId: string,
    holdingIds: readonly string[],
    tx: DatabaseTransaction | typeof db
  ): Promise<Map<string, { account: string; symbol: string }>> {
    const rows = await tx
      .select({
        id: schema.holdings.id,
        account: schema.accounts.name,
        symbol: schema.tokens.symbol,
      })
      .from(schema.holdings)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
      .where(
        and(
          eq(schema.holdings.userId, userId),
          inArray(schema.holdings.id, [...new Set(holdingIds)])
        )
      );
    return new Map(rows.map((row) => [row.id, { account: row.account, symbol: row.symbol }]));
  }

  private async outflow(
    tx: DatabaseTransaction,
    userId: string,
    outflowId: string
  ): Promise<Outflow> {
    const ht = schema.holdingTransactions;
    const [row] = await tx
      .select({
        transferReview: ht.transferReview,
        transferReviewSplit: ht.transferReviewSplit,
        quantity: ht.quantity,
      })
      .from(ht)
      .where(and(eq(ht.id, outflowId), eq(ht.userId, userId)))
      .for('update');
    if (!row) throw new Refused('gone');
    return row;
  }

  /** The outflow's answer with its travelled part replaced, taken off the outflow. */
  private async replaced(
    tx: DatabaseTransaction,
    userId: string,
    open: OpenTransit,
    outflow: Outflow,
    replace: Replace
  ): Promise<TransferReviewSplit> {
    const parts = travelledPartReplaced(open, outflow, replace);
    if (!(await this.reviews.reopen(userId, open.outflowId, tx))) throw new Refused('gone');
    return parts;
  }

  /**
   * One part of a split that went to several holdings, answered on its own
   * (SC-1684): the split with this part replaced, this destination's person
   * leg deleted, and `claim` (the inflow or refund the part became) joined to
   * the outflow's group. The other parts and their arrivals stay as they are.
   */
  private async answerPart(
    tx: DatabaseTransaction,
    userId: string,
    open: OpenTransit,
    outflow: Outflow,
    replace: Replace,
    claim?: string
  ): Promise<void> {
    const parts = travelledPartReplaced(open, outflow, replace);
    const written = await this.reviews.resolvePart(
      userId,
      open.outflowId,
      open.destinationHoldingId,
      parts,
      { claim, transaction: tx }
    );
    if (!written) throw new Refused('refused');
    const ht = schema.holdingTransactions;
    await tx
      .update(ht)
      .set({
        sourceMetadata: sql`${ht.sourceMetadata} #- array[${TRANSIT_ASK_AGAIN_KEY}::text, ${open.destinationHoldingId}::text]`,
      })
      .where(and(eq(ht.id, open.outflowId), eq(ht.userId, userId)));
    await this.cacheWriter.refresh(userId, [open.sourceHoldingId, open.destinationHoldingId], tx);
  }

  /** The answer `parts` describe, written as the queue would write it. */
  private async answerAgain(
    tx: DatabaseTransaction,
    userId: string,
    outflowId: string,
    parts: TransferReviewSplit
  ): Promise<void> {
    const [only] = parts;
    const result =
      parts.length > 1
        ? await this.reviews.resolveSplit(userId, outflowId, parts, { transaction: tx })
        : only?.decision === 'paired'
          ? await this.reviews.resolve(userId, outflowId, 'paired', {
              matchTransactionId: only.matchTransactionId,
              transaction: tx,
            })
          : only && only.decision !== 'internal'
            ? await this.reviews.resolve(userId, outflowId, only.decision, { transaction: tx })
            : ({ ok: false } as const);
    if (!result.ok) throw new Refused('refused');
    const ht = schema.holdingTransactions;
    await tx
      .update(ht)
      .set({ sourceMetadata: sql`${ht.sourceMetadata} - ${TRANSIT_ASK_AGAIN_KEY}` })
      .where(and(eq(ht.id, outflowId), eq(ht.userId, userId)));
  }

  private async write(
    tx: DatabaseTransaction | undefined,
    fn: (t: DatabaseTransaction) => Promise<Date>
  ): Promise<TransitAnswerResult> {
    try {
      const sentAt = tx ? await tx.transaction(fn) : await db.transaction(fn);
      return { ok: true, sentAt };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, reason: error.reason };
      throw error;
    }
  }
}

interface Outflow {
  transferReview: string | null;
  transferReviewSplit: unknown;
  quantity: string;
}
type Replace = Parameters<typeof replaceTravelledPart>[3];

function asksAbout(open: OpenTransit, key: TransitReviewKey): boolean {
  return open.outflowId === key.outflowId && open.destinationHoldingId === key.destinationHoldingId;
}

/** Whether the outflow is a split whose parts went to more than one holding. */
function severalHoldings(outflow: Outflow): boolean {
  if (outflow.transferReview !== 'split') return false;
  const parsed = transferReviewSplitSchema.safeParse(outflow.transferReviewSplit);
  return parsed.success && parsed.data.filter((part) => part.decision === 'internal').length > 1;
}

function travelledPartReplaced(
  open: OpenTransit,
  outflow: Outflow,
  replace: Replace
): TransferReviewSplit {
  const parts = replaceTravelledPart(
    {
      review: outflow.transferReview,
      split: outflow.transferReviewSplit,
      quantity: outflow.quantity,
    },
    new Decimal(open.transit.sent),
    { accountId: open.destinationAccountId, holdingId: open.destinationHoldingId },
    replace
  );
  if (!parts) throw new Refused('refused');
  return parts;
}
