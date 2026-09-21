import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { getBetterAuth, protectedProcedure, router } from '../trpc';

/**
 * Active-session management for the signed-in user.
 *
 * Wraps Better-Auth's server-side session API so the frontend can show a
 * "Devices / sessions" list in Settings and revoke individual entries
 * (e.g. a forgotten browser, a stolen device). The current session is
 * marked so the UI can disable revoke on the row that would log the
 * caller out — separate sign-out flow already covers that case.
 *
 * Better-Auth supports unlimited concurrent sessions per user out of
 * the box; nothing here changes that, we just expose it.
 *
 * A session's TOKEN never leaves the server: it is the bearer credential
 * itself, so a list that carried every one of them handed any script running
 * in the page — one XSS — every device the user is signed in on (SC-1288).
 * Rows are identified by the session's id, and `revoke` resolves the token
 * from the caller's own session list.
 */
export const sessionsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.headers) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing request headers' });
    }
    const auth = getBetterAuth();
    // Returns every active session for the cookie-authenticated user.
    const sessions = await auth.api.listSessions({ headers: ctx.headers });
    // The current session's token comes back via getSession; mark it so
    // the UI can render "(this device)" and skip the revoke button.
    const current = await auth.api.getSession({ headers: ctx.headers });
    const currentToken = current?.session?.token ?? null;
    return sessions.map((s) => ({
      id: s.id,
      ipAddress: s.ipAddress ?? null,
      userAgent: s.userAgent ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      expiresAt: s.expiresAt,
      isCurrent: s.token === currentToken,
    }));
  }),

  revoke: protectedProcedure
    .input(strictInput(z.object({ id: z.string().min(1) })))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.headers) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing request headers' });
      }
      if (!ctx.userId) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      // Per-user budget: an attacker with one stolen session is correctly
      // blocked from revoking *other users'* sessions by the ownership
      // check below, but without a per-user cap they could still loop
      // through the victim's own session list and log every device out.
      // 10/min is well above any legitimate UI flow.
      const rl = await ctx.sessionRevokeLimiter.tryConsumeKey(`user:${ctx.userId}`);
      if (!rl.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many session-revoke attempts; retry in ${rl.retryAfterSec}s`,
        });
      }
      const auth = getBetterAuth();
      // The caller's own session list is both the lookup and the ownership
      // check: an id that is not in it is someone else's or nobody's, and
      // Better-Auth's revokeSession is then never asked.
      const sessions = await auth.api.listSessions({ headers: ctx.headers });
      const owned = sessions.find((s) => s.id === input.id);
      if (!owned) {
        // NOT_FOUND rather than FORBIDDEN — don't tell a probing caller
        // whether the token exists for some other user.
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
      }
      await auth.api.revokeSession({
        headers: ctx.headers,
        body: { token: owned.token },
      });
      return { ok: true as const };
    }),

  revokeOthers: protectedProcedure.mutation(async ({ ctx }) => {
    if (!ctx.headers) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing request headers' });
    }
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }
    // Same per-user budget as `revoke` — one HTTP call costs one token
    // even though it revokes many sessions, since that's how an attacker
    // would invoke it.
    const rl = await ctx.sessionRevokeLimiter.tryConsumeKey(`user:${ctx.userId}`);
    if (!rl.ok) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Too many session-revoke attempts; retry in ${rl.retryAfterSec}s`,
      });
    }
    const auth = getBetterAuth();
    // "Sign out everywhere else" — revokes every session for the user
    // except the one making this call.
    await auth.api.revokeOtherSessions({ headers: ctx.headers });
    return { ok: true as const };
  }),
});
