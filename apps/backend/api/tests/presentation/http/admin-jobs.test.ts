import { describe, expect, it } from 'bun:test';
import { validateRedisReadCommands } from '../../../src/presentation/http/admin-jobs';

describe('validateRedisReadCommands', () => {
  it('accepts a pipeline of whitelisted read commands on queue keys', () => {
    const result = validateRedisReadCommands([
      ['LLEN', 'bull:scani-jobs:wait'],
      ['ZRANGE', 'bull:scani-jobs:failed', 0, 49, 'REV'],
      ['HGETALL', 'bull:scani-jobs:123'],
      ['LPOS', 'bull:scani-jobs:active', '123'],
      ['ZSCORE', 'bull:scani-dlq:failed', '123'],
    ]);
    expect(result.ok).toBe(true);
  });

  it('accepts rate-limiter keys', () => {
    const result = validateRedisReadCommands([['ZCARD', 'rl:coingecko']]);
    expect(result.ok).toBe(true);
  });

  it('normalizes command names to uppercase', () => {
    const result = validateRedisReadCommands([['llen', 'bull:scani-jobs:wait']]);
    expect(result).toEqual({ ok: true, commands: [['LLEN', 'bull:scani-jobs:wait']] });
  });

  it.each([
    ['write command', [['DEL', 'bull:scani-jobs:wait']]],
    ['dangerous command', [['FLUSHALL', 'bull:x']]],
    ['generic read outside whitelist', [['GET', 'bull:scani-jobs:wait']]],
    ['keyspace scan', [['KEYS', 'bull:*']]],
    ['non-queue key', [['LLEN', 'admin:spend:overrides']]],
    ['key prefix smuggled after the first arg', [['LLEN', 'session:1', 'bull:x']]],
    ['missing key', [['LLEN']]],
    ['non-array entry', ['LLEN bull:scani-jobs:wait']],
    ['non-scalar arg', [['LRANGE', 'bull:scani-jobs:wait', { evil: true }]]],
    ['non-string command name', [[42, 'bull:scani-jobs:wait']]],
  ])('rejects %s', (_label, input) => {
    expect(validateRedisReadCommands(input).ok).toBe(false);
  });

  it('rejects non-array payloads and empty pipelines', () => {
    expect(validateRedisReadCommands(undefined).ok).toBe(false);
    expect(validateRedisReadCommands({}).ok).toBe(false);
    expect(validateRedisReadCommands([]).ok).toBe(false);
  });

  it('caps pipeline length at 256 commands', () => {
    const max = Array.from({ length: 256 }, () => ['LLEN', 'bull:scani-jobs:wait']);
    expect(validateRedisReadCommands(max).ok).toBe(true);
    expect(validateRedisReadCommands([...max, ['LLEN', 'bull:scani-jobs:wait']]).ok).toBe(false);
  });
});
