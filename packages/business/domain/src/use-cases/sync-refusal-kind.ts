import { ProviderError } from '@scani/providers/core/errors';

/** A refusal that usually means a dead key, recorded until confirmed (SC-1733). */
export const SUSPECT_CREDENTIAL = 'credential-suspect';

/** How long after the first suspect answer a second one confirms it. */
const SUSPECT_CONFIRMED_AFTER_MS = 60 * 60 * 1000;

/**
 * The refusal kind a sync records. A suspect answer (a Fio 500: a dead token,
 * or an outage) is recorded as a suspect, which pauses nothing. It becomes
 * `auth-failed`, which stops every scheduler until the key is replaced
 * (SC-1728), only when the run of suspect answers began at least an hour ago:
 * two answers an hour apart, not one bad hour.
 */
export function syncRefusalKind(
  error: unknown,
  credential: { syncRefusalKind: string | null; syncRefusalSince: Date | null },
  now: Date
): string | null {
  if (!(error instanceof ProviderError)) return null;
  if (!error.suspectCredential) return error.kind;
  const since =
    credential.syncRefusalKind === SUSPECT_CREDENTIAL ? credential.syncRefusalSince : null;
  return since && now.getTime() - since.getTime() >= SUSPECT_CONFIRMED_AFTER_MS
    ? 'auth-failed'
    : SUSPECT_CREDENTIAL;
}
