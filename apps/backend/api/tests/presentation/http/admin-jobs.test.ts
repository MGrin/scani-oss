import { describe, expect, it } from 'bun:test';
import IORedis, { Pipeline as IORedisPipeline } from 'ioredis';
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

  // SC-1043 FLIPPED THIS. It asserted `commands: [['ZCARD', ...]]` and was the
  // one test that pinned the defect: uppercase is what the ALLOWLIST is keyed
  // on (`REDIS_READ_COMMANDS.has(name.toUpperCase())`, still correct and
  // unchanged), but it is not what ioredis accepts. The direction of the
  // normalisation is load-bearing, so it is asserted rather than left to the
  // crossing tests below.
  it('normalizes command names to lowercase — the case ioredis defines', () => {
    const result = validateRedisReadCommands([['ZCARD', 'rl:coingecko']]);
    expect(result).toEqual({ ok: true, commands: [['zcard', 'rl:coingecko']] });
    // The allowlist is still case-insensitive on the way IN.
    expect(validateRedisReadCommands([['zcard', 'rl:coingecko']])).toEqual({
      ok: true,
      commands: [['zcard', 'rl:coingecko']],
    });
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

/**
 * SC-1043 — the crossing from the validator into the client, which nothing
 * tested. The cases above assert the validator's OUTPUT SHAPE; the route then
 * hands that output to `redis.pipeline(...)`, and every one of those names was
 * rejected by ioredis. A pure-function assertion cannot see that, so
 * `POST /admin/jobs/redis-read` 500'd on every call from the day the route
 * became reachable (SC-1032 fixed the gate that had been refusing first).
 *
 * `ioredis` resolves a pipeline entry's first element as a METHOD NAME on the
 * Pipeline object and defines those LOWERCASE, so an uppercase name resolves
 * to `undefined` and `this[commandName].apply` throws. The throw is at
 * pipeline CONSTRUCTION, not at `exec()`, which is what lets these run with no
 * Redis server: `lazyConnect` never opens a socket.
 *
 * The `REJECTS` case at the end is the control. Without it a green here is
 * indistinguishable from a test that constructs nothing — it is what proves
 * this instrument can come back red.
 */
describe('SC-1043: the validator emits names ioredis will accept', () => {
  const lazyClient = () => new IORedis({ lazyConnect: true, port: 1, retryStrategy: () => null });

  // Every allowlisted command, not just the one the admin app happens to
  // send today. ZCARD is providerStatus.ts's only caller, so a spot check on
  // it would leave the other six untested against the client.
  const ALLOWLISTED: Array<[string, Array<string | number>]> = [
    ['LLEN', ['rl:coingecko']],
    ['LRANGE', ['rl:coingecko', 0, 9]],
    ['LPOS', ['rl:coingecko', '123']],
    ['ZCARD', ['rl:coingecko']],
    ['ZRANGE', ['rl:coingecko', 0, 49]],
    ['ZSCORE', ['rl:coingecko', '123']],
    ['HGETALL', ['rl:coingecko']],
  ];

  it.each(
    ALLOWLISTED
  )('%s: the validated pipeline builds against a real ioredis client', (name, argv) => {
    const validated = validateRedisReadCommands([[name, ...argv]]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const client = lazyClient();
    try {
      // The exact call the route makes at admin-jobs.ts's
      // `redis.pipeline(validated.commands)`. This threw for all seven.
      expect(() => client.pipeline(validated.commands)).not.toThrow();
    } finally {
      client.disconnect();
    }
  });

  it('emits names that are real methods on ioredis Pipeline, whatever case came in', () => {
    // Both directions: the admin app sends uppercase (providerStatus.ts),
    // and a hand-rolled caller may send lowercase. Neither may reach Redis
    // in a form it does not define.
    for (const incoming of ['ZCARD', 'zcard', 'ZcArD']) {
      const validated = validateRedisReadCommands([[incoming, 'rl:coingecko']]);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const emitted = validated.commands[0]?.[0] as string;
      expect(
        typeof (IORedisPipeline.prototype as unknown as Record<string, unknown>)[emitted]
      ).toBe('function');
    }
  });

  it('CONTROL: an uppercase name really does throw, so the cases above can fail', () => {
    const client = lazyClient();
    try {
      // Not routed through the validator on purpose — this asserts the
      // property of ioredis that the cases above depend on. If ioredis ever
      // starts accepting uppercase, this goes red and they become vacuous.
      expect(() => client.pipeline([['ZCARD', 'rl:coingecko']])).toThrow();
      expect(() => client.pipeline([['zcard', 'rl:coingecko']])).not.toThrow();
    } finally {
      client.disconnect();
    }
  });
});
