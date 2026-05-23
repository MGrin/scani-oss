import { TRPCError } from '@trpc/server';
import { z } from 'zod';
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
      token: s.token,
      ipAddress: s.ipAddress ?? null,
      userAgent: s.userAgent ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      expiresAt: s.expiresAt,
      isCurrent: s.token === currentToken,
    }));
  }),

  revoke: protectedProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.headers) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing request headers' });
      }
      if (!ctx.userId) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const auth = getBetterAuth();
      // Defense in depth: Better-Auth's revokeSession scopes to the
      // caller's user via the session cookie, but we don't want the
      // safety of an internal API call sitting on a single library
      // contract — verify the token belongs to the caller against the
      // session list before revoking.
      const sessions = await auth.api.listSessions({ headers: ctx.headers });
      const owned = sessions.some((s) => s.token === input.token);
      if (!owned) {
        // NOT_FOUND rather than FORBIDDEN — don't tell a probing caller
        // whether the token exists for some other user.
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
      }
      await auth.api.revokeSession({
        headers: ctx.headers,
        body: { token: input.token },
      });
      return { ok: true as const };
    }),

  revokeOthers: protectedProcedure.mutation(async ({ ctx }) => {
    if (!ctx.headers) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing request headers' });
    }
    const auth = getBetterAuth();
    // "Sign out everywhere else" — revokes every session for the user
    // except the one making this call.
    await auth.api.revokeOtherSessions({ headers: ctx.headers });
    return { ok: true as const };
  }),
});
