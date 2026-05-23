import { describe, expect, test } from 'bun:test';
import { LruCache } from '../../src/lib/lru-cache';

describe('LruCache', () => {
  test('returns undefined for missing keys', () => {
    const cache = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 });
    expect(cache.get('nope')).toBeUndefined();
  });

  test('returns the value for present, fresh keys', () => {
    const cache = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  test('expires entries past their TTL', async () => {
    const cache = new LruCache<string, number>({ maxEntries: 10, ttlMs: 10 });
    cache.set('a', 1);
    await new Promise((r) => setTimeout(r, 25));
    expect(cache.get('a')).toBeUndefined();
  });

  test('evicts the least-recently-used entry when over capacity', () => {
    const cache = new LruCache<string, number>({ maxEntries: 3, ttlMs: 10_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Touch 'a' so it becomes most-recently-used.
    cache.get('a');
    // Insert 'd' → over cap, evict the LRU which is now 'b'.
    cache.set('d', 4);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  test('updating an existing key bumps recency', () => {
    const cache = new LruCache<string, number>({ maxEntries: 2, ttlMs: 10_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 11); // Re-insert moves 'a' to back; 'b' is now LRU.
    cache.set('c', 3); // Should evict 'b'.
    expect(cache.get('a')).toBe(11);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  test('size reflects current entry count', () => {
    const cache = new LruCache<string, number>({ maxEntries: 5, ttlMs: 10_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);
    cache.delete('a');
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
