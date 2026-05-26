import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { isNodeEnvProduction } from '@scani/config';
import { db } from '@scani/db';
import {
  tokens,
  tokenTypes,
  userAccounts,
  userSessions,
  users,
  userVerifications,
} from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, magicLink } from 'better-auth/plugins';
import { and, eq, isNull } from 'drizzle-orm';
import { Container } from 'typedi';
import { screenshotBotPlugin } from './screenshot-bot-plugin';

const authLogger = createComponentLogger('auth');

// Hard ceiling on session lifetime. Independent of `expiresIn` /
// `updateAge` — those govern the rolling renewal window; this caps
// how far that window can slide. 30 days matches what most banking /
// crypto SaaS apps expose as "stay signed in for a month" without
// triggering a re-auth. Compromised tokens have a bounded blast
// radius even if the legitimate user keeps the session active.
const ABSOLUTE_SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;

// First time it's called, resolves USD's token id from the fiat seed and
// caches it for the life of the process. Every downstream feature
// (dashboard, portfolio valuation, holdings) assumes the field is set —
// without this the first authenticated request 500s with "User not found
// or has no base currency set". Users can change it in Settings; this is
// just a sane default so sign-up → dashboard is seamless.
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

export function createBetterAuth(opts: {
  baseURL: string;
  secret: string;
  cookieDomain?: string;
  trustedOrigins?: string[];
  screenshotBotSecret?: string;
}) {
  const email = Container.get(EmailFacade);

  // Fire-and-forget wrapper for emails that should *not* block the HTTP
  // response. Used on sign-up: `requireEmailVerification: false` means the
  // user is already signed in, so we shouldn't make them wait 5-10s on an
  // SMTP round-trip just to ship them a confirmation email. Failures are
  // logged but don't propagate. Magic-link / OTP flows explicitly await
  // because the user is literally waiting for the email to arrive.
  const sendInBackground = (op: () => Promise<void>, context: Record<string, unknown>): void => {
    void op()
      .then(() => authLogger.info(context, '✅ Background email sent'))
      .catch((err) =>
        authLogger.error(
          { ...context, error: err instanceof Error ? err.message : String(err) },
          '❌ Background email failed'
        )
      );
  };

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
      // Disabled. The SPA's only auth path is `signIn.emailOtp(...)`
      // (apps/frontend/app/src/contexts/AuthContext.tsx). Leaving
      // emailAndPassword enabled keeps Better-Auth's `POST
      // /api/auth/sign-up/email` and `POST /api/auth/sign-in/email`
      // routes mounted — those let a scripted caller bypass the OTP /
      // magic-link flow entirely (sign up with `requireEmailVerification:
      // false` + `autoSignIn: true` returns a session cookie without
      // proof of email control). Closing the routes shrinks the
      // attack surface to the intended passwordless flow.
      enabled: false,
    },
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
      session: {
        // Absolute session-max enforcement. The base session config
        // sets `expiresIn = 7 days` with `updateAge = 1 day` — a
        // sliding window that, by itself, has no hard ceiling. An
        // active user (or a compromised long-lived token used
        // weekly to keep it alive) could ride the same session for
        // months. This hook rejects any session whose `createdAt` is
        // more than ABSOLUTE_SESSION_MAX_MS in the past, regardless
        // of how recently it was touched. The user is forced through
        // a fresh sign-in (magic link / passkey / OTP) at that
        // point, which re-mints a fresh sessionId.
        update: {
          before: async (session) => {
            const createdAt = session.createdAt;
            if (!createdAt) return;
            const ageMs = Date.now() - new Date(createdAt).getTime();
            if (ageMs > ABSOLUTE_SESSION_MAX_MS) {
              authLogger.info(
                {
                  userId: session.userId,
                  sessionId: session.id,
                  ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
                },
                'Session exceeded absolute max age; refusing extension'
              );
              // Throwing rejects the update; Better-Auth then
              // treats the session as unresolved and forces the
              // user back through sign-in.
              throw new Error('Session exceeded absolute max age');
            }
            // Returning `false` from a Better-Auth `before` hook
            // means "no changes" — pass the data through unchanged.
            return false;
          },
        },
      },
    },
    emailVerification: {
      sendVerificationEmail: ({ user, url }) => {
        sendInBackground(() => email.sendVerificationEmail({ to: user.email, url }), {
          userId: user.id,
          kind: 'verification',
        });
        return Promise.resolve();
      },
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // extend at most once per day
      // Sensitive ops (Better-Auth's /change-email, /change-password,
      // and any other endpoint that calls `requireFreshSession`) reject
      // when the session is older than freshAge. 5 minutes forces the
      // user to have authenticated very recently before changing
      // recovery-grade attributes — even an attacker with a long-lived
      // stolen cookie cannot pivot to email-change without re-auth.
      freshAge: 60 * 5, // 5 min
      // The cookie cache is per-instance and not shared across Fly machines.
      // Keeping it on in prod meant a session revoked on machine A could
      // still authenticate on machine B for up to 5 min — incompatible with
      // "sign me out everywhere now". In dev keep it on (no horizontal
      // scaling) to avoid a DB hit on every authenticated request.
      cookieCache: isNodeEnvProduction() ? { enabled: false } : { enabled: true, maxAge: 5 * 60 },
    },
    advanced: {
      useSecureCookies: opts.baseURL.startsWith('https://'),
      database: {
        // users.id is a uuid column; override Better-Auth's default nanoid
        // so both tables agree on format.
        generateId: () => crypto.randomUUID(),
      },
      // Distinct cookie name so this session cookie doesn't collide with
      // the data-provider's Better-Auth cookie when both apps run on
      // `localhost` in dev (browsers ignore port for cookie scope, so the
      // default `better-auth.session_token` from both servers would stomp
      // on each other and signing into one would log the other out).
      cookiePrefix: 'scani-app',
      defaultCookieAttributes: opts.cookieDomain
        ? {
            domain: opts.cookieDomain,
            // SameSite=Strict on the session cookie. Lax would allow top-
            // level GET navigations to carry the cookie cross-site (so an
            // attacker page's <a href="https://app.scani/sensitive">
            // attaches the session). The magic-link click-from-email flow
            // is unaffected: it establishes a NEW session via Set-Cookie
            // in the response and doesn't rely on an existing cookie.
            sameSite: 'strict',
            secure: opts.baseURL.startsWith('https://'),
          }
        : undefined,
    },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email: to, url }) => {
          authLogger.info({ email: to }, '🪄 Magic-link callback fired');
          try {
            await email.sendMagicLink({ to, url });
            authLogger.info({ email: to }, '✅ Magic link sent');
          } catch (err) {
            authLogger.error(
              { email: to, error: err instanceof Error ? err.message : String(err) },
              '❌ Failed to send magic link'
            );
            throw err;
          }
        },
        expiresIn: 60 * 15, // 15 min
        // Hash tokens before storing in user_verifications.value. A read-
        // only DB leak otherwise hands the attacker valid magic-links for
        // the next 15 minutes. Better-Auth re-hashes on verification.
        storeToken: 'hashed',
      }),
      // The frontend picks the OTP flow for PWAs (installed standalone
      // mode), where clicking a magic link bounces the user out of the PWA
      // into Safari/Chrome and loses the standalone session. Instead the
      // user receives a 6-digit code and pastes it back into the PWA.
      emailOTP({
        otpLength: 6,
        expiresIn: 5 * 60, // 5 min
        allowedAttempts: 5,
        // Hash OTPs before storing in user_verifications.value (same
        // reasoning as magicLink.storeToken above). The user-facing OTP
        // is still emailed in plaintext; only the DB stores the hash.
        storeOTP: 'hashed',
        sendVerificationOTP: async ({ email: to, otp, type }) => {
          try {
            await email.sendOtp({ to, code: otp, type });
            authLogger.info({ email: to, type }, '✅ OTP sent');
          } catch (err) {
            authLogger.error(
              { email: to, type, error: err instanceof Error ? err.message : String(err) },
              '❌ Failed to send OTP'
            );
            throw err;
          }
        },
      }),
      screenshotBotPlugin({ secret: opts.screenshotBotSecret }),
    ],
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
