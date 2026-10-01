import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { db } from '@scani/db';
import { userSessions, users } from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { createBetterAuth } from '../../src/auth/better-auth';
import { registerSignInGuard, SignInRefused } from '../../src/auth/sign-in-guard';

/**
 * A registered sign-in guard decides whether Better-Auth may create a session.
 * The allowing case is the control in each pair: it proves the same path
 * writes a row, so a missing row under a refusing guard means the guard fired
 * rather than that the call never reached the database.
 */

const ORIGIN = 'http://localhost:5173';
const auth = createBetterAuth({
  baseURL: 'http://localhost:3001',
  secret: 'test-secret-at-least-32-characters-long',
  trustedOrigins: [ORIGIN],
  cookieDomain: undefined,
  screenshotBotSecret: 'test-screenshot-bot-secret',
});

const createdUsers: string[] = [];

afterEach(() => registerSignInGuard(async () => true));

afterAll(async () => {
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.id, createdUsers));
});

async function probeUser(): Promise<{ id: string; email: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `guard-${crypto.randomUUID()}@scani.test`, name: 'sign-in guard probe' })
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

/** Hashed the way the `emailOTP({ storeOTP: 'hashed' })` plugin stores a code. */
async function hashOtp(otp: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(otp));
  return Buffer.from(digest).toString('base64url');
}

/** Plants a valid sign-in code for `email`, then submits it over HTTP. */
async function signInWithOtp(email: string): Promise<Response> {
  const otp = '123456';
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `sign-in-otp-${email}`,
    value: `${await hashOtp(otp)}:0`,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  return auth.handler(
    new Request('http://localhost:3001/api/auth/sign-in/email-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, otp }),
    })
  );
}

describe('sign-in guard', () => {
  test('with no guard registered, a session is created (control)', async () => {
    const { id } = await probeUser();
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(id);
    expect(session.userId).toBe(id);
    expect(await sessionCount(id)).toBe(1);
  });

  test('a guard that refuses stops the session and writes no row', async () => {
    const { id } = await probeUser();
    registerSignInGuard(async (userId) => userId !== id);
    const ctx = await auth.$context;
    await expect(ctx.internalAdapter.createSession(id)).rejects.toBeInstanceOf(SignInRefused);
    expect(await sessionCount(id)).toBe(0);
  });

  test('a guard that throws fails closed: no session row', async () => {
    const { id } = await probeUser();
    registerSignInGuard(async () => {
      throw new Error('guard backend unavailable');
    });
    const ctx = await auth.$context;
    await expect(ctx.internalAdapter.createSession(id)).rejects.toThrow(
      'guard backend unavailable'
    );
    expect(await sessionCount(id)).toBe(0);
  });
});

describe('sign-in guard over HTTP (email OTP)', () => {
  test('an allowing guard signs in with 200 and a session row (control)', async () => {
    const { id, email } = await probeUser();
    registerSignInGuard(async () => true);
    const res = await signInWithOtp(email);
    expect(res.status).toBe(200);
    expect(await sessionCount(id)).toBe(1);
  });

  test('a refusing guard answers 403 with no reason, and no session row', async () => {
    const { id, email } = await probeUser();
    registerSignInGuard(async (userId) => userId !== id);
    const res = await signInWithOtp(email);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'SIGN_IN_REFUSED', message: 'Sign-in refused' });
    expect(await sessionCount(id)).toBe(0);
  });
});
