import { afterAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from '@scani/db';
import { userSessions, users } from '@scani/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { createBetterAuth } from '../../src/auth/better-auth';
import { TRUST_DEVICE_COOKIE_NAME, TWO_FACTOR_COOKIE_NAME } from '../../src/auth/two-factor-gate';

const ORIGIN = 'http://localhost:5173';
// Its own API host: every auth instance seeds the MCP oauth_resource for its
// base URL, and a seed still in flight from another file collides on it.
const API = 'http://localhost:3046/api/auth';
const auth = createBetterAuth({
  baseURL: 'http://localhost:3046',
  appUrl: ORIGIN,
  secret: 'test-secret-at-least-32-characters-long',
  trustedOrigins: [ORIGIN],
  cookieDomain: undefined,
  screenshotBotSecret: 'test-screenshot-bot-secret',
});

const createdUsers: string[] = [];
afterAll(async () => {
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.id, createdUsers));
});

/** Cookies by name, merged from every response a test has seen. */
class Jar {
  private readonly cookies = new Map<string, string>();
  take(res: Response): Response {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair?.indexOf('=') ?? -1;
      if (!pair || at < 0) continue;
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  drop(suffix: string): void {
    for (const name of [...this.cookies.keys()])
      if (name.endsWith(suffix)) this.cookies.delete(name);
  }
  has(suffix: string): boolean {
    return [...this.cookies.keys()].some((name) => name.endsWith(suffix));
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function post(jar: Jar, path: string, body: unknown): Promise<Response> {
  return jar.take(
    await auth.handler(
      new Request(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: jar.header() },
        body: JSON.stringify(body),
      })
    )
  );
}

async function probeUser(): Promise<{ id: string; email: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `2fa-${crypto.randomUUID()}@scani.test`, name: '2fa probe' })
    .returning({ id: users.id, email: users.email });
  if (!user) throw new Error('could not create the probe user');
  createdUsers.push(user.id);
  return user;
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(eq(userSessions.userId, userId));
  return rows.length;
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(digest).toString('base64url');
}

async function signInWithOtp(jar: Jar, email: string): Promise<Response> {
  const otp = '123456';
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `sign-in-otp-${email}`,
    value: `${await hash(otp)}:0`,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  return post(jar, '/sign-in/email-otp', { email, otp });
}

async function followMagicLink(jar: Jar, email: string): Promise<Response> {
  const token = crypto.randomUUID();
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `magic-link:${await hash(token)}`,
    value: JSON.stringify({ type: 'magic-link', email }),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  const url = `${API}/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent(`${ORIGIN}/`)}`;
  return jar.take(await auth.handler(new Request(url, { headers: { cookie: jar.header() } })));
}

/** Enrols TOTP from a signed-in session; returns the secret and backup codes. */
async function enrol(email: string): Promise<{ secret: string; backupCodes: string[] }> {
  const jar = new Jar();
  expect((await signInWithOtp(jar, email)).status).toBe(200);
  const enabled = await post(jar, '/two-factor/enable', {});
  expect(enabled.status).toBe(200);
  const { totpURI, backupCodes } = (await enabled.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const secret = new URL(totpURI).searchParams.get('secret') ?? '';
  const code = await totp(secret);
  expect((await post(jar, '/two-factor/verify-totp', { code })).status).toBe(200);
  return { secret, backupCodes };
}

/** RFC 6238 over the base32 secret the enrol URI carries. */
async function totp(base32Secret: string): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32Secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

describe('2FA gate on scani sign-in paths (SC-1646)', () => {
  test('2FA off: email-OTP sign-in returns a session (control)', async () => {
    const { id, email } = await probeUser();
    const res = await signInWithOtp(new Jar(), email);
    expect(res.status).toBe(200);
    expect(await sessionCount(id)).toBe(1);
  });

  test('2FA on: email-OTP sign-in returns a challenge and no session', async () => {
    const { id, email } = await probeUser();
    const { secret } = await enrol(email);
    const before = await sessionCount(id);
    const jar = new Jar();
    const res = await signInWithOtp(jar, email);
    expect(await res.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await sessionCount(id)).toBe(before);
    expect(jar.has('session_token')).toBe(false);
    expect(jar.has(TWO_FACTOR_COOKIE_NAME)).toBe(true);

    const done = await post(jar, '/two-factor/verify-totp', { code: await totp(secret) });
    expect(done.status).toBe(200);
    expect(await sessionCount(id)).toBe(before + 1);
  });

  test('2FA on: magic link redirects to the challenge page and creates no session', async () => {
    const { id, email } = await probeUser();
    await enrol(email);
    const before = await sessionCount(id);
    const jar = new Jar();
    const res = await followMagicLink(jar, email);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/sign-in/2fa`);
    expect(await sessionCount(id)).toBe(before);
    expect(jar.has('session_token')).toBe(false);
  });

  test('wrong codes end the challenge', async () => {
    const { email } = await probeUser();
    const { secret } = await enrol(email);
    const jar = new Jar();
    await signInWithOtp(jar, email);
    for (let i = 0; i < 5; i++) await post(jar, '/two-factor/verify-totp', { code: '000000' });
    const late = await post(jar, '/two-factor/verify-totp', { code: await totp(secret) });
    expect(late.status).not.toBe(200);
  });

  test('a backup code completes once and never twice', async () => {
    const { email } = await probeUser();
    const { backupCodes } = await enrol(email);
    const code = backupCodes[0] ?? '';
    const first = new Jar();
    await signInWithOtp(first, email);
    expect((await post(first, '/two-factor/verify-backup-code', { code })).status).toBe(200);
    const second = new Jar();
    await signInWithOtp(second, email);
    expect((await post(second, '/two-factor/verify-backup-code', { code })).status).not.toBe(200);
  });

  test('a trusted device skips the challenge', async () => {
    const { id, email } = await probeUser();
    const { secret } = await enrol(email);
    const jar = new Jar();
    await signInWithOtp(jar, email);
    await post(jar, '/two-factor/verify-totp', { code: await totp(secret), trustDevice: true });
    expect(jar.has(TRUST_DEVICE_COOKIE_NAME)).toBe(true);
    const before = await sessionCount(id);
    const again = await signInWithOtp(jar, email);
    expect(again.status).toBe(200);
    expect(await again.json()).not.toMatchObject({ twoFactorRedirect: true });
    expect(await sessionCount(id)).toBe(before + 1);
  });

  test('an expired challenge refuses a correct code', async () => {
    const { id, email } = await probeUser();
    const { secret } = await enrol(email);
    const jar = new Jar();
    await signInWithOtp(jar, email);
    await db.execute(
      sql`UPDATE user_verifications SET expires_at = now() - interval '1 minute'
          WHERE identifier LIKE '2fa-%' AND value = ${id}`
    );
    const res = await post(jar, '/two-factor/verify-totp', { code: await totp(secret) });
    expect(res.status).not.toBe(200);
  });

  test('a session older than five minutes cannot change 2FA or passkeys', async () => {
    const { id, email } = await probeUser();
    const jar = new Jar();
    await signInWithOtp(jar, email);
    await db
      .update(userSessions)
      .set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(userSessions.userId, id));
    // The cached copy still says it was just created; the hook must read the row.
    jar.drop('session_data');
    const calls: { path: string; get?: boolean; body?: unknown }[] = [
      { path: '/two-factor/enable' },
      { path: '/two-factor/disable' },
      { path: '/two-factor/generate-backup-codes' },
      { path: '/passkey/generate-register-options', get: true },
      { path: '/passkey/verify-registration', body: { response: {} } },
      { path: '/passkey/delete-passkey', body: { id: 'x' } },
    ];
    for (const call of calls) {
      const res = call.get
        ? jar.take(
            await auth.handler(
              new Request(`${API}${call.path}`, {
                headers: { origin: ORIGIN, cookie: jar.header() },
              })
            )
          )
        : await post(jar, call.path, call.body ?? {});
      expect({ path: call.path, status: res.status }).toEqual({ path: call.path, status: 403 });
    }
  });

  test("the gate's cookie names are the installed plugin's", () => {
    const source = readFileSync(
      new URL(
        '../../../../../node_modules/better-auth/dist/plugins/two-factor/constant.mjs',
        import.meta.url
      ),
      'utf8'
    );
    expect(source).toContain(`TWO_FACTOR_COOKIE_NAME = "${TWO_FACTOR_COOKIE_NAME}"`);
    expect(source).toContain(`TRUST_DEVICE_COOKIE_NAME = "${TRUST_DEVICE_COOKIE_NAME}"`);
  });
});
