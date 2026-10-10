import { createHmac } from 'node:crypto';
import type { Page } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { mailpit } from '../../fixtures/mailpit';
import { expect, test } from '../../fixtures/test';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';

/** RFC 6238 over the raw secret Better-Auth keeps; the URI carries it base32-encoded. */
function totp(base32Secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32Secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}

async function post(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`${API_BASE_URL}/api/auth${path}`, {
    data,
    headers: { 'content-type': 'application/json', origin: ORIGIN },
  });
  expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

/** Turns 2FA on for the signed-in page's user; returns the secret and backup codes. */
async function enrol(page: Page): Promise<{ secret: string; backupCodes: string[] }> {
  const { totpURI, backupCodes } = (await post(page, '/two-factor/enable', {})) as {
    totpURI: string;
    backupCodes: string[];
  };
  const secret = new URL(totpURI).searchParams.get('secret') ?? '';
  await post(page, '/two-factor/verify-totp', { code: totp(secret) });
  return { secret, backupCodes };
}

async function followMagicLink(page: Page, email: string) {
  await page.request.post(`${API_BASE_URL}/api/auth/sign-in/magic-link`, {
    data: { email, callbackURL: `${ORIGIN}/` },
    headers: { 'content-type': 'application/json', origin: ORIGIN },
  });
  const message = await mailpit.waitForMessageTo(email);
  await page.goto(mailpit.extractMagicLinkFromBody(await mailpit.getBody(message.ID)));
}

async function sessionEmail(page: Page): Promise<string | undefined> {
  const res = await page.request.get(`${API_BASE_URL}/api/auth/get-session`);
  return ((await res.json()) as { user?: { email?: string } } | null)?.user?.email;
}

test.describe('auth: two-factor sign-in (SC-1646)', () => {
  test('a magic link lands on the challenge, and the authenticator code signs in', async ({
    page,
  }, testInfo) => {
    const { email } = await signIn({ page, testInfo });
    const { secret } = await enrol(page);
    await page.context().clearCookies();

    await followMagicLink(page, email);
    await expect(page).toHaveURL(/\/sign-in\/2fa/);
    expect(await sessionEmail(page)).toBeUndefined();

    await page.getByLabel('6-digit code').fill(totp(secret));
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).not.toHaveURL(/\/sign-in\/2fa|\/auth/);
    expect(await sessionEmail(page)).toBe(email);
  });

  test('a backup code signs in once, and a second time it is refused', async ({
    page,
  }, testInfo) => {
    const { email } = await signIn({ page, testInfo });
    const { backupCodes } = await enrol(page);
    const code = backupCodes[0] ?? '';

    for (const expected of ['signed-in', 'refused'] as const) {
      await page.context().clearCookies();
      await followMagicLink(page, email);
      await page.getByRole('button', { name: 'Use a backup code' }).click();
      await page.getByLabel('Backup code').fill(code);
      await page.getByRole('button', { name: 'Continue' }).click();
      if (expected === 'signed-in') {
        await expect(page).not.toHaveURL(/\/sign-in\/2fa/);
        expect(await sessionEmail(page)).toBe(email);
      } else {
        await expect(page.getByRole('alert')).toBeVisible();
        expect(await sessionEmail(page)).toBeUndefined();
      }
    }
  });
});

test.describe('auth: passkeys (SC-1646)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'virtual authenticator is CDP');

  async function authenticator(page: Page, isUserVerified: boolean) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified,
        automaticPresenceSimulation: true,
      },
    });
    return { cdp, authenticatorId };
  }

  test('a passkey added in Settings signs in without email or TOTP', async ({ page }, testInfo) => {
    const { email } = await signIn({ page, testInfo });
    await enrol(page);
    await authenticator(page, true);

    await page.goto('/settings/account');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByText('Passkey added.').first()).toBeVisible();

    await page.context().clearCookies();
    await page.goto('/auth');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page).not.toHaveURL(/\/auth|\/sign-in\/2fa/);
    expect(await sessionEmail(page)).toBe(email);
  });

  test('a passkey that cannot verify the user is refused', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });
    const { cdp, authenticatorId } = await authenticator(page, true);
    await page.goto('/settings/account');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByText('Passkey added.').first()).toBeVisible();

    await page.context().clearCookies();
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
    await page.goto('/auth');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await sessionEmail(page)).toBeUndefined();
  });
});

/**
 * A device with no platform authenticator (the iOS Simulator, a phone with no
 * passcode) rejects every WebAuthn call with NotAllowedError. That must read as
 * a sentence, and the email sign-in must still work afterwards.
 */
const NO_AUTHENTICATOR = () => {
  const refuse = () =>
    Promise.reject(
      new DOMException(
        'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.',
        'NotAllowedError'
      )
    );
  Object.defineProperty(navigator.credentials, 'create', { value: refuse });
  Object.defineProperty(navigator.credentials, 'get', { value: refuse });
};

test.describe('auth: passkeys fail safe (SC-1646)', () => {
  test('adding a passkey fails readably and adds nothing', async ({ page }, testInfo) => {
    await page.addInitScript(NO_AUTHENTICATOR);
    await signIn({ page, testInfo });
    await page.goto('/settings/account');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByText("This device couldn't save a passkey.").first()).toBeVisible();
    await expect(page.getByText(/w3\.org|NotAllowedError/)).toHaveCount(0);
    await expect(page.getByText('Passkey added.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove passkey' })).toHaveCount(0);
  });

  test('a passkey sign-in fails readably, and email sign-in still works', async ({
    page,
  }, testInfo) => {
    await page.addInitScript(NO_AUTHENTICATOR);
    await page.goto('/auth');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(
      "This device couldn't use a passkey. Sign in with your email instead."
    );

    const { email } = await signIn({ page, testInfo });
    expect(await sessionEmail(page)).toBe(email);
  });
});
