import { createHmac } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { deleteSessionCookie, expireCookie } from 'better-auth/cookies';
import { generateRandomString } from 'better-auth/crypto';

/**
 * The twoFactor plugin's cookie names, which it does not export. A test reads
 * them from the installed plugin, so an upgrade that renames them goes red.
 */
export const TWO_FACTOR_COOKIE_NAME = 'two_factor';
export const TRUST_DEVICE_COOKIE_NAME = 'trust_device';

const GATED_PATHS = new Set(['/sign-in/email-otp', '/magic-link/verify']);

/**
 * Writes that change how this account can be signed in. The plugins ask only
 * for a session (disable asks for no more), so a stolen session could plant
 * its own passkey or read fresh backup codes; these need one signed in within
 * `session.freshAge`, like account deletion (SC-1351).
 */
const FRESH_SESSION_PATHS = new Set([
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/generate-backup-codes',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
]);

/**
 * Better-Auth's twoFactor plugin swaps a fresh session for a 2FA challenge only
 * on password, username and phone sign-in (`two-factor/index.mjs:245`). Scani
 * signs in by email code and magic link, so this does the same swap on those
 * two paths, with the plugin's own cookie and verification rows, so its
 * `/two-factor/verify-*` endpoints complete the challenge (SC-1646).
 */
export function twoFactorGatePlugin(opts: {
  appUrl: string;
  trustDeviceMaxAge: number;
  twoFactorCookieMaxAge: number;
}): BetterAuthPlugin {
  return {
    id: 'two-factor-gate',
    hooks: {
      before: [
        {
          matcher: (context) => FRESH_SESSION_PATHS.has(context.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            const freshAge = ctx.context.sessionConfig.freshAge * 1000;
            const age = Date.now() - new Date(session.session.createdAt).getTime();
            if (freshAge > 0 && age >= freshAge) {
              throw new APIError('FORBIDDEN', {
                message: 'SESSION_NOT_FRESH',
                code: 'SESSION_NOT_FRESH',
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (context) => GATED_PATHS.has(context.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const data = ctx.context.newSession;
            if (!data?.user || !(data.user as { twoFactorEnabled?: boolean }).twoFactorEnabled)
              return;
            if (await consumeTrustedDevice(ctx, data.user.id, opts.trustDeviceMaxAge)) return;

            deleteSessionCookie(ctx, true);
            await ctx.context.internalAdapter.deleteSession(data.session.token);
            ctx.context.setNewSession(null);

            const maxAge = opts.twoFactorCookieMaxAge;
            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, { maxAge });
            const identifier = `2fa-${generateRandomString(20)}`;
            const expiresAt = new Date(Date.now() + maxAge * 1000);
            await ctx.context.internalAdapter.createVerificationValue({
              value: data.user.id,
              identifier,
              expiresAt,
            });
            await ctx.context.internalAdapter.createVerificationValue({
              value: '0',
              identifier: `2fa-attempts-${identifier}`,
              expiresAt,
            });
            await ctx.setSignedCookie(
              cookie.name,
              identifier,
              ctx.context.secret,
              cookie.attributes
            );

            if (ctx.path === '/magic-link/verify') {
              throw ctx.redirect(`${opts.appUrl}/sign-in/2fa`);
            }
            return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
          }),
        },
      ],
    },
  };
}

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** The plugin's trusted-device check, rotating the cookie on success (`index.mjs:252-275`). */
async function consumeTrustedDevice(
  ctx: HookContext,
  userId: string,
  maxAge: number
): Promise<boolean> {
  const attrs = ctx.context.createAuthCookie(TRUST_DEVICE_COOKIE_NAME, { maxAge });
  const value = await ctx.getSignedCookie(attrs.name, ctx.context.secret);
  if (!value) return false;
  const [token, trustIdentifier] = value.split('!');
  // The plugin's `createHMAC('SHA-256', 'base64urlnopad')`, byte for byte; the
  // trusted-device test proves a cookie it signed verifies here.
  const sign = async (id: string) =>
    createHmac('sha256', ctx.context.secret).update(`${userId}!${id}`).digest('base64url');
  if (token && trustIdentifier && token === (await sign(trustIdentifier))) {
    const record = await ctx.context.internalAdapter.findVerificationValue(trustIdentifier);
    if (record && record.value === userId && record.expiresAt > new Date()) {
      await ctx.context.internalAdapter.deleteVerificationByIdentifier(trustIdentifier);
      const next = `trust-device-${generateRandomString(32)}`;
      await ctx.context.internalAdapter.createVerificationValue({
        value: userId,
        identifier: next,
        expiresAt: new Date(Date.now() + maxAge * 1000),
      });
      await ctx.setSignedCookie(
        attrs.name,
        `${await sign(next)}!${next}`,
        ctx.context.secret,
        attrs.attributes
      );
      return true;
    }
  }
  expireCookie(ctx, attrs);
  return false;
}
