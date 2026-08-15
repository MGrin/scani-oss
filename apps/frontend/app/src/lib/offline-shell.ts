/**
 * What the app says when it cannot reach its own server (SC-78 §2).
 *
 * Kept out of the component because the component imports the SVG registry,
 * which is `import.meta.glob` and therefore Vite-only — and the wording is the
 * part that has to be assertable. The screen this replaces was the sign-in
 * form: offline, an installed-PWA cold start read as "you have been logged
 * out" while the session was in fact intact, and the reader's natural response
 * to that was to sign in again, into a spinner that never resolved.
 *
 * So the copy has one job and one prohibition: say the server is unreachable,
 * and never imply a sign-out.
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
}: {
  email: string | null;
  online: boolean;
}): ServerUnreachableCopy {
  return {
    title: 'Can’t reach Scani',
    subtitle: online
      ? 'Your device is online, but Scani’s server didn’t answer.'
      : 'This device has no connection right now.',
    body: email
      ? `You’re still signed in as ${email}. Nothing has been logged out — we just can’t load your data until the server answers.`
      : 'We can’t load anything until the server answers.',
    reassurance: 'This retries on its own as soon as the connection is back.',
    retryLabel: 'Try again',
    retryingLabel: 'Trying again…',
    // Never the primary action: on this screen signing in is the wrong
    // instinct, not the right one.
    signInLabel: 'Sign in with a different email',
  };
}
