/**
 * Carries the demo's tag from the link that brought a visitor here into the
 * sign-in that creates their account (SC-515).
 *
 * The demo's "create your own account" link is `…/?src=demo`, and the account
 * it eventually produces is created on `api.scani.xyz` in the request that
 * verifies a magic link — an email round trip later, possibly from another
 * device. Nothing in this tab is present at that moment. What IS present is the
 * `callbackURL` the server stored on the magic link, so this module's entire
 * job is to get the tag from the landing URL onto that `callbackURL`, and the
 * server takes it from there (`apps/backend/api/src/auth/signup-source.ts`).
 *
 * **Why `sessionStorage` and not `localStorage`.** The lifetime wanted is
 * exactly the gap between arriving at `/?src=demo` and submitting an email
 * address on `/auth` — one visit, one tab. Nothing needs it after that: the
 * return leg reads the tag off the URL the server redirected to, not from here.
 * A `localStorage` value would outlive its meaning and tag a signup made a week
 * later from the same browser.
 *
 * **The tag is forwarded, not interpreted.** This does not know what `demo`
 * means; it knows the shape a tag may have, so a stranger cannot use the
 * parameter to smuggle something into a URL the server will parse. Deciding
 * what a tag counts as is the server's, where the value is closed.
 */

const STORAGE_KEY = 'scani.signup-source';

/** The parameter the demo's link carries. Mirrors `SIGNUP_SOURCE_PARAM`. */
const PARAM = 'src';

/**
 * A tag is a short slug. Anything else came from something that is not our
 * link, and it is going to be appended to a URL — so it is bounded here rather
 * than trusted to be harmless.
 */
const TAG_SHAPE = /^[a-z0-9-]{1,32}$/;

/** Same reasoning as `chunk-reload.ts`: Safari with website data blocked throws
 *  on the property access itself, not on the call. */
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Remember the tag on the URL this document was opened with, if there is one.
 *
 * Called from `main.tsx` before React renders, because the query string does
 * not survive the redirect an anonymous visitor takes from `/` to `/auth`.
 *
 * Silent about everything: a visitor who arrived with no tag, a browser with no
 * storage, and a malformed parameter are all "there is nothing to carry", which
 * is the ordinary case rather than a failure.
 */
export function captureSignupSource(
  search: string = window.location.search,
  storage: Storage | null = sessionStore()
): void {
  if (!storage) return;
  const tag = new URLSearchParams(search).get(PARAM);
  if (tag === null || !TAG_SHAPE.test(tag)) return;
  try {
    storage.setItem(STORAGE_KEY, tag);
  } catch {
    // Quota or a security error. The visit is untagged, which reads as
    // `direct` — an under-count, never a wrong attribution.
  }
}

/** Internal: `withSignupSource` is the only caller, and the only thing anybody
 *  outside this module needs. */
function readSignupSource(storage: Storage | null): string | null {
  if (!storage) return null;
  try {
    const tag = storage.getItem(STORAGE_KEY);
    return tag !== null && TAG_SHAPE.test(tag) ? tag : null;
  } catch {
    return null;
  }
}

/**
 * Put the remembered tag on a `callbackURL`, or return it untouched.
 *
 * Never overwrites an existing `src`: the caller may have built one
 * deliberately, and a tag this module merely remembered is the weaker claim.
 */
export function withSignupSource(
  callbackURL: string,
  storage: Storage | null = sessionStore()
): string {
  const tag = readSignupSource(storage);
  if (tag === null) return callbackURL;
  let url: URL;
  try {
    // The caller builds an absolute URL, so the base is only there to keep a
    // relative one parseable. `undefined` off a browser is deliberate: under
    // `bun test` there is no `window`, and reaching for one would make this
    // function's behaviour depend on a global rather than on its arguments.
    url = new URL(callbackURL, typeof window === 'undefined' ? undefined : window.location.origin);
  } catch {
    return callbackURL;
  }
  if (url.searchParams.has(PARAM)) return callbackURL;
  url.searchParams.set(PARAM, tag);
  return url.toString();
}
