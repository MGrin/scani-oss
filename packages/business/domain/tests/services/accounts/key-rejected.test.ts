import { describe, expect, test } from 'bun:test';
import { keyRejectedByInstitution } from '../../../src/services/accounts/key-rejected';

describe('keyRejectedByInstitution (SC-1686)', () => {
  const manifests = [
    { institutionName: 'Bybit', providerKey: 'bybit' },
    { institutionName: 'Kraken', providerKey: 'kraken' },
    {
      institutionName: 'Fio banka',
      providerKey: 'fio',
      credentialNoun: 'token' as const,
      credentialLifetimeDays: 180,
    },
  ];

  test('names the provider whose connect page replaces the key', () => {
    const map = keyRejectedByInstitution(
      [{ institutionId: 'inst-bybit', institutionName: 'Bybit' }],
      manifests
    );
    expect(map.get('inst-bybit')).toEqual({
      providerKey: 'bybit',
      credentialNoun: 'key',
      credentialLifetimeDays: null,
    });
    expect(map.has('inst-kraken')).toBe(false);
  });

  test('an institution with no manifest is still flagged, with no key to link', () => {
    const map = keyRejectedByInstitution(
      [{ institutionId: 'inst-old', institutionName: 'Retired Exchange' }],
      manifests
    );
    expect(map.get('inst-old')).toEqual({
      providerKey: null,
      credentialNoun: 'key',
      credentialLifetimeDays: null,
    });
  });

  // SC-1733: a Fio token expires, so a refused one is an expired token.
  test("carries the provider's noun and how long its credential lasts", () => {
    const map = keyRejectedByInstitution(
      [{ institutionId: 'inst-fio', institutionName: 'Fio banka' }],
      manifests
    );
    expect(map.get('inst-fio')).toEqual({
      providerKey: 'fio',
      credentialNoun: 'token',
      credentialLifetimeDays: 180,
    });
  });
});
