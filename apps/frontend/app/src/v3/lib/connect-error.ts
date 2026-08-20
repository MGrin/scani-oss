import { httpStatus } from '@scani/ui/lib/user-facing-error';
import { describeQueryError } from '@scani/ui/v3/lib/errors';

type Translate = (key: string, vars?: Record<string, unknown>) => string;

export interface ConnectErrorCopy {
  title: string;
  detail: string;
}

/**
 * "We could not check your keys" is not "your keys are wrong" (SC-445).
 *
 * The connect form has exactly one failure sentence, and until this existed
 * every way of failing produced the same one: `describeQueryError`'s 400
 * branch, which reads "Couldn't connect Kraken. <reason>. Your data is
 * untouched." That is the right sentence for a rejected key and a lie for a
 * venue that was down, timed out, or asked us to slow down — and the reader
 * acts on it, by going back to the exchange to issue keys that were already
 * fine.
 *
 * The api now separates them by status: `BAD_REQUEST` only when a provider
 * reached a verdict, a 5xx or a 408 when it could not. Everything else
 * — offline, 429, 401 — already has copy of its own that makes no claim about
 * the credential, so it keeps going through `describeQueryError`.
 *
 * Returns the two halves rather than a sentence for the same reason
 * `describeQueryError` does: joining them here would put the word order in
 * code, where a translator cannot reach it.
 */
export function connectErrorCopy(
  t: Translate,
  error: unknown,
  institutionName: string
): ConnectErrorCopy {
  const status = httpStatus(error);
  if (status !== null && (status === 408 || status >= 500)) {
    return {
      title: t('v3.capture.integration.unverifiedTitle', { name: institutionName }),
      detail: t('v3.capture.integration.unverifiedDetail', { name: institutionName }),
    };
  }
  const copy = describeQueryError(error, institutionName, 'connect');
  return { title: copy.title, detail: copy.detail };
}
