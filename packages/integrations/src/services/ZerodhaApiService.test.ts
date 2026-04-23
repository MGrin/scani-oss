import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { __test_generateTotpCode } from './ZerodhaApiService';

describe('generateTotpCode (RFC 6238 compat)', () => {
  let nowSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    nowSpy = spyOn(Date, 'now');
  });
  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = undefined;
  });

  /**
   * RFC 6238 Appendix B test vectors use the ASCII-encoded seed
   * "12345678901234567890" (20 bytes → 160 bits). Encoded as base32
   * it's "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".
   *
   * Each vector gives an epoch-seconds timestamp and the expected
   * 6-digit TOTP code (last 6 digits of the published 8-digit value).
   */
  const SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('matches RFC 6238 vector @ T=59s → 287082', () => {
    nowSpy!.mockReturnValue(59 * 1000);
    expect(__test_generateTotpCode(SECRET_BASE32)).toBe('287082');
  });

  it('matches RFC 6238 vector @ T=1111111109s → 081804', () => {
    nowSpy!.mockReturnValue(1111111109 * 1000);
    expect(__test_generateTotpCode(SECRET_BASE32)).toBe('081804');
  });

  it('matches RFC 6238 vector @ T=1234567890s → 005924', () => {
    nowSpy!.mockReturnValue(1234567890 * 1000);
    expect(__test_generateTotpCode(SECRET_BASE32)).toBe('005924');
  });

  it('tolerates lowercase + padded base32 secrets', () => {
    nowSpy!.mockReturnValue(59 * 1000);
    expect(__test_generateTotpCode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq====')).toBe('287082');
  });
});
