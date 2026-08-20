import { describe, expect, test } from 'bun:test';
import { warmInterface } from '../../src/lib/warm-interface';

/**
 * The gate, not the fetch. What `warmInterface` *loads* is a chunk that only
 * exists after a build; what it decides is whether to load anything at all,
 * and that decision is the whole of SC-132 #2 and SC-164.
 *
 * `hasCachedUser` is passed explicitly so these do not depend on
 * `localStorage` — which is exactly the storage the SC-164 case is about
 * losing.
 */
describe('warmInterface', () => {
  test('a first-time visitor warms nothing', () => {
    expect(warmInterface('/', false)).toBeNull();
    expect(warmInterface('/holdings', false)).toBeNull();
    expect(warmInterface('/auth', false)).toBeNull();
  });

  test('a device that has held a session warms the generation it will get', () => {
    expect(warmInterface('/', true)).not.toBeNull();
  });

  test('the magic-link callback warms even with no hint left on the device', () => {
    // WebKit clears script-writable storage after seven days, which takes the
    // hint with it — and a reader past seven days is who clicks a magic link.
    // The path itself is the evidence: it is the redirect target of a verify
    // that has already minted the session cookie (SC-164).
    expect(warmInterface('/auth/callback', false)).not.toBeNull();
    expect(warmInterface('/auth/callback/', false)).not.toBeNull();
  });

  test('a path that merely starts with the callback is not the callback', () => {
    expect(warmInterface('/auth/callback-something', false)).toBeNull();
  });
});
