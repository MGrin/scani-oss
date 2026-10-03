import { describe, expect, spyOn, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import type { Account } from '@scani/db/schema';
import { Container } from 'typedi';
import { BalanceSyncOwnershipService } from '../../../src/services/accounts/BalanceSyncOwnershipService';
import {
  type BalanceSyncSource,
  EXCHANGE_BALANCE_SYNC_SOURCE,
  WALLET_BALANCE_SYNC_SOURCE,
} from '../../../src/services/holdings/balance-sync-sources';
import { withTestDb } from '../../../test/helpers/db';
import { makeCredential, makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeWallet } from '../../../test/helpers/factories-extra';
import { countingStatements } from '../../../test/helpers/statement-count';

/**
 * Which balance sync owns a user's account (SC-356), asked two ways: of one
 * account by every path that creates a holding, and of a whole list by the
 * holdings page (R96). It is one rule, so both give the answer written beside
 * each shape below. Both are asked on behalf of one user. An account that is
 * not that user's has no entry in the list (R97), and asked alone it is
 * refused: `null` there would read as "no sync", which is an answer (R102).
 */

const WALLET = WALLET_BALANCE_SYNC_SOURCE;
const EXCHANGE = EXCHANGE_BALANCE_SYNC_SOURCE;
/** Another user's account: the list has no entry for it, and asked alone it is refused. */
const NOT_ANSWERED = undefined;

interface Asked {
  shape: string;
  account: Account;
  want: BalanceSyncSource | null | typeof NOT_ANSWERED;
  /** Its `metadata.userWalletId` is text Postgres does not read as a uuid. */
  malformedPointer?: true;
}

interface World {
  /** The user every question is asked for. */
  userId: string;
  asked: Asked[];
}

type Place = { userId: string; institutionId: string };

/**
 * Every shape the rule separates, in one set of rows, so that a list holding
 * all of them also shows no account is answered from another user's wallet or
 * credential.
 */
async function world(tx: DatabaseTransaction): Promise<World> {
  const user = await makeUser(tx);
  const stranger = await makeUser(tx);
  const place = async (userId = user.id): Promise<Place> => ({
    userId,
    institutionId: (await makeInstitution(tx)).id,
  });
  const pointing = (at: Place, userWalletId: string, overrides: { isActive?: boolean } = {}) =>
    makeAccount(tx, { ...at, metadata: { chainId: 1, userWalletId }, ...overrides });

  const asked: Asked[] = [];
  const ask = (
    shape: string,
    account: Account,
    want: Asked['want'],
    flags: Pick<Asked, 'malformedPointer'> = {}
  ) => asked.push({ shape, account, want, ...flags });

  ask('nothing is connected', await makeAccount(tx, await place()), null);

  const connected = await place();
  await makeCredential(tx, connected);
  ask('a live credential at its institution', await makeAccount(tx, connected), EXCHANGE);
  ask('a second account at that institution', await makeAccount(tx, connected), EXCHANGE);
  ask(
    'an inactive account at that institution',
    await makeAccount(tx, { ...connected, isActive: false }),
    null
  );
  ask(
    "another user's account at that institution",
    await makeAccount(tx, { userId: stranger.id, institutionId: connected.institutionId }),
    NOT_ANSWERED
  );
  ask(
    'an empty pointer at that institution',
    await makeAccount(tx, { ...connected, metadata: { userWalletId: '' } }),
    EXCHANGE
  );
  ask(
    'a pointer that is not a uuid, at that institution',
    await pointing(connected, 'not-a-uuid'),
    EXCHANGE,
    { malformedPointer: true }
  );

  const removed = await place();
  await makeCredential(tx, { ...removed, isActive: false });
  ask('a removed credential', await makeAccount(tx, removed), null);

  const theirs = await place();
  await makeCredential(tx, { userId: stranger.id, institutionId: theirs.institutionId });
  ask(
    "an institution only another user's credential is live at",
    await makeAccount(tx, theirs),
    null
  );

  const chain = await place();
  await makeCredential(tx, {
    ...chain,
    credentialsType: 'rpc',
    encryptedCredentials: { type: 'public_rpc' },
  });
  ask(
    'the public_rpc marker and no pointer',
    await makeAccount(tx, { ...chain, metadata: { chainId: 1 } }),
    EXCHANGE
  );

  const walletPlace = await place();
  const wallet = await makeWallet(tx, walletPlace);
  ask('a pointer at a live wallet', await pointing(walletPlace, wallet.id), WALLET);
  ask(
    'an inactive account pointing at it',
    await pointing(walletPlace, wallet.id, { isActive: false }),
    WALLET
  );
  ask(
    'the pointer spelled in upper case',
    await pointing(walletPlace, wallet.id.toUpperCase()),
    WALLET
  );
  ask(
    'the pointer spelled without hyphens',
    await pointing(walletPlace, wallet.id.replaceAll('-', '')),
    WALLET
  );
  ask('the pointer spelled in braces', await pointing(walletPlace, `{${wallet.id}}`), WALLET);
  ask(
    "the live wallet's id with a stray character, which is not a uuid",
    await pointing(walletPlace, `${wallet.id}x`),
    null,
    { malformedPointer: true }
  );
  ask(
    "another user's account pointing at it",
    await pointing(await place(stranger.id), wallet.id),
    NOT_ANSWERED
  );
  const theirWallet = await makeWallet(tx, await place(stranger.id));
  ask(
    "a pointer at another user's live wallet",
    await pointing(await place(), theirWallet.id),
    null
  );

  const deactivated = await place();
  const off = await makeWallet(tx, deactivated, { isActive: false });
  ask('a deactivated wallet', await pointing(deactivated, off.id), null);

  const fallback = await place();
  await makeCredential(tx, fallback);
  const offThere = await makeWallet(tx, fallback, { isActive: false });
  ask('a deactivated wallet at a live credential', await pointing(fallback, offThere.id), EXCHANGE);

  const both = await place();
  await makeCredential(tx, both);
  const liveThere = await makeWallet(tx, both);
  ask('a live wallet at a live credential', await pointing(both, liveThere.id), WALLET);

  return { userId: user.id, asked };
}

const service = () => Container.get(BalanceSyncOwnershipService);
const accountsOf = (asked: Asked[]) => asked.map(({ account }) => account);

/** `run`, with the service's warnings captured rather than printed: the context of each, in order. */
async function capturingWarnings<T>(
  run: () => Promise<T>
): Promise<{ result: T; warned: unknown[] }> {
  // `logger` is protected so the service owns its component name.
  const { logger } = service() as unknown as {
    logger: { warn: (context: unknown, message: string) => void };
  };
  const logged = spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    const result = await run();
    return { result, warned: logged.mock.calls.map(([context]) => context) };
  } finally {
    logged.mockRestore();
  }
}

/** One warning for each account whose pointer is not a uuid, naming it and nothing else. */
const warningsFor = (asked: Asked[]) =>
  asked
    .filter(({ malformedPointer }) => malformedPointer)
    .map(({ account }) => ({ accountId: account.id }));

describe('BalanceSyncOwnershipService', () => {
  test("resolveSyncSource answers each of the user's accounts asked alone", async () => {
    await withTestDb(async (tx) => {
      const { userId, asked } = await world(tx);
      const own = asked.filter(({ want }) => want !== NOT_ANSWERED);

      const { result: answers, warned } = await capturingWarnings(async () => {
        const each: Array<[string, BalanceSyncSource | null]> = [];
        for (const { shape, account } of own) {
          each.push([shape, await service().resolveSyncSource(userId, account, tx)]);
        }
        return each;
      });

      expect(own).toHaveLength(asked.length - 2);
      expect(answers).toEqual(own.map(({ shape, want }) => [shape, want ?? null]));
      expect(warned).toEqual(warningsFor(asked));
    });
  });

  test("resolveSyncSource refuses an account that is not the asking user's, and answers its owner", async () => {
    await withTestDb(async (tx) => {
      const { userId, asked } = await world(tx);
      const foreign = asked.filter(({ want }) => want === NOT_ANSWERED);

      const refusals: string[] = [];
      for (const { account } of foreign) {
        refusals.push(
          await service()
            .resolveSyncSource(userId, account, tx)
            .then(
              (answer) => `answered ${answer}`,
              (error: Error) => error.message
            )
        );
      }

      expect(refusals).toEqual(
        foreign.map(({ account }) => `account ${account.id} is not user ${userId}'s`)
      );
      expect(foreign.map(({ shape }) => shape)).toEqual([
        "another user's account at that institution",
        "another user's account pointing at it",
      ]);
      // The control: each is an account its own user is answered about.
      const owners: Array<BalanceSyncSource | null> = [];
      for (const { account } of foreign) {
        owners.push(await service().resolveSyncSource(account.userId, account, tx));
      }
      expect(owners).toEqual([null, null]);
    });
  });

  test("resolveSyncSources gives each of the user's accounts the same answer when they are asked together, and has no entry for one that is not theirs", async () => {
    await withTestDb(async (tx) => {
      const { userId, asked } = await world(tx);

      const { result: answers, warned } = await capturingWarnings(() =>
        service().resolveSyncSources(userId, accountsOf(asked), tx)
      );

      // One pointer that is not a uuid does not cost the others their answers (R97).
      expect(asked.map(({ shape, account }) => [shape, answers.get(account.id)])).toEqual(
        asked.map(({ shape, want }) => [shape, want])
      );
      expect(warningsFor(asked)).toHaveLength(2);
      expect(warned).toEqual(warningsFor(asked));
      const foreign = asked.filter(({ want }) => want === NOT_ANSWERED);
      expect(foreign).toHaveLength(2);
      expect(foreign.map(({ account }) => answers.has(account.id))).toEqual([false, false]);
      expect(answers.size).toBe(asked.length - foreign.length);
    });
  });

  test('resolveSyncSources reads twice however many accounts it answers, their wallets and their credentials, and not at all for none', async () => {
    await withTestDb(async (tx) => {
      const { userId, asked } = await world(tx);
      const all = countingStatements(tx);
      const none = countingStatements(tx);

      const { result: empty } = await capturingWarnings(async () => {
        await service().resolveSyncSources(userId, accountsOf(asked), all.handle);
        return service().resolveSyncSources(userId, [], none.handle);
      });

      expect(asked.length).toBeGreaterThan(10);
      expect([all.started(), none.started()]).toEqual([2, 0]);
      expect(empty.size).toBe(0);
    });
  });
});
