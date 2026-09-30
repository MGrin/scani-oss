import { describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
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
      // Strict, and without a `Number()` around it: the count is declared a
      // number, so an uncast bigint arriving as `"0"` must fail here (SC-88).
      expect(rows[0]!.holdingsCount).toBe(0);
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

test('allocation edits reject totals above 100 and foreign holdings without changing the existing share', async () => {
  await withTestDb(async (tx) => {
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = await makeToken(tx);
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
    });
    const first = await repo().create(
      { userId: user.id, name: 'first', currencyId: token.id, targetAmount: '100', color: '#333' },
      tx
    );
    const second = await repo().create(
      { userId: user.id, name: 'second', currencyId: token.id, targetAmount: '100', color: '#333' },
      tx
    );
    await repo().attachHolding(first.id, holding.id, 60, tx);
    await expect(repo().attachHolding(second.id, holding.id, 41, tx)).rejects.toThrow('100%');
    await repo().attachHolding(second.id, holding.id, 40, tx);
    await expect(repo().updateHoldingPercentage(first.id, holding.id, 61, tx)).rejects.toThrow(
      '100%'
    );
    expect(
      (await repo().findVaultsByHoldingId(holding.id, tx)).map((r) => r.percentage).sort()
    ).toEqual([40, 60]);
    const other = await makeUser(tx);
    const foreign = await repo().create(
      {
        userId: other.id,
        name: 'foreign',
        currencyId: token.id,
        targetAmount: '100',
        color: '#333',
      },
      tx
    );
    await expect(repo().attachHolding(foreign.id, holding.id, 1, tx)).rejects.toThrow(
      'Holding not found'
    );
  });
});

test('fractional totals, legacy precision, atomic batches and concurrent writers share one allocation limit', async () => {
  const db = getDb();
  const fixture = await db.transaction(async (tx) => {
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = await makeToken(tx);
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
    });
    const second = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      label: 'second',
    });
    const vaults = [];
    for (const name of ['one', 'two', 'three', 'four'])
      vaults.push(
        await repo().create(
          { userId: user.id, name, currencyId: token.id, targetAmount: '100', color: '#333' },
          tx
        )
      );
    return { user, institution, token, holding, second, vaults };
  });
  const { user, holding, second, vaults } = fixture;
  const [one, two, three, four] = vaults;
  try {
    await repo().attachHolding(one!.id, holding.id, 25.1);
    await repo().setAllocations(user.id, two!.id, [{ holdingId: holding.id, percentage: 74.9 }]);
    expect((await repo().findVaultsByHoldingId(holding.id)).length).toBe(2);
    // New inputs take at most two decimals (bus #17236); 33.334 is refused as
    // an input even though legacy rows below may hold it.
    await expect(repo().attachHolding(three!.id, second.id, 33.334)).rejects.toThrow(
      'between 0 and 100%'
    );
    expect(await repo().findVaultsByHoldingId(second.id)).toEqual([]);
    await expect(
      repo().setAllocations(user.id, three!.id, [
        { holdingId: second.id, percentage: 20 },
        { holdingId: holding.id, percentage: 0.01 },
      ])
    ).rejects.toThrow('100%');
    expect(await repo().findVaultsByHoldingId(second.id)).toEqual([]);
    await expect(
      repo().setAllocations(user.id, three!.id, [
        { holdingId: second.id, percentage: 20 },
        { holdingId: crypto.randomUUID(), percentage: 20 },
      ])
    ).rejects.toThrow('Holding not found');
    expect(await repo().findVaultsByHoldingId(second.id)).toEqual([]);
    await repo().detachAllHoldingsForHolding(holding.id);
    await db.insert(schema.vaultHoldings).values(
      [one!, two!, three!].map((vault) => ({
        vaultId: vault.id,
        holdingId: holding.id,
        percentage: 33.334,
      }))
    );
    await expect(
      repo().setAllocations(user.id, four!.id, [{ holdingId: holding.id, percentage: 0.01 }])
    ).rejects.toThrow('100%');
    expect(
      (await repo().findVaultsByHoldingId(holding.id)).every((row) => row.percentage > 33.33)
    ).toBe(true);
    await repo().detachAllHoldingsForHolding(holding.id);
    const concurrent = await Promise.allSettled([
      repo().setAllocations(user.id, one!.id, [{ holdingId: holding.id, percentage: 60 }]),
      repo().attachHolding(two!.id, holding.id, 60),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await repo().findVaultsByHoldingId(holding.id)).reduce((sum, row) => sum + row.percentage, 0)
    ).toBe(60);
  } finally {
    await db.delete(schema.vaults).where(
      inArray(
        schema.vaults.id,
        vaults.map((vault) => vault.id)
      )
    );
    await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await db.delete(schema.tokens).where(eq(schema.tokens.id, fixture.token.id));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, fixture.institution.id));
  }
});
