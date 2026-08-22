import { describe, expect, test } from 'bun:test';
import { buildInstitutionIconUrl, institutionIconUrl } from '../../src/lib/icons';

/**
 * SC-208. The client half: which URL an institution mark asks for.
 *
 * Split the same way `api-base-url.test.ts` splits its subject. `apiBaseUrl()`
 * reads `import.meta.env.VITE_API_URL`, which a build bakes in and `bun test`
 * does not have — so the URL SHAPE is asserted against the pure builder, and
 * the wrapper is asserted for the cases where it must produce no URL at all.
 */

const BASE = 'https://api.scani.xyz';

describe('buildInstitutionIconUrl — the shape', () => {
  test('points at our own api, keyed on the institution id', () => {
    expect(buildInstitutionIconUrl(BASE, { id: 'abc-123', website: 'https://chase.com' })).toBe(
      'https://api.scani.xyz/institution-icons/abc-123'
    );
  });

  test('NEVER at google.com — that is the whole ticket', () => {
    // A regression here is invisible in every other test: the <img> still
    // renders, the letter tile still works, and the only symptom is a
    // third-party request from a finance app on every row.
    const url = buildInstitutionIconUrl(BASE, { id: 'abc-123', website: 'https://chase.com' });
    expect(url).not.toContain('google.com');
    expect(url).not.toContain('gstatic.com');
  });

  test('the website is not in the URL, so it cannot name a host for the server to fetch', () => {
    const url = buildInstitutionIconUrl(BASE, { id: 'abc-123', website: 'https://evil.example/' });
    expect(url).not.toContain('evil.example');
  });

  test('the id is encoded rather than interpolated raw', () => {
    const url = buildInstitutionIconUrl(BASE, { id: 'a/../b', website: 'https://chase.com' });
    expect(url).not.toContain('/a/../b');
    expect(url).toContain('a%2F..%2Fb');
  });

  test('a relative base — the published image builds with VITE_API_URL=/api', () => {
    expect(buildInstitutionIconUrl('/api', { id: 'abc', website: 'https://chase.com' })).toBe(
      '/api/institution-icons/abc'
    );
  });

  test('no website means no request at all — the letter tile draws immediately', () => {
    expect(buildInstitutionIconUrl(BASE, { id: 'abc-123', website: null })).toBeNull();
    expect(buildInstitutionIconUrl(BASE, { id: 'abc-123' })).toBeNull();
  });

  test('a missing institution is null rather than a URL with `undefined` in it', () => {
    // `AccountsList` looks its institution up in a Map, so `undefined` is a
    // real value on this path, not a defensive hypothetical.
    expect(buildInstitutionIconUrl(BASE, undefined)).toBeNull();
    expect(buildInstitutionIconUrl(BASE, null)).toBeNull();
  });
});

describe('institutionIconUrl — what happens when the base cannot be resolved', () => {
  test('an unresolvable API base is a letter tile, NOT a thrown render', () => {
    // This test exists because writing it is what found the bug. `apiBaseUrl()`
    // THROWS when `VITE_API_URL` is absent, and `institutionIconUrl` is called
    // from render — so the first version of this turned every institution row
    // into an error boundary the moment a build shipped without that variable.
    // `getFaviconUrl`, which this replaced, could not throw at all.
    //
    // Under `bun test` there is no `import.meta.env.VITE_API_URL`, so this runs
    // the failing branch for real rather than by simulating it. If a future
    // build system starts providing one here, this case stops proving anything
    // and the assertion below is what should be re-pointed — do not delete it.
    expect(() => institutionIconUrl({ id: 'abc-123', website: 'https://chase.com' })).not.toThrow();
  });

  test('and the no-website short-circuit happens before the base is ever resolved', () => {
    expect(institutionIconUrl({ id: 'abc-123', website: null })).toBeNull();
    expect(institutionIconUrl(undefined)).toBeNull();
  });
});
