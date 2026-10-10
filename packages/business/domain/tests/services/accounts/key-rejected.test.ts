import { describe, expect, test } from 'bun:test';
import { keyRejectedByInstitution } from '../../../src/services/accounts/key-rejected';

describe('keyRejectedByInstitution (SC-1686)', () => {
  const manifests = [
    { institutionName: 'Bybit', providerKey: 'bybit' },
    { institutionName: 'Kraken', providerKey: 'kraken' },
  ];

  test('names the provider whose connect page replaces the key', () => {
    const map = keyRejectedByInstitution(
      [{ institutionId: 'inst-bybit', institutionName: 'Bybit' }],
      manifests
    );
    expect(map.get('inst-bybit')).toEqual({ providerKey: 'bybit' });
    expect(map.has('inst-kraken')).toBe(false);
  });

  test('an institution with no manifest is still flagged, with no key to link', () => {
    const map = keyRejectedByInstitution(
      [{ institutionId: 'inst-old', institutionName: 'Retired Exchange' }],
      manifests
    );
    expect(map.get('inst-old')).toEqual({ providerKey: null });
  });
});
