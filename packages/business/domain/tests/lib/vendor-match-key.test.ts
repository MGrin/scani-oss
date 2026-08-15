import { describe, expect, test } from 'bun:test';
import { vendorMatchKey } from '../../src/lib/vendor-match-key';

// The key two vendor names are compared on. `normalizeVendorName` already
// collapses case, punctuation and processor prefixes for the SAME string; the
// only thing added here is dropping the trailing legal form, which is what
// makes "Hetzner Online GmbH" and "Hetzner Online" one vendor rather than two.
describe('vendorMatchKey', () => {
  test('collapses the legal form the duplicates were actually made of', () => {
    expect(vendorMatchKey('Hetzner Online GmbH')).toBe('hetzner online');
    expect(vendorMatchKey('Hetzner Online')).toBe('hetzner online');

    expect(vendorMatchKey('Fly.io, Inc.')).toBe('fly io');
    expect(vendorMatchKey('Fly.io')).toBe('fly io');

    expect(vendorMatchKey('Anthropic Limited')).toBe(vendorMatchKey('Anthropic'));
    expect(vendorMatchKey('Vercel Inc')).toBe(vendorMatchKey('Vercel'));
  });

  test('handles the non-English forms and stacked ones', () => {
    // `normalizeVendorName` drops the non-ASCII "à" with the punctuation, so
    // "S.à r.l." reaches this function as "s r l" — both spellings are listed.
    expect(vendorMatchKey('Acme S.à r.l.')).toBe('acme');
    expect(vendorMatchKey('Acme S.a.r.l.')).toBe('acme');
    // Three strips: "kg", then "co", then "gmbh".
    expect(vendorMatchKey('Muster GmbH & Co. KG')).toBe('muster');
    expect(vendorMatchKey('Nordea AB')).toBe('nordea');
    expect(vendorMatchKey('Sklep Sp. z o.o.')).toBe('sklep');
  });

  test('strips only at the end, and never the whole name', () => {
    // "taco" ends in "co" without a space before it — a suffix, not a token.
    expect(vendorMatchKey('Taco Bell')).toBe('taco bell');
    expect(vendorMatchKey('Cointreau')).toBe('cointreau');
    // A vendor genuinely called by a legal form survives: there is nothing
    // left to fall back to, so the strip must not fire at all.
    expect(vendorMatchKey('Ltd')).toBe('ltd');
    expect(vendorMatchKey('Co')).toBe('co');
  });

  test('keeps genuinely different companies apart', () => {
    expect(vendorMatchKey('Deutsche Bank')).not.toBe(vendorMatchKey('Deutsche Telekom'));
    expect(vendorMatchKey('Apple')).not.toBe(vendorMatchKey('Apple Bank'));
    expect(vendorMatchKey('Google Cloud')).not.toBe(vendorMatchKey('Google Workspace'));
  });

  test('composes with the processor-prefix stripping it inherits', () => {
    expect(vendorMatchKey('SQ *Acme Ltd')).toBe('acme');
    expect(vendorMatchKey('Acme')).toBe('acme');
  });
});
