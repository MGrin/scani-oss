import { describe, expect, test } from 'bun:test';
import { normalizeVendorName } from '../../src/lib/normalize-vendor-name';

// This function decides whether two raw strings CAN be pointed at the
// same vendor row — a wrong merge is destructive (payment history gets
// silently reattributed) and hard to unpick, so it only collapses
// surface-form noise (case, punctuation, whitespace, known
// payment-processor prefixes) it can prove is noise. It deliberately does
// NOT try to derive "amazon" from "amzn" or otherwise guess that two
// differently-spelled strings name the same real-world vendor — that's
// what `VendorRepository.merge` + explicit aliases are for (see the
// repository test for the "AMZN Mktp GB" / "Amazon.co.uk" / "AMAZON
// MKTP" scenario end to end).

describe('normalizeVendorName', () => {
  test('lowercases', () => {
    expect(normalizeVendorName('AMAZON')).toBe('amazon');
  });

  test('collapses repeated internal whitespace', () => {
    expect(normalizeVendorName('AMAZON  MKTP')).toBe('amazon mktp');
  });

  test('trims leading and trailing whitespace', () => {
    expect(normalizeVendorName('  Amazon  ')).toBe('amazon');
  });

  test('turns punctuation into a separator rather than deleting it', () => {
    // Deleting punctuation outright would collapse "Amazon.co.uk" into
    // "amazoncouk", a single run that could accidentally coincide with
    // an unrelated name. Replacing with a space keeps word boundaries.
    expect(normalizeVendorName('Amazon.co.uk')).toBe('amazon co uk');
  });

  test('strips a known payment-processor noise prefix', () => {
    expect(normalizeVendorName('SQ *The Coffee Shop')).toBe('the coffee shop');
  });

  test('strips a known noise prefix case-insensitively', () => {
    expect(normalizeVendorName('sq *The Coffee Shop')).toBe('the coffee shop');
  });

  test('strips the PAYPAL processor prefix', () => {
    expect(normalizeVendorName('PAYPAL *NETFLIX')).toBe('netflix');
  });

  test('a bare noise-prefix-only input does not collapse to empty', () => {
    // Nothing meaningful survives stripping "SQ *" from itself — falling
    // back to the un-stripped (but still cased/punctuation-normalized)
    // value beats silently returning "".
    expect(normalizeVendorName('SQ *')).not.toBe('');
  });

  test('two case/whitespace-equivalent spellings normalize identically', () => {
    expect(normalizeVendorName('AMZN Mktp GB')).toBe(normalizeVendorName('amzn   mktp gb'));
  });

  test('is idempotent', () => {
    const once = normalizeVendorName('  SQ *The Coffee Shop!! ');
    expect(normalizeVendorName(once)).toBe(once);
  });

  describe('does not over-normalize into false merges', () => {
    test('"Apple" and "Apple Music" stay distinct', () => {
      expect(normalizeVendorName('Apple')).not.toBe(normalizeVendorName('Apple Music'));
    });

    test('"Netflix" and "Netflix Ads" stay distinct', () => {
      expect(normalizeVendorName('Netflix')).not.toBe(normalizeVendorName('Netflix Ads'));
    });

    test('genuinely different spellings of the same real vendor are NOT auto-merged by normalization alone', () => {
      // This is the brief's canonical example. All three name the same
      // real-world vendor (Amazon), but normalizeVendorName has no
      // license to guess that "AMZN" abbreviates "Amazon" — that
      // inference belongs to a human (or a future heuristic) explicitly
      // calling VendorRepository.addAlias / .merge, not to this pure
      // function. Proving the three stay distinct here documents that
      // the alias table — not this function — is the merge mechanism.
      const amznMktpGb = normalizeVendorName('AMZN Mktp GB');
      const amazonCoUk = normalizeVendorName('Amazon.co.uk');
      const amazonMktp = normalizeVendorName('AMAZON  MKTP');

      expect(amznMktpGb).not.toBe(amazonCoUk);
      expect(amznMktpGb).not.toBe(amazonMktp);
      expect(amazonCoUk).not.toBe(amazonMktp);
    });
  });
});
