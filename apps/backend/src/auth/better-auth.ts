import { db } from '@scani/core/database';
import { userAccounts, userSessions, users, userVerifications } from '@scani/core/database/schema';
import { authLogger } from '@scani/core/utils/logger';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { createTransport } from 'nodemailer';
import { createFastmailSender } from './fastmail-jmap';

/**
 * Better-Auth server instance. One per backend process, created at boot.
 * Handles magic-link signin, email/password signup, session management.
 */
export function createBetterAuth(opts: {
  baseURL: string;
  secret: string;
  smtpUrl?: string;
  smtpFrom?: string;
  /**
   * Fastmail API token with `mail/send` scope. When set, email goes out
   * via Fastmail's JMAP API instead of SMTP — saves us from needing a
   * separate app-specific password. Takes precedence over smtpUrl.
   */
  fastmailApiToken?: string;
  /**
   * When set, Better-Auth session cookies are issued with Domain=<cookieDomain>,
   * so `app.scani.xyz` can read the cookie Better-Auth mints against
   * `api.scani.xyz`. Leave undefined in dev (localhost) where same-port
   * cookies just work.
   */
  cookieDomain?: string;
  /**
   * Allow sign-in / callback redirects to these origins in addition to
   * baseURL. Typically set to the frontend's origin (e.g. https://app.scani.xyz).
   */
  trustedOrigins?: string[];
}) {
  const fastmailSender = opts.fastmailApiToken ? createFastmailSender(opts.fastmailApiToken) : null;
  const transporter = !fastmailSender && opts.smtpUrl ? createTransport(opts.smtpUrl) : null;
  const fromAddress = opts.smtpFrom ?? 'no-reply@scani.xyz';

  const sendEmail = async (input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }) => {
    if (fastmailSender) {
      await fastmailSender.sendMail(input);
    } else if (transporter) {
      await transporter.sendMail(input);
    } else {
      throw new Error('No email transport configured (set FASTMAIL_API_TOKEN or SMTP_URL)');
    }
  };

  const hasEmailTransport = fastmailSender !== null || transporter !== null;

  return betterAuth({
    baseURL: opts.baseURL,
    secret: opts.secret,
    trustedOrigins: opts.trustedOrigins ?? [],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: users,
        session: userSessions,
        account: userAccounts,
        verification: userVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // Flip to true once SMTP deliverability is confirmed.
      autoSignIn: true,
      minPasswordLength: 10,
    },
    emailVerification: hasEmailTransport
      ? {
          sendVerificationEmail: async ({ user, url }) => {
            await sendEmail({
              from: fromAddress,
              to: user.email,
              subject: 'Verify your scani email',
              text: `Click to verify: ${url}`,
              html: `<p>Click <a href="${url}">here</a> to verify your scani email.</p>`,
            });
            authLogger.info({ userId: user.id }, 'Sent email verification');
          },
          sendOnSignUp: true,
          autoSignInAfterVerification: true,
        }
      : undefined,
    // Session cookie settings — HTTPS-only + SameSite=lax is the recommended
    // default for a first-party SPA served from app.scani.xyz hitting api.scani.xyz.
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // extend at most once per day
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 min in-memory cache to avoid DB hit on every request
      },
    },
    advanced: {
      useSecureCookies: opts.baseURL.startsWith('https://'),
      // users.id is a uuid column; override Better-Auth's default nanoid so
      // both tables agree on format.
      database: {
        generateId: () => crypto.randomUUID(),
      },
      // Share the session cookie across app.scani.xyz ↔ api.scani.xyz.
      // SameSite=lax lets the browser forward the cookie on top-level
      // navigations (magic-link click) but not on cross-site XHR from
      // third parties.
      defaultCookieAttributes: opts.cookieDomain
        ? {
            domain: opts.cookieDomain,
            sameSite: 'lax',
            secure: opts.baseURL.startsWith('https://'),
          }
        : undefined,
    },
    plugins: [
      // Magic-link authentication — matches the previous Supabase flow.
      // The frontend calls signIn.magicLink({ email }); we email the URL;
      // the callback hits GET /api/auth/magic-link/verify?token=... which
      // mints a session and 302s back to the app.
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          authLogger.info(
            { email, hasTransport: hasEmailTransport },
            '🪄 Magic-link callback fired'
          );
          if (!hasEmailTransport) {
            authLogger.error(
              { email },
              'Magic link requested but no email transport is configured'
            );
            throw new Error('Email not configured');
          }
          try {
            await sendEmail({
              from: fromAddress,
              to: email,
              subject: 'Sign in to scani',
              text: `Sign in by opening this link: ${url}\n\nIf you didn't request this, ignore this email.`,
              html: `
                <p>Sign in to scani by clicking the link below:</p>
                <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#0066cc;color:#fff;border-radius:6px;text-decoration:none;">Sign in</a></p>
                <p style="color:#666;font-size:12px;">If you didn't request this, ignore this email.</p>
              `,
            });
            authLogger.info({ email }, '✅ Magic link sent');
          } catch (err) {
            authLogger.error(
              { email, error: err instanceof Error ? err.message : String(err) },
              '❌ Failed to send magic link'
            );
            throw err;
          }
        },
        // Session minted automatically after the recipient opens the link.
        expiresIn: 60 * 15, // 15 min
      }),
    ],
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
