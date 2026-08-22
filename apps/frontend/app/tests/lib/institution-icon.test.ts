import { describe, expect, test } from 'bun:test';
import { institutionIconUrl } from '../../src/lib/icons';

/**
 * SC-208. The client half: which URL an institution mark asks for.
 *
 * `VITE_API_URL` is baked in at build time and `apiBaseUrl()` resolves it
 * against the page origin, so these assert the SHAPE — the prefix and the key —
 * rather than a literal host, which differs between dev, `app.scani.xyz` and
 * the published image's nginx-proxied `/api`.
 */

describe('institutionIconUrl', () => {
  test('points at our own api, keyed on the institution id', () => {
    const url = institutionIconUrl({ id: 'abc-123', website: 'https://chase.com' });
    expect(url).toContain('/institution-icons/abc-123');
  });

  test('NEVER at google.com — that is the whole ticket', () => {
    // A regression here is invisible in every other test: the <img> still
    // renders, the letter tile still works, and the only symptom is a
    // third-party request from a finance app.
    const url = institutionIconUrl({ id: 'abc-123', website: 'https://chase.com' });
    expect(url).not.toContain('google.com');
    expect(url).not.toContain('gstatic.com');
  });

  test('the website is not in the URL, so it cannot name a host for the server to fetch', () => {
    const url = institutionIconUrl({ id: 'abc-123', website: 'https://evil.example/' });
    expect(url).not.toContain('evil.example');
  });

  test('the id is encoded rather than interpolated raw', () => {
    const url = institutionIconUrl({ id: 'a/../b', website: 'https://chase.com' });
    expect(url).not.toContain('/a/../b');
    expect(url).toContain('a%2F..%2Fb');
  });

  test('no website means no request at all — the letter tile draws immediately', () => {
    expect(institutionIconUrl({ id: 'abc-123', website: null })).toBeNull();
    expect(institutionIconUrl({ id: 'abc-123' })).toBeNull();
  });

  test('a missing institution is null rather than a URL with `undefined` in it', () => {
    // `AccountsList` looks its institution up in a Map, so `undefined` is a
    // real value here, not a defensive hypothetical.
    expect(institutionIconUrl(undefined)).toBeNull();
    expect(institutionIconUrl(null)).toBeNull();
  });
});
