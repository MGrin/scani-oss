import { describe, expect, test } from 'bun:test';
import { warmUiVersion } from '../../src/lib/warm-ui-version';

/**
 * The gate, not the fetch. What `warmUiVersion` *loads* is a chunk that only
 * exists after a build; what it decides is whether to load anything at all,
 * and that decision is the whole of SC-132 #2 and SC-164.
 *
 * `hasCachedUser` is passed explicitly so these do not depend on
 * `localStorage` — which is exactly the storage the SC-164 case is about
 * losing.
 */
describe('warmUiVersion', () => {
  test('a first-time visitor warms nothing', () => {
    expect(warmUiVersion('/', false)).toBeNull();
    expect(warmUiVersion('/holdings', false)).toBeNull();
    expect(warmUiVersion('/auth', false)).toBeNull();
  });

  test('a device that has held a session warms the generation it will get', () => {
    expect(warmUiVersion('/', true)).not.toBeNull();
  });

  test('the magic-link callback warms even with no hint left on the device', () => {
    // WebKit clears script-writable storage after seven days, which takes the
    // hint with it — and a reader past seven days is who clicks a magic link.
    // The path itself is the evidence: it is the redirect target of a verify
    // that has already minted the session cookie (SC-164).
    expect(warmUiVersion('/auth/callback', false)).not.toBeNull();
    expect(warmUiVersion('/auth/callback/', false)).not.toBeNull();
  });

  test('a path that merely starts with the callback is not the callback', () => {
    expect(warmUiVersion('/auth/callback-something', false)).toBeNull();
  });
});
