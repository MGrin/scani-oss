/**
 * Factory helpers for tables that need more than a single insert to set up
 * (tokens need a token type, accounts need account+institution types, etc.).
 * Kept alongside `factories.ts` so the basic ones stay legible.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { makeInstitution, makeVendor } from './factories';

async function getOrCreateCryptoTokenType(
  tx: DatabaseTransaction
): Promise<typeof schema.tokenTypes.$inferSelect> {
  const existing = await tx.select().from(schema.tokenTypes).limit(1);
  if (existing[0]) return existing[0];
  const [row] = await tx
    .insert(schema.tokenTypes)
    .values({ code: 'crypto', name: 'Crypto' })
    .returning();
  if (!row) throw new Error('tokenTypes insert failed');
  return row;
}

async function getOrCreateAccountType(
  tx: DatabaseTransaction
): Promise<typeof schema.accountTypes.$inferSelect> {
  const existing = await tx.select().from(schema.accountTypes).limit(1);
  if (existing[0]) return existing[0];
  const [row] = await tx
    .insert(schema.accountTypes)
    .values({ code: 'wallet', name: 'Wallet' })
    .returning();
  if (!row) throw new Error('accountTypes insert failed');
  return row;
}

export async function makeToken(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.tokens.$inferInsert> = {}
): Promise<typeof schema.tokens.$inferSelect> {
  let typeId = overrides.typeId;
  if (!typeId) {
    const type = await getOrCreateCryptoTokenType(tx);
    typeId = type.id;
  }
  const [row] = await tx
    .insert(schema.tokens)
    .values({
      // The FULL uuid, not a slice. `tokens` carries a unique constraint on
      // (symbol, type_id, COALESCE(market_segment,'')) and this default is
      // the only thing keeping 127 call sites off each other (SC-230).
      //
      // It was `randomUUID().slice(0, 4).toUpperCase()` — four hex
      // characters, a space of 65,536. Measured against the shared local
      // database on 2026-08-15: 138 surviving `TOK####` rows and 127
      // makeToken call sites gave roughly a 23% chance that some test in a
      // full-suite run collided, plus another ~11% for two calls colliding
      // with each other inside one run.
      //
      // It ratchets, which is why it got worse rather than staying flat: a
      // collision fails a test, a test that fails partway through its
      // fixture does not finish cleaning up, the surviving rows widen the
      // occupied space, and the next run is likelier to collide. Each
      // full-suite run left roughly six more rows behind.
      //
      // The damage was never in the file that failed. `PaymentService`
      // inserts no tokens of its own and still failed on `insert into
      // "tokens"`, on a different test each run, because it was simply the
      // suite holding the seed when the collision landed. Chasing that took
      // eight repeat runs and an import-graph check to rule out.
      symbol: overrides.symbol ?? `TOK${randomUUID().replace(/-/g, '').toUpperCase()}`,
      name: overrides.name ?? 'Test Token',
      typeId,
      isScamProbability: overrides.isScamProbability ?? 0,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('tokens insert failed');
  return row;
}

export async function makeAccount(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.accounts.$inferInsert> & {
    userId: string;
    institutionId: string;
    typeId?: string;
  }
): Promise<typeof schema.accounts.$inferSelect> {
  let typeId = overrides.typeId;
  if (!typeId) {
    const accountType = await getOrCreateAccountType(tx);
    typeId = accountType.id;
  }
  const [row] = await tx
    .insert(schema.accounts)
    .values({
      ...overrides,
      typeId,
      name: overrides.name ?? `Account-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  if (!row) throw new Error('accounts insert failed');
  return row;
}

export async function makeHolding(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.holdings.$inferInsert> & {
    userId: string;
    accountId: string;
    tokenId: string;
  }
): Promise<typeof schema.holdings.$inferSelect> {
  const [row] = await tx
    .insert(schema.holdings)
    .values({
      ...overrides,
      balance: overrides.balance ?? '100',
      source: overrides.source ?? 'manual',
    })
    .returning();
  if (!row) throw new Error('holdings insert failed');
  return row;
}

export async function makeHoldingTransaction(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.holdingTransactions.$inferInsert> & {
    userId: string;
    holdingId?: string;
    tokenId?: string;
    accountId?: string;
  }
): Promise<typeof schema.holdingTransactions.$inferSelect> {
  let holdingId = overrides.holdingId;
  let tokenId = overrides.tokenId;

  if (!holdingId) {
    tokenId = tokenId ?? (await makeToken(tx)).id;
    const accountId =
      overrides.accountId ??
      (
        await makeAccount(tx, {
          userId: overrides.userId,
          institutionId: (await makeInstitution(tx)).id,
        })
      ).id;
    holdingId = (await makeHolding(tx, { userId: overrides.userId, accountId, tokenId })).id;
  } else if (!tokenId) {
    const [holding] = await tx
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId))
      .limit(1);
    if (!holding) throw new Error(`makeHoldingTransaction: holding ${holdingId} not found`);
    tokenId = holding.tokenId;
  }

  const [row] = await tx
    .insert(schema.holdingTransactions)
    .values({
      kind: overrides.kind ?? 'withdraw',
      quantity: overrides.quantity ?? '-1',
      occurredAt: overrides.occurredAt ?? new Date(),
      source: overrides.source ?? 'test-fixture',
      externalId: overrides.externalId ?? randomUUID(),
      ...overrides,
      userId: overrides.userId,
      holdingId,
      tokenId,
    })
    .returning();
  if (!row) throw new Error('holding_transactions insert failed');
  return row;
}

export async function makePayment(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.payments.$inferInsert> & {
    userId: string;
    vendorId?: string;
    currencyTokenId?: string;
  }
): Promise<typeof schema.payments.$inferSelect> {
  const vendorId = overrides.vendorId ?? (await makeVendor(tx, { userId: overrides.userId })).id;
  const currencyTokenId = overrides.currencyTokenId ?? (await makeToken(tx)).id;
  const [row] = await tx
    .insert(schema.payments)
    .values({
      direction: overrides.direction ?? 'outflow',
      kind: overrides.kind ?? 'fixed',
      expectedAmount: overrides.expectedAmount ?? '12.99',
      intervalUnit: overrides.intervalUnit ?? 'month',
      intervalCount: overrides.intervalCount ?? 1,
      anchorDate: overrides.anchorDate ?? '2026-01-01',
      ...overrides,
      userId: overrides.userId,
      vendorId,
      currencyTokenId,
    })
    .returning();
  if (!row) throw new Error('payments insert failed');
  return row;
}

export async function makePaymentOccurrence(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.paymentOccurrences.$inferInsert> & {
    paymentId: string;
    dueDate: string;
  }
): Promise<typeof schema.paymentOccurrences.$inferSelect> {
  const [row] = await tx
    .insert(schema.paymentOccurrences)
    .values({
      status: overrides.status ?? 'scheduled',
      expectedAmount: overrides.expectedAmount ?? null,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('payment_occurrences insert failed');
  return row;
}
