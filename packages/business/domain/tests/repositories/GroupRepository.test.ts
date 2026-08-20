import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { GroupRepository } from '../../src/repositories/GroupRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// GroupRepository resolves three states into one answer: in by its own row, in
// via its account's standing rule, and explicitly vetoed out. The tests below
// are mostly about the boundaries between them — which writes create a veto,
// which clear it, and what "remove the account" has to mean for it to be
// believable (SC-386).

const repo = () => Container.get(GroupRepository);

async function scaffold(
  tx: Parameters<Parameters<typeof import('../../test/helpers/db').withTestDb>[0]>[0]
) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  return { user, institution, account };
}

async function groupIdsFor(
  tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
  holdingId: string,
  accountId: string
): Promise<string[]> {
  const map = await repo().findGroupsForHoldings([{ id: holdingId, accountId }], tx);
  return (map.get(holdingId) ?? []).map((group) => group.id);
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

  /**
   * The counts are declared `number` and were delivered as `"1"`: an uncast
   * `COUNT(*)` is a bigint, which postgres.js returns as a decimal string.
   * `toBe` is strict, so this fails on the string and passes on the number —
   * the assertion the groups list needed before it printed "1 holdings"
   * (SC-88). Asserting the type as well as the value, because `toBe(1)`
   * against `"1"` is the whole defect in one line.
   */
  test('findByUserWithCounts returns counts as numbers, not bigint strings', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const group = await repo().create({ userId: user.id, name: 'one', color: '#111' }, tx);
      await repo().bulkAddHoldingGroups([holding.id], [group.id], tx);
      await repo().addAccountGroups([account.id], [group.id], tx);

      const rows = await repo().findByUserWithCounts(user.id, tx);
      expect(rows.length).toBe(1);
      expect(typeof rows[0]!.holdingsCount).toBe('number');
      expect(typeof rows[0]!.accountsCount).toBe('number');
      expect(rows[0]!.holdingsCount).toBe(1);
      expect(rows[0]!.accountsCount).toBe(1);
    });
  });

  /**
   * The count labels a list, and the list is `findByUserWithFullDetails`, which
   * filters hidden holdings AND scam-flagged tokens. This subquery only had the
   * first half, so a group holding one impersonating airdrop read one higher on
   * the groups list than on its own page — a fourth number on a screen SC-388
   * was already reported for having three.
   */
  test('findByUserWithCounts leaves out what the holdings list leaves out', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const group = await repo().create({ userId: user.id, name: 'one', color: '#111' }, tx);

      const real = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
      });
      const hidden = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        isHidden: true,
      });
      const scam = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx, { isScamProbability: 0.9 })).id,
      });
      await repo().bulkAddHoldingGroups([real.id, hidden.id, scam.id], [group.id], tx);

      const rows = await repo().findByUserWithCounts(user.id, tx);
      expect(rows[0]!.holdingsCount).toBe(1);
    });
  });

  test('findByUserWithCounts returns 0, not "0", for an empty group', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().create({ userId: user.id, name: 'empty', color: '#111' }, tx);
      const rows = await repo().findByUserWithCounts(user.id, tx);
      expect(rows[0]!.holdingsCount).toBe(0);
      expect(rows[0]!.accountsCount).toBe(0);
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

  /**
   * The semantic itself, and the exact scenario SC-385 pinned the other way
   * round. `account_groups` used to be a cache with no invalidation, so a
   * holding that arrived after the account joined a group left the account's
   * row asserting something no longer true. mgrin chose the standing rule on
   * 2026-08-18 — the account is in the group, and so is what it receives — so
   * the row is true again and the arrival is in the group by it.
   *
   * On production this is 6,218.75 USD of Airwallex cash and 16 airdrops
   * joining Liquid, taking the group from 46,805.30 to 53,024.05 on BOTH
   * surfaces rather than on the dashboard alone.
   */
  test('a holding created after the account joined a group IS in it, by the account rule', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const existing = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'liquid', color: '#aaa' }, tx);

      await repo().addAccountGroups([account.id], [g.id], tx);
      expect((await repo().findGroupsByAccountId(account.id, tx)).map((gr) => gr.id)).toContain(
        g.id
      );

      // A sync lands a new position in the same account. Nothing recomputes,
      // and nothing needs to.
      const arrived = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });

      expect(await groupIdsFor(tx, existing.id, account.id)).toEqual([g.id]);
      expect(await groupIdsFor(tx, arrived.id, account.id)).toEqual([g.id]);
    });
  });

  /**
   * What makes the rule survivable in a wallet that receives junk. The remove
   * the user already has — the × on the group page's member row, the unchecked
   * box in the holdings list's bulk dialog — has to work on a holding that is
   * in the group only by its account, and before this it deleted a row that
   * was never there and the holding came straight back.
   */
  test('removing a holding that is in by its account vetoes it, and the veto holds', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const dust = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'liquid', color: '#aaa' }, tx);
      await repo().addAccountGroups([account.id], [g.id], tx);
      expect(await groupIdsFor(tx, dust.id, account.id)).toEqual([g.id]);

      await repo().bulkRemoveHoldingGroups([dust.id], [g.id], tx);

      expect(await groupIdsFor(tx, dust.id, account.id)).toEqual([]);
      // The account has not left the group — that is the whole point.
      expect((await repo().findGroupsByAccountId(account.id, tx)).map((gr) => gr.id)).toEqual([
        g.id,
      ]);
    });
  });

  test('a vetoed holding is counted out of the group, and its account still counted in', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const keep = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const dust = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'liquid', color: '#aaa' }, tx);
      await repo().addAccountGroups([account.id], [g.id], tx);
      await repo().bulkRemoveHoldingGroups([dust.id], [g.id], tx);

      const rows = await repo().findByUserWithCounts(user.id, tx);
      expect(rows[0]!.holdingsCount).toBe(1);
      expect(rows[0]!.accountsCount).toBe(1);
      expect(await groupIdsFor(tx, keep.id, account.id)).toEqual([g.id]);
    });
  });

  test('adding the holding back clears its veto', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'liquid', color: '#aaa' }, tx);
      await repo().addAccountGroups([account.id], [g.id], tx);
      await repo().bulkRemoveHoldingGroups([holding.id], [g.id], tx);
      expect(await groupIdsFor(tx, holding.id, account.id)).toEqual([]);

      await repo().bulkAddHoldingGroups([holding.id], [g.id], tx);

      expect(await groupIdsFor(tx, holding.id, account.id)).toEqual([g.id]);
    });
  });

  /**
   * A veto on a pair nothing puts together would be an assertion with no
   * referent — and worse, it would silently outrank a later "add this whole
   * account", which is the one bulk correction the user has.
   */
  test('removing a holding whose account is NOT in the group writes no veto', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'liquid', color: '#aaa' }, tx);

      await repo().bulkAddHoldingGroups([holding.id], [g.id], tx);
      await repo().bulkRemoveHoldingGroups([holding.id], [g.id], tx);
      expect(await groupIdsFor(tx, holding.id, account.id)).toEqual([]);

      // If the removal had left a veto behind, the account's rule would arrive
      // and be silently overridden.
      await repo().addAccountGroups([account.id], [g.id], tx);
      expect(await groupIdsFor(tx, holding.id, account.id)).toEqual([g.id]);
    });
  });

  test('adding the account again clears the vetoes taken out under the last rule', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const dust = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'liquid', color: '#aaa' }, tx);
      await repo().addAccountGroups([account.id], [g.id], tx);
      await repo().bulkRemoveHoldingGroups([dust.id], [g.id], tx);
      await repo().removeAccountGroups([account.id], [g.id], tx);

      await repo().addAccountGroups([account.id], [g.id], tx);

      expect(await groupIdsFor(tx, dust.id, account.id)).toEqual([g.id]);
    });
  });

  /**
   * "This account is not in this group" has to be total. Most of the holdings'
   * own rows were written by the cascade this model replaced; leaving them
   * would mean removing the account changed nothing a reader can see, which is
   * the mirror image of the drift SC-385 found.
   */
  test('removing the account takes its holdings own rows out with it', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'liquid', color: '#aaa' }, tx);
      await repo().bulkAddHoldingGroups([holding.id], [g.id], tx);
      await repo().addAccountGroups([account.id], [g.id], tx);

      await repo().removeAccountGroups([account.id], [g.id], tx);

      expect(await repo().findGroupsByAccountId(account.id, tx)).toEqual([]);
      expect(await groupIdsFor(tx, holding.id, account.id)).toEqual([]);
      const rows = await repo().findByUserWithCounts(user.id, tx);
      expect(rows[0]!.holdingsCount).toBe(0);
      expect(rows[0]!.accountsCount).toBe(0);
    });
  });

  test('a holding reached by both its own row and its account is in the group once', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'liquid', color: '#aaa' }, tx);
      await repo().bulkAddHoldingGroups([holding.id], [g.id], tx);
      await repo().addAccountGroups([account.id], [g.id], tx);

      expect(await groupIdsFor(tx, holding.id, account.id)).toEqual([g.id]);
    });
  });

  test("another account's holding is untouched by this account's rule", async () => {
    await withTestDb(async (tx) => {
      const { user, institution, account } = await scaffold(tx);
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      const elsewhere = await makeHolding(tx, {
        userId: user.id,
        accountId: other.id,
        tokenId: token.id,
      });
      const g = await repo().create({ userId: user.id, name: 'liquid', color: '#aaa' }, tx);
      await repo().addAccountGroups([account.id], [g.id], tx);

      expect(await groupIdsFor(tx, elsewhere.id, other.id)).toEqual([]);
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
