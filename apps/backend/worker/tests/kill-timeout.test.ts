import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * SC-1454. Fly kills the machine `kill_timeout` after the stop signal, and
 * its default is 5s. The worker drains for up to DRAIN_TIMEOUT_MS and only
 * then hands in-flight jobs back to `waiting`; a kill that lands first leaves
 * them `active` until the stalled check reclaims them, ten minutes or more
 * later. So the fly.toml key has to exist and outlast the drain.
 */

const WORKER = new URL('..', import.meta.url).pathname;
const POST_DRAIN_MARGIN_MS = 10_000;

function killTimeoutMs(toml: string): number | null {
  const value = (Bun.TOML.parse(toml) as { kill_timeout?: number | string }).kill_timeout;
  if (value === undefined) return null;
  if (typeof value === 'number') return value * 1000;
  const match = /^(\d+)s$/.exec(value);
  const seconds = match?.[1];
  if (!seconds) throw new Error(`kill_timeout ${value} is not in seconds`);
  return Number(seconds) * 1000;
}

function drainTimeoutMs(source: string): number {
  const match = /const DRAIN_TIMEOUT_MS = ([\d_]+);/.exec(source);
  const digits = match?.[1];
  if (!digits) throw new Error('DRAIN_TIMEOUT_MS not found in src/index.ts');
  return Number(digits.replaceAll('_', ''));
}

describe('worker kill_timeout (SC-1454)', () => {
  const toml = readFileSync(`${WORKER}fly.toml`, 'utf8');
  const drain = drainTimeoutMs(readFileSync(`${WORKER}src/index.ts`, 'utf8'));

  test('fly.toml sets kill_timeout, so Fly does not fall back to its 5s default', () => {
    expect(killTimeoutMs(toml)).not.toBeNull();
  });

  test('the machine outlives the drain budget plus the post-drain steps', () => {
    expect(killTimeoutMs(toml)).toBeGreaterThanOrEqual(drain + POST_DRAIN_MARGIN_MS);
  });

  test('control: a file without the key reads as unset, and 5s reads as too short', () => {
    expect(killTimeoutMs('app = "x"\n')).toBeNull();
    expect(killTimeoutMs('kill_timeout = "5s"\n')).toBeLessThan(drain + POST_DRAIN_MARGIN_MS);
  });
});

describe('stalled-job reclaim bound (SC-1454)', () => {
  const ROOT = new URL('../../../..', import.meta.url).pathname;
  const source = readFileSync(`${ROOT}packages/infra/queue/src/consumer/worker-client.ts`, 'utf8');
  const interval = Number(
    /const STALLED_INTERVAL_MS = ([\d_]+);/.exec(source)?.[1]?.replaceAll('_', '')
  );
  const WORST_CASE_MS = 20 * 60_000;

  test('a job orphaned by a hard death is reclaimed within two passes, at most ~20 min', () => {
    // First pass after boot only marks active jobs; the next reclaims them, and
    // the boot pass itself can be throttled by the dead worker's last one.
    expect(interval).toBeGreaterThan(0);
    expect(2 * interval).toBeLessThanOrEqual(WORST_CASE_MS);
  });

  test('the worker README states that bound', () => {
    const readme = readFileSync(`${WORKER}README.md`, 'utf8');
    expect(readme).toContain('up to ~20 min before the stalled check reclaims the job');
  });
});
