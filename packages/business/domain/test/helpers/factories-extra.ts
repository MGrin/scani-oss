/**
 * Factory helpers for tables that need more than a single insert to set up
 * (tokens need a token type, accounts need account+institution types, etc.).
 * Kept alongside `factories.ts` so the basic ones stay legible.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';

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
      symbol: overrides.symbol ?? `TOK${randomUUID().slice(0, 4).toUpperCase()}`,
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
      userId: overrides.userId,
      institutionId: overrides.institutionId,
      typeId,
      name: overrides.name ?? `Account-${randomUUID().slice(0, 6)}`,
      ...overrides,
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
      userId: overrides.userId,
      accountId: overrides.accountId,
      tokenId: overrides.tokenId,
      balance: overrides.balance ?? '100',
      source: overrides.source ?? 'manual',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('holdings insert failed');
  return row;
}
