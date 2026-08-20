/**
 * Which errors are allowed to speak to a reader (SC-311).
 *
 * Every renderer in this kit used to show `error.message`. That made the
 * passthrough the DEFAULT: a deliberate sentence and a programming assertion
 * are both an `Error` with a `message`, so `useTheme must be used within a
 * ThemeProvider` and `snapPoints must contain at least one value in (0, 1]`
 * rendered verbatim under "Something went wrong" — in English forever, since
 * an arbitrary exception has no translation key, and with no URL bar to leave
 * by in the installed PWA (SC-62, SC-73).
 *
 * Deleting the passthrough is the wrong fix, because some of those sentences
 * are the answer: "Nothing to export" and the chunk-failure copy are written
 * for a reader precisely so the app does not say "something broke" when it
 * knows exactly what happened. Collapsing them into one generic sentence is
 * the absence-vs-refusal regression the ticket exists to stop.
 *
 * So the passthrough becomes OPT-IN, through three doors and no others:
 *
 * 1. `UserFacingError` — somebody wrote this sentence for a reader.
 * 2. A plain `string` handed to `showError` — same thing, at a call site that
 *    already had the copy in hand.
 * 3. A rejection our own server wrote, recognised by its envelope rather than
 *    by how the text reads (SC-140).
 *
 * Everything else gets the generic sentence it should always have had.
 *
 * **Why the message is translated at the THROW site, not carried as a key.**
 * The obvious shape is an error holding an i18n key. It does not survive this
 * codebase: `@scani/ui` runs its own i18next instance holding only `ui.*`,
 * because three of its four consumers have no i18n at all (SC-250). A renderer
 * handed `v3.capture.token.addFailed` would have to resolve it against a
 * bundle it does not own — so either the app registers its translator with the
 * kit (a step that can be forgotten, and whose failure mode is a raw key on
 * screen, which is the exact defect SC-250 and SC-257 were both about) or the
 * key silently renders as itself. The throw site, by contrast, provably has
 * the right `t`: it is the only place that knows the key AND its bundle. An
 * error is shown within milliseconds of being thrown, so a message resolved
 * there is in the same language as one resolved at render.
 */

/** The `data` envelope a tRPC client error carries. Duck-typed rather than
 *  importing `TRPCClientError`: the shape is stable, the import is not free,
 *  and this module must stay a pure function of its arguments. */
interface ErrorWithStatus {
  data?: { httpStatus?: unknown } | null;
  message?: unknown;
}

/**
 * A message somebody wrote for a reader, already in the reader's language.
 *
 * Throw this instead of `Error` when the sentence IS the answer — "Nothing to
 * export", "A PDF holds 2,000 rows at most". Anything thrown as a plain
 * `Error` is treated as an accident and shown as the generic sentence, which
 * is the correct default for the overwhelming majority of throws.
 */
export class UserFacingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'UserFacingError';
    // Assigned rather than passed to `super`: the second `ErrorOptions`
    // argument is ignored by the transpile target this bundle still supports,
    // and losing the cause loses the only record of what actually failed.
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export function httpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as ErrorWithStatus).data?.httpStatus;
  return typeof status === 'number' ? status : null;
}

export function errorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const raw = (error as ErrorWithStatus).message;
  return typeof raw === 'string' ? raw : '';
}

/**
 * A rejection the server wrote FOR the reader, or null.
 *
 * A 400 is the one status where the message is the point: the API validates
 * exchange keys against the provider before storing anything and rethrows the
 * provider's own words (`Kraken rejected request: EAPI:Invalid key`), and it is
 * the only place the app can learn *which* thing the reader got wrong. Throwing
 * it away turned every upstream rejection — wrong key, missing permission, IP
 * allowlist, expired key — into one sentence that blamed "the server", so the
 * rational next step was to wait rather than re-check the field (SC-140).
 *
 * Not every rejection carries prose. tRPC serialises a failed input schema into
 * a JSON array of zod issues as its message, and a wall of
 * `[{"code":"too_small",…}]` on screen is worse than the generic sentence. A
 * `TRPCError` thrown with no message at all also arrives carrying its own code
 * as the message, so a bare `BAD_REQUEST` has to be refused too. Only a short,
 * single-line, non-JSON, non-SHOUTING message survives — anything else was
 * written for a log, and the generic branch is the honest answer to it.
 */
const TRPC_CODE = /^[A-Z][A-Z_]*$/;

export function rejectionReason(error: unknown): string | null {
  const raw = errorMessage(error).trim();
  if (!raw || raw.length > 200) return null;
  if (raw.startsWith('[') || raw.startsWith('{')) return null;
  if (raw.includes('\n')) return null;
  if (TRPC_CODE.test(raw)) return null;
  return raw;
}

/**
 * The one question every error renderer in this kit asks.
 *
 * `null` means "nobody wrote this for a reader" — the caller shows its own
 * generic sentence. It is never the raw text of an error nobody vouched for.
 */
export function userFacingMessage(error: unknown): string | null {
  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed || null;
  }
  if (error instanceof UserFacingError) return error.message.trim() || null;
  // The server envelope, NOT the shape of the text. A component's assertion
  // can read as a perfectly tidy sentence — `Kraken rejected request: …` would
  // pass every rule in `rejectionReason` if a component happened to throw it —
  // so the discriminator has to be a fact about where the error came from.
  if (httpStatus(error) === null) return null;
  return rejectionReason(error);
}
