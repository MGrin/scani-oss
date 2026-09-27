/**
 * The api's refusal of an irreversible action from a session signed in more
 * than five minutes ago (SC-1351, `requireFreshSession`). The one answer to it
 * is a code sign-in, which mints a new session, then the same request again.
 */
export function isSessionNotFresh(error: unknown): boolean {
  return error instanceof Error && error.message === 'SESSION_NOT_FRESH';
}
