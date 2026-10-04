import { RecordNotAccessibleError } from '@scani/domain/services';
import { createComponentLogger } from '@scani/logging';
import { UnrecoverableError, userFacing } from '@scani/queue';

const logger = createComponentLogger('worker:request-refusal');

/**
 * What a job's owner reads when the account, holding or institution it named
 * is gone, or was never theirs.
 *
 * One sentence per record for both cases, on purpose: another user's record reads as missing,
 * so the answer says nothing about an id that is not the requester's
 * (SC-1336). And no id at all — the domain message carries a uuid, and this
 * string is shown to a person on the Jobs page (SC-1527).
 */
export function describeRefusedRecord(record: RecordNotAccessibleError['record']): string {
  switch (record) {
    case 'account':
      return 'The account this was for could not be found. It may have been deleted. Choose another account and try again.';
    case 'holding':
      return 'The holding this was for could not be found. It may have been deleted. Reload the page and try again.';
    case 'institution':
      return 'The institution this was for could not be found. It may have been removed. Choose another institution and try again.';
  }
}

/**
 * The error a user job fails with in place of `error` (SC-1545).
 *
 * A request the domain layer refused comes back as a user-facing
 * `UnrecoverableError`: the record will not start existing on a retry, and a
 * person naming a deleted account is not a failure to page on or to file in
 * the dead-letter queue. Anything else comes back untouched, so it is still
 * retried and still alerts.
 *
 * The domain message is logged here because it is about to be replaced: it is
 * the only place the id and the not-found/not-theirs distinction survive.
 */
export function asJobFailure(error: unknown, jobId: string | undefined): unknown {
  if (!(error instanceof RecordNotAccessibleError)) return error;
  logger.warn(
    { jobId, record: error.record, reason: error.message },
    'Job refused: the record it names is missing or belongs to another user'
  );
  return userFacing(new UnrecoverableError(describeRefusedRecord(error.record)));
}
