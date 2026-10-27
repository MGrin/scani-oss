import { describe, expect, test } from 'bun:test';
import { returnsSpanAttributes } from '../../src/lib/returns-span';

// SC-1776: a getReturns miss on production could not say which request it was;
// the span carried the cache outcome and nothing about the window or scope.
describe('returnsSpanAttributes (SC-1776)', () => {
  const user = { kind: 'user' as const };

  test('names the window kind and the scope kind beside the cache outcome', () => {
    expect(
      returnsSpanAttributes({ hit: false, versionMs: 12 }, { scope: user, window: { kind: 'ytd' } })
    ).toEqual({
      'returns.cache': 'miss',
      'returns.version_ms': 12,
      'returns.window': 'ytd',
      'returns.scope': 'user',
    });
  });

  test('a custom window carries its length in days, so a period switch reads as one', () => {
    const attrs = returnsSpanAttributes(
      { hit: true, shared: true, versionMs: 3 },
      {
        scope: { kind: 'account', id: 'a1' },
        window: {
          kind: 'custom',
          from: new Date('2026-09-27T00:00:00Z'),
          to: new Date('2026-10-27T00:00:00Z'),
        },
      }
    );
    expect(attrs).toMatchObject({
      'returns.cache': 'shared',
      'returns.window': 'custom',
      'returns.window_days': 30,
      'returns.scope': 'account',
    });
  });

  test('a stale answer is tagged stale whatever else is set', () => {
    expect(
      returnsSpanAttributes(
        { hit: false, stale: true, versionMs: 1 },
        { scope: user, window: { kind: 'all' } }
      )['returns.cache']
    ).toBe('stale');
  });
});
