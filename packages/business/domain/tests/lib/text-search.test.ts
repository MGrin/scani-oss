import { describe, expect, test } from 'bun:test';
import { ilikePattern } from '../../src/lib/text-search';

describe('ilikePattern', () => {
  test('wraps the term so it matches anywhere in the value', () => {
    expect(ilikePattern('revolut')).toBe('%revolut%');
  });

  test('trims, because a search box collects spaces', () => {
    expect(ilikePattern('  revolut ')).toBe('%revolut%');
  });

  /**
   * `null` rather than `'%%'`. The empty pattern matches every row, so the
   * caller would run a search that reads as a search and behaves as none — the
   * same one-value-two-facts shape as the ticket this exists for.
   */
  test('nothing to search for says so, rather than matching everything', () => {
    expect(ilikePattern('')).toBeNull();
    expect(ilikePattern('   ')).toBeNull();
    expect(ilikePattern(undefined)).toBeNull();
    expect(ilikePattern(null)).toBeNull();
  });

  /**
   * The three characters that are syntax inside a LIKE pattern. A reader who
   * types `%` means the character; unescaped it is the pattern that matches
   * their whole list and hands it back as a result.
   */
  test('a wildcard the reader typed is escaped into a character', () => {
    expect(ilikePattern('%')).toBe('%\\%%');
    expect(ilikePattern('_')).toBe('%\\_%');
    expect(ilikePattern('a\\b')).toBe('%a\\\\b%');
    expect(ilikePattern('50%_off')).toBe('%50\\%\\_off%');
  });
});
