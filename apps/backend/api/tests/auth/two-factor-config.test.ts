import { describe, expect, test } from 'bun:test';
import { createBetterAuth } from '../../src/auth/better-auth';
import { passkeyRelyingParty } from '../../src/auth/passkey-config';

// One instance: each one seeds the MCP oauth_resource in the background, and
// several seeding at once collide on its unique identifier.
const auth = createBetterAuth({
  baseURL: 'http://localhost:3001',
  appUrl: 'http://localhost:5173',
  secret: 'test-secret-at-least-32-characters-long',
  trustedOrigins: ['http://localhost:5173'],
  cookieDomain: undefined,
  screenshotBotSecret: 'test-screenshot-bot-secret',
});

type WithOptions = { options?: Record<string, unknown> };

describe('2FA and passkey config (SC-1646)', () => {
  test('two-factor, passkey and the scani gate are registered', () => {
    const ids = auth.options.plugins?.map((p) => p.id) ?? [];
    expect(ids).toContain('two-factor');
    expect(ids).toContain('passkey');
    expect(ids).toContain('two-factor-gate');
  });

  test('two-factor: passwordless, 10 backup codes, 30-day trust, no email second factor', () => {
    const plugin = auth.options.plugins?.find((p) => p.id === 'two-factor') as WithOptions;
    expect(plugin.options?.issuer).toBe('Scani');
    expect(plugin.options?.allowPasswordless).toBe(true);
    expect((plugin.options?.backupCodeOptions as { amount?: number })?.amount).toBe(10);
    expect(plugin.options?.trustDeviceMaxAge).toBe(30 * 24 * 60 * 60);
    expect(plugin.options?.otpOptions).toBeUndefined();
  });

  test('passkey: user verification required, relying party from the app URL', () => {
    const plugin = auth.options.plugins?.find((p) => p.id === 'passkey') as WithOptions;
    expect(plugin.options?.rpID).toBe('localhost');
    expect(plugin.options?.origin).toBe('http://localhost:5173');
    expect(
      (plugin.options?.authenticatorSelection as { userVerification?: string })?.userVerification
    ).toBe('required');
  });

  test("relying party is the app's own hostname, so no public-suffix list is needed", () => {
    expect(passkeyRelyingParty('https://app.scani.xyz')).toEqual({
      rpID: 'app.scani.xyz',
      origin: 'https://app.scani.xyz',
    });
    expect(passkeyRelyingParty('http://localhost:5173/')).toEqual({
      rpID: 'localhost',
      origin: 'http://localhost:5173',
    });
    expect(passkeyRelyingParty('https://finance.example.co.uk')).toEqual({
      rpID: 'finance.example.co.uk',
      origin: 'https://finance.example.co.uk',
    });
  });
});
