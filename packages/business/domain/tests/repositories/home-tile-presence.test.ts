import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { AccountRepository } from '../../src/repositories/AccountRepository';
import { GroupRepository } from '../../src/repositories/GroupRepository';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { VaultRepository } from '../../src/repositories/VaultRepository';
import { GainsByWrapperService } from '../../src/services/portfolio/GainsByWrapperService';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

// SC-1773: the overview's `presence` probes. Home leaves a tile out when its
// probe says false, so false must mean the tile's own query finds nothing.

const groups = new GroupRepository();
const vaults = new VaultRepository();
const accounts = new AccountRepository();
const transactions = new HoldingTransactionRepository();

async function world(tx: DatabaseTransaction) {
  const usd = await makeToken(tx);
  const user = await makeUser(tx, { baseCurrencyId: usd.id });
  const other = await makeUser(tx, { baseCurrencyId: usd.id });
  const institution = await makeInstitution(tx);
  const typeId = async (code: string) => {
    const [row] = await tx
      .select({ id: schema.accountTypes.id })
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, code));
    if (!row) throw new Error(`account type ${code} not seeded`);
    return row.id;
  };
  return { usd, user, other, institution, typeId };
}

describe('home tile presence probes', () => {
  test('groups: only an active group of this user counts', async () => {
    await withTestDb(async (tx) => {
      const { user, other } = await world(tx);
      const insert = (userId: string, isActive: boolean) =>
        tx.insert(schema.groups).values({
          userId,
          name: `g-${isActive}`,
          color: '#22c55e',
          isActive,
        });
      await insert(other.id, true);
      await insert(user.id, false);
      expect(await groups.hasActiveForUser(user.id, tx)).toBe(false);
      await insert(user.id, true);
      expect(await groups.hasActiveForUser(user.id, tx)).toBe(true);
    });
  });

  test('vaults: only an active vault of this user counts', async () => {
    await withTestDb(async (tx) => {
      const { usd, user, other } = await world(tx);
      const insert = (userId: string, isActive: boolean) =>
        tx.insert(schema.vaults).values({
          userId,
          name: `v-${isActive}`,
          targetAmount: '100',
          currencyId: usd.id,
          color: '#22c55e',
          isActive,
        });
      await insert(other.id, true);
      await insert(user.id, false);
      expect(await vaults.hasActiveForUser(user.id, tx)).toBe(false);
      await insert(user.id, true);
      expect(await vaults.hasActiveForUser(user.id, tx)).toBe(true);
    });
  });

  test('wrapped: agrees with GainsByWrapperService.anyWrapped', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, typeId } = await world(tx);
      const gains = new GainsByWrapperService();
      const window = { kind: '1y' as const };
      const anyWrapped = async () =>
        (await gains.compute(user.id, window, new Date(), tx)).anyWrapped;

      await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        typeId: await typeId('investment'),
        wrapper: null,
      });
      expect(await accounts.hasWrappedAssetAccount(user.id, tx)).toBe(false);
      expect(await anyWrapped()).toBe(false);

      await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        typeId: await typeId('investment'),
        wrapper: 'isa',
      });
      expect(await accounts.hasWrappedAssetAccount(user.id, tx)).toBe(true);
      expect(await anyWrapped()).toBe(true);
    });
  });

  test('income: an income row on a counted holding, and nothing else', async () => {
    await withTestDb(async (tx) => {
      const { user, institution } = await world(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const closed = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        isActive: false,
      });

      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        ledgerKind: 'fee',
      });
      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: closed.id,
        ledgerKind: 'income',
      });
      expect(await transactions.hasIncomeForUser(user.id, tx)).toBe(false);

      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        ledgerKind: 'income',
      });
      expect(await transactions.hasIncomeForUser(user.id, tx)).toBe(true);
    });
  });
});
