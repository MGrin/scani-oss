import { LANGUAGE_HEADER } from '@scani/shared';

/**
 * The interface language of the request that asked for an auth email, or null
 * (SC-412).
 *
 * **This is the whole of "where the language comes from".** A signed-out
 * sender knows only an email address, so on a first sign-in there is nothing
 * stored to read — the language has to arrive with the request, and it does,
 * on a header the app sets from its own `i18n.language`.
 *
 * On a sign-in it is also written to `users.language` (SC-1503): the
 * activation nudge is mailed by a job, outside any request, so for that one
 * letter the language is a property of the account. Every other mail still
 * reads the header, because the first letter an account receives is sent
 * before any preference could have been stored.
 *
 * Better-Auth hands its callbacks a `GenericEndpointContext` whose shape is
 * partial by type, so both spellings are read: `headers` is what better-call
 * populates, `request` is the original when the adapter passed one through.
 */
export function languageFromAuthContext(ctx?: {
  headers?: Headers | undefined;
  request?: Request | undefined;
}): string | null {
  const value = ctx?.headers?.get(LANGUAGE_HEADER) ?? ctx?.request?.headers.get(LANGUAGE_HEADER);
  if (!value) return null;
  // A tag is `en`, `ru-RU`, `pt-BR`. Anything longer or stranger than that
  // came from something that is not our app, and a header is attacker-typed
  // even when it is harmless — it reaches `resolveEmailStrings`, which returns
  // English for anything it does not recognise, but there is no reason to
  // carry 4 KB of junk that far.
  return /^[A-Za-z]{2,8}([-_][A-Za-z0-9]{2,8})?$/.test(value) ? value : null;
}
