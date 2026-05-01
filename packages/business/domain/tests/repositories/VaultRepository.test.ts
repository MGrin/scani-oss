import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { VaultRepository } from '../../src/repositories/VaultRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// VaultRepository backs the "goals" feature. The attach/detach flow must
// maintain a clean many-to-many mapping, and the counts query must stay
// correct when a vault has zero attached holdings (LEFT JOIN + COALESCE).

const repo = () => Container.get(VaultRepository);

describe('VaultRepository', () => {
  test('findByUser returns only active vaults for the user', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const currency = await makeToken(tx);
      const vault = await repo().create(
        {
          userId: user.id,
          name: 'Emergency fund',
          currencyId: currency.id,
          targetAmount: '1000',
          color: '#333',
        },
        tx
      );
      await repo().create(
        {
          userId: user.id,
          name: 'archived',
          currencyId: currency.id,
          targetAmount: '1000',
          color: '#333',
          isActive: false,
        },
        tx
      );
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.map((r) => r.id)).toEqual([vault.id]);
    });
  });

  test('findByUserWithHoldingsCounts returns 0 for a vault with no holdings', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const currency = await makeToken(tx);
      await repo().create(
        {
          userId: user.id,
          name: 'empty',
          currencyId: currency.id,
          targetAmount: '1000',
          color: '#333',
        },
        tx
      );
      const rows = await repo().findByUserWithHoldingsCounts(user.id, tx);
      expect(rows.length).toBe(1);
      expect(Number(rows[0]!.holdingsCount)).toBe(0);
    });
  });

  test('attachHolding / detachHolding / findVaultsByHoldingId round-trip', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
      });
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const currency = await makeToken(tx);
      const vault = await repo().create(
        {
          userId: user.id,
          name: 'v',
          currencyId: currency.id,
          targetAmount: '1000',
          color: '#333',
        },
        tx
      );
      await repo().attachHolding(vault.id, holding.id, 50, tx);
      let vaultsForHolding = await repo().findVaultsByHoldingId(holding.id, tx);
      expect(vaultsForHolding.map((v) => v.vault.id)).toEqual([vault.id]);

      await repo().detachHolding(vault.id, holding.id, tx);
      vaultsForHolding = await repo().findVaultsByHoldingId(holding.id, tx);
      expect(vaultsForHolding).toEqual([]);
    });
  });

  test('detachAllHoldingsForHolding returns the affected vaultIds', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
      });
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const currency = await makeToken(tx);
      const v1 = await repo().create(
        {
          userId: user.id,
          name: 'v1',
          currencyId: currency.id,
          targetAmount: '1000',
          color: '#333',
        },
        tx
      );
      const v2 = await repo().create(
        {
          userId: user.id,
          name: 'v2',
          currencyId: currency.id,
          targetAmount: '1000',
          color: '#333',
        },
        tx
      );
      await repo().attachHolding(v1.id, holding.id, 50, tx);
      await repo().attachHolding(v2.id, holding.id, 25, tx);

      const vaultIds = await repo().detachAllHoldingsForHolding(holding.id, tx);
      expect(vaultIds.sort()).toEqual([v1.id, v2.id].sort());
      expect(await repo().findVaultsByHoldingId(holding.id, tx)).toEqual([]);
    });
  });

  test('updateHoldingPercentage returns null on no-match, updated row on match', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
      });
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const currency = await makeToken(tx);
      const vault = await repo().create(
        {
          userId: user.id,
          name: 'v',
          currencyId: currency.id,
          targetAmount: '1000',
          color: '#333',
        },
        tx
      );
      expect(await repo().updateHoldingPercentage(vault.id, holding.id, 75, tx)).toBeNull();
      await repo().attachHolding(vault.id, holding.id, 50, tx);
      const updated = await repo().updateHoldingPercentage(vault.id, holding.id, 80, tx);
      expect(updated?.percentage).toBe(80);
    });
  });
});
