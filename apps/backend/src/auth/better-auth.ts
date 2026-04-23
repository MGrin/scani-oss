import { createCloudEmailSender } from '@scani/cloud-client/adapters/email';
import { getCloudClient } from '@scani/cloud-client/runtime';
import { db } from '@scani/db';
import {
  tokens,
  tokenTypes,
  userAccounts,
  userSessions,
  users,
  userVerifications,
} from '@scani/db/schema';
import { createFastmailSender } from '@scani/email';
import { authLogger } from '@scani/logging';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, magicLink } from 'better-auth/plugins';
import { and, eq, isNull } from 'drizzle-orm';
import { createTransport } from 'nodemailer';
import {
  type EmailContent,
  renderMagicLinkEmail,
  renderOtpEmail,
  renderVerificationEmail,
} from './email-templates';

/**
 * Default base currency for newly-created users. First time it's called,
 * resolves USD's token id from the fiat seed and caches it for the life
 * of the process.
 */
let cachedDefaultBaseCurrencyId: Promise<string | null> | null = null;
async function getDefaultBaseCurrencyId(): Promise<string | null> {
  if (cachedDefaultBaseCurrencyId) return cachedDefaultBaseCurrencyId;
  cachedDefaultBaseCurrencyId = (async () => {
    const [row] = await db
      .select({ id: tokens.id })
      .from(tokens)
      .innerJoin(tokenTypes, eq(tokens.typeId, tokenTypes.id))
      .where(and(eq(tokens.symbol, 'USD'), eq(tokenTypes.code, 'fiat')))
      .limit(1);
    if (!row) {
      authLogger.error(
        {},
        'USD fiat token not found in DB — seed migrations may not have run. New users will have baseCurrencyId=null until seeds apply.'
      );
      return null;
    }
    return row.id;
  })();
  return cachedDefaultBaseCurrencyId;
}

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
  // Priority order: cloud > fastmail > SMTP. Cloud mode centralizes the
  // outbound-mail secret on the data-provider (Tier 2/3 deployments),
  // the middle tier (direct Fastmail) is what we use in production today,
  // SMTP is the OSS self-host fallback.
  const cloudClient = getCloudClient();
  const cloudSender = cloudClient ? createCloudEmailSender(cloudClient) : null;
  const fastmailSender =
    !cloudSender && opts.fastmailApiToken ? createFastmailSender(opts.fastmailApiToken) : null;
  const transporter =
    !cloudSender && !fastmailSender && opts.smtpUrl ? createTransport(opts.smtpUrl) : null;
  const fromAddress = opts.smtpFrom ?? '"Scani" <welcome@scani.xyz>';

  const sendRendered = async (to: string, msg: EmailContent) => {
    const payload = { from: fromAddress, to, subject: msg.subject, text: msg.text, html: msg.html };
    if (cloudSender) {
      await cloudSender.sendMail(payload);
    } else if (fastmailSender) {
      await fastmailSender.sendMail(payload);
    } else if (transporter) {
      await transporter.sendMail(payload);
    } else {
      throw new Error(
        'No email transport configured (set SCANI_CLOUD_URL+SCANI_CLOUD_API_KEY, FASTMAIL_API_TOKEN, or SMTP_URL)'
      );
    }
  };

  /**
   * Fire-and-forget wrapper for emails that should *not* block the HTTP
   * response. Used on sign-up: `requireEmailVerification: false` means the
   * user is already signed in, so we shouldn't make them wait 5-10s on an
   * SMTP round-trip just to ship them a confirmation email. Failures are
   * logged but don't propagate.
   *
   * Not used for magic-link / OTP — those flows explicitly await the send
   * because the user is literally waiting for the email to arrive.
   */
  const sendInBackground = (to: string, msg: EmailContent, context: Record<string, unknown>) => {
    void sendRendered(to, msg)
      .then(() => authLogger.info(context, '✅ Background email sent'))
      .catch((err) =>
        authLogger.error(
          { ...context, error: err instanceof Error ? err.message : String(err) },
          '❌ Background email failed'
        )
      );
  };

  const hasEmailTransport = cloudSender !== null || fastmailSender !== null || transporter !== null;

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
    // After Better-Auth inserts a new user row via the Drizzle adapter, back-
    // fill `baseCurrencyId` to USD. Every downstream feature (dashboard,
    // portfolio valuation, holdings) assumes the field is set — without this
    // the first authenticated request 500s with "User not found or has no
    // base currency set". Users can change it in Settings; this is just a
    // sane default so sign-up → dashboard is seamless.
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            try {
              const baseCurrencyId = await getDefaultBaseCurrencyId();
              if (!baseCurrencyId) return;
              await db
                .update(users)
                .set({ baseCurrencyId })
                .where(and(eq(users.id, user.id), isNull(users.baseCurrencyId)));
              authLogger.info(
                { userId: user.id, baseCurrencyId },
                'Set default base currency for new user'
              );
            } catch (err) {
              authLogger.error(
                {
                  userId: user.id,
                  error: err instanceof Error ? err.message : String(err),
                },
                'Failed to set default base currency — user will need to set it in Settings'
              );
            }
          },
        },
      },
    },
    emailVerification: hasEmailTransport
      ? {
          sendVerificationEmail: ({ user, url }) => {
            sendInBackground(user.email, renderVerificationEmail({ url }), {
              userId: user.id,
              kind: 'verification',
            });
            // Return resolved promise so Better-Auth's await doesn't block;
            // the actual SMTP send runs asynchronously.
            return Promise.resolve();
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
      // Distinct cookie name so this session cookie doesn't collide with
      // the data-provider's Better-Auth cookie when both apps run on
      // `localhost` in dev (browsers ignore port for cookie scope, so the
      // default `better-auth.session_token` from both servers would stomp
      // on each other and signing into one would log the other out).
      cookiePrefix: 'scani-app',
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
            await sendRendered(email, renderMagicLinkEmail({ url }));
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
      // One-time-code sign-in. The frontend picks this flow for PWAs
      // (installed standalone mode), where clicking a magic link bounces
      // the user out of the PWA into Safari/Chrome and loses the standalone
      // session. Instead the user receives a 6-digit code and pastes it
      // back into the PWA.
      emailOTP({
        otpLength: 6,
        expiresIn: 5 * 60, // 5 min
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (!hasEmailTransport) {
            authLogger.error({ email }, 'OTP requested but no email transport is configured');
            throw new Error('Email not configured');
          }
          try {
            await sendRendered(email, renderOtpEmail({ code: otp, type }));
            authLogger.info({ email, type }, '✅ OTP sent');
          } catch (err) {
            authLogger.error(
              { email, type, error: err instanceof Error ? err.message : String(err) },
              '❌ Failed to send OTP'
            );
            throw err;
          }
        },
      }),
    ],
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
