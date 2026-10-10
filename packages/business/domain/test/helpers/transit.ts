import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import { TRANSFER_REVIEW_CREATED_SOURCE } from '@scani/shared';
import { Container } from 'typedi';
import { arrivalMetadata } from '../../src/lib/created-destination';
import { HoldingCacheWriter } from '../../src/services/feeds/HoldingCacheWriter';
import { makeInstitution, makeUser } from './factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
  seedReading,
} from './factories-extra';

/**
 * 500 left a 2000 account for a provider-fed account holding 1000, answered
 * `internal` the way TransferReviewService.writeInflow leaves it (SC-1675).
 * The cash token is the user's base, so every price is 1. `absorb` adds the
 * provider reading that holds the destination at 1000 after the outflow.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
export const ago = (days: number) => new Date(NOW - days * DAY);

export async function travelling(tx: DatabaseTransaction, opts: { sentDaysAgo?: number } = {}) {
  const sentAt = ago(opts.sentDaysAgo ?? 5);
  const cash = await makeToken(tx);
  const user = await makeUser(tx, { baseCurrencyId: cash.id });
  const institutionId = (await makeInstitution(tx)).id;
  const sourceAccount = await makeAccount(tx, { userId: user.id, institutionId });
  const destinationAccount = await makeAccount(tx, { userId: user.id, institutionId });
  const source = await makeHolding(tx, {
    userId: user.id,
    accountId: sourceAccount.id,
    tokenId: cash.id,
    source: 'manual',
    kind: 'snapshot',
  });
  await seedReading(tx, { userId: user.id, holdingId: source.id, balance: '2000', at: ago(10) });
  const destination = await makeHolding(tx, {
    userId: user.id,
    accountId: destinationAccount.id,
    tokenId: cash.id,
    source: 'sync_exchange_balances',
    kind: 'feed',
  });
  await seedReading(tx, {
    userId: user.id,
    holdingId: destination.id,
    balance: '1000',
    at: ago(10),
    authority: 'provider',
  });
  const groupId = randomUUID();
  const outflow = await makeHoldingTransaction(tx, {
    userId: user.id,
    holdingId: source.id,
    kind: 'withdraw',
    quantity: '-500',
    occurredAt: sentAt,
    transferReview: 'internal',
    transferReviewSource: 'user',
    transferGroupId: groupId,
  });
  await makeHoldingTransaction(tx, {
    userId: user.id,
    holdingId: destination.id,
    kind: 'transfer_in',
    quantity: '500',
    occurredAt: sentAt,
    source: TRANSFER_REVIEW_CREATED_SOURCE,
    externalId: outflow.id,
    transferGroupId: groupId,
    inputId: null,
    sourceMetadata: arrivalMetadata({
      outflowTransactionId: outflow.id,
      createdDestination: false,
      movedDestinationAnchor: false,
      outflowAt: sentAt,
    }),
  });
  await Container.get(HoldingCacheWriter).refresh(user.id, [source.id, destination.id], tx);
  return {
    userId: user.id,
    baseId: cash.id,
    outflowId: outflow.id,
    source,
    destination,
    sourceAccount,
    destinationAccount,
    groupId,
  };
}

export async function absorb(
  tx: DatabaseTransaction,
  t: Awaited<ReturnType<typeof travelling>>,
  at: Date = ago(3)
): Promise<void> {
  await seedReading(tx, {
    userId: t.userId,
    holdingId: t.destination.id,
    balance: '1000',
    at,
    authority: 'provider',
  });
}
