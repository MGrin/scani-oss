/**
 * The bulk group-assignment use cases checked that every holding or account
 * was the caller's and never looked at the GROUP ids, so user B could link
 * B's own rows into A's group by its UUID. Exploited on 2026-09-19 between an
 * attacker's own accounts (SC-1286). The single-item use cases always checked.
 *
 * Each refusal is asserted against the table it would have written, because
 * the defect was a write: a thrown error alone would also pass against a use
 * case that wrote first and threw after.
 */

import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { GroupRepository } from '../../src/repositories/GroupRepository';
import { BulkAssignAccountGroupsUseCase } from '../../src/use-cases/BulkAssignAccountGroupsUseCase';
import { BulkAssignHoldingGroupsUseCase } from '../../src/use-cases/BulkAssignHoldingGroupsUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function makeOwner(tx: Tx, name: string) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
  });
  const group = await Container.get(GroupRepository).create(
    { userId: user.id, name, color: '#111111' },
    tx
  );
  return { user, account, holding, group };
}

const holdingGroupRows = (tx: Tx, groupId: string) =>
  tx.select().from(schema.holdingGroups).where(eq(schema.holdingGroups.groupId, groupId));
const accountGroupRows = (tx: Tx, groupId: string) =>
  tx.select().from(schema.accountGroups).where(eq(schema.accountGroups.groupId, groupId));
const exclusionRows = (tx: Tx, groupId: string) =>
  tx
    .select()
    .from(schema.holdingGroupExclusions)
    .where(eq(schema.holdingGroupExclusions.groupId, groupId));

describe('BulkAssignHoldingGroupsUseCase — group ownership (SC-1286)', () => {
  const useCase = () => Container.get(BulkAssignHoldingGroupsUseCase);

  test("B cannot add B's holding to A's group", async () => {
    await withTestDb(async (tx) => {
      const a = await makeOwner(tx, 'A-group');
      const b = await makeOwner(tx, 'B-group');

      await expect(
        useCase().execute(
          { holdingIds: [b.holding.id], addedGroupIds: [a.group.id], removedGroupIds: [] },
          b.user.id,
          tx
        )
      ).rejects.toThrow(/Unauthorized/);
      expect(await holdingGroupRows(tx, a.group.id)).toEqual([]);
    });
  });

  test("B cannot remove B's holding from A's group", async () => {
    await withTestDb(async (tx) => {
      const a = await makeOwner(tx, 'A-group');
      const b = await makeOwner(tx, 'B-group');

      await expect(
        useCase().execute(
          { holdingIds: [b.holding.id], addedGroupIds: [], removedGroupIds: [a.group.id] },
          b.user.id,
          tx
        )
      ).rejects.toThrow(/Unauthorized/);
      expect(await exclusionRows(tx, a.group.id)).toEqual([]);
    });
  });

  test("one foreign id refuses the whole request, including the caller's own group", async () => {
    await withTestDb(async (tx) => {
      const a = await makeOwner(tx, 'A-group');
      const b = await makeOwner(tx, 'B-group');

      await expect(
        useCase().execute(
          {
            holdingIds: [b.holding.id],
            addedGroupIds: [b.group.id, a.group.id],
            removedGroupIds: [],
          },
          b.user.id,
          tx
        )
      ).rejects.toThrow(/Unauthorized/);
      expect(await holdingGroupRows(tx, b.group.id)).toEqual([]);
    });
  });

  test('the owner can still add and remove their own group — the control', async () => {
    await withTestDb(async (tx) => {
      const b = await makeOwner(tx, 'B-group');

      await useCase().execute(
        { holdingIds: [b.holding.id], addedGroupIds: [b.group.id], removedGroupIds: [] },
        b.user.id,
        tx
      );
      expect(await holdingGroupRows(tx, b.group.id)).toHaveLength(1);

      await useCase().execute(
        { holdingIds: [b.holding.id], addedGroupIds: [], removedGroupIds: [b.group.id] },
        b.user.id,
        tx
      );
      expect(await holdingGroupRows(tx, b.group.id)).toEqual([]);
    });
  });
});

describe('BulkAssignAccountGroupsUseCase — group ownership (SC-1286)', () => {
  const useCase = () => Container.get(BulkAssignAccountGroupsUseCase);

  test("B cannot add B's account to A's group", async () => {
    await withTestDb(async (tx) => {
      const a = await makeOwner(tx, 'A-group');
      const b = await makeOwner(tx, 'B-group');

      await expect(
        useCase().execute(
          { accountIds: [b.account.id], addedGroupIds: [a.group.id], removedGroupIds: [] },
          b.user.id,
          tx
        )
      ).rejects.toThrow(/Unauthorized/);
      expect(await accountGroupRows(tx, a.group.id)).toEqual([]);
    });
  });

  test("B cannot remove anything from A's group", async () => {
    await withTestDb(async (tx) => {
      const a = await makeOwner(tx, 'A-group');
      const b = await makeOwner(tx, 'B-group');
      await Container.get(GroupRepository).addAccountGroups([a.account.id], [a.group.id], tx);

      await expect(
        useCase().execute(
          { accountIds: [b.account.id], addedGroupIds: [], removedGroupIds: [a.group.id] },
          b.user.id,
          tx
        )
      ).rejects.toThrow(/Unauthorized/);
      expect(await accountGroupRows(tx, a.group.id)).toHaveLength(1);
    });
  });

  test('a group id that does not exist is refused like a foreign one', async () => {
    await withTestDb(async (tx) => {
      const b = await makeOwner(tx, 'B-group');

      await expect(
        useCase().execute(
          {
            accountIds: [b.account.id],
            addedGroupIds: ['00000000-0000-4000-8000-000000000000'],
            removedGroupIds: [],
          },
          b.user.id,
          tx
        )
      ).rejects.toThrow(/Unauthorized/);
    });
  });

  test('the owner can still add and remove their own group — the control', async () => {
    await withTestDb(async (tx) => {
      const b = await makeOwner(tx, 'B-group');

      await useCase().execute(
        { accountIds: [b.account.id], addedGroupIds: [b.group.id], removedGroupIds: [] },
        b.user.id,
        tx
      );
      expect(await accountGroupRows(tx, b.group.id)).toHaveLength(1);

      await useCase().execute(
        { accountIds: [b.account.id], addedGroupIds: [], removedGroupIds: [b.group.id] },
        b.user.id,
        tx
      );
      expect(await accountGroupRows(tx, b.group.id)).toEqual([]);
    });
  });
});

/**
 * Defence in depth for rows the missing check already let in: prod carries one
 * of each shape. A cross-owner membership row must not make A's group readable
 * through B's rows, nor inflate A's account count.
 */
describe('GroupRepository ignores a cross-owner membership row (SC-1286)', () => {
  const repo = () => Container.get(GroupRepository);

  test("B's holding in A's group does not surface A's group on B's holding", async () => {
    await withTestDb(async (tx) => {
      const a = await makeOwner(tx, 'A-group');
      const b = await makeOwner(tx, 'B-group');
      await repo().bulkAddHoldingGroups([b.holding.id], [a.group.id], tx);

      expect(await repo().findGroupsByHoldingId(b.holding.id, tx)).toEqual([]);
      const map = await repo().findGroupsForHoldings(
        [{ id: b.holding.id, accountId: b.account.id }],
        tx
      );
      expect(map.get(b.holding.id)).toEqual([]);
    });
  });

  test("B's account in A's group surfaces nothing and is not counted", async () => {
    await withTestDb(async (tx) => {
      const a = await makeOwner(tx, 'A-group');
      const b = await makeOwner(tx, 'B-group');
      await repo().addAccountGroups([b.account.id], [a.group.id], tx);
      await repo().addAccountGroups([a.account.id], [a.group.id], tx);

      expect(await repo().findGroupsByAccountId(b.account.id, tx)).toEqual([]);
      expect((await repo().findGroupsForAccounts([b.account.id], tx)).get(b.account.id)).toEqual(
        []
      );
      // inherited through B's account's rule
      expect(await repo().findGroupsByHoldingId(b.holding.id, tx)).toEqual([]);

      const [counted] = await repo().findByUserWithCounts(a.user.id, tx);
      expect(counted?.accountsCount).toBe(1);
      // the control: A's own account still resolves to A's group
      expect((await repo().findGroupsByAccountId(a.account.id, tx)).map((g) => g.id)).toEqual([
        a.group.id,
      ]);
    });
  });
});
