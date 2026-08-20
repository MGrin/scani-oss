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
 * There is deliberately no `users.language` column behind this. Every email
 * the product sends is sent inside an HTTP request from a browser: the api's
 * magic-link and OTP mails, and every message the data-provider sends on
 * behalf of a visitor in front of a page. Nothing in `apps/backend/worker`
 * sends mail at all. A column would therefore be written by one caller and read by
 * none — which is the "no dead code" rule, and also a worse answer than the
 * header for the case that matters, since the first letter an account ever
 * receives is the one sent before any preference could have been stored.
 *
 * The day a job emails somebody — a payment reminder, a report — that changes,
 * and the language becomes a property of the user rather than of a request.
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
