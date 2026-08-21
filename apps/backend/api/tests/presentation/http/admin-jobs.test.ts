import { describe, expect, it } from 'bun:test';
import { validateRedisReadCommands } from '../../../src/presentation/http/admin-jobs';

/**
 * SC-518 narrowed `REDIS_READ_KEY_PREFIXES` from `['bull:', 'rl:']` to `['rl:']`:
 * queue state moved to Postgres and the admin reads it there directly, so the
 * only thing still behind this proxy is the rate limiter's windows.
 *
 * That rewrite is why the rejection cases below assert a REASON and not just
 * `ok: false`. Every one of them used to carry a `bull:` key, and every one of
 * them kept passing after the narrowing — while silently testing the wrong
 * thing. "rejects a write command" was no longer reaching the command
 * whitelist at all; it was tripping on the prefix check first and returning
 * `ok: false` for a reason its own label does not mention.
 *
 * Three tests went red and told me. Seven went green and did not. Asserting the
 * reason is what makes the next prefix change break loudly instead of hollowing
 * these out again.
 */
describe('validateRedisReadCommands', () => {
  it('accepts a pipeline of whitelisted read commands on rate-limiter keys', () => {
    const result = validateRedisReadCommands([
      ['ZCARD', 'rl:coingecko'],
      ['ZRANGE', 'rl:etherscan', 0, 49, 'REV'],
      ['HGETALL', 'rl:binance-private'],
      ['LPOS', 'rl:solana', '123'],
      ['ZSCORE', 'rl:kraken-private', '123'],
    ]);
    expect(result.ok).toBe(true);
  });

  // RESTORED. The pre-SC-518 file had this single-command case alongside the
  // pipeline one above, and my first pass folded the two together. That is a
  // coverage decision, not a rewrite, and it is not mine to make silently —
  // the pipeline test could later be retargeted at something else and take
  // this assertion with it without anyone noticing.
  it('accepts a single rate-limiter key', () => {
    expect(validateRedisReadCommands([['ZCARD', 'rl:coingecko']]).ok).toBe(true);
  });

  it('normalizes command names to uppercase', () => {
    const result = validateRedisReadCommands([['zcard', 'rl:coingecko']]);
    expect(result).toEqual({ ok: true, commands: [['ZCARD', 'rl:coingecko']] });
  });

  // The narrowing itself, asserted rather than assumed. Queue keys were
  // reachable through this shared-HMAC endpoint until SC-518; they must not be
  // now, and a future edit re-adding `bull:` should have to delete this line.
  it('REJECTS queue keys — the bull: prefix left the whitelist in SC-518', () => {
    const result = validateRedisReadCommands([['LLEN', 'bull:scani-jobs:wait']]);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('key must start with') });
  });

  it.each([
    ['write command', [['DEL', 'rl:coingecko']], 'command not allowed'],
    ['dangerous command', [['FLUSHALL', 'rl:x']], 'command not allowed'],
    ['generic read outside whitelist', [['GET', 'rl:coingecko']], 'command not allowed'],
    ['keyspace scan', [['KEYS', 'rl:*']], 'command not allowed'],
    ['non-rate-limiter key', [['LLEN', 'admin:spend:overrides']], 'key must start with'],
    [
      'key prefix smuggled after the first arg',
      [['LLEN', 'session:1', 'rl:x']],
      'key must start with',
    ],
    ['missing key', [['LLEN']], 'each command must be'],
    ['non-array entry', ['LLEN rl:coingecko'], 'each command must be'],
    ['non-scalar arg', [['LRANGE', 'rl:coingecko', { evil: true }]], 'command args must be'],
    ['non-string command name', [[42, 'rl:coingecko']], 'command not allowed'],
  ])('rejects %s, and for the stated reason', (_label, input, reason) => {
    const result = validateRedisReadCommands(input);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining(reason as string) });
  });

  it('rejects non-array payloads and empty pipelines', () => {
    expect(validateRedisReadCommands(undefined).ok).toBe(false);
    expect(validateRedisReadCommands({}).ok).toBe(false);
    expect(validateRedisReadCommands([]).ok).toBe(false);
  });

  it('caps pipeline length at 256 commands', () => {
    const max = Array.from({ length: 256 }, () => ['ZCARD', 'rl:coingecko']);
    expect(validateRedisReadCommands(max).ok).toBe(true);
    const over = validateRedisReadCommands([...max, ['ZCARD', 'rl:coingecko']]);
    expect(over.ok).toBe(false);
    // Must trip on LENGTH, not on some earlier check — the previous fixture
    // used `bull:` keys, so after the narrowing this "length cap" test was
    // actually exercising the prefix check.
    expect(over).toMatchObject({ reason: expect.stringContaining('exceeds 256') });
  });
});
