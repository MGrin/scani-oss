/**
 * The request named an account or a holding the requester cannot act on: it
 * does not exist, or it is somebody else's.
 *
 * Typed because the two readers of this failure need different things from it
 * and neither can get them from the words. An API caller shows `message`, so
 * each throw site keeps the sentence it always had. A worker job has to know
 * that a retry cannot change the answer, and has to tell its owner something
 * that is not a uuid — it reads `record` and writes its own sentence (SC-1545).
 */
export class RecordNotAccessibleError extends Error {
  constructor(
    readonly record: 'account' | 'holding',
    message: string
  ) {
    super(message);
    this.name = 'RecordNotAccessibleError';
  }
}
