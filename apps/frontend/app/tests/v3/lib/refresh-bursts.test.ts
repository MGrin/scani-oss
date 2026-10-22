import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { foldRefreshBursts, type JobRow } from '../../../src/v3/lib/jobs';

/**
 * SC-1724. One app-open queues one `refresh-account-balance` per account,
 * each carrying the `requestId` of the `app-open-refresh` that queued it.
 */
const at = '2026-10-11T09:00:00.000Z';
const open = (requestId: string): JobRow => ({
  jobId: `open-${requestId}`,
  jobName: 'app-open-refresh',
  state: 'completed',
  createdAt: at,
  payloadSummary: { requestId },
});
const refresh = (requestId: string | undefined, i: number, state = 'completed'): JobRow => ({
  jobId: `refresh-${requestId}-${i}`,
  jobName: 'refresh-account-balance',
  state,
  createdAt: at,
  payloadSummary: requestId ? { requestId, accountId: `acct-${i}` } : { accountId: `acct-${i}` },
});

describe('foldRefreshBursts', () => {
  test('a burst folds into the open that queued it, keeping its id', () => {
    const folded = foldRefreshBursts([open('r1'), refresh('r1', 0), refresh('r1', 1, 'active')]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.jobId).toBe('open-r1');
    expect(folded[0]?.burst).toEqual({ total: 2, done: 1, failed: 0, running: 1 });
    expect(folded[0]?.state).toBe('active');
  });

  test('a burst whose open is gone still folds, under its first refresh', () => {
    const folded = foldRefreshBursts([refresh('r1', 0), refresh('r1', 1)]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.jobId).toBe('refresh-r1-0');
    expect(folded[0]?.burst?.total).toBe(2);
  });

  test('a burst that all failed reads failed; one with a success reads completed', () => {
    const allFailed = foldRefreshBursts([
      open('r1'),
      refresh('r1', 0, 'failed'),
      refresh('r1', 1, 'failed'),
    ]);
    expect(allFailed[0]?.state).toBe('failed');
    const some = foldRefreshBursts([open('r1'), refresh('r1', 0, 'failed'), refresh('r1', 1)]);
    expect(some[0]?.state).toBe('completed');
    expect(some[0]?.burst?.failed).toBe(1);
  });

  test('CONTROL: a lone refresh, a refresh with no requestId and other jobs pass through', () => {
    const other: JobRow = {
      jobId: 'p',
      jobName: 'screenshot-parse',
      state: 'completed',
      createdAt: at,
    };
    const folded = foldRefreshBursts([
      refresh('solo', 0),
      refresh(undefined, 1),
      refresh(undefined, 2),
      other,
    ]);
    expect(folded.map((j) => j.jobId)).toEqual([
      'refresh-solo-0',
      'refresh-undefined-1',
      'refresh-undefined-2',
      'p',
    ]);
    expect(folded.every((j) => j.burst === undefined)).toBe(true);
  });
});
