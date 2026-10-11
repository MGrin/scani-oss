import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HouseholdViewService } from '../../../src/services/household/HouseholdViewService';
import { HouseholdError } from '../../../src/services/household/household-errors';
import { AssetAllocationService } from '../../../src/services/portfolio/AssetAllocationService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeToken,
  makeWallet,
} from '../../../test/helpers/factories-extra';

const view = new HouseholdViewService();
const AN_HOUR_AGO = () => new Date(Date.now() - 3_600_000);

async function household(tx: DatabaseTransaction, baseCurrencyId: string, members: string[]) {
  const [admin, ...rest] = members;
  const [row] = await tx
    .insert(schema.households)
    .values({ name: 'Home', baseCurrencyId, createdBy: admin ?? null })
    .returning();
  const householdId = row?.id ?? '';
  if (admin) {
    await tx.insert(schema.householdMembers).values({ householdId, userId: admin, role: 'admin' });
  }
  for (const userId of rest) {
    await tx.insert(schema.householdMembers).values({ householdId, userId, role: 'member' });
  }
  return householdId;
}

async function share(
  tx: DatabaseTransaction,
  householdId: string,
  accountId: string,
  owner: string
) {
  await tx.insert(schema.accountShares).values({ accountId, householdId, sharedBy: owner });
}

async function price(tx: DatabaseTransaction, tokenId: string, baseTokenId: string, value: string) {
  await tx.insert(schema.tokenPrices).values({
    tokenId,
    baseTokenId,
    price: value,
    timestamp: AN_HOUR_AGO(),
    source: 'test',
    granularity: 'intraday',
  });
}

async function world(tx: DatabaseTransaction) {
  const usd = await makeToken(tx);
  const eur = await makeToken(tx);
  const coin = await makeToken(tx);
  await price(tx, coin.id, usd.id, '100');
  await price(tx, coin.id, eur.id, '90');
  const alice = await makeUser(tx, { name: 'Alice', baseCurrencyId: usd.id });
  const bob = await makeUser(tx, { name: 'Bob', baseCurrencyId: eur.id });
  const institution = await makeInstitution(tx);
  const account = (userId: string, name: string, metadata: Record<string, unknown> = {}) =>
    makeAccount(tx, { userId, institutionId: institution.id, name, metadata });
  const hold = (userId: string, accountId: string, balance: string) =>
    makeHolding(tx, { userId, accountId, tokenId: coin.id, balance });
  return { usd, eur, coin, alice, bob, institution, account, hold };
}

describe('HouseholdViewService.now (SC-1647)', () => {
  test('one member sharing everything sees exactly their own net worth and allocation', async () => {
    await withTestDb(async (tx) => {
      const { usd, alice, account, hold } = await world(tx);
      const householdId = await household(tx, usd.id, [alice.id]);
      const a1 = await account(alice.id, 'A1');
      const a2 = await account(alice.id, 'A2');
      await hold(alice.id, a1.id, '2');
      await hold(alice.id, a2.id, '3');
      await share(tx, householdId, a1.id, alice.id);
      await share(tx, householdId, a2.id, alice.id);

      const at = new Date();
      const result = await view.now(alice.id, 'token_type', { at, tx });

      const own = await Container.get(PortfolioValuationService).computePortfolioValueAt(alice.id, {
        at,
        tx,
      });
      const holdings = await Container.get(HoldingRepository).findByUserWithFullDetails(
        alice.id,
        undefined,
        tx
      );
      const ownAllocation = await Container.get(AssetAllocationService).calculateFromFetchedData(
        alice.id,
        'token_type',
        own,
        holdings
      );
      expect(result.total).toBe(own.totalValue);
      expect(result.total).toBe('500');
      expect(result.allocation).toEqual(ownAllocation.items);
      expect(result.baseCurrencyId).toBe(usd.id);
      expect(result.baseCurrencySymbol).toBe(usd.symbol);
    });
  });

  test('an unshared account changes nothing, and the account list carries owners and values', async () => {
    await withTestDb(async (tx) => {
      const { usd, alice, bob, account, hold, institution } = await world(tx);
      const householdId = await household(tx, usd.id, [alice.id, bob.id]);
      const shared = await account(alice.id, 'Shared');
      const hidden = await account(alice.id, 'Private');
      await hold(alice.id, shared.id, '2');
      await hold(alice.id, hidden.id, '50');
      await share(tx, householdId, shared.id, alice.id);

      const result = await view.now(bob.id, 'token_type', { tx });
      expect(result.total).toBe('200');
      expect(result.accounts).toEqual([
        {
          accountId: shared.id,
          name: 'Shared',
          institutionName: institution.name,
          ownerId: alice.id,
          ownerName: 'Alice',
          ownedByViewer: false,
          value: '200',
        },
      ]);
      expect(result.trackedTwice).toEqual([]);
    });
  });

  test('two members in different base currencies sum in the household currency', async () => {
    await withTestDb(async (tx) => {
      const { usd, alice, bob, account, hold } = await world(tx);
      const householdId = await household(tx, usd.id, [alice.id, bob.id]);
      const a1 = await account(alice.id, 'A1');
      const b1 = await account(bob.id, 'B1');
      await hold(alice.id, a1.id, '2');
      await hold(bob.id, b1.id, '3');
      await share(tx, householdId, a1.id, alice.id);
      await share(tx, householdId, b1.id, bob.id);

      const result = await view.now(alice.id, 'token_type', { tx });
      // Bob's own base is EUR (90 a coin); the household values his coins in USD.
      expect(result.total).toBe('500');
      expect(result.accounts.map((row) => [row.name, row.value])).toEqual([
        ['A1', '200'],
        ['B1', '300'],
      ]);
      expect(result.allocation.map((item) => item.value)).toEqual(['500']);
    });
  });

  test('the same account tracked by two members is named, by name or by wallet', async () => {
    await withTestDb(async (tx) => {
      const { usd, alice, bob, account, institution } = await world(tx);
      const householdId = await household(tx, usd.id, [alice.id, bob.id]);
      const aliceJoint = await account(alice.id, 'Joint');
      const bobJoint = await account(bob.id, 'joint');
      const aliceWallet = await makeWallet(tx, { userId: alice.id, institutionId: institution.id });
      const bobWallet = await makeWallet(
        tx,
        { userId: bob.id, institutionId: institution.id },
        { walletAddress: aliceWallet.walletAddress }
      );
      const aliceChain = await account(alice.id, 'Alice ETH', { userWalletId: aliceWallet.id });
      const bobChain = await account(bob.id, 'Bob ETH', { userWalletId: bobWallet.id });
      for (const row of [aliceJoint, aliceChain]) await share(tx, householdId, row.id, alice.id);
      for (const row of [bobJoint, bobChain]) await share(tx, householdId, row.id, bob.id);

      const { trackedTwice } = await view.now(alice.id, 'token_type', { tx });
      const pairs = trackedTwice.map((pair) => ({
        reason: pair.reason,
        ids: [...pair.accountIds].sort(),
      }));
      expect(pairs).toHaveLength(2);
      expect(pairs).toContainEqual({
        reason: 'same-name',
        ids: [aliceJoint.id, bobJoint.id].sort(),
      });
      expect(pairs).toContainEqual({
        reason: 'same-wallet',
        ids: [aliceChain.id, bobChain.id].sort(),
      });
    });
  });

  test('a user in no household is refused', async () => {
    await withTestDb(async (tx) => {
      const { alice } = await world(tx);
      const refusal = await view
        .now(alice.id, 'token_type', { tx })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(HouseholdError);
      expect((refusal as HouseholdError).code).toBe('no-household');
    });
  });
});
