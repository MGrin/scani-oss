/**
 * The guard is what stands between a green suite and an unattributable one,
 * so it is tested against a real Postgres rather than a stub: the whole
 * mechanism IS `pg_try_advisory_lock`, and a stub would assert our idea of it.
 *
 * Every case runs on its own random key. The real `SUITE_LOCK_KEY` is held by
 * the suite this test is running inside, so reusing it would make the
 * "acquires when free" case unreachable and the "busy" case pass for the
 * wrong reason.
 */

import { describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import {
  acquireSuiteLock,
  busyMessage,
  databaseNameOf,
  EXPECTED_NODE_ENV,
  nodeEnvRefusal,
} from '../test-suite-guard';

const DB_URL = process.env.DATABASE_URL as string;

function freshKey(): bigint {
  return BigInt(randomInt(1, 2 ** 30)) * 1_000_003n;
}

describe('acquireSuiteLock', () => {
  test('acquires a free key, and refuses the second holder of the same key', async () => {
    const key = freshKey();

    const first = await acquireSuiteLock(DB_URL, { key, pid: '111111' });
    expect(first.kind).toBe('acquired');

    const second = await acquireSuiteLock(DB_URL, { key, pid: '222222' });
    expect(second.kind).toBe('busy');
    if (second.kind !== 'busy') throw new Error('unreachable');
    // The point of the guard is naming WHO — a bare refusal would leave the
    // reader guessing which of their terminals to look at.
    expect(second.holder?.pid).toBe('111111');
    expect(second.holder?.backendPid).toBeGreaterThan(0);
  });

  test('two different keys do not contend, which is why two gate databases can run at once', async () => {
    const a = await acquireSuiteLock(DB_URL, { key: freshKey(), pid: '333333' });
    const b = await acquireSuiteLock(DB_URL, { key: freshKey(), pid: '444444' });
    expect(a.kind).toBe('acquired');
    expect(b.kind).toBe('acquired');
  });

  test('an unreachable database is reported, not thrown — a frontend-only run has no Postgres', async () => {
    const outcome = await acquireSuiteLock(
      'postgres://scani:scani@127.0.0.1:1/nothing?sslmode=disable',
      { key: freshKey() }
    );
    expect(outcome.kind).toBe('unreachable');
  });
});

describe('busyMessage', () => {
  test('names the database, the holder, and the command that fixes it', () => {
    const message = busyMessage('postgres://scani:scani@localhost:5433/scani?sslmode=disable', {
      pid: '4242',
      backendPid: 99,
      startedAt: '2026-08-18 07:00:00+00',
    });
    expect(message).toContain('"scani"');
    expect(message).toContain('pid 4242');
    expect(message).toContain('bun run db:migrate && bun run test');
    expect(message).toContain('SCANI_ALLOW_SHARED_TEST_DB=1');
  });

  test('still tells the reader what to do when the holder vanished mid-lookup', () => {
    const message = busyMessage('postgres://scani:scani@localhost:5433/scani', null);
    expect(message).toContain('bun run db:migrate && bun run test');
  });
});

describe('databaseNameOf', () => {
  test('reads the database out of a url, and degrades instead of throwing', () => {
    expect(databaseNameOf('postgres://u:p@localhost:5433/scani_gate_123?sslmode=disable')).toBe(
      'scani_gate_123'
    );
    expect(databaseNameOf('not a url')).toBe('<unparseable>');
  });
});

describe('nodeEnvRefusal', () => {
  test('passes only the value the suite is specified to run under', () => {
    expect(nodeEnvRefusal(EXPECTED_NODE_ENV)).toBeNull();
  });

  test('refuses the value a copied .env.example leaves behind, and names it', () => {
    const message = nodeEnvRefusal('development');
    expect(message).toContain('NODE_ENV=test');
    expect(message).toContain('"development"');
    expect(message).toContain('.env');
    // The leading newline+indent is load-bearing. The wrapper invocation this
    // replaced ENDED with "bun run test", so a bare toContain here passes
    // against the very message this test exists to reject — measured, it was
    // the one pin of the six that could not go red (SC-651).
    expect(message).toContain('\n  bun run test\n');
  });

  test('refuses an unset NODE_ENV rather than reading it as the default', () => {
    // `bun test` supplies its own `test` default, so unset reaches the suite
    // only when something stripped the variable — and @scani/logging treats
    // absent the same as development, which is the failing case again.
    expect(nodeEnvRefusal(undefined)).toContain('<unset>');
  });

  test('refuses production, which would flip every requiredInProd gate', () => {
    expect(nodeEnvRefusal('production')).toContain('"production"');
  });
});
