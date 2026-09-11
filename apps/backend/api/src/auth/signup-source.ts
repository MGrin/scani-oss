import { db } from '@scani/db';
import { users } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { eq } from 'drizzle-orm';

/**
 * Where the sign-in that created an account came from (SC-515).
 *
 * SC-507 made the demo the primary CTA on the landing page and shipped nothing
 * that could say whether anyone who saw it opened an account. The activation
 * funnel is a per-account SQL query, so a demo visitor — who has no account —
 * cannot appear in it at all. The one moment the two are connected is the
 * sign-in that turns a visitor into a row, and this is what reads and records it.
 *
 * **Why the `callbackURL` and not a cookie, a header or client storage.** A
 * sign-in here goes out through email and comes back, and the return leg is a
 * top-level navigation the browser makes from a mail client — possibly on
 * another device, certainly from a different origin. Client storage is gone by
 * then, and `app.scani.xyz`'s cookies are not sent to `api.scani.xyz`. The
 * `callbackURL` is the only part of the request the SERVER itself carries
 * across the round trip: Better-Auth stores it on the magic link and hands it
 * back on `/magic-link/verify`, which is the same request that creates the
 * user. So the tag survives the hop server-side, which is the only place it can.
 *
 * **It is not trusted and does not need to be.** Anybody can hand-craft a
 * `callbackURL` carrying the tag. This is an attribution signal for a funnel,
 * never a permission — and the value is closed by `users_signup_source_known`,
 * so the worst a stranger can do is mis-attribute their own signup.
 */

/** Query parameter the demo's outbound link carries. */
export const SIGNUP_SOURCE_PARAM = 'src';

/** The one tag that exists today. `apps/backend/api/src/config/demo.ts` emits it. */
export const DEMO_SIGNUP_TAG = 'demo';

/**
 * - `demo` — the sign-in carried the demo's tag.
 * - `direct` — it did not, on a flow that WOULD have carried one. An observed
 *   absence, which is what lets the column discriminate at all.
 * - `unknown` — the flow cannot carry a tag. Today that is the email-OTP path
 *   the installed PWA uses: `POST /sign-in/email-otp` takes `{email, otp}` and
 *   no `callbackURL`, so there is nothing for a tag to ride on.
 *
 * NULL in the database is a fourth state and means the account predates the
 * column. Merging it with `unknown` would turn "we never looked" into a
 * measurement.
 */
type SignupSource = 'demo' | 'direct' | 'unknown';

/** Only ever used to make a relative `callbackURL` parseable. Never resolved. */
const RELATIVE_BASE = 'http://signup-source.invalid';

const signupSourceLogger = createComponentLogger('auth');

function signupSourceFrom(callbackURL: unknown): SignupSource {
  if (typeof callbackURL !== 'string' || callbackURL.trim() === '') return 'unknown';
  let parsed: URL;
  try {
    // Relative (`/auth/callback?src=demo`) and absolute both occur: the app
    // sends an absolute one, and Better-Auth substitutes `"/"` when a caller
    // sends none.
    parsed = new URL(callbackURL, RELATIVE_BASE);
  } catch {
    // A `callbackURL` we cannot read is not an absence of a tag — we did not
    // get to look. Better-Auth's `originCheck` would have refused this before
    // us, so it is unreachable in practice and stated anyway.
    return 'unknown';
  }
  return parsed.searchParams.get(SIGNUP_SOURCE_PARAM) === DEMO_SIGNUP_TAG ? 'demo' : 'direct';
}

/**
 * Better-Auth hands database hooks a `GenericEndpointContext` whose every field
 * is optional by type and whose `query` is `any`. Digging it out is the part
 * most likely to be silently wrong — a rename upstream would make every signup
 * read `unknown` with nothing going red — so it is one named function with its
 * own tests rather than an inline `ctx?.query?.callbackURL` at the call site.
 */
export function signupSourceFromAuthContext(
  // `null` is in the contract, not defensive: `getCurrentAuthContext()` is
  // `.catch(() => null)`-ed before the hook is called, so a call that arrives
  // outside an endpoint has no request to read at all — which is `unknown`.
  ctx?: { query?: Record<string, unknown> | undefined } | null
): SignupSource {
  return signupSourceFrom(ctx?.query?.callbackURL);
}

/**
 * A second UPDATE rather than a field on the INSERT, on the precedent of
 * `baseCurrencyId` in the same hook — and for a reason stronger than symmetry.
 * Better-Auth's adapter writes only the columns declared in its own schema map
 * (`convertToDB` iterates the declared fields and drops everything else), so a
 * value handed to a `create.before` hook without a matching
 * `user.additionalFields` entry is discarded in silence: the insert succeeds,
 * the hook looks correct, and the column is NULL forever. Writing it ourselves
 * cannot fail that way.
 *
 * Never throws. An account that exists is worth more than knowing where it came
 * from, and this runs inside the hook that finishes a stranger's first sign-in.
 */
export async function recordSignupSource(userId: string, source: SignupSource): Promise<void> {
  try {
    await db.update(users).set({ signupSource: source }).where(eq(users.id, userId));
  } catch (err) {
    signupSourceLogger.error(
      { userId, source, error: err instanceof Error ? err.message : String(err) },
      'Failed to record signup source — the funnel will read this account as predating the column'
    );
  }
}
