import { timingSafeEqual } from 'node:crypto';
import { createComponentLogger } from '@scani/logging';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';

const log = createComponentLogger('auth.screenshot-bot');

// Single allow-listed account whose curated demo data backs the landing
// screenshots. Hardcoded — this endpoint exists only to authenticate
// the GH Actions screenshot workflow as exactly this user.
export const SCREENSHOT_BOT_ALLOWED_EMAIL = 'mr6r1n+olesya@gmail.com';

// Screenshot-bot sessions are minted by the GH Actions landing-shot
// workflow and consumed within a single short-lived capture run. The
// default 7-day session expiry left the admin session list flooded with
// stale screenshot sessions, so these are capped at 15 minutes — long
// enough for one run, short enough to age out on their own.
const SCREENSHOT_SESSION_TTL_SEC = 15 * 60;

function timingSafeStrEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Better-Auth plugin exposing `POST /screenshot-bot/sign-in`.
 *
 * Mounted at `/api/auth/screenshot-bot/sign-in`. Requires
 * `Authorization: Bearer <SCREENSHOT_BOT_SECRET>`. Mints a real
 * Better-Auth session for {@link SCREENSHOT_BOT_ALLOWED_EMAIL} and
 * writes the signed session cookie on the response. The Playwright
 * script in `scripts/capture-landing-shots.ts` calls this once per run
 * via Playwright's request context — the cookie then rides along on
 * every subsequent navigation.
 */
export const screenshotBotPlugin = (opts: { secret: string | undefined }) => ({
  id: 'screenshot-bot',
  endpoints: {
    screenshotBotSignIn: createAuthEndpoint(
      '/screenshot-bot/sign-in',
      { method: 'POST', requireHeaders: true },
      async (ctx) => {
        if (!opts.secret) {
          log.warn({}, 'screenshot-bot endpoint hit without SCREENSHOT_BOT_SECRET configured');
          throw APIError.fromStatus('FORBIDDEN', { message: 'screenshot-bot disabled' });
        }
        const header = ctx.headers?.get('authorization') ?? '';
        const provided = header.replace(/^Bearer\s+/i, '');
        if (!provided || !timingSafeStrEq(provided, opts.secret)) {
          throw APIError.fromStatus('UNAUTHORIZED', { message: 'invalid bot credentials' });
        }
        const found = await ctx.context.internalAdapter.findUserByEmail(
          SCREENSHOT_BOT_ALLOWED_EMAIL
        );
        if (!found?.user) {
          log.error(
            { email: SCREENSHOT_BOT_ALLOWED_EMAIL },
            'screenshot-bot user does not exist in DB; create it before running the workflow'
          );
          throw APIError.fromStatus('NOT_FOUND', { message: 'screenshot user not provisioned' });
        }
        const expiresAt = new Date(Date.now() + SCREENSHOT_SESSION_TTL_SEC * 1000);
        const session = await ctx.context.internalAdapter.createSession(
          found.user.id,
          false,
          { expiresAt },
          true
        );
        if (!session) {
          throw APIError.fromStatus('INTERNAL_SERVER_ERROR', {
            message: 'failed to create session',
          });
        }
        await setSessionCookie(ctx, { session, user: found.user }, false, {
          maxAge: SCREENSHOT_SESSION_TTL_SEC,
        });
        log.info({ userId: found.user.id, sessionId: session.id }, 'minted screenshot-bot session');
        return ctx.json({
          token: session.token,
          expiresAt: session.expiresAt,
        });
      }
    ),
  },
});
