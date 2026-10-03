import { describe, expect, test } from 'bun:test';
import { OUTCOME_JOB_NAMES, outcomeState, readJobOutcome } from '../../src/dtos/job-outcome';

// SC-1527. One reading of "what did this run produce", shared by the server
// (which sends the counts on every `jobs.listMine` row) and the job page
// (which reads them off the full result) — so the two cannot disagree.

describe('readJobOutcome', () => {
  test('a parse reads its own per-file summary', () => {
    expect(
      readJobOutcome('screenshot-parse', { summary: { successCount: 0, failureCount: 1 } })
    ).toEqual({ succeeded: 0, failed: 1 });
  });

  test('a manual create counts holdings with and without an error', () => {
    expect(
      readJobOutcome('manual-holdings-create', {
        holdings: [{ error: 'no price' }, { symbol: 'BTC' }, { error: 'no price' }],
      })
    ).toEqual({ succeeded: 1, failed: 2 });
  });

  test('a job whose result carries no outcome has none', () => {
    expect(readJobOutcome('wallet-import', { chains: [] })).toBeNull();
    expect(readJobOutcome('screenshot-parse', null)).toBeNull();
    expect(readJobOutcome('screenshot-parse', 'done')).toBeNull();
  });

  test('a job name outside the list it reads is never read', () => {
    expect(OUTCOME_JOB_NAMES).not.toContain('wallet-import');
    expect(
      readJobOutcome('exchange-import', { summary: { successCount: 0, failureCount: 1 } })
    ).toBeNull();
  });
});

describe('outcomeState', () => {
  test('a finished run that produced nothing and failed something is failed', () => {
    expect(outcomeState('completed', { succeeded: 0, failed: 1 })).toBe('failed');
  });

  test('a partial success stays completed', () => {
    expect(outcomeState('completed', { succeeded: 1, failed: 2 })).toBe('completed');
  });

  test('an empty run with nothing failed is not a failure', () => {
    expect(outcomeState('completed', { succeeded: 0, failed: 0 })).toBe('completed');
  });

  test('a run that has not finished, or has no outcome, keeps its state', () => {
    expect(outcomeState('active', { succeeded: 0, failed: 1 })).toBe('active');
    expect(outcomeState('completed', null)).toBe('completed');
    expect(outcomeState('completed', undefined)).toBe('completed');
  });
});
