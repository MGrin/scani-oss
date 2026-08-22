import { describe, expect, test } from 'bun:test';
import { UnrecoverableError } from 'bullmq';
import { userFacing, userFacingMessage } from '../../src/core/user-facing';

/**
 * The gate is DEFAULT-DENY, and every test here is really the same assertion
 * from a different side: nothing reaches the job's owner unless somebody said
 * it should.
 *
 * The tests that matter most are the negative ones. A gate that lets the right
 * things through is easy to write and easy to check; one that reliably refuses
 * everything else is the whole security property, and its failures are silent —
 * an unmarked message that slips through looks exactly like a marked one on
 * screen.
 */
describe('nothing speaks to the owner unless it was marked', () => {
  test('a plain Error says nothing, however readable it looks', () => {
    // The sentence a human would happily show a user. It is still refused,
    // because how the text READS cannot establish who wrote it for whom —
    // the same argument that makes SC-311 gate on the server envelope rather
    // than on message shape.
    expect(userFacingMessage(new Error('Your API key was rejected by Kraken.'))).toBeNull();
  });

  test('a raw SQL failure says nothing — the case this exists for', () => {
    const err = new Error(
      'Failed query: select "id", "user_id", "account_id", "balance" from "holdings" where "holdings"."id" = $1 limit $2'
    );
    expect(userFacingMessage(err)).toBeNull();
  });

  test('an UnrecoverableError is not a claim about audience', () => {
    // Terminality and audience are different questions that often coincide.
    // `wallet-import` throws `UnrecoverableError` carrying an internal summary,
    // so reading "the queue gave up" as "show this to the user" would leak.
    expect(userFacingMessage(new UnrecoverableError('produced no chains; errors: …'))).toBeNull();
  });

  test('non-errors say nothing', () => {
    for (const value of [null, undefined, 'a bare string', 42, {}, { message: 'hello' }]) {
      expect(userFacingMessage(value)).toBeNull();
    }
  });
});

describe('a marked message survives', () => {
  test('userFacing returns the same object, so it wraps a throw in place', () => {
    const err = new Error('Nothing to import.');
    expect(userFacing(err)).toBe(err);
  });

  test('the marked message is what comes back', () => {
    const err = userFacing(new Error('The uploaded file is no longer available.'));
    expect(userFacingMessage(err)).toBe('The uploaded file is no longer available.');
  });

  test('it composes with UnrecoverableError, which is why it is a brand', () => {
    // The four processors that throw owner-facing copy all throw
    // `UnrecoverableError`. A `UserFacingError extends Error` subclass would
    // have forced them to choose between saying "do not retry" and saying
    // "show this"; both claims are true and both are needed.
    const err = userFacing(new UnrecoverableError('Delete this document and upload it again.'));
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe('Delete this document and upload it again.');
  });

  test('an empty or whitespace message is not a message', () => {
    expect(userFacingMessage(userFacing(new Error('   ')))).toBeNull();
    expect(userFacingMessage(userFacing(new Error('')))).toBeNull();
  });

  test('the mark does not serialise, and must not', () => {
    // Deliberate. The brand is read once, in the catch, in the same process
    // that threw. If it survived JSON it would invite a downstream consumer to
    // re-derive provenance from the wire — and a value that crossed a boundary
    // can no longer vouch for itself. What crosses is the extracted string.
    const err = userFacing(new Error('shown to the owner'));
    const revived = JSON.parse(JSON.stringify({ ...err, message: err.message }));
    expect(userFacingMessage(revived)).toBeNull();
  });
});
