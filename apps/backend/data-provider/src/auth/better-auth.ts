import { cloudAccounts, cloudSessions, cloudUsers, cloudVerifications } from '@scani/db';
import { LocalEmailService, SCANI_CLOUD_BRAND } from '@scani/email';
import { logger } from '@scani/logging';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, magicLink } from 'better-auth/plugins';
import { Container } from 'typedi';
import type { CloudDb } from '../db/connection';

// Second auth strategy on apps/backend/data-provider — runs alongside the
// M2M bearer-token gate for tRPC calls from backend/worker. Cookie sessions
// issued here authenticate browser users on cloud.scani.xyz (FE-2) against
// `keys.list` / `keys.create` / `keys.revoke` / `usage.*`.
//
// The table set (cloud_users, cloud_sessions, …) is intentionally separate
// from the backend's users / user_sessions — cloud-frontend operators are
// a distinct identity namespace from app.scani.xyz end-users.
//
// Gated by CLOUD_MANAGEMENT_ENABLED=true. In OSS Tier 1 boot the function
// is never called; the data-provider stays single-purpose.
export function createCloudBetterAuth(opts: {
  db: CloudDb;
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
  cookieDomain?: string;
}) {
  const email = Container.get(LocalEmailService);

  return betterAuth({
    baseURL: opts.baseURL,
    secret: opts.secret,
    trustedOrigins: opts.trustedOrigins ?? [],
    database: drizzleAdapter(opts.db, {
      provider: 'pg',
      schema: {
        user: cloudUsers,
        session: cloudSessions,
        account: cloudAccounts,
        verification: cloudVerifications,
      },
    }),
    emailAndPassword: {
      // Disabled — mirror of the main api fix (PR #48, H1). The cloud
      // frontend's only auth path is `signIn.emailOtp(...)` / magic-link.
      // Leaving emailAndPassword enabled would mount `POST /api/auth/
      // sign-up/email` + `POST /api/auth/sign-in/email`, which let a
      // scripted caller bypass the OTP/magic-link flow entirely (sign up
      // with `requireEmailVerification: false` + `autoSignIn: true`
      // returns a session cookie without proof of email control). This
      // surface is gated by CLOUD_MANAGEMENT_ENABLED so it's dormant in
      // OSS Tier-1 boot; the disable is insurance for operators who
      // turn cloud-management on.
      enabled: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // extend at most once/day
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    advanced: {
      useSecureCookies: opts.baseURL.startsWith('https://'),
      database: {
        generateId: () => crypto.randomUUID(),
      },
      // Distinct cookie name so the cloud-frontend session cookie doesn't
      // collide with the main app's backend Better-Auth cookie when both
      // run on `localhost` in dev. Browsers ignore port for cookie scope,
      // so without distinct prefixes signing into one app logs the other
      // out.
      cookiePrefix: 'scani-cloud',
      defaultCookieAttributes: opts.cookieDomain
        ? {
            domain: opts.cookieDomain,
            sameSite: 'lax',
            secure: opts.baseURL.startsWith('https://'),
          }
        : undefined,
    },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email: to, url }) => {
          try {
            await email.sendMagicLink({ to, url, brand: SCANI_CLOUD_BRAND });
            logger.info({ email: to }, 'cloud-auth: magic link sent');
          } catch (err) {
            logger.error(
              { email: to, err: err instanceof Error ? err.message : String(err) },
              'cloud-auth: magic link send failed'
            );
            throw err;
          }
        },
        expiresIn: 60 * 15, // 15 min
        // Hash tokens before storing in cloud_verifications.value — mirror
        // of the main api fix (PR #50, M1). A read-only DB leak otherwise
        // hands the attacker valid magic-links for the next 15 minutes.
        // Better-Auth re-hashes on verification.
        storeToken: 'hashed',
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 5 * 60,
        allowedAttempts: 5,
        // Hash OTPs before storing (same reasoning as magicLink.storeToken
        // above). The user-facing OTP is still emailed in plaintext; only
        // the DB stores the hash.
        storeOTP: 'hashed',
        sendVerificationOTP: async ({ email: to, otp, type }) => {
          try {
            await email.sendOtp({ to, code: otp, type, brand: SCANI_CLOUD_BRAND });
            logger.info({ email: to }, 'cloud-auth: OTP sent');
          } catch (err) {
            logger.error(
              { email: to, err: err instanceof Error ? err.message : String(err) },
              'cloud-auth: OTP send failed'
            );
            throw err;
          }
        },
      }),
    ],
  });
}

export type CloudBetterAuthInstance = ReturnType<typeof createCloudBetterAuth>;
