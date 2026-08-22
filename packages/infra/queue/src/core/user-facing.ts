/**
 * Which part of a failed job may be shown to the person who started it
 * (SC-551).
 *
 * `UserJobProcessor` captures `err.message` verbatim for any throw out of any
 * `handle()`, and that is correct — three admin surfaces read it and an
 * operator diagnosing a DLQ entry needs exactly the raw text. It is also how a
 * `DrizzleQueryError` put a full
 * `select "id", "user_id", … from "holdings" where …` in front of an
 * authenticated user: the same string went to the operator and to the owner.
 *
 * So the two audiences get different values, and the split is **opt-in**:
 * nothing reaches the owner unless somebody deliberately wrote it for them.
 * This is SC-311's rule, one layer down. There it is `UserFacingError` and a
 * `userFacingMessage` gate in `@scani/ui`; the reasoning is the same and the
 * mechanism cannot be, for two reasons:
 *
 * 1. **A brand, not a subclass.** The processors that throw reader-facing copy
 *    throw BullMQ's `UnrecoverableError`, because the message being
 *    user-actionable and the retry budget being skipped are *different claims*
 *    that happen to coincide. A `UserFacingJobError extends Error` would force
 *    a choice between them; `userFacing(new UnrecoverableError(msg))` composes.
 *    Reading terminality as an audience signal would also be wrong in the other
 *    direction — `wallet-import` throws `UnrecoverableError` carrying an
 *    internal summary.
 *
 * 2. **It is read in-process, never on the wire.** The brand is a property on
 *    the thrown object and dies at the process boundary, which is fine: it is
 *    read once, in the catch that captures the message, and what crosses to the
 *    api is the already-extracted string. Nothing downstream re-derives
 *    provenance from text — that is precisely the mistake SC-311's
 *    `rejectionReason` gate exists to avoid, since a tidy internal sentence
 *    passes every shape rule you could write.
 */

const USER_FACING = Symbol.for('scani.queue.userFacingError');

/**
 * Mark an error's message as written for the job's owner.
 *
 * Use it where the sentence IS the answer — "The original file is no longer
 * stored. Delete this document and upload it again." Anything thrown without
 * it is treated as an accident, and the owner is told the job failed without
 * being shown the words.
 *
 * Returns the same object, so it wraps a throw in place:
 *
 * ```ts
 * throw userFacing(new UnrecoverableError('Your API key was rejected.'));
 * ```
 */
export function userFacing<E extends Error>(error: E): E {
  Object.defineProperty(error, USER_FACING, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return error;
}

/**
 * The message this error is allowed to show its owner, or `null`.
 *
 * `null` means nobody vouched for it — the caller shows a translated
 * category instead (`jobFailureSentence`, SC-424). It is never the raw text of
 * an error nobody marked.
 */
export function userFacingMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if ((error as Record<symbol, unknown>)[USER_FACING] !== true) return null;
  const raw = (error as { message?: unknown }).message;
  if (typeof raw !== 'string') return null;
  return raw.trim() || null;
}
