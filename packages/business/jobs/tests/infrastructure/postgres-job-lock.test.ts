/**
 * SC-1763: the hourly pricing step on 2026-10-21 finished its work at
 * 19:00:29Z and then hung to its 30-minute limit. Neon had dropped
 * connections at 19:00:18Z, and the job lock held its advisory lock on a
 * reserved pool connection, so the unlock went to a dead socket and never
 * settled. The lock dies the way production lost it: its backend is
 * terminated from the server side.
 */
import { describe, expect, test } from 'bun:test';
import { AdvisoryLockLostError } from '@scani/db';
import { client } from '@scani/db/connection';
import { advisoryLockKey } from '../../../../infra/db/src/advisory-lock-key';
import { PostgresJobLock } from '../../src/infrastructure/postgres-job-lock';

const SETTLE_MS = 10_000;

async function killLockBackend(name: string): Promise<void> {
  const k = advisoryLockKey(name).toString();
  const rows = (await client.unsafe(
    `select pid from pg_locks
      where locktype = 'advisory' and granted and objsubid = 1
        and classid = (($1::bigint >> 32) & 4294967295)::oid
        and objid = ($1::bigint & 4294967295)::oid`,
    [k]
  )) as Array<{ pid: number }>;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error(`no backend holds ${name}`);
  await client`select pg_terminate_backend(${pid})`;
  await Bun.sleep(300);
}

function settles<T>(work: Promise<T>): Promise<'settled' | 'hung'> {
  return Promise.race([
    work.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    Bun.sleep(SETTLE_MS).then(() => 'hung' as const),
  ]);
}

const uniqueName = (what: string) => `sc1763:${what}:${process.pid}:${Date.now()}`;

describe('PostgresJobLock when its connection dies (SC-1763)', () => {
  test(
    'the step settles instead of hanging on the release',
    async () => {
      const name = uniqueName('dies');
      const run = new PostgresJobLock().withLock(name, async () => {
        await killLockBackend(name);
        return 'priced';
      });
      expect(await settles(run)).toBe('settled');
      // A lost lock is a failed step the group retries, never a clean run.
      await expect(run).rejects.toBeInstanceOf(AdvisoryLockLostError);
    },
    SETTLE_MS + 5_000
  );

  test('control: a held lock runs fn once, and a second caller is skipped meanwhile', async () => {
    const name = uniqueName('control');
    const lock = new PostgresJobLock();
    let inner: { ran: boolean } | undefined;
    const outer = await lock.withLock(name, async () => {
      inner = await lock.withLock(name, async () => 'second');
      return 'first';
    });
    expect(outer).toEqual({ ran: true, result: 'first' });
    expect(inner?.ran).toBe(false);
    expect((await lock.withLock(name, async () => 'again')).ran).toBe(true);
  });
});
