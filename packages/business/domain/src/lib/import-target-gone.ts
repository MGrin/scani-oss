/**
 * An exchange import named a user, a credential or an institution that is no
 * longer there.
 *
 * Typed because a retry cannot change the answer and the worker cannot learn
 * that from the words: the job is enqueued only after its credential row is
 * committed, so one missing at run time was removed in between. A lookup that
 * FAILS is a different error and is still retried. Each throw site keeps the
 * message it always had (SC-1545).
 */
export class ImportTargetGoneError extends Error {
  constructor(
    readonly missing: 'user' | 'credentials' | 'institution',
    message: string
  ) {
    super(message);
    this.name = 'ImportTargetGoneError';
  }
}
