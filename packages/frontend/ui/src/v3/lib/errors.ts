import { uiT } from '../../i18n';
import { errorMessage, httpStatus, rejectionReason } from '../../lib/user-facing-error';
/**
 * Error copy, under the voice rules of §2.5.
 *
 * Three rules, and every string below is checkable against them:
 *
 * 1. **Say what happened.** "Couldn't reach the server" — not "Something went
 *    wrong", which tells the reader only that the app noticed.
 * 2. **Say what to do**, and make the retry a real action rather than a
 *    suggestion to reload the page.
 * 3. **Never apologise.** An apology is the app asking to be forgiven instead
 *    of telling the reader whether their data is intact. Saying the data is
 *    untouched is the thing that actually settles someone reading an error on
 *    a finance app.
 *
 * The subject is the caller's, because the specific noun is what separates
 * "Couldn't reach Kraken" from "Something went wrong" — this module cannot
 * know it and must not invent it.
 *
 * Duck-typed rather than importing `TRPCClientError`: the shape is stable, the
 * import is not free, and this file has to stay a pure function of its
 * arguments so the voice rules can be asserted in a test.
 *
 * `httpStatus` / `errorMessage` / `rejectionReason` live in
 * `lib/user-facing-error` (SC-311) rather than here: the same "did a person
 * write this for a reader?" decision is now made by the toast helper and the
 * crash boundary too, and neither of those is v3-scoped.
 */

export interface ErrorCopy {
  title: string;
  detail: string;
  retryLabel: string;
}

/** A request that never reached the server at all. `fetch` rejects with a
 *  `TypeError` whose wording differs per engine, so this matches on all three
 *  of the phrasings the browsers in scope produce. */
function isNetworkFailure(error: unknown): boolean {
  const text = errorMessage(error).toLowerCase();
  return (
    httpStatus(error) === null &&
    (text.includes('failed to fetch') ||
      text.includes('networkerror') ||
      text.includes('load failed') ||
      text.includes('network request failed'))
  );
}

/**
 * What the caller was doing, as a closed set rather than a free string.
 *
 * It was a `string` defaulting to `'load'`, and every caller passed an English
 * word straight into a sentence this file then translates — so a Russian
 * reader got "Не удалось load этот кошелёк" (SC-201). A union resolved through
 * `ui.errors.verb.*` is the smallest change that makes the frame and its verb
 * come from the same bundle; the four values are every one a caller uses.
 */
export type ErrorVerb = 'load' | 'create' | 'save' | 'connect';

/**
 * @param subject the noun the caller is acting on — `this payment`, `Kraken`.
 *   Callers pass a translated noun or a proper name; never an English literal.
 * @param verb what the caller was doing, for the title. Defaults to `load`,
 *   which is wrong for a write: a rejected *connect* that says "Couldn't load
 *   Kraken" describes an action the reader never took.
 */
export function describeQueryError(
  error: unknown,
  subject: string,
  verbKey: ErrorVerb = 'load'
): ErrorCopy {
  // Resolved against the KIT's instance, never a caller's. Every key below is
  // `ui.*`, which lives only in this package's bundle — the app's instance
  // holds none of them, so a caller passing its own `t` got the key back as
  // the string. Five v3 import flows rendered `ui.errors.offline.title` in
  // their FAILURE state, which is the moment the copy matters most (SC-316).
  //
  // Taking a `t` parameter was the defect, not the callers: a function that
  // resolves only this package's keys must not accept a translator that
  // structurally cannot resolve them.
  const t = uiT;
  const verb = t(`ui.errors.verb.${verbKey}`);
  if (isNetworkFailure(error)) {
    return {
      title: t('ui.errors.offline.title'),
      detail: t('ui.errors.offline.detail'),
      retryLabel: t('ui.errors.tryAgain'),
    };
  }

  const status = httpStatus(error);

  if (status === 401 || status === 403) {
    return {
      title: t('ui.errors.session.title'),
      detail: t('ui.errors.session.detail', { subject }),
      retryLabel: t('ui.errors.tryAgain'),
    };
  }

  if (status === 408 || status === 504) {
    return {
      title: t('ui.errors.timeout.title'),
      detail: t('ui.errors.timeout.detail', { verb, subject }),
      retryLabel: t('ui.errors.tryAgain'),
    };
  }

  if (status === 429) {
    return {
      title: t('ui.errors.rateLimit.title'),
      detail: t('ui.errors.rateLimit.detail'),
      retryLabel: t('ui.errors.retry'),
    };
  }

  // A 422 is the same case as a 400 — both are "we read your input and it is
  // not usable", and tRPC's `UNPROCESSABLE_CONTENT` reaches the client as one.
  if (status === 400 || status === 422) {
    const reason = rejectionReason(error);
    if (reason) {
      return {
        title: t('ui.errors.generic.title', { verb, subject }),
        detail: t('ui.errors.rejected.detail', { reason: reason.replace(/[.!]$/, '') }),
        retryLabel: t('ui.errors.tryAgain'),
      };
    }
  }

  return {
    title: t('ui.errors.generic.title', { verb, subject }),
    detail: t('ui.errors.generic.detail'),
    retryLabel: t('ui.errors.tryAgain'),
  };
}
