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
 */

export interface ErrorCopy {
  title: string;
  detail: string;
  retryLabel: string;
}

/** The `data` envelope a tRPC client error carries. */
interface ErrorWithStatus {
  data?: { httpStatus?: unknown } | null;
  message?: unknown;
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as ErrorWithStatus).data?.httpStatus;
  return typeof status === 'number' ? status : null;
}

function message(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const raw = (error as ErrorWithStatus).message;
  return typeof raw === 'string' ? raw : '';
}

/** A request that never reached the server at all. `fetch` rejects with a
 *  `TypeError` whose wording differs per engine, so this matches on all three
 *  of the phrasings the browsers in scope produce. */
function isNetworkFailure(error: unknown): boolean {
  const text = message(error).toLowerCase();
  return (
    httpStatus(error) === null &&
    (text.includes('failed to fetch') ||
      text.includes('networkerror') ||
      text.includes('load failed') ||
      text.includes('network request failed'))
  );
}

/**
 * A rejection reason the server wrote FOR the reader, or null.
 *
 * A 400 is the one status where the message is the point: the API validates
 * exchange keys against the provider before storing anything and rethrows the
 * provider's own words (`Kraken rejected request: EAPI:Invalid key`), and it is
 * the only place the app can learn *which* thing the reader got wrong. Throwing
 * it away turned every upstream rejection — wrong key, missing permission, IP
 * allowlist, expired key — into one sentence that blamed "the server", so the
 * rational next step was to wait rather than re-check the field (SC-140).
 *
 * Not every 400 carries prose. tRPC serialises a failed input schema into the
 * same status with a JSON array of zod issues as its message, and a wall of
 * `[{"code":"too_small",…}]` on screen is worse than the generic sentence. A
 * `TRPCError` thrown with no message at all also arrives carrying its own code
 * as the message, so a bare `BAD_REQUEST` has to be refused too. Only a short,
 * single-line, non-JSON, non-SHOUTING message survives — anything else was
 * written for a log, and the generic branch is the honest answer to it.
 */
const TRPC_CODE = /^[A-Z][A-Z_]*$/;

function rejectionReason(error: unknown): string | null {
  const raw = message(error).trim();
  if (!raw || raw.length > 200) return null;
  if (raw.startsWith('[') || raw.startsWith('{')) return null;
  if (raw.includes('\n')) return null;
  if (TRPC_CODE.test(raw)) return null;
  return raw;
}

/**
 * @param subject the noun the caller is acting on — `this payment`, `Kraken`.
 * @param verb what the caller was doing, for the title. Defaults to `load`,
 *   which is wrong for a write: a rejected *connect* that says "Couldn't load
 *   Kraken" describes an action the reader never took.
 */
export function describeQueryError(error: unknown, subject: string, verb = 'load'): ErrorCopy {
  if (isNetworkFailure(error)) {
    return {
      title: "Couldn't reach the server",
      detail: 'Check your connection. Nothing has been changed.',
      retryLabel: 'Try again',
    };
  }

  const status = httpStatus(error);

  if (status === 401 || status === 403) {
    return {
      title: 'Your session ended',
      detail: `Sign in again to see ${subject}.`,
      retryLabel: 'Try again',
    };
  }

  if (status === 408 || status === 504) {
    return {
      title: 'The server took too long',
      detail: `That request to ${verb} ${subject} timed out. Your data is untouched.`,
      retryLabel: 'Try again',
    };
  }

  if (status === 429) {
    return {
      title: 'Too many requests',
      detail: 'The server asked us to slow down. Wait a moment, then retry.',
      retryLabel: 'Retry',
    };
  }

  // A 422 is the same case as a 400 — both are "we read your input and it is
  // not usable", and tRPC's `UNPROCESSABLE_CONTENT` reaches the client as one.
  if (status === 400 || status === 422) {
    const reason = rejectionReason(error);
    if (reason) {
      return {
        title: `Couldn't ${verb} ${subject}`,
        detail: `${reason.replace(/[.!]$/, '')}. Your data is untouched.`,
        retryLabel: 'Try again',
      };
    }
  }

  return {
    title: `Couldn't ${verb} ${subject}`,
    detail: 'The server returned an error. Your data is untouched.',
    retryLabel: 'Try again',
  };
}
