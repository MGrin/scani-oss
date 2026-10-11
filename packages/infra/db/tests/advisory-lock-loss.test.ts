/**
 * SC-1613: a session advisory lock dies with its connection, and Postgres
 * frees it. The holder must find out before it writes again, and closing the
 * dead connection must not crash the process.
 *
 * The loss is made the way production lost it: the lock's backend goes away
 * from the server side (`pg_terminate_backend`), so the client learns of it
 * only from the socket.
 */
import { describe, expect, test } from 'bun:test';
import { AdvisoryLockLostError, withAdvisoryLock } from '../src/advisory-lock';
import { advisoryLockKey } from '../src/advisory-lock-key';
import { client } from '../src/connection';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lockBackendPid(key: string): Promise<number | undefined> {
  const k = advisoryLockKey(key).toString();
  const rows = (await client.unsafe(
    `select pid from pg_locks
      where locktype = 'advisory' and granted and objsubid = 1
        and classid = (($1::bigint >> 32) & 4294967295)::oid
        and objid = ($1::bigint & 4294967295)::oid`,
    [k]
  )) as Array<{ pid: number }>;
  return rows[0]?.pid;
}

async function killLockBackend(key: string): Promise<void> {
  const pid = await lockBackendPid(key);
  if (pid === undefined) throw new Error(`no backend holds ${key}`);
  await client`select pg_terminate_backend(${pid})`;
  await sleep(300);
}

const uniqueKey = (name: string) => `sc1613:${name}:${process.pid}:${Date.now()}`;

describe('withAdvisoryLock when its connection dies (SC-1613)', () => {
  test('the holder learns of the loss before its next write, and a second caller gets the lock', async () => {
    const key = uniqueKey('assert');
    let secondRan: boolean | undefined;
    let wroteAfterLoss = false;

    const first = withAdvisoryLock(key, async (lock) => {
      await killLockBackend(key);
      secondRan = (await withAdvisoryLock(key, async () => 'second')).ran;
      await lock.assertHeld();
      wroteAfterLoss = true;
    });

    await expect(first).rejects.toBeInstanceOf(AdvisoryLockLostError);
    expect(secondRan).toBe(true);
    expect(wroteAfterLoss).toBe(false);
  });

  test('the signal aborts when the connection closes', async () => {
    const key = uniqueKey('signal');
    let abortedWith: unknown;
    const run = withAdvisoryLock(key, async (lock) => {
      expect(lock.signal.aborted).toBe(false);
      await killLockBackend(key);
      abortedWith = lock.signal.reason;
    });
    await expect(run).rejects.toBeInstanceOf(AdvisoryLockLostError);
    expect(abortedWith).toBeInstanceOf(AdvisoryLockLostError);
  });

  test('a holder that never checks still reports the loss rather than a clean run', async () => {
    const key = uniqueKey('unchecked');
    await expect(
      withAdvisoryLock(key, async () => {
        await killLockBackend(key);
        return 'done';
      })
    ).rejects.toBeInstanceOf(AdvisoryLockLostError);
  });

  test('control: a held lock runs fn, passes assertHeld, and is free afterwards', async () => {
    const key = uniqueKey('control');
    const outcome = await withAdvisoryLock(key, async (lock) => {
      await lock.assertHeld();
      expect((await withAdvisoryLock(key, async () => 'other')).ran).toBe(false);
      return 42;
    });
    expect(outcome).toEqual({ ran: true, result: 42 });
    await sleep(100);
    expect(await lockBackendPid(key)).toBeUndefined();
    expect(await withAdvisoryLock(key, async () => 'after')).toEqual({
      ran: true,
      result: 'after',
    });
  });

  // Keys hash into signed int64, so about half are negative and split across
  // pg_locks' classid/objid differently from a positive one.
  test.each([
    ['sc1613:negative', -1n],
    ['sc1613:positive', 1n],
  ])('control: %s is found held and refuses a second caller', async (key, sign) => {
    expect(advisoryLockKey(key) * sign > 0n).toBe(true);
    const outcome = await withAdvisoryLock(key, async (lock) => {
      await lock.assertHeld();
      return (await withAdvisoryLock(key, async () => 'other')).ran;
    });
    expect(outcome).toEqual({ ran: true, result: false });
  });

  test('the shared pool still answers after a lock was lost', async () => {
    const key = uniqueKey('pool');
    await withAdvisoryLock(key, async () => killLockBackend(key)).catch(() => {});
    const rows = await Promise.all(Array.from({ length: 30 }, () => client`select 1 as one`));
    expect(rows.every((r) => r[0]?.one === 1)).toBe(true);
  });
});
