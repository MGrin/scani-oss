import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { HoldingTransaction, NewHoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Service } from 'typedi';
import { INFLOW_KINDS, OUTFLOW_KINDS } from '../lib/transfer-matching';

/** An outflow answered `internal` (whole or in part) and one arrival leg of its group. */
export interface AnsweredInternalRow {
  outflowId: string;
  sourceHoldingId: string;
  quantity: string;
  sentAt: Date;
  review: string | null;
  split: unknown;
  arrivalId: string;
  arrivalSource: string;
  arrivalQuantity: string;
  arrivedAt: Date;
  destinationHoldingId: string;
  destinationAccountId: string;
  tokenId: string;
  kind: 'feed' | 'snapshot' | null;
  holdingSource: string;
  /** When "still waiting" asked Review to ask again about this arrival's part (SC-1675 Q4, SC-1684). */
  askAgainAt: string | null;
}

/** The outflow metadata key "still waiting" writes: an instant per destination holding. */
export const TRANSIT_ASK_AGAIN_KEY = 'transitAskAgainAt';

@Service()
export class TransitRepository extends BaseRepository<HoldingTransaction, NewHoldingTransaction> {
  protected readonly table = schema.holdingTransactions;
  protected readonly tableName = 'holding_transactions';

  async findAnsweredInternal(
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<AnsweredInternalRow[]> {
    const outflow = alias(schema.holdingTransactions, 'outflow');
    const arrival = alias(schema.holdingTransactions, 'arrival');
    const rows = await this.getDb(tx)
      .select({
        outflowId: outflow.id,
        sourceHoldingId: outflow.holdingId,
        quantity: outflow.quantity,
        sentAt: outflow.occurredAt,
        review: outflow.transferReview,
        split: outflow.transferReviewSplit,
        arrivalId: arrival.id,
        arrivalSource: arrival.source,
        arrivalQuantity: arrival.quantity,
        arrivedAt: arrival.occurredAt,
        destinationHoldingId: arrival.holdingId,
        destinationAccountId: schema.holdings.accountId,
        tokenId: schema.holdings.tokenId,
        kind: schema.holdings.kind,
        holdingSource: schema.holdings.source,
        askAgainAt: sql<
          string | null
        >`${outflow.sourceMetadata}->${TRANSIT_ASK_AGAIN_KEY}->>(${arrival.holdingId})::text`,
      })
      .from(outflow)
      .innerJoin(
        arrival,
        and(
          eq(arrival.transferGroupId, outflow.transferGroupId),
          eq(arrival.userId, outflow.userId),
          ne(arrival.id, outflow.id),
          inArray(arrival.kind, [...INFLOW_KINDS])
        )
      )
      .innerJoin(schema.holdings, eq(schema.holdings.id, arrival.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .leftJoin(schema.accountTypes, eq(schema.accountTypes.id, schema.accounts.typeId))
      .where(
        and(
          eq(outflow.userId, userId),
          // A debt holding's value leaves P&L once as debtValue, so money
          // travelling into one would count twice (SC-1664, #24146).
          or(isNull(schema.accountTypes.class), ne(schema.accountTypes.class, 'liability')),
          inArray(outflow.kind, [...OUTFLOW_KINDS]),
          isNotNull(outflow.transferGroupId),
          inArray(outflow.transferReview, ['internal', 'split'])
        )
      )
      .orderBy(asc(outflow.occurredAt), asc(outflow.id), asc(arrival.id));
    return rows;
  }
}
