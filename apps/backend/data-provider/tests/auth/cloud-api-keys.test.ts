import { describe, expect, it } from 'bun:test';
import {
  CLOUD_API_KEY_PREFIX,
  generateCloudApiKey,
  sha256Hex,
} from '../../src/auth/cloud-api-keys';

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

  it('hashes the whole token, so one character changes the digest', async () => {
    const a = await sha256Hex(`${CLOUD_API_KEY_PREFIX}abc`);
    const b = await sha256Hex(`${CLOUD_API_KEY_PREFIX}abd`);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('generateCloudApiKey', () => {
  it('returns rawToken as the Scani prefix + 32 hex', async () => {
    const { rawToken } = await generateCloudApiKey();
    expect(rawToken).toMatch(new RegExp(`^${CLOUD_API_KEY_PREFIX}[0-9a-f]{32}$`));
  });

  /**
   * SC-189. `sk_live_` is Stripe's secret-key prefix, so under it every key we
   * minted was read as a Stripe credential by scanners neither we nor our
   * customers control — including GitHub push protection, which rejected a
   * push to the public repo over an obvious placeholder in a fixture.
   *
   * The assertion is against third-party prefixes generally, not `sk_live_`
   * alone: the mistake is reusing someone else's namespace, and the next one
   * would be just as invisible until a scanner shouted.
   */
  it('does not mint keys under another vendor prefix', async () => {
    const foreignPrefixes = ['sk_live_', 'sk_test_', 'pk_live_', 'ghp_', 'xoxb-', 'AKIA'];
    const { rawToken, keyPrefix } = await generateCloudApiKey();
    for (const foreign of foreignPrefixes) {
      expect(rawToken.startsWith(foreign)).toBe(false);
      expect(keyPrefix.startsWith(foreign)).toBe(false);
    }
    expect(rawToken.startsWith('scani_')).toBe(true);
  });

  it('returns hashedKey that matches sha256Hex(rawToken)', async () => {
    const { rawToken, hashedKey } = await generateCloudApiKey();
    expect(hashedKey).toBe(await sha256Hex(rawToken));
  });

  it('returns keyPrefix as the prefix plus 4 hex chars', async () => {
    const { rawToken, keyPrefix } = await generateCloudApiKey();
    expect(keyPrefix).toBe(rawToken.slice(0, CLOUD_API_KEY_PREFIX.length + 4));
    expect(keyPrefix.startsWith(CLOUD_API_KEY_PREFIX)).toBe(true);
  });

  it('never returns enough of the token to reconstruct it', async () => {
    const { rawToken, keyPrefix } = await generateCloudApiKey();
    expect(keyPrefix.length).toBeLessThan(rawToken.length);
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
