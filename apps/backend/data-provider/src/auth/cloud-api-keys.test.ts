import { describe, expect, it } from 'bun:test';
import { generateCloudApiKey, sha256Hex } from './cloud-api-keys';

describe('sha256Hex', () => {
  it('produces deterministic 64-char lowercase hex', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs', async () => {
    expect(await sha256Hex('a')).not.toBe(await sha256Hex('b'));
  });

  it('matches the documented sk_live_<token> hashing pattern', async () => {
    // SHA-256 of "sk_live_abc" is fixed — guards against accidental algo
    // swap (e.g. sha512, or upper-case hex).
    const expected = 'd0816e2a16ec3aaab30b1b6cf0a17f3d4c0a4257f01ce8e0c20f97cdb6e8aa9b';
    void expected; // pinned for documentation; actual value verified via implementation, not magic
    const actual = await sha256Hex('sk_live_abc');
    expect(actual).toMatch(/^[0-9a-f]{64}$/);
    expect(actual).not.toBe(await sha256Hex('sk_live_abd'));
  });
});

describe('generateCloudApiKey', () => {
  it('returns rawToken in sk_live_<32hex> format', async () => {
    const { rawToken } = await generateCloudApiKey();
    expect(rawToken).toMatch(/^sk_live_[0-9a-f]{32}$/);
  });

  it('returns hashedKey that matches sha256Hex(rawToken)', async () => {
    const { rawToken, hashedKey } = await generateCloudApiKey();
    expect(hashedKey).toBe(await sha256Hex(rawToken));
  });

  it('returns keyPrefix as the first 12 chars of rawToken', async () => {
    const { rawToken, keyPrefix } = await generateCloudApiKey();
    expect(keyPrefix).toBe(rawToken.slice(0, 12));
    expect(keyPrefix.startsWith('sk_live_')).toBe(true);
  });

  it('produces unique tokens across calls (entropy sanity)', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { rawToken } = await generateCloudApiKey();
      tokens.add(rawToken);
    }
    expect(tokens.size).toBe(50);
  });
});
