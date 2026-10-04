import { describe, expect, test } from 'bun:test';
import { RecordNotAccessibleError } from '@scani/domain/services';
import { UnrecoverableError, userFacingMessage } from '@scani/queue';
import { asJobFailure, describeRefusedRecord } from '../../src/lib/request-refusal';

// SC-1545. The three refusals that reached the dead-letter queue, as the
// domain layer words them. The second carried a real uuid in production.
const ACCESS_DENIED = new RecordNotAccessibleError('account', 'Access denied to this account');
const ACCOUNT_GONE = new RecordNotAccessibleError('account', 'Account with ID acct-1 not found');
const HOLDING_GONE = new RecordNotAccessibleError('holding', 'Holding not found');
// SC-1558: a manual entry naming an institution that is gone or not theirs.
const INSTITUTION_GONE = new RecordNotAccessibleError(
  'institution',
  'Institution with ID inst-1 not found'
);

describe('asJobFailure', () => {
  test.each([
    ['an account that is not theirs', ACCESS_DENIED],
    ['an account that is gone', ACCOUNT_GONE],
    ['a holding that is gone', HOLDING_GONE],
    ['an institution that is gone', INSTITUTION_GONE],
  ])('%s ends the job without a retry', (_name, refused) => {
    // A plain Error would be retried, then copied to the dead-letter queue.
    expect(asJobFailure(refused, 'job-1')).toBeInstanceOf(UnrecoverableError);
  });

  test('the owner reads a sentence written for them, not the domain message', () => {
    expect(userFacingMessage(asJobFailure(ACCOUNT_GONE, 'job-1'))).toBe(
      'The account this was for could not be found. It may have been deleted. Choose another account and try again.'
    );
    expect(userFacingMessage(asJobFailure(HOLDING_GONE, 'job-1'))).toBe(
      'The holding this was for could not be found. It may have been deleted. Reload the page and try again.'
    );
  });

  test('an institution refusal has its own sentence, with no id in it', () => {
    const message = userFacingMessage(asJobFailure(INSTITUTION_GONE, 'job-1'));
    expect(message).toBe(
      'The institution this was for could not be found. It may have been removed. Choose another institution and try again.'
    );
    expect(message).not.toContain('inst-1');
  });

  test('the id the domain message carries does not reach the owner', () => {
    expect(userFacingMessage(asJobFailure(ACCOUNT_GONE, 'job-1'))).not.toContain('acct-1');
  });

  // Another user's record reads as missing: the answer must say nothing about
  // an id that is not the requester's (SC-1336).
  test("somebody else's account reads exactly as a missing one", () => {
    expect(userFacingMessage(asJobFailure(ACCESS_DENIED, 'job-1'))).toBe(
      describeRefusedRecord('account')
    );
  });

  test('CONTROL: anything else comes back as the same object, unmarked', () => {
    const dropped = new Error('socket hang up');
    const failure = asJobFailure(dropped, 'job-1');
    expect(failure).toBe(dropped);
    expect(failure).not.toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(failure)).toBeNull();
  });
});
