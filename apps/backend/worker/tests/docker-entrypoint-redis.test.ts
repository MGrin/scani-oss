import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// SC-1349: the embedded Redis is reachable on the Fly org's private network,
// demo apps included, so its admin commands are disabled. This pins both
// halves: the dangerous ones are off, and nothing the apps send is.

const entrypoint = readFileSync(join(import.meta.dir, '..', 'docker-entrypoint.sh'), 'utf8');
const config = entrypoint.slice(
  entrypoint.indexOf('cat > /tmp/redis-scani.conf <<EOF'),
  entrypoint.indexOf('\nEOF\n', entrypoint.indexOf('cat > /tmp/redis-scani.conf <<EOF'))
);
const disabled = new Set(
  [...config.matchAll(/^rename-command (\S+) ""$/gm)].map((m) => (m[1] as string).toUpperCase())
);

const USED = [
  'SET',
  'GET',
  'INCRBY',
  'EXPIRE',
  'PEXPIRE',
  'ZADD',
  'ZCARD',
  'ZRANGE',
  'ZREMRANGEBYSCORE',
  'EVAL',
  'EVALSHA',
  'MULTI',
  'EXEC',
  'SCAN',
  'UNLINK',
  'DEL',
  'PUBLISH',
  'PSUBSCRIBE',
  'PUNSUBSCRIBE',
  'SUBSCRIBE',
  'UNSUBSCRIBE',
  'INFO',
  'PING',
  'AUTH',
  'QUIT',
  'SELECT',
  'CLIENT',
];

describe('embedded Redis config (SC-1349)', () => {
  test.each([
    'FLUSHALL',
    'FLUSHDB',
    'CONFIG',
    'DEBUG',
    'MODULE',
    'REPLICAOF',
    'SLAVEOF',
    'MIGRATE',
  ])('disables %s', (command) => {
    expect(disabled.has(command)).toBe(true);
  });

  test('disables no command the apps send', () => {
    expect(USED.filter((command) => disabled.has(command))).toEqual([]);
  });

  test('still requires a password', () => {
    expect(config).toContain('requirepass $REDIS_PASS');
  });
});
