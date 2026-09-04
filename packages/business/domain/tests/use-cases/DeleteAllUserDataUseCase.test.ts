/**
 * Runs the real flow against a real database, on a user this file creates.
 *
 * The sibling `user-data-deletion-manifest.test.ts` proves every table keyed on
 * `users.id` has been CLASSIFIED. This one proves the classification is true:
 * that a table marked for deletion actually reaches zero, and — the half that
 * makes the first half mean anything — that the tables marked `keep` do NOT.
 * A run in which everything reached zero would satisfy a delete-only assertion
 * and would have destroyed the login the settings copy promises to leave.
 *
 * Seeds are COMMITTED rather than wrapped in `withTestDb`: the use case opens
 * its own transaction on the module-level connection, so a rolled-back outer
 * transaction is invisible to it and every table would read zero for a reason
 * having nothing to do with the flow. Everything is cleaned up in `finally`.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Container } from 'typedi';
import { DeleteAllUserDataUseCase } from '../../src/use-cases/DeleteAllUserDataUseCase';
import { USER_DATA_TABLE_DISPOSITIONS } from '../../src/use-cases/user-data-deletion-manifest';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import {
  makeCredential,
  makeDocument,
  makeDocumentExtraction,
  makeInstitution,
  makeUser,
  makeVendor,
} from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makePayment,
  makePaymentOccurrence,
  makeToken,
} from '../../test/helpers/factories-extra';

restoreContainerAfterAll();

const deletedObjectKeys: string[] = [];

let userId: string;
let seededTokenIds: string[] = [];
let seededInstitutionId: string;
let seededR2Key: string;
/** Per-table counts for this user, taken after the seed and before the run. */
const seededCounts = new Map<string, number>();

/**
 * One row in every table the manifest classifies, so that "it reached zero"
 * and "there was never a row" cannot be confused. Anything the manifest gains
 * later must be seeded here or the assertion below cannot see it — which is
 * why the count of seeded tables is checked against the manifest.
 */
async function seed(tx: DatabaseTransaction): Promise<void> {
  const institution = await makeInstitution(tx);
  seededInstitutionId = institution.id;
  const token = await makeToken(tx);
  const baseToken = await makeToken(tx);
  seededTokenIds = [token.id, baseToken.id];

  // All three of the override triple in one insert: `users_observed_burn_
  // override_complete` refuses an amount with no currency, so a fixture that
  // filled them one statement at a time would fail on the first.
  const user = await makeUser(tx, {
    observedBurnOverride: '1234.56',
    observedBurnOverrideCurrencyId: token.id,
    observedBurnOverrideAt: new Date(),
  });
  userId = user.id;

  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  const holding = await makeHolding(tx, { userId, accountId: account.id, tokenId: token.id });
  await makeHoldingTransaction(tx, { userId, holdingId: holding.id });

  await tx.insert(schema.holdingBalanceObservations).values({
    userId,
    holdingId: holding.id,
    balance: '1',
    observedAt: new Date(),
    source: 'test-fixture',
  });
  await tx.insert(schema.portfolioValueDaily).values({
    userId,
    scopeId: account.id,
    snapshotDate: '2026-01-01',
    baseCurrencyId: baseToken.id,
    totalValue: '1',
    coverageQuality: 'complete',
    holdingsWithKnownValue: 1,
    holdingsTotal: 1,
  });

  const vendor = await makeVendor(tx, { userId });
  const document = await makeDocument(tx, {
    userId,
    r2Key: `documents/${userId}/${randomUUID()}.pdf`,
  });
  seededR2Key = document.r2Key;
  const extraction = await makeDocumentExtraction(tx, {
    documentId: document.id,
    vendorId: vendor.id,
  });
  const payment = await makePayment(tx, { userId, vendorId: vendor.id, currencyTokenId: token.id });
  // The occurrence that makes the ordering load-bearing: `DocumentDeletionService`
  // refuses a document one of these depends on, and this flow must not be able
  // to hit that refusal or to strip the occurrence silently.
  await makePaymentOccurrence(tx, {
    paymentId: payment.id,
    dueDate: '2026-01-01',
    status: 'matched',
    matchedExtractionId: extraction.id,
  });

  await tx.insert(schema.entities).values({ userId, name: `Entity ${randomUUID().slice(0, 6)}` });
  await tx.insert(schema.vaults).values({
    userId,
    name: 'Vault',
    targetAmount: '10',
    currencyId: token.id,
    color: '#000000',
  });
  await tx.insert(schema.groups).values({ userId, name: 'Group', color: '#000000' });
  await tx
    .insert(schema.userWallets)
    .values({ userId, walletAddress: `0x${randomUUID().replace(/-/g, '')}` });
  await tx.insert(schema.holdingExclusions).values({
    userId,
    institutionId: institution.id,
    externalId: 'native',
  });
  await tx.insert(schema.transferReviewRules).values({
    userId,
    matchCounterparty: randomUUID(),
    verdict: 'not_a_disposal',
    note: 'fixture',
  });
  await makeCredential(tx, { userId, institutionId: institution.id });
  await tx.insert(schema.credentialPoolState).values({ userId, institutionId: institution.id });
  await tx
    .insert(schema.alertDeliveries)
    .values({ userId, rule: 'fixture', dedupeKey: randomUUID() });
  await tx.insert(schema.pushSubscriptions).values({
    userId,
    endpoint: `https://push.example/${randomUUID()}`,
    p256dh: 'x',
    auth: 'x',
  });
  await tx.insert(schema.userCostBasisMethodChanges).values({
    userId,
    previousMethod: 'fifo',
    newMethod: 'uk_section_104',
    source: 'user_profile_update',
  });
  await tx
    .insert(schema.userJobs)
    .values({ jobId: randomUUID(), userId, jobName: 'user-data-delete' });

  // Kept and anonymised rows — the controls.
  await tx.insert(schema.userAccounts).values({
    id: randomUUID(),
    accountId: randomUUID(),
    providerId: 'credential',
    userId,
  });
  await tx.insert(schema.userSessions).values({
    id: randomUUID(),
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 86_400_000),
    userId,
  });
  await tx.insert(schema.tokenPriceEditHistory).values({
    tokenId: token.id,
    baseTokenId: baseToken.id,
    newPrice: '1',
    editedByUserId: userId,
  });
  await tx.insert(schema.credentialPoolBorrowLog).values({
    providerKey: 'fixture',
    borrowedFromUserId: userId,
    outcome: 'ok',
  });
}

beforeAll(async () => {
  Container.set(StorageFacade, {
    delete: async (key: string) => {
      deletedObjectKeys.push(key);
    },
  } as unknown as StorageFacade);
  await getDb().transaction(seed);
  for (const entry of USER_DATA_TABLE_DISPOSITIONS) {
    seededCounts.set(getTableConfig(entry.table).name, await rowsNamingUser(entry));
  }
  await Container.get(DeleteAllUserDataUseCase).execute(userId);
});

afterAll(async () => {
  const db = getDb();
  try {
    // RESTRICT on `users.id`, so it blocks the teardown that follows it.
    await db
      .delete(schema.tokenPriceEditHistory)
      .where(eq(schema.tokenPriceEditHistory.editedByUserId, userId));
    await db
      .delete(schema.credentialPoolBorrowLog)
      .where(eq(schema.credentialPoolBorrowLog.providerKey, 'fixture'));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    for (const id of seededTokenIds) await db.delete(schema.tokens).where(eq(schema.tokens.id, id));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, seededInstitutionId));
  } catch {
    // Teardown of a fixture must not turn a red assertion into a red teardown
    // that hides it. The rows are synthetic and the gate database is per-run.
  }
});

async function rowsNamingUser(
  entry: (typeof USER_DATA_TABLE_DISPOSITIONS)[number]
): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(entry.table)
    .where(eq(entry.userColumn, userId));
  return row?.n ?? 0;
}

test('every table the manifest marks for deletion holds nothing for this user', async () => {
  const survivors: string[] = [];
  for (const entry of USER_DATA_TABLE_DISPOSITIONS) {
    if (entry.kind !== 'delete') continue;
    if ((await rowsNamingUser(entry)) > 0) survivors.push(getTableConfig(entry.table).name);
  }
  expect(survivors).toEqual([]);
});

test('every table the manifest marks KEEP still holds this user — the control', async () => {
  // Without this the test above is satisfied by a flow that deleted the
  // account outright, which is the failure mode the promise cares most about.
  const lost: string[] = [];
  for (const entry of USER_DATA_TABLE_DISPOSITIONS) {
    if (entry.kind !== 'keep') continue;
    if ((await rowsNamingUser(entry)) === 0) lost.push(getTableConfig(entry.table).name);
  }
  expect(lost).toEqual([]);
});

test('an anonymised row survives with the user link severed', async () => {
  const [remaining] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.credentialPoolBorrowLog)
    .where(eq(schema.credentialPoolBorrowLog.providerKey, 'fixture'));
  expect(remaining?.n).toBe(1);

  const [named] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.credentialPoolBorrowLog)
    .where(eq(schema.credentialPoolBorrowLog.borrowedFromUserId, userId));
  expect(named?.n).toBe(0);
});

test('the stored object behind the deleted document is removed', async () => {
  expect(deletedObjectKeys).toEqual([seededR2Key]);
});

test('the surviving user row keeps its login and loses the figures on it', async () => {
  const [user] = await getDb().select().from(schema.users).where(eq(schema.users.id, userId));
  expect(user).toBeDefined();
  expect(user?.email).toBeTruthy();
  expect({
    override: user?.observedBurnOverride,
    currency: user?.observedBurnOverrideCurrencyId,
    at: user?.observedBurnOverrideAt,
  }).toEqual({ override: null, currency: null, at: null });
});

test('the seed covered every table the manifest classifies', async () => {
  // The control on this whole file. An unseeded table reads zero after the run
  // for exactly the same reason a correctly-deleted one does, so a delete
  // assertion over a table nobody seeded is vacuous — which is the failure
  // this ticket is an instance of, one level up. This goes red when the
  // manifest grows and the fixture does not.
  const unseeded = USER_DATA_TABLE_DISPOSITIONS.map(
    (entry) => getTableConfig(entry.table).name
  ).filter((name) => (seededCounts.get(name) ?? 0) === 0);
  expect(unseeded).toEqual([]);
});
