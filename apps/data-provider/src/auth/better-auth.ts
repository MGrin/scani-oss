import { cloudAccounts, cloudSessions, cloudUsers, cloudVerifications } from '@scani/db';
import { createFastmailSender } from '@scani/email';
import { logger } from '@scani/logging';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, magicLink } from 'better-auth/plugins';
import { createTransport, type Transporter } from 'nodemailer';
import type { CloudDb } from '../db/connection';

/**
 * Better-Auth server for the data-provider's cloud-frontend console.
 *
 * This is the second auth strategy on apps/data-provider — it runs
 * alongside the M2M bearer-token gate for tRPC calls from backend/worker.
 * Cookie sessions issued here authenticate browser users on
 * cloud.scani.xyz (FE-2) against routes like `keys.list`, `keys.create`,
 * `keys.revoke`, and `usage.*`.
 *
 * The table set (`cloud_users`, `cloud_sessions`, `cloud_accounts`,
 * `cloud_verifications`) is intentionally separate from the backend's
 * `users`/`user_sessions`/etc. — cloud-frontend operators are a distinct
 * identity namespace from app.scani.xyz end-users.
 *
 * Gated by `CLOUD_MANAGEMENT_ENABLED=true`. In OSS Tier 1 boot the
 * function is never called; the data-provider stays single-purpose.
 */
export function createCloudBetterAuth(opts: {
  db: CloudDb;
  baseURL: string;
  secret: string;
  fastmailApiToken?: string;
  /**
   * SMTP transport URL — used as a dev fallback when Fastmail isn't
   * configured. Docker-compose points this at Mailpit
   * (`smtp://mailpit:1025`) so OTPs / magic links land in the inspector
   * instead of just stdout. Production deployments leave it unset and
   * rely on Fastmail.
   */
  smtpUrl?: string;
  smtpFrom?: string;
  /** Origin of cloud-frontend SPA (e.g. https://cloud.scani.xyz). */
  trustedOrigins?: string[];
  /** When two subdomains share the cookie (e.g. cloud.scani.xyz ↔ api.cloud.scani.xyz). */
  cookieDomain?: string;
}) {
  const fastmailSender = opts.fastmailApiToken ? createFastmailSender(opts.fastmailApiToken) : null;
  const smtpTransporter: Transporter | null =
    !fastmailSender && opts.smtpUrl ? createTransport(opts.smtpUrl) : null;
  const fromAddress = opts.smtpFrom ?? '"Scani Cloud" <cloud@scani.xyz>';

  // Send priority: Fastmail → SMTP (Mailpit in dev) → stdout log.
  // Stdout is the last-resort dev fallback so a contributor without
  // either email transport can still grab the OTP from `docker logs`.
  // env.ts already refuses the stdout branch in production.
  const sendEmail = async (to: string, subject: string, text: string, html: string) => {
    if (fastmailSender) {
      await fastmailSender.sendMail({ from: fromAddress, to, subject, text, html });
      return;
    }
    if (smtpTransporter) {
      await smtpTransporter.sendMail({ from: fromAddress, to, subject, text, html });
      return;
    }
    logger.warn(
      { to, subject, text },
      'cloud-auth: no email transport configured — logging to stdout (dev-only)'
    );
  };

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
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
      minPasswordLength: 10,
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
      // out. In prod the apps live on different registrable domains so the
      // collision wouldn't happen, but the prefix is also good defense in
      // depth for any future co-deployment.
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
        sendMagicLink: async ({ email, url }) => {
          try {
            await sendEmail(
              email,
              'Sign in to Scani Cloud',
              `Sign in to Scani Cloud by clicking this link:\n\n${url}\n\nThe link is valid for 15 minutes.`,
              `<p>Sign in to <strong>Scani Cloud</strong> by clicking the link below.</p>` +
                `<p><a href="${url}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Sign in</a></p>` +
                `<p style="color:#666;font-size:12px">Link valid for 15 minutes. If you didn't request this, ignore this email.</p>`
            );
            logger.info({ email }, 'cloud-auth: magic link sent');
          } catch (err) {
            logger.error(
              { email, err: err instanceof Error ? err.message : String(err) },
              'cloud-auth: magic link send failed'
            );
            throw err;
          }
        },
        expiresIn: 60 * 15, // 15 min
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 5 * 60,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp }) => {
          try {
            await sendEmail(
              email,
              `Your Scani Cloud code: ${otp}`,
              `Your verification code is ${otp}. It expires in 5 minutes.`,
              `<p>Your verification code is:</p>` +
                `<p style="font-size:24px;letter-spacing:0.2em;font-weight:bold">${otp}</p>` +
                `<p style="color:#666;font-size:12px">Expires in 5 minutes. Never share this code.</p>`
            );
            logger.info({ email }, 'cloud-auth: OTP sent');
          } catch (err) {
            logger.error(
              { email, err: err instanceof Error ? err.message : String(err) },
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
