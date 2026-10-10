import { describe, expect, test } from 'bun:test';
import { CacheWriteCounter, cacheWritesKey } from '../../../src/services/feeds/CacheWriteCounter';

const at = (iso: string) => new Date(iso);

describe('CacheWriteCounter (SC-1610)', () => {
  test('keys a UTC day and a trigger', () => {
    expect(cacheWritesKey(at('2026-10-08T23:59:59Z'), 'hourly')).toBe(
      'cache:writes:2026-10-08:hourly'
    );
  });

  test('sums a day per trigger, and keeps the triggers and the days apart', async () => {
    const counter = new CacheWriteCounter();
    await counter.add('hourly', 3, at('2026-10-08T01:00:00Z'));
    await counter.add('hourly', 2, at('2026-10-08T02:00:00Z'));
    await counter.add('active', 4, at('2026-10-08T02:03:00Z'));
    await counter.add('hourly', 7, at('2026-10-09T00:00:00Z'));

    expect(await counter.read(at('2026-10-08T12:00:00Z'), 'hourly')).toBe(5);
    expect(await counter.read(at('2026-10-08T12:00:00Z'), 'active')).toBe(4);
    expect(await counter.read(at('2026-10-09T12:00:00Z'), 'hourly')).toBe(7);
  });

  test('a run that wrote nothing still reads as 0, not as absent', async () => {
    const counter = new CacheWriteCounter();
    await counter.add('active', 0, at('2026-10-08T02:18:00Z'));
    expect(await counter.read(at('2026-10-08T02:18:00Z'), 'active')).toBe(0);
  });
});
