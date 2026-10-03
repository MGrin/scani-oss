/**
 * Feed inputs follow connect and disconnect (A2 Task 20, D-11).
 *
 * An account's input is created on connect where D-7 plans one
 * (`planFeedInputs`), linked to the credential or wallet behind it, and its
 * status is that connection's: `active`, or `disconnected` once deactivated.
 * The inputs ingest creates carry no credential or wallet (R39); a connect
 * links them by the (account, source) key, which names one input at most.
 *
 * The services write through their own connections, so the fixtures are
 * committed; the races need a second transaction to see a lock at all.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { type DatabaseTransaction, getDb } from '@scani/db';
import type { FeedInput } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { FeedInputRepository } from '../../src/repositories/FeedInputRepository';
import type { PlannedFeedInput } from '../../src/services/foundation/plan-feed-inputs';
import { IntegrationCredentialsService } from '../../src/services/users/IntegrationCredentialsService';
import { UserWalletService } from '../../src/services/users/UserWalletService';
import { committedRows } from '../../test/helpers/committed-rows';
import {
  type CommittedExchange,
  commitExchange,
  commitWalletAccount,
} from '../../test/helpers/committed-seeds';
import { withTestDb } from '../../test/helpers/db';
import { makeCredential, makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount } from '../../test/helpers/factories-extra';
import { backendPid, latch, outcomeOf, waitUntilBlocked } from '../../test/helpers/lock-wait';

const rows = committedRows();
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await rows.drop();
});

const repo = () => Container.get(FeedInputRepository);
const credentials = () => Container.get(IntegrationCredentialsService);
const wallets = () => Container.get(UserWalletService);

/** What ingest does first: find or create the input, with no credential or wallet (R39). */
const ingestFindOrCreate = (
  owner: { userId: string; account: { id: string } },
  source: string,
  tx: DatabaseTransaction
) =>
  repo().findOrCreate(
    {
      userId: owner.userId,
      accountId: owner.account.id,
      source,
      credentialId: null,
      walletId: null,
    },
    tx
  );

const inputsOf = (accountId: string) =>
  getDb()
    .select()
    .from(schema.feedInputs)
    .where(eq(schema.feedInputs.accountId, accountId))
    .orderBy(asc(schema.feedInputs.source));

const shape = (i: FeedInput) => ({
  source: i.source,
  credentialId: i.credentialId,
  walletId: i.walletId,
  status: i.status,
});

const store = (owner: CommittedExchange) =>
  credentials().storeCredentials(owner.userId, owner.institutionId, { apiKey: 'k' }, 'api_key');

describe('FeedInputRepository.linkAndSetStatus', () => {
  test('links a NULL credential or wallet, takes the planned status, and keeps a reference already set', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const credential = await makeCredential(tx, {
        userId: user.id,
        institutionId: institution.id,
      });
      const other = await makeInstitution(tx);
      const otherCredential = await makeCredential(tx, {
        userId: user.id,
        institutionId: other.id,
      });
      const input = (source: string, fields: Partial<PlannedFeedInput> = {}): PlannedFeedInput => ({
        userId: user.id,
        accountId: account.id,
        source,
        credentialId: null,
        walletId: null,
        status: 'active',
        ...fields,
      });
      await repo().insertMissing(
        [
          input('provider:unlinked'),
          input('provider:linked', { credentialId: otherCredential.id }),
          input('statement', { status: 'disconnected' }),
        ],
        tx
      );

      const changed = await repo().linkAndSetStatus(
        [
          input('provider:unlinked', { credentialId: credential.id, status: 'disconnected' }),
          input('provider:linked', { credentialId: credential.id }),
          input('statement'),
          input('provider:absent', { credentialId: credential.id }),
        ],
        tx
      );

      const stored = await tx
        .select()
        .from(schema.feedInputs)
        .where(eq(schema.feedInputs.accountId, account.id))
        .orderBy(asc(schema.feedInputs.source));
      expect(stored.map(shape)).toEqual([
        {
          source: 'provider:linked',
          credentialId: otherCredential.id,
          walletId: null,
          status: 'active',
        },
        {
          source: 'provider:unlinked',
          credentialId: credential.id,
          walletId: null,
          status: 'disconnected',
        },
        { source: 'statement', credentialId: null, walletId: null, status: 'active' },
      ]);
      expect(changed).toBe(2);
    });
  });

  test("writes nothing when nothing changes, and nothing to another user's input", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const stranger = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const planned: PlannedFeedInput = {
        userId: user.id,
        accountId: account.id,
        source: 'statement',
        credentialId: null,
        walletId: null,
        status: 'active',
      };
      await repo().insertMissing([planned], tx);
      const [before] = await tx
        .select()
        .from(schema.feedInputs)
        .where(eq(schema.feedInputs.accountId, account.id));

      expect(await repo().linkAndSetStatus([planned], tx)).toBe(0);
      expect(
        await repo().linkAndSetStatus(
          [{ ...planned, userId: stranger.id, status: 'disconnected' }],
          tx
        )
      ).toBe(0);
      const [after] = await tx
        .select()
        .from(schema.feedInputs)
        .where(eq(schema.feedInputs.accountId, account.id));
      expect([after!.status, after!.updatedAt]).toEqual(['active', before!.updatedAt]);
    });
  });
});

describe('feed inputs follow connect and disconnect (A2 Task 20)', () => {
  test('connect creates the input', async () => {
    const owner = await commitExchange(rows, { evidence: true });
    expect(await inputsOf(owner.account.id)).toEqual([]);

    const credential = await store(owner);

    expect((await inputsOf(owner.account.id)).map(shape)).toEqual([
      { source: owner.source, credentialId: credential.id, walletId: null, status: 'active' },
    ]);
  });

  /** D-7, through `planFeedInputs`: an exchange account's input needs its provider's rows. */
  test('connect creates no input where D-7 plans none: no account, or an account holding nothing', async () => {
    const bare = await commitExchange(rows);
    const accountless = await commitExchange(rows);
    await getDb().delete(schema.accounts).where(eq(schema.accounts.id, accountless.account.id));

    await store(bare);
    await store(accountless);

    expect(await inputsOf(bare.account.id)).toEqual([]);
    const ofAccountless = await getDb()
      .select()
      .from(schema.feedInputs)
      .where(eq(schema.feedInputs.userId, accountless.userId));
    expect(ofAccountless).toEqual([]);
  });

  /**
   * The input is the account's at (account, source), and D-7 names the source:
   * the institution's provider source for the credential. Another provider
   * input on the account, or its statement input, is not the credential's, so
   * it keeps its NULL and its status (R67).
   */
  test('connect links an input ingest created with null credential_id and wallet_id (R39)', async () => {
    const owner = await commitExchange(rows);
    const created = await getDb().transaction(async (tx) => {
      const own = await ingestFindOrCreate(owner, owner.source, tx);
      await ingestFindOrCreate(owner, 'kraken-api', tx);
      await ingestFindOrCreate(owner, 'statement', tx);
      return own;
    });
    expect([created.credentialId, created.walletId]).toEqual([null, null]);

    const credential = await store(owner);

    const inputs = await inputsOf(owner.account.id);
    const expected: Array<ReturnType<typeof shape>> = [
      { source: owner.source, credentialId: credential.id, walletId: null, status: 'active' },
      { source: 'kraken-api', credentialId: null, walletId: null, status: 'active' },
      { source: 'statement', credentialId: null, walletId: null, status: 'active' },
    ];
    expect(inputs.map(shape)).toEqual(expected.sort((a, b) => a.source.localeCompare(b.source)));
    expect(inputs.find((i) => i.source === owner.source)?.id).toBe(created.id);
  });

  test("re-activating a wallet links its account's input ingest created (R39)", async () => {
    const chain = await commitWalletAccount(rows, { walletActive: false });
    const created = await getDb().transaction((tx) => ingestFindOrCreate(chain, 'etherscan', tx));

    await wallets().updateWallet(chain.walletId, { isActive: true });

    expect((await inputsOf(chain.account.id)).map((i) => [i.id, i.walletId, i.status])).toEqual([
      [created.id, chain.walletId, 'active'],
    ]);
  });

  test('deactivate and reactivate flip status', async () => {
    const chain = await commitWalletAccount(rows);
    await getDb().transaction((tx) => ingestFindOrCreate(chain, 'etherscan', tx));
    const owner = await commitExchange(rows, { evidence: true });
    await store(owner);
    const statuses = async () =>
      [...(await inputsOf(chain.account.id)), ...(await inputsOf(owner.account.id))].map(
        (i) => i.status
      );
    expect(await statuses()).toEqual(['active', 'active']);

    await wallets().deleteWallet(chain.walletId);
    await credentials().deleteCredentials(owner.userId, owner.institutionId);
    expect(await statuses()).toEqual(['disconnected', 'disconnected']);

    await wallets().updateWallet(chain.walletId, { isActive: true });
    expect(await statuses()).toEqual(['active', 'disconnected']);
  });

  test('removing the wallet clears the link and disconnects the input', async () => {
    const chain = await commitWalletAccount(rows);
    await getDb().transaction((tx) => ingestFindOrCreate(chain, 'etherscan', tx));
    await wallets().updateWallet(chain.walletId, { isActive: true });
    expect((await inputsOf(chain.account.id)).map((i) => i.walletId)).toEqual([chain.walletId]);

    await wallets().hardDeleteWallet(chain.walletId, chain.userId);

    expect((await inputsOf(chain.account.id)).map(shape)).toEqual([
      { source: 'etherscan', credentialId: null, walletId: null, status: 'disconnected' },
    ]);
  });

  test('deleting the credential keeps the input with credential_id NULL (control)', async () => {
    const owner = await commitExchange(rows, { evidence: true });
    const credential = await store(owner);
    const [linked] = await inputsOf(owner.account.id);
    expect(linked?.credentialId).toBe(credential.id);

    await getDb()
      .delete(schema.userIntegrationCredentials)
      .where(eq(schema.userIntegrationCredentials.id, credential.id));

    expect((await inputsOf(owner.account.id)).map((i) => [i.id, i.credentialId, i.status])).toEqual(
      [[linked!.id, null, 'active']]
    );
  });

  /** Connecting is what the person asked for; the inputs are bookkeeping (D-1). */
  test('a connect whose inputs cannot be written still connects', async () => {
    const owner = await commitExchange(rows, { evidence: true });
    spies.push(
      spyOn(repo(), 'findAccountInputFacts').mockRejectedValue(new Error('inputs unavailable'))
    );

    const credential = await store(owner);

    expect([credential.isActive, credential.importStatus]).toEqual([true, 'pending_enqueue']);
    expect(await inputsOf(owner.account.id)).toEqual([]);
  });
});

/**
 * A connect and an import's find-or-create on one account: one input either
 * way, by the (account, source) key, and neither fails. Each holds only that
 * account's input rows, so neither can wait on the other while holding what
 * the other needs (N2: the import's order is account, input, holdings).
 */
describe('a connect racing an import’s findOrCreate on one account', () => {
  test('the import holds the input it created: the connect waits, then links that one input', async () => {
    const owner = await commitExchange(rows, { evidence: true });
    const held = latch();
    const release = latch();
    let importPid: number | undefined;
    let importedId: string | undefined;
    const imported = getDb().transaction(async (tx) => {
      importPid = await backendPid(tx);
      importedId = (await ingestFindOrCreate(owner, owner.source, tx)).id;
      held.open();
      await release.passed;
    });

    let connectPid: number | undefined;
    let connect: ReturnType<typeof store> | undefined;
    let blocked = false;
    try {
      await Promise.race([held.passed, imported]);
      const insertMissing = repo().insertMissing.bind(repo());
      spies.push(
        spyOn(repo(), 'insertMissing').mockImplementation(async (planned, tx) => {
          connectPid = await backendPid(tx);
          return await insertMissing(planned, tx);
        })
      );
      connect = store(owner);
      blocked = await waitUntilBlocked({ pid: () => connectPid, settled: connect }, importPid!);
    } finally {
      release.open();
    }
    const outcomes = await Promise.allSettled([imported, connect]);

    expect({ blocked, outcomes: outcomes.map(outcomeOf) }).toEqual({
      blocked: true,
      outcomes: ['fulfilled', 'fulfilled'],
    });
    const inputs = await inputsOf(owner.account.id);
    expect(inputs.map((i) => [i.source, i.status])).toEqual([[owner.source, 'active']]);
    expect(inputs[0]?.id).toBe(importedId);
    expect(inputs[0]?.credentialId).toBe((await connect)!.id);
  });

  /**
   * The common case in production: ingest made the input long before the
   * connect, unlinked (R39), and an import's findOrCreate holds it. The
   * connect's insert finds it there and writes nothing, so the connect waits
   * in linkAndSetStatus, on that one row.
   */
  test('the import holds an input that already existed: the connect waits in linkAndSetStatus, then links it', async () => {
    const owner = await commitExchange(rows, { evidence: true });
    const existing = await getDb().transaction((tx) => ingestFindOrCreate(owner, owner.source, tx));
    const held = latch();
    const release = latch();
    let importPid: number | undefined;
    const imported = getDb().transaction(async (tx) => {
      importPid = await backendPid(tx);
      await ingestFindOrCreate(owner, owner.source, tx);
      held.open();
      await release.passed;
    });

    let connectPid: number | undefined;
    let connect: ReturnType<typeof store> | undefined;
    let blocked = false;
    try {
      await Promise.race([held.passed, imported]);
      const linkAndSetStatus = repo().linkAndSetStatus.bind(repo());
      spies.push(
        spyOn(repo(), 'linkAndSetStatus').mockImplementation(async (planned, tx) => {
          connectPid = await backendPid(tx);
          return await linkAndSetStatus(planned, tx);
        })
      );
      connect = store(owner);
      blocked = await waitUntilBlocked({ pid: () => connectPid, settled: connect }, importPid!);
    } finally {
      release.open();
    }
    const outcomes = await Promise.allSettled([imported, connect]);

    expect({ blocked, outcomes: outcomes.map(outcomeOf) }).toEqual({
      blocked: true,
      outcomes: ['fulfilled', 'fulfilled'],
    });
    expect((await inputsOf(owner.account.id)).map((i) => [i.id, i.credentialId, i.status])).toEqual(
      [[existing.id, (await connect)!.id, 'active']]
    );
  });

  test('the connect holds the input it created: the import waits, then takes that one input', async () => {
    const owner = await commitExchange(rows, { evidence: true });
    const atLink = latch();
    const proceed = latch();
    let connectPid: number | undefined;
    const linkAndSetStatus = repo().linkAndSetStatus.bind(repo());
    spies.push(
      spyOn(repo(), 'linkAndSetStatus').mockImplementation(async (planned, tx) => {
        connectPid = await backendPid(tx);
        atLink.open();
        await proceed.passed;
        return await linkAndSetStatus(planned, tx);
      })
    );
    const connect = store(owner);

    let importPid: number | undefined;
    let imported: Promise<FeedInput | undefined> = Promise.resolve(undefined);
    let blocked = false;
    try {
      await Promise.race([atLink.passed, connect]);
      imported = getDb().transaction(async (tx) => {
        importPid = await backendPid(tx);
        return await ingestFindOrCreate(owner, owner.source, tx);
      });
      blocked = await waitUntilBlocked({ pid: () => importPid, settled: imported }, connectPid!);
    } finally {
      proceed.open();
    }
    const outcomes = await Promise.allSettled([connect, imported]);

    expect({ blocked, outcomes: outcomes.map(outcomeOf) }).toEqual({
      blocked: true,
      outcomes: ['fulfilled', 'fulfilled'],
    });
    const inputs = await inputsOf(owner.account.id);
    expect(inputs).toHaveLength(1);
    expect((await imported)?.id).toBe(inputs[0]?.id);
    expect([inputs[0]?.credentialId, inputs[0]?.status]).toEqual([(await connect).id, 'active']);
  });
});
