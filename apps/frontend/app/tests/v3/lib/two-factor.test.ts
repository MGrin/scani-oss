import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import { isTotpCode, manualKey, normaliseCode } from '@/v3/lib/two-factor';

describe('two-factor helpers (SC-1646)', () => {
  test('a typed code loses its spaces, and a backup code keeps its dash and case', () => {
    expect(normaliseCode(' 123 456 ')).toBe('123456');
    // Better-Auth's backup codes look like this and are compared as stored.
    expect(normaliseCode(' EtXQg-FW9Ww ')).toBe('EtXQg-FW9Ww');
  });

  test('a TOTP code is exactly six digits once normalised', () => {
    expect(isTotpCode('123 456')).toBe(true);
    expect(isTotpCode('123-456')).toBe(true);
    expect(isTotpCode('12345')).toBe(false);
    expect(isTotpCode('1234567')).toBe(false);
    expect(isTotpCode('12a456')).toBe(false);
  });

  test('the manual key is the URI secret, grouped in fours', () => {
    const uri = 'otpauth://totp/Scani:a%40b.c?secret=JBSWY3DPEHPK3PXP&issuer=Scani&digits=6';
    expect(manualKey(uri)).toBe('JBSW Y3DP EHPK 3PXP');
  });

  test('a URI with no secret gives no key', () => {
    expect(manualKey('otpauth://totp/Scani:a?issuer=Scani')).toBeNull();
    expect(manualKey('not a uri')).toBeNull();
  });
});
