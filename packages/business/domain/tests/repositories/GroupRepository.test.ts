import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { GroupRepository } from '../../src/repositories/GroupRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// GroupRepository is the heart of the "custom groups" feature. The subtle
// bit is `recomputeAccountGroups` — an account is "in" a group iff every
// visible holding of the account is in that group. Lock down that contract
// with scaffolded holdings so a future refactor can't silently regress it.

const repo = () => Container.get(GroupRepository);

async function scaffold(
  tx: Parameters<Parameters<typeof import('../../test/helpers/db').withTestDb>[0]>[0]
) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  return { user, institution, account };
}

describe('GroupRepository', () => {
  test('findByUser returns active groups sorted by displayOrder then name', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().create(
        { userId: user.id, name: 'B-second', color: '#ff0000', displayOrder: 2 },
        tx
      );
      await repo().create(
        { userId: user.id, name: 'A-first', color: '#00ff00', displayOrder: 1 },
        tx
      );
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.map((r) => r.name)).toEqual(['A-first', 'B-second']);
    });
  });

  test('findByUser excludes inactive groups', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().create({ userId: user.id, name: 'hidden', color: '#000', isActive: false }, tx);
      expect(await repo().findByUser(user.id, tx)).toEqual([]);
    });
  });

  test('assignHoldingGroups replaces (not unions) existing assignments', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g1 = await repo().create({ userId: user.id, name: 'g1', color: '#111' }, tx);
      const g2 = await repo().create({ userId: user.id, name: 'g2', color: '#222' }, tx);
      const g3 = await repo().create({ userId: user.id, name: 'g3', color: '#333' }, tx);

      await repo().assignHoldingGroups(holding.id, [g1.id, g2.id], tx);
      let groups = await repo().findGroupsByHoldingId(holding.id, tx);
      expect(groups.map((g) => g.id).sort()).toEqual([g1.id, g2.id].sort());

      // Reassign — must replace, not union.
      await repo().assignHoldingGroups(holding.id, [g3.id], tx);
      groups = await repo().findGroupsByHoldingId(holding.id, tx);
      expect(groups.map((g) => g.id)).toEqual([g3.id]);
    });
  });

  test('bulkAddHoldingGroups unions without dupes on (holdingId, groupId)', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g1 = await repo().create({ userId: user.id, name: 'g1', color: '#1' }, tx);

      await repo().bulkAddHoldingGroups([holding.id], [g1.id], tx);
      // Second call must NOT throw (ON CONFLICT DO NOTHING).
      await repo().bulkAddHoldingGroups([holding.id], [g1.id], tx);
      const groups = await repo().findGroupsByHoldingId(holding.id, tx);
      expect(groups.length).toBe(1);
    });
  });

  test('recomputeAccountGroups: account joins group iff all visible holdings are in it', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const h1 = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const h2 = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'target', color: '#aaa' }, tx);

      // Assign only h1 to g — account should NOT be in g yet.
      await repo().bulkAddHoldingGroups([h1.id], [g.id], tx);
      await repo().recomputeAccountGroups([account.id], tx);
      let groupsForAcct = await repo().findGroupsByAccountId(account.id, tx);
      expect(groupsForAcct.map((gr) => gr.id)).not.toContain(g.id);

      // Now assign h2 too — all visible holdings are in g, account joins.
      await repo().bulkAddHoldingGroups([h2.id], [g.id], tx);
      await repo().recomputeAccountGroups([account.id], tx);
      groupsForAcct = await repo().findGroupsByAccountId(account.id, tx);
      expect(groupsForAcct.map((gr) => gr.id)).toContain(g.id);
    });
  });

  test('findGroupsForHoldings returns an entry for every requested holding (even empty)', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const h = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const map = await repo().findGroupsForHoldings([{ id: h.id, accountId: account.id }], tx);
      expect(map.has(h.id)).toBe(true);
      expect(map.get(h.id)).toEqual([]);
    });
  });
});
