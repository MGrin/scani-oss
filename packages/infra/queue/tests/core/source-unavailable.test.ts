import { describe, expect, test } from 'bun:test';
import { UnrecoverableError } from 'bullmq';
import { jobDeathReason, sourceUnavailable, userFacing } from '../../src';

// SC-1527. The reason `markDead` records is what the api reads to decide
// whether Retry is offered, so the brand has to survive into it — and only
// the brand, never the error's words.

describe('jobDeathReason', () => {
  test('an unrecoverable throw branded as an outage is recorded as one', () => {
    expect(jobDeathReason(sourceUnavailable(new UnrecoverableError('no chains')), true)).toBe(
      'source_unavailable'
    );
  });

  test('the brand composes with userFacing', () => {
    const error = userFacing(sourceUnavailable(new UnrecoverableError('Networks are down.')));
    expect(jobDeathReason(error, true)).toBe('source_unavailable');
  });

  test('an unbranded unrecoverable throw stays unrecoverable, whatever it says', () => {
    expect(jobDeathReason(new UnrecoverableError('Chain could not be checked: 429'), true)).toBe(
      'unrecoverable'
    );
  });

  test('a job that used up its attempts is exhausted, branded or not', () => {
    expect(jobDeathReason(new Error('boom'), false)).toBe('retries_exhausted');
    expect(jobDeathReason(sourceUnavailable(new Error('down')), false)).toBe('retries_exhausted');
  });
});
