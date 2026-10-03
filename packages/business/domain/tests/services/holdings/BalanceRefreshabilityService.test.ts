import { describe, expect, spyOn, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import { Container } from 'typedi';
import { BalanceSyncOwnershipService } from '../../../src/services/accounts/BalanceSyncOwnershipService';
import {
  type BalanceRefreshability,
  BalanceRefreshabilityService,
} from '../../../src/services/holdings/BalanceRefreshabilityService';
import {
  EXCHANGE_BALANCE_SYNC_SOURCE,
  MANUAL_HOLDING_SOURCE,
  WALLET_BALANCE_SYNC_SOURCE,
} from '../../../src/services/holdings/balance-sync-sources';
import { withTestDb } from '../../../test/helpers/db';
import { makeCredential, makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeToken,
  makeWalletAccount,
} from '../../../test/helpers/factories-extra';
import { countingStatements } from '../../../test/helpers/statement-count';

/**
 * R95, as R97 amends it: a balance can be re-fetched when a feed states it
 * (`holdings.kind`), the balance sync can write the row, and a live wallet or
 * credential is there to ask (`resolveSyncSource`). It replaces a read of
 * `holdings.source`. F2 to F4 are the shapes where the two readings differ:
 * D-1 exception U5. F1 is the shape R97 took out of it, a row the sync's
 * matcher never returns, which keeps the answer its source gave.
 */

interface Shape {
  source: string;
  kind: Holding['kind'];
  /** What could be asked for this account's balances. */
  sync: 'credential' | 'removed-credential' | 'wallet' | 'none';
}

interface Owner {
  userId: string;
  tokenId: string;
}

async function owner(tx: DatabaseTransaction): Promise<Owner> {
  const user = await makeUser(tx);
  const token = await makeToken(tx);
  return { userId: user.id, tokenId: token.id };
}

/** One holding in an account of its own, at an institution of its own. */
async function holdingOf(tx: DatabaseTransaction, who: Owner, shape: Shape): Promise<Holding> {
  const institution = await makeInstitution(tx);
  const at = { userId: who.userId, institutionId: institution.id };
  if (shape.sync === 'credential' || shape.sync === 'removed-credential') {
    await makeCredential(tx, { ...at, isActive: shape.sync === 'credential' });
  }
  const account =
    shape.sync === 'wallet' ? await makeWalletAccount(tx, at) : await makeAccount(tx, at);
  return makeHolding(tx, {
    userId: who.userId,
    accountId: account.id,
    tokenId: who.tokenId,
    source: shape.source,
    kind: shape.kind,
  });
}

const F1: Shape = { source: MANUAL_HOLDING_SOURCE, kind: 'feed', sync: 'credential' };
const F2: Shape = { source: 'statement-import', kind: 'feed', sync: 'none' };
const F3: Shape = {
  source: EXCHANGE_BALANCE_SYNC_SOURCE,
  kind: 'feed',
  sync: 'removed-credential',
};
const F4: Shape = { source: 'exchange', kind: 'snapshot', sync: 'credential' };
const WALLET_FEED: Shape = { source: WALLET_BALANCE_SYNC_SOURCE, kind: 'feed', sync: 'wallet' };
const EXCHANGE_FEED: Shape = {
  source: EXCHANGE_BALANCE_SYNC_SOURCE,
  kind: 'feed',
  sync: 'credential',
};
const PERSON_SNAPSHOT: Shape = { source: MANUAL_HOLDING_SOURCE, kind: 'snapshot', sync: 'none' };

const service = () => Container.get(BalanceRefreshabilityService);

describe('BalanceRefreshabilityService.forHolding', () => {
  test.each<[string, Shape, BalanceRefreshability]>([
    [
      "F1 (R97): a person's row a transaction import wrote into is not, credential live or not, because the sync never writes it",
      F1,
      'sync-cannot-write',
    ],
    [
      'F1 with nothing connected gets the same answer, not the one about a missing connection',
      { ...F1, sync: 'none' },
      'sync-cannot-write',
    ],
    [
      'F2 (U5): a statement-fed holding in an account nothing syncs is not, where its source offered a refresh that ended unsupported',
      F2,
      'no-live-sync',
    ],
    [
      'F3 (U5): a synced holding whose credential was removed is not, where its source offered a refresh that failed',
      F3,
      'no-live-sync',
    ],
    [
      'F4 (U5): a snapshot under a non-manual source is not, even with the credential live',
      F4,
      'not-a-feed',
    ],
    ['control: a wallet-synced feed holding is refreshable, as before', WALLET_FEED, 'refreshable'],
    [
      'control: an exchange-synced feed holding is refreshable, as before',
      EXCHANGE_FEED,
      'refreshable',
    ],
    ["control: a person's snapshot is not, as before", PERSON_SNAPSHOT, 'not-a-feed'],
    [
      'a holding nothing has classified is not a feed',
      { source: EXCHANGE_BALANCE_SYNC_SOURCE, kind: null, sync: 'credential' },
      'not-a-feed',
    ],
  ])('%s', async (_name, shape, expected) => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const holding = await holdingOf(tx, who, shape);
      expect(await service().forHolding(who.userId, holding, tx)).toBe(expected);
    });
  });

  test("answers for the user it is asked for: a feed in an account that is not theirs is not answered from its owner's sync (R97)", async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const stranger = await owner(tx);
      const holding = await holdingOf(tx, who, EXCHANGE_FEED);

      expect(await service().forHolding(stranger.userId, holding, tx)).toBe('no-live-sync');
      // The control: its owner is told it can be refreshed.
      expect(await service().forHolding(who.userId, holding, tx)).toBe('refreshable');
    });
  });
});

describe('BalanceRefreshabilityService.forHoldings', () => {
  test('answers a whole list in one call, each holding by its own account', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const shapes = [F1, F2, F3, F4, WALLET_FEED, PERSON_SNAPSHOT];
      const holdings: Holding[] = [];
      for (const shape of shapes) holdings.push(await holdingOf(tx, who, shape));

      const answers = await service().forHoldings(who.userId, holdings, tx);

      expect(holdings.map((h) => answers.get(h.id))).toEqual([
        'sync-cannot-write',
        'no-live-sync',
        'no-live-sync',
        'not-a-feed',
        'refreshable',
        'not-a-feed',
      ]);
    });
  });

  test("asks about an account once however many feed holdings it has, and never about one holding only a snapshot or only a person's row", async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const first = await holdingOf(tx, who, EXCHANGE_FEED);
      const siblings: Holding[] = [];
      for (let i = 0; i < 2; i += 1) {
        const token = await makeToken(tx);
        siblings.push(
          await makeHolding(tx, {
            userId: who.userId,
            accountId: first.accountId,
            tokenId: token.id,
            source: EXCHANGE_BALANCE_SYNC_SOURCE,
            kind: 'feed',
          })
        );
      }
      const snapshot = await holdingOf(tx, who, PERSON_SNAPSHOT);
      const personsRow = await holdingOf(tx, who, F1);

      const resolve = spyOn(Container.get(BalanceSyncOwnershipService), 'resolveSyncSources');
      try {
        const answers = await service().forHoldings(
          who.userId,
          [first, ...siblings, snapshot, personsRow],
          tx
        );

        expect(
          resolve.mock.calls.map(([userId, accounts]) => [userId, accounts.map(({ id }) => id)])
        ).toEqual([[who.userId, [first.accountId]]]);
        expect([first, ...siblings].map((h) => answers.get(h.id))).toEqual([
          'refreshable',
          'refreshable',
          'refreshable',
        ]);
        expect(answers.get(snapshot.id)).toBe('not-a-feed');
        expect(answers.get(personsRow.id)).toBe('sync-cannot-write');
      } finally {
        resolve.mockRestore();
      }
    });
  });

  test('costs three reads however many feed accounts the list has: the accounts, their wallets, their credentials (R96)', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const reads = async (accounts: number): Promise<number> => {
        const holdings: Holding[] = [];
        for (let i = 0; i < accounts; i += 1) {
          holdings.push(await holdingOf(tx, who, i % 2 === 0 ? EXCHANGE_FEED : WALLET_FEED));
        }
        const { handle, started } = countingStatements(tx);
        const answers = await service().forHoldings(who.userId, holdings, handle);
        expect([...answers.values()]).toEqual(holdings.map(() => 'refreshable'));
        return started();
      };

      expect([await reads(2), await reads(12)]).toEqual([3, 3]);
    });
  });
});
