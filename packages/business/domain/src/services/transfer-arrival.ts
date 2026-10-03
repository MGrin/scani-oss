import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import Container from 'typedi';
import type { AdoptedBalanceEdit } from '../lib/created-destination';
import { MANUAL_EDIT_FLOW_SOURCE } from '../lib/person-authored-sources';
import {
  BalanceSyncOwnershipService,
  type SyncOwnableAccount,
} from './accounts/BalanceSyncOwnershipService';
import { type BalanceSyncSource, MANUAL_HOLDING_SOURCE } from './holdings/balance-sync-sources';

/**
 * How an arrival written for a transfer meets its destination: the queue's
 * `internal` answer (`TransferReviewService`) and a feed's mirror leg
 * (`MirrorLegWriter`) apply this one rule, so the two cannot come to disagree
 * about what the destination's balance does.
 */

/** How far a typed deposit may sit from the transfer and still be its arrival. */
const TYPED_DEPOSIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function adoptTypedDeposit(
  tx: DatabaseTransaction,
  userId: string,
  holdingId: string,
  tokenId: string,
  quantity: Decimal,
  outflowAt: Date
): Promise<AdoptedBalanceEdit | null> {
  const from = new Date(outflowAt.getTime() - TYPED_DEPOSIT_WINDOW_MS);
  const to = new Date(outflowAt.getTime() + TYPED_DEPOSIT_WINDOW_MS);
  const candidates = await tx
    .select()
    .from(schema.holdingTransactions)
    .where(
      and(
        eq(schema.holdingTransactions.userId, userId),
        eq(schema.holdingTransactions.holdingId, holdingId),
        eq(schema.holdingTransactions.tokenId, tokenId),
        eq(schema.holdingTransactions.source, MANUAL_EDIT_FLOW_SOURCE),
        eq(schema.holdingTransactions.kind, 'deposit'),
        isNull(schema.holdingTransactions.transferGroupId),
        gte(schema.holdingTransactions.occurredAt, from),
        lte(schema.holdingTransactions.occurredAt, to)
      )
    );
  const matching = candidates.filter((row) => new Decimal(row.quantity).eq(quantity));
  // Two typed deposits of the same amount that close are ambiguous; taking
  // either would be a guess about which one the person meant.
  if (matching.length !== 1) return null;
  const row = matching[0]!;
  await tx.delete(schema.holdingTransactions).where(eq(schema.holdingTransactions.id, row.id));
  return {
    holdingId: row.holdingId,
    tokenId: row.tokenId,
    kind: row.kind,
    quantity: row.quantity,
    occurredAt: row.occurredAt.toISOString(),
    source: row.source,
    externalId: row.externalId,
    counterparty: row.counterparty,
    description: row.description,
    sourceMetadata: row.sourceMetadata,
  };
}

export function anchorIsUnobserved(
  holding: { source: string },
  accountSyncSource: BalanceSyncSource | null
): boolean {
  return holding.source === MANUAL_HOLDING_SOURCE || accountSyncSource === null;
}

export async function openingOf(
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
