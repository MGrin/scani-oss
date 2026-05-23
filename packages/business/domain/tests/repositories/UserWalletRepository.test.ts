import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { UserWalletRepository } from '../../src/repositories/UserWalletRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';

// UserWalletRepository is the cross-chain address registry. `findByAddress`
// is the one that drives "this address already exists for another user"
// detection on import. The JSONB @> operator in `findByInstitution` is the
// subtle bit — pin that query shape here so a refactor to `= ANY(...)`
// doesn't silently drop matches.

const repo = () => Container.get(UserWalletRepository);

describe('UserWalletRepository', () => {
  test('findByUser returns active wallets sorted by createdAt', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().create({ userId: user.id, walletAddress: '0xaaa', institutionIds: [] }, tx);
      await repo().create({ userId: user.id, walletAddress: '0xbbb', institutionIds: [] }, tx);
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.walletAddress).sort()).toEqual(['0xaaa', '0xbbb']);
    });
  });

  test('findByUser skips inactive wallets', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().create(
        { userId: user.id, walletAddress: '0xdead', institutionIds: [], isActive: false },
        tx
      );
      expect(await repo().findByUser(user.id, tx)).toEqual([]);
    });
  });

  test('findByUserAndAddress narrows to the user scope', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      await repo().create({ userId: userA.id, walletAddress: '0xshared', institutionIds: [] }, tx);
      await repo().create({ userId: userB.id, walletAddress: '0xshared', institutionIds: [] }, tx);
      const forA = await repo().findByUserAndAddress(userA.id, '0xshared', tx);
      const forB = await repo().findByUserAndAddress(userB.id, '0xshared', tx);
      expect(forA?.userId).toBe(userA.id);
      expect(forB?.userId).toBe(userB.id);
    });
  });

  test('findByAddress returns all active rows across users', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      await repo().create({ userId: userA.id, walletAddress: '0xshared', institutionIds: [] }, tx);
      await repo().create({ userId: userB.id, walletAddress: '0xshared', institutionIds: [] }, tx);
      const rows = await repo().findByAddress('0xshared', tx);
      expect(rows.length).toBe(2);
      const userIds = rows.map((r) => r.userId).sort();
      expect(userIds).toEqual([userA.id, userB.id].sort());
    });
  });

  test('findByInstitution uses JSONB containment (single-institution membership)', async () => {
    // Regression pin for the `@>` operator — this is the cheap path;
    // swapping it for `= ANY` silently misses matches.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institutionA = await makeInstitution(tx);
      const institutionB = await makeInstitution(tx);
      await repo().create(
        {
          userId: user.id,
          walletAddress: '0xmulti',
          institutionIds: [institutionA.id, institutionB.id],
        },
        tx
      );
      const byA = await repo().findByInstitution(institutionA.id, tx);
      const byB = await repo().findByInstitution(institutionB.id, tx);
      expect(byA.map((r) => r.walletAddress)).toContain('0xmulti');
      expect(byB.map((r) => r.walletAddress)).toContain('0xmulti');
    });
  });

  test('findByInstitution returns [] when no wallets mention that institution', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const unrelated = await makeInstitution(tx);
      await repo().create({ userId: user.id, walletAddress: '0xiso', institutionIds: [] }, tx);
      expect(await repo().findByInstitution(unrelated.id, tx)).toEqual([]);
    });
  });
});
