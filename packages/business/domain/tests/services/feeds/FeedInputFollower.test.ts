/**
 * `FeedInputFollower` brings the inputs of the accounts it is given up to D-7:
 * it creates what `planFeedInputs` plans, links a NULL credential or wallet,
 * and sets the status the connection gives (A2 Task 20). It touches only those
 * accounts, one transaction each, and never fails its caller.
 *
 * It writes through its own connection, so the fixtures are committed.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { databaseErrorOf } from '../../../src/lib/database-error';
import { FeedInputRepository } from '../../../src/repositories/FeedInputRepository';
import { FeedInputFollower } from '../../../src/services/feeds/FeedInputFollower';
import { committedRows } from '../../../test/helpers/committed-rows';
import { commitExchange } from '../../../test/helpers/committed-seeds';
import {
  backendPid,
  latch,
  settlesWithin,
  waitUntilBlocked,
} from '../../../test/helpers/lock-wait';

const rows = committedRows();
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await rows.drop();
});

const follower = () => Container.get(FeedInputFollower);

/** Two accounts at one connected exchange, each holding what its sync writes. */
const connectedExchange = () =>
  commitExchange(rows, { accounts: 2, evidence: true, connected: true });

const idsOf = (accounts: ReadonlyArray<{ id: string }>) => accounts.map((a) => a.id);

const inputs = (userId: string) =>
  getDb()
    .select()
    .from(schema.feedInputs)
    .where(eq(schema.feedInputs.userId, userId))
    .orderBy(asc(schema.feedInputs.accountId));

describe('FeedInputFollower.follow', () => {
  test('follows only the accounts it is given', async () => {
    const owner = await connectedExchange();
    const [given, other] = idsOf(owner.accounts) as [string, string];

    await follower().follow(owner.userId, { accountIds: [given] });

    expect(
      (await inputs(owner.userId)).map((i) => [i.accountId, i.source, i.credentialId, i.status])
    ).toEqual([[given, owner.source, owner.credentialId, 'active']]);

    await follower().follow(owner.userId, { accountIds: [other] });
    expect((await inputs(owner.userId)).map((i) => i.accountId)).toEqual([given, other]);
  });

  test("by institution, it follows every one of the user's accounts there", async () => {
    const owner = await connectedExchange();

    await follower().follow(owner.userId, { institutionId: owner.institutionId });

    expect((await inputs(owner.userId)).map((i) => [i.accountId, i.credentialId])).toEqual(
      idsOf(owner.accounts).map((id) => [id, owner.credentialId])
    );
  });

  test("one account's failure leaves the others followed, and nothing reaches the caller", async () => {
    const owner = await connectedExchange();
    const [failing, passing] = idsOf(owner.accounts) as [string, string];
    const repo = Container.get(FeedInputRepository);
    const insertMissing = repo.insertMissing.bind(repo);
    spies.push(
      spyOn(repo, 'insertMissing').mockImplementation(async (planned, tx) => {
        if (planned.some((p) => p.accountId === failing)) throw new Error('this account fails');
        return await insertMissing(planned, tx);
      })
    );

    await follower().follow(owner.userId, { institutionId: owner.institutionId });

    expect((await inputs(owner.userId)).map((i) => i.accountId)).toEqual([passing]);
  });

  /**
   * The follow runs on request paths — a connect, an account's removal — and an
   * ingest holds its input FOR NO KEY UPDATE for its whole run (N2). Its lock
   * timeout is 5s, so the follow gives that account up well inside twice that,
   * as the same warning any other failure ends in, and the caller is not held.
   */
  test('an input another transaction holds ends the follow at its lock timeout, as a warning', async () => {
    const owner = await commitExchange(rows, { evidence: true, connected: true });
    const repo = Container.get(FeedInputRepository);
    const input = {
      userId: owner.userId,
      accountId: owner.account.id,
      source: owner.source,
      credentialId: null,
      walletId: null,
    };
    await getDb().transaction((tx) => repo.findOrCreate(input, tx));

    const held = latch();
    const release = latch();
    let holderPid: number | undefined;
    const holder = getDb().transaction(async (tx) => {
      holderPid = await backendPid(tx);
      await repo.findOrCreate(input, tx);
      held.open();
      await release.passed;
    });

    let followPid: number | undefined;
    let refusedWith: string | undefined;
    const linkAndSetStatus = repo.linkAndSetStatus.bind(repo);
    spies.push(
      spyOn(repo, 'linkAndSetStatus').mockImplementation(async (planned, tx) => {
        followPid = await backendPid(tx);
        try {
          return await linkAndSetStatus(planned, tx);
        } catch (error) {
          refusedWith = databaseErrorOf(error)?.code;
          throw error;
        }
      })
    );
    const { logger } = follower() as unknown as { logger: { warn: (...args: unknown[]) => void } };
    const warn = spyOn(logger, 'warn');
    spies.push(warn);

    let follow: Promise<void> = Promise.resolve();
    let blocked = false;
    let ended = false;
    try {
      await Promise.race([held.passed, holder]);
      follow = follower().follow(owner.userId, { accountIds: [owner.account.id] });
      blocked = await waitUntilBlocked({ pid: () => followPid, settled: follow }, holderPid!);
      ended = await settlesWithin(follow, 10_000);
    } finally {
      release.open();
    }
    await Promise.allSettled([holder, follow]);

    expect({ blocked, ended, refusedWith }).toEqual({
      blocked: true,
      ended: true,
      refusedWith: '55P03',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain(owner.account.id);
    expect((await inputs(owner.userId)).map((i) => [i.credentialId, i.status])).toEqual([
      [null, 'active'],
    ]);
  }, 30_000);

  /**
   * A credential can go back to active (SC-1534), so the status a follow
   * writes has to come from a read that no connect or disconnect can move
   * under it: the credential row is taken FOR SHARE first. Here a disconnect
   * is still uncommitted when the follow starts. An unlocked read sees the
   * credential active, changes nothing and returns, and the input is left
   * `active` beside a disconnected credential.
   */
  test('a follow waits for an uncommitted change to the credential, and writes the status it then reads', async () => {
    const owner = await commitExchange(rows, { evidence: true, connected: true });
    const account = { accountIds: [owner.account.id] };
    await follower().follow(owner.userId, account);
    expect((await inputs(owner.userId)).map((i) => i.status)).toEqual(['active']);

    const held = latch();
    const release = latch();
    const holder = getDb().transaction(async (tx) => {
      await tx
        .update(schema.userIntegrationCredentials)
        .set({ isActive: false })
        .where(eq(schema.userIntegrationCredentials.id, owner.credentialId!));
      held.open();
      await release.passed;
    });

    let follow: Promise<void> = Promise.resolve();
    let waited = false;
    try {
      await Promise.race([held.passed, holder]);
      follow = follower().follow(owner.userId, account);
      waited = !(await settlesWithin(follow, 1_500));
    } finally {
      release.open();
    }
    await Promise.allSettled([holder, follow]);

    expect(waited).toBe(true);
    expect((await inputs(owner.userId)).map((i) => i.status)).toEqual(['disconnected']);
  }, 30_000);
});
