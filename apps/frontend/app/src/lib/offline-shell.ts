import type { TFunction } from 'i18next';

/**
 * What the app says when it cannot reach its own server (SC-78 §2).
 *
 * Kept out of the component because the wording is the part that has to be
 * assertable, and a test that renders a card to read a sentence is a test that
 * fails when the card's markup changes.
 *
 * The screen this replaces was the sign-in form: offline, an installed-PWA
 * cold start read as "you have been logged out" while the session was in fact
 * intact, and the reader's natural response to that was to sign in again, into
 * a spinner that never resolved.
 *
 * So the copy has one job and one prohibition: say the server is unreachable,
 * and never imply a sign-out.
 *
 * ## Why an ordinary `t`, on the screen that exists for when nothing works
 *
 * Because nothing here runs before the app does, and nothing here needs the
 * network. Both are worth stating, because the opposite was assumed (SC-410):
 *
 * - **This builds no DOM.** It returns strings. `ServerUnreachable` renders
 *   them, and `ProtectedRoute` renders *that* — a static import in `App.tsx`,
 *   not a `lazyRoute`, so it is in the entry chunk with the rest of the shell.
 *   React is mounted before a reader can see any of this.
 * - **No locale is ever fetched.** `src/i18n/index.ts` discovers
 *   `locales/*.json` with an **eager** `import.meta.glob`, so Vite inlines
 *   every language into the entry bundle at build time. i18next is initialised
 *   synchronously from in-memory resources, and the language comes from
 *   `localStorage` via the detector during that same `init` — before the first
 *   render, with no request to fail.
 *
 * A screen that only spoke the reader's language once the app had loaded would
 * be no fix, since the screen exists for when it has not. This one is in the
 * same chunk as the code that decides to show it: if the reader can see the
 * card at all, the translation for it is already in memory.
 */

export interface ServerUnreachableCopy {
  title: string;
  /** Which half is broken, as far as the device can tell. */
  subtitle: string;
  /** The session claim. Names who, when this device has seen anyone. */
  body: string;
  reassurance: string;
  retryLabel: string;
  retryingLabel: string;
  signInLabel: string;
}

export function serverUnreachableCopy({
  email,
  online,
  t,
}: {
  email: string | null;
  online: boolean;
  t: TFunction;
}): ServerUnreachableCopy {
  return {
    title: t('offline.title'),
    subtitle: online ? t('offline.subtitleOnline') : t('offline.subtitleOffline'),
    body: email ? t('offline.bodySignedIn', { email }) : t('offline.bodyUnknown'),
    reassurance: t('offline.reassurance'),
    retryLabel: t('offline.retry'),
    retryingLabel: t('offline.retrying'),
    // Never the primary action: on this screen signing in is the wrong
    // instinct, not the right one.
    signInLabel: t('offline.signInDifferent'),
  };
}
