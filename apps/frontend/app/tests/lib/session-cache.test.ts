import { describe, expect, test } from 'bun:test';
import {
  clearCachedUser,
  parseCachedUser,
  readCachedUser,
  writeCachedUser,
} from '@/lib/session-cache';

/**
 * SC-78 §2. Offline, the installed PWA's cold start landed on "Welcome / Enter
 * your email" — because a session probe that could not reach the server was
 * read as the answer "no session". This hint is what lets the shell say the
 * true thing instead. It is never a credential: nothing here grants access, and
 * a half-written or hand-edited value must reach a screen as "unknown", not as
 * a name.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

const user = { id: 'u1', email: 'steve@scani.xyz', name: 'Steve', image: null };

describe('the last-seen identity hint', () => {
  test('round-trips the fields the offline screen needs', () => {
    const store = memoryStorage();
    writeCachedUser(user, store);
    expect(readCachedUser(store)).toEqual(user);
  });

  test('is gone after it is cleared — sign-out and a real "no session" both do this', () => {
    const store = memoryStorage();
    writeCachedUser(user, store);
    clearCachedUser(store);
    expect(readCachedUser(store)).toBeNull();
  });

  test('reads as absent when there is no store at all', () => {
    expect(readCachedUser(null)).toBeNull();
    // Writing without a store is a no-op rather than a throw: a refusing
    // localStorage costs the offline screen a name and nothing else.
    expect(() => writeCachedUser(user, null)).not.toThrow();
    expect(() => clearCachedUser(null)).not.toThrow();
  });
});

describe('parsing a stored hint', () => {
  test('accepts a well-formed record', () => {
    expect(parseCachedUser(JSON.stringify(user))).toEqual(user);
  });

  test('rejects anything that is not a plausible user', () => {
    expect(parseCachedUser(null)).toBeNull();
    expect(parseCachedUser('')).toBeNull();
    expect(parseCachedUser('not json')).toBeNull();
    expect(parseCachedUser('"a string"')).toBeNull();
    expect(parseCachedUser('null')).toBeNull();
    expect(parseCachedUser(JSON.stringify({ email: 'no-id@scani.xyz' }))).toBeNull();
    expect(parseCachedUser(JSON.stringify({ id: 'u1' }))).toBeNull();
    expect(parseCachedUser(JSON.stringify({ id: '', email: 'a@b.c' }))).toBeNull();
    expect(parseCachedUser(JSON.stringify({ id: 1, email: 'a@b.c' }))).toBeNull();
  });

  test('normalises a missing name or image to null rather than undefined', () => {
    expect(parseCachedUser(JSON.stringify({ id: 'u1', email: 'a@b.c' }))).toEqual({
      id: 'u1',
      email: 'a@b.c',
      name: null,
      image: null,
    });
  });
});
