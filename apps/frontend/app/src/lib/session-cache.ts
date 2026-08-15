/**
 * The last identity this device saw, remembered locally.
 *
 * Why it has to exist (SC-78 §2): the session lives in an HttpOnly cookie on
 * `api.scani.xyz`, so the only way the client can learn whether it is signed in
 * is to ask the server. When the server cannot be reached that question has no
 * answer — but `AuthProvider` used to treat the failure as the answer "no", and
 * an offline cold start of the installed PWA landed on "Welcome / Enter your
 * email". The session was intact the whole time (relaunching with the api back
 * went straight to the holdings screen), so the screen was telling the reader
 * something false about their own account, and the natural response to it —
 * trying to sign in — walked into §1's wedge.
 *
 * This is a HINT, never a credential: nothing here grants access, and every
 * protected call still fails without the cookie. It exists so the shell can say
 * "you are still signed in, we just cannot reach the server" instead of
 * "you are signed out", and so the offline screen can name who.
 *
 * Written on every resolved session and cleared on the two events that make it
 * false: a definitive signed-out answer from the server, and sign-out.
 */

export interface CachedAuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}

const STORAGE_KEY = 'scani.auth.last-user';

/** `localStorage` throws in private-mode Safari and is absent under the test
 *  runner; a missing hint is only ever a slightly worse message. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Anything that is not a plausible user record is treated as absent — a
 *  half-written or hand-edited value must not reach a screen as a name. */
export function parseCachedUser(raw: string | null): CachedAuthUser | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { id, email, name, image } = parsed as Record<string, unknown>;
    if (typeof id !== 'string' || !id) return null;
    if (typeof email !== 'string' || !email) return null;
    return {
      id,
      email,
      name: typeof name === 'string' ? name : null,
      image: typeof image === 'string' ? image : null,
    };
  } catch {
    return null;
  }
}

export function readCachedUser(store: Storage | null = storage()): CachedAuthUser | null {
  if (!store) return null;
  try {
    return parseCachedUser(store.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeCachedUser(user: CachedAuthUser, store: Storage | null = storage()): void {
  if (!store) return;
  try {
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        image: user.image ?? null,
      })
    );
  } catch {
    // A full or refusing store costs the offline screen a name, nothing more.
  }
}

export function clearCachedUser(store: Storage | null = storage()): void {
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Same as above.
  }
}
