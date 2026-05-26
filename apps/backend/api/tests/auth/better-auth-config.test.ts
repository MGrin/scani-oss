import { describe, expect, test } from 'bun:test';
import { createBetterAuth } from '../../src/auth/better-auth';

function build() {
  return createBetterAuth({
    baseURL: 'http://localhost:3001',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://localhost:5173'],
    cookieDomain: undefined,
    screenshotBotSecret: 'test-screenshot-bot-secret',
  });
}

describe('Better-Auth config — auth hardening', () => {
  test('magicLink stores tokens hashed (M1)', () => {
    const auth = build();
    const opts = auth.options;
    const magicLinkPlugin = opts.plugins?.find((p) => p.id === 'magic-link');
    expect(magicLinkPlugin).toBeDefined();
    // Better-Auth plugins expose their resolved options on the instance.
    // The exact accessor depends on the plugin's internal shape — read
    // the plugin's source if this fails:
    // node_modules/better-auth/dist/plugins/magic-link/index.mjs
    expect((magicLinkPlugin as { options?: { storeToken?: unknown } }).options?.storeToken).toBe(
      'hashed'
    );
  });

  test('emailOTP stores OTPs hashed (M1)', () => {
    const auth = build();
    const opts = auth.options;
    const emailOtpPlugin = opts.plugins?.find((p) => p.id === 'email-otp');
    expect(emailOtpPlugin).toBeDefined();
    expect((emailOtpPlugin as { options?: { storeOTP?: unknown } }).options?.storeOTP).toBe(
      'hashed'
    );
  });

  test('session cookie is SameSite=Strict in deployed mode (M4)', () => {
    const auth = createBetterAuth({
      baseURL: 'https://app.scani.example',
      secret: 'test-secret-at-least-32-characters-long',
      trustedOrigins: ['https://app.scani.example'],
      cookieDomain: 'app.scani.example',
      screenshotBotSecret: 'test-screenshot-bot-secret',
    });
    const attrs = auth.options.advanced?.defaultCookieAttributes;
    expect(attrs?.sameSite).toBe('strict');
    expect(attrs?.secure).toBe(true);
    expect(attrs?.domain).toBe('app.scani.example');
  });
});
