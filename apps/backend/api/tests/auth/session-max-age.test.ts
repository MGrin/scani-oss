import { afterAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db';
import { userSessions, users } from '@scani/db/schema';
import { makeSignature } from 'better-auth/crypto';
import { eq, inArray } from 'drizzle-orm';
import { createBetterAuth } from '../../src/auth/better-auth';

/**
 * SC-1351: sessions have an absolute 30-day cap. The old `session.update.before`
 * hook never saw `createdAt` (Better-Auth refreshes with only `expiresAt` and
 * `updatedAt`), so the cap never applied and an active session slid forever.
 *
 * The 1-day session is the control: it proves the signed cookie this test
 * builds is one Better-Auth accepts, so a `null` for the old one means the cap
 * fired rather than that the cookie was wrong.
 */

const SECRET = 'test-secret-at-least-32-characters-long';
const DAY_MS = 24 * 60 * 60 * 1000;

const auth = createBetterAuth({
  baseURL: 'http://localhost:3001',
  secret: SECRET,
  trustedOrigins: ['http://localhost:5173'],
  cookieDomain: undefined,
  screenshotBotSecret: 'test-screenshot-bot-secret',
});

const createdUsers: string[] = [];

afterAll(async () => {
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.id, createdUsers));
});

async function sessionSignedInDaysAgo(days: number) {
  const [user] = await db
    .insert(users)
    .values({ email: `sc1351-${crypto.randomUUID()}@scani.test`, name: 'SC-1351 probe' })
    .returning({ id: users.id });
  if (!user) throw new Error('could not create the probe user');
  createdUsers.push(user.id);
  const token = crypto.randomUUID().replaceAll('-', '');
  const now = Date.now();
  await db.insert(userSessions).values({
    id: crypto.randomUUID(),
    token,
    userId: user.id,
    createdAt: new Date(now - days * DAY_MS),
    updatedAt: new Date(now),
    expiresAt: new Date(now + 6 * DAY_MS),
  });
  const signed = `${token}.${await makeSignature(token, SECRET)}`;
  const headers = new Headers({ cookie: `scani-app.session_token=${encodeURIComponent(signed)}` });
  return { userId: user.id, token, headers };
}

async function sessionRowExists(token: string): Promise<boolean> {
  const rows = await db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(eq(userSessions.token, token));
  return rows.length > 0;
}

async function expiresAtOf(token: string): Promise<Date | null> {
  const [row] = await db
    .select({ expiresAt: userSessions.expiresAt })
    .from(userSessions)
    .where(eq(userSessions.token, token));
  return row?.expiresAt ?? null;
}

describe('absolute session lifetime (SC-1351)', () => {
  test('a session signed in one day ago still resolves (control)', async () => {
    const s = await sessionSignedInDaysAgo(1);
    const result = await auth.api.getSession({ headers: s.headers });
    expect(result?.user.id).toBe(s.userId);
    expect(await sessionRowExists(s.token)).toBe(true);
  });

  test('a refresh never extends a session past 30 days from sign-in', async () => {
    const s = await sessionSignedInDaysAgo(29);
    expect((await auth.api.getSession({ headers: s.headers }))?.user.id).toBe(s.userId);
    const expiresAt = await expiresAtOf(s.token);
    expect(expiresAt).not.toBeNull();
    // Signed in 29 days ago, so the refresh may reach one day ahead, not seven.
    expect((expiresAt as Date).getTime()).toBeLessThanOrEqual(Date.now() + DAY_MS + 60_000);
  });

  test('a session signed in 31 days ago ends: its next lookup is null and the row is gone', async () => {
    const s = await sessionSignedInDaysAgo(31);
    await auth.api.getSession({ headers: s.headers });
    expect(await auth.api.getSession({ headers: s.headers })).toBeNull();
    expect(await sessionRowExists(s.token)).toBe(false);
  });
});
