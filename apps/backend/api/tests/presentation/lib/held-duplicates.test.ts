import { describe, expect, test } from 'bun:test';
import { describeHeldDuplicates } from '../../../src/presentation/lib/held-duplicates';

/**
 * SC-1527. The refusal `createHoldingsBatch` now gives BEFORE it enqueues,
 * where it used to be a job that failed every row in the batch. Read by the
 * screenshot review verbatim (through `describeQueryError`'s 409 branch), so it
 * is the whole of what that surface can say.
 */
describe('describeHeldDuplicates', () => {
  test('names the token and the way through', () => {
    expect(describeHeldDuplicates(['BTC'])).toBe(
      "This account already holds BTC under the same name. Give the new row its own name to keep it as a separate pot, or change the existing holding's balance instead."
    );
  });

  test('names several at once', () => {
    expect(describeHeldDuplicates(['EUR', 'USD'])).toContain('already holds EUR, USD');
  });

  test('stays a sentence a client will show: short, one line, not JSON', () => {
    const message = describeHeldDuplicates(['BTC']);
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message).not.toContain('\n');
  });
});
