import { describe, expect, test } from 'bun:test';
import { captureSignupSource, withSignupSource } from '@/lib/signup-source';

/**
 * SC-515. The client half carries a tag from the demo's link onto the
 * `callbackURL` of a magic-link sign-in; the server half decides what it means.
 * Every function takes its `Storage` so none of this needs a browser.
 *
 * Asserted through `withSignupSource` rather than a reader of its own, because
 * putting the tag on that URL is the only observable this module has — a tag
 * remembered and never forwarded is the same as one never captured.
 */

const CALLBACK = 'https://app.scani.xyz/auth/callback';

/** A `Storage` that is only what these functions use, plus a way to throw. */
function memoryStorage(opts: { throwOnSet?: boolean; throwOnGet?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      if (opts.throwOnGet) throw new Error('blocked');
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (opts.throwOnSet) throw new Error('QuotaExceeded');
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    key() {
      return null;
    },
    get length() {
      return map.size;
    },
  } as Storage;
}

/** Arrive with `search`, then sign in. Returns the callbackURL that goes out. */
function arriveAndSignIn(search: string, storage: Storage | null): string {
  captureSignupSource(search, storage);
  return withSignupSource(CALLBACK, storage);
}

describe('the tag survives from the demo link to the callbackURL', () => {
  test('a tagged arrival puts the tag on the callbackURL', () => {
    expect(arriveAndSignIn('?src=demo', memoryStorage())).toBe(`${CALLBACK}?src=demo`);
  });

  test('the CONTROL — an untagged arrival sends a byte-identical callbackURL', () => {
    // Not merely equivalent: an ordinary signup must not start sending a
    // different URL because this module exists.
    expect(arriveAndSignIn('?utm_campaign=x', memoryStorage())).toBe(CALLBACK);
    expect(arriveAndSignIn('', memoryStorage())).toBe(CALLBACK);
  });

  test('the tag survives a navigation — captured on landing, read at sign-in', () => {
    // The whole reason it is stored at all: `/?src=demo` redirects to `/auth`
    // before anybody types an email address.
    const storage = memoryStorage();
    captureSignupSource('?src=demo', storage);
    expect(withSignupSource(CALLBACK, storage)).toBe(`${CALLBACK}?src=demo`);
    expect(withSignupSource(CALLBACK, storage)).toBe(`${CALLBACK}?src=demo`);
  });
});

describe('what it refuses to carry', () => {
  test('a tag that is not a short slug, rather than forwarding it into a URL', () => {
    const search = `?src=${encodeURIComponent('https://evil.example/#')}`;
    expect(arriveAndSignIn(search, memoryStorage())).toBe(CALLBACK);
  });

  test('an over-long tag', () => {
    expect(arriveAndSignIn(`?src=${'a'.repeat(33)}`, memoryStorage())).toBe(CALLBACK);
  });

  test('a tag the caller built deliberately is not overwritten', () => {
    const storage = memoryStorage();
    captureSignupSource('?src=demo', storage);
    expect(withSignupSource(`${CALLBACK}?src=partner`, storage)).toBe(`${CALLBACK}?src=partner`);
  });

  test('an unparseable callbackURL is returned as it came', () => {
    const storage = memoryStorage();
    captureSignupSource('?src=demo', storage);
    expect(withSignupSource('::not a url::', storage)).toBe('::not a url::');
  });
});

describe('a browser that refuses storage', () => {
  test('loses the tag and nothing else', () => {
    // Safari with website data blocked throws on the property access itself.
    // The visit reads as `direct` on the server — an under-count, never a wrong
    // attribution, and never an exception on the sign-in path.
    expect(arriveAndSignIn('?src=demo', memoryStorage({ throwOnSet: true }))).toBe(CALLBACK);
    expect(arriveAndSignIn('?src=demo', memoryStorage({ throwOnGet: true }))).toBe(CALLBACK);
    expect(arriveAndSignIn('?src=demo', null)).toBe(CALLBACK);
  });
});
