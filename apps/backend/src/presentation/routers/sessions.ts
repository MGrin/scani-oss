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
      const auth = getBetterAuth();
      // Better-Auth scopes the revoke to the caller's user — the session
      // table lookup happens server-side, so a malicious caller can't
      // revoke another user's session by guessing tokens.
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
