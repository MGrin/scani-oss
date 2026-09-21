/**
 * `sessions.list` returned every session's raw token, and a session token IS
 * the bearer credential — so one XSS reading that list could take over every
 * device the user is signed in on (SC-1288). The list now carries only the
 * session's id, and `revoke` takes that id and finds the token server-side.
 *
 * Better-Auth is replaced with a fake holding sessions for two users: the
 * library is not under test, the router's use of it is.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { appRouter } from '../../../src/presentation/router';
import { setBetterAuthForContext } from '../../../src/presentation/trpc';
import { buildAuthedContext } from '../../helpers/test-caller';

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface FakeSession {
  id: string;
  token: string;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

function session(id: string, userId: string): FakeSession {
  return {
    id,
    token: `secret-token-${id}`,
    userId,
    ipAddress: null,
    userAgent: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  };
}

let sessions: FakeSession[] = [];
let revokedTokens: string[] = [];

// The fake reads the caller from a header the test sets, standing in for the
// session cookie Better-Auth resolves.
const callerOf = (headers: Headers) => headers.get('x-test-user');

setBetterAuthForContext({
  api: {
    listSessions: async ({ headers }: { headers: Headers }) =>
      sessions.filter((s) => s.userId === callerOf(headers)),
    getSession: async ({ headers }: { headers: Headers }) => ({
      session: sessions.find((s) => s.userId === callerOf(headers)),
    }),
    revokeSession: async ({ body }: { body: { token: string } }) => {
      revokedTokens.push(body.token);
      return { status: true };
    },
  },
} as unknown as Parameters<typeof setBetterAuthForContext>[0]);

afterAll(() => {
  setBetterAuthForContext(null as unknown as Parameters<typeof setBetterAuthForContext>[0]);
});

beforeEach(() => {
  sessions = [
    session('a-current', USER_A),
    session('a-laptop', USER_A),
    session('b-phone', USER_B),
  ];
  revokedTokens = [];
});

function callerFor(userId: string) {
  const context = buildAuthedContext({
    id: userId,
    email: `${userId}@scani.local`,
  } as typeof schema.users.$inferSelect);
  const headers = new Headers({ 'x-test-user': userId });
  return appRouter.createCaller({ ...context, headers });
}

describe('sessions router — no bearer token leaves the server (SC-1288)', () => {
  test('list carries no session token', async () => {
    const listed = await callerFor(USER_A).sessions.list();

    expect(listed.map((s) => s.id).sort()).toEqual(['a-current', 'a-laptop']);
    const serialized = JSON.stringify(listed);
    for (const s of sessions) expect(serialized).not.toContain(s.token);
    expect(listed.find((s) => s.id === 'a-current')?.isCurrent).toBe(true);
    expect(listed.find((s) => s.id === 'a-laptop')?.isCurrent).toBe(false);
  });

  test('revoke by id revokes that session — the control', async () => {
    await callerFor(USER_A).sessions.revoke({ id: 'a-laptop' });
    expect(revokedTokens).toEqual(['secret-token-a-laptop']);
  });

  test("B cannot revoke A's session by its id", async () => {
    await expect(callerFor(USER_B).sessions.revoke({ id: 'a-laptop' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(revokedTokens).toEqual([]);
  });
});
