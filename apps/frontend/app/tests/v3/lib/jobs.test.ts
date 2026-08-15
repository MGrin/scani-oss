import { describe, expect, test } from 'bun:test';
import {
  compareJobs,
  deriveJobOutcomeState,
  isJobRunning,
  type JobRow,
  jobBucket,
  jobBucketLabel,
  jobBucketOptions,
  jobNeedsAction,
  jobStateLabel,
  summariseJobPayload,
} from '../../../src/v3/lib/jobs';

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    jobId: 'job-1',
    jobName: 'screenshot-parse',
    state: 'completed',
    createdAt: '2026-08-10T09:00:00.000Z',
    actionTakenAt: null,
    payloadSummary: null,
    ...overrides,
  };
}

describe('jobNeedsAction', () => {
  test('a finished reviewable job with no stamp is waiting on the user', () => {
    expect(jobNeedsAction(job())).toBe(true);
  });

  test('a stamped job is done', () => {
    expect(jobNeedsAction(job({ actionTakenAt: '2026-08-10T10:00:00.000Z' }))).toBe(false);
  });

  test('a job whose name has no follow-up never asks for one', () => {
    expect(jobNeedsAction(job({ jobName: 'holding-price-update' }))).toBe(false);
  });

  test('a running reviewable job is not yet asking for anything', () => {
    expect(jobNeedsAction(job({ state: 'active' }))).toBe(false);
  });
});

describe('jobBucket', () => {
  test('assigns exactly one bucket per job, review outranking completed', () => {
    // The bug this encodes: v2 builds its sections with independent `filter`
    // calls, so a completed-unactioned job appears under both "Needs your
    // review" and "Completed".
    expect(jobBucket(job())).toBe('review');
    expect(jobBucket(job({ actionTakenAt: '2026-08-10T10:00:00.000Z' }))).toBe('completed');
    expect(jobBucket(job({ state: 'queued' }))).toBe('running');
    expect(jobBucket(job({ state: 'progress' }))).toBe('running');
    expect(jobBucket(job({ state: 'failed' }))).toBe('failed');
  });

  test('an unrecognised state reads as completed rather than vanishing', () => {
    expect(jobBucket(job({ jobName: 'user-data-delete', state: 'weird' }))).toBe('completed');
  });

  // SC-153. `state === 'failed'` is written on every failed *attempt*, so the
  // Failed bucket used to hold jobs the queue was still working on — which is
  // also why it could not mean "these are dead".
  test('a job with a retry still coming belongs with the running work', () => {
    expect(
      jobBucket(
        job({ state: 'failed', jobName: 'wallet-import', attemptsMade: 1, attemptsAllowed: 3 })
      )
    ).toBe('running');
  });

  test('a job the queue has given up on is Failed', () => {
    expect(
      jobBucket(
        job({
          state: 'failed',
          jobName: 'wallet-import',
          deadAt: '2026-08-14T12:00:00.000Z',
          failureReason: 'retries_exhausted',
          attemptsMade: 3,
          attemptsAllowed: 3,
        })
      )
    ).toBe('failed');
  });

  test('a cancelled job is Failed rather than perpetually running', () => {
    expect(
      jobBucket(
        job({
          state: 'failed',
          jobName: 'wallet-import',
          deadAt: '2026-08-14T12:00:00.000Z',
          failureReason: 'cancelled',
          attemptsMade: 1,
          attemptsAllowed: 3,
        })
      )
    ).toBe('failed');
  });
});

describe('jobBucketOptions', () => {
  test('offers only the buckets present, in urgency order', () => {
    const options = jobBucketOptions([
      job({ state: 'failed', jobName: 'holding-price-update' }),
      job({ jobId: 'job-2' }),
    ]);
    expect(options).toEqual([
      { value: 'review', label: 'Needs your review' },
      { value: 'failed', label: "Failed — won't retry" },
    ]);
  });

  test('an empty list offers nothing to filter by', () => {
    expect(jobBucketOptions([])).toEqual([]);
  });
});

describe('labels', () => {
  test('names the states a person sees', () => {
    expect(jobStateLabel('progress')).toBe('Running');
    expect(jobStateLabel('completed')).toBe('Completed');
  });

  test('falls back to the raw state rather than rendering nothing', () => {
    expect(jobStateLabel('stalled')).toBe('stalled');
    expect(jobBucketLabel('completed')).toBe('Completed');
  });
});

describe('isJobRunning', () => {
  test('covers all three in-flight states', () => {
    for (const state of ['queued', 'active', 'progress']) {
      expect(isJobRunning(job({ state }))).toBe(true);
    }
    expect(isJobRunning(job({ state: 'completed' }))).toBe(false);
  });
});

describe('compareJobs', () => {
  const older = job({ jobId: 'a', createdAt: '2026-08-01T00:00:00.000Z' });
  const newer = job({ jobId: 'b', createdAt: '2026-08-09T00:00:00.000Z' });

  test('newest first when descending', () => {
    expect(compareJobs(newer, older, 'started', 'desc')).toBeLessThan(0);
  });

  test('accepts a Date as readily as an ISO string', () => {
    const asDate = job({ jobId: 'c', createdAt: new Date('2026-08-09T00:00:00.000Z') });
    expect(compareJobs(asDate, older, 'started', 'asc')).toBeGreaterThan(0);
  });
});

describe('deriveJobOutcomeState', () => {
  test('a parse where every file failed reads as failed, not completed', () => {
    const result = { summary: { successCount: 0, failureCount: 3 } };
    expect(deriveJobOutcomeState('screenshot-parse', 'completed', result)).toBe('failed');
  });

  test('a partial success stays completed', () => {
    const result = { summary: { successCount: 1, failureCount: 2 } };
    expect(deriveJobOutcomeState('file-import', 'completed', result)).toBe('completed');
  });

  test('a manual create where every holding errored reads as failed', () => {
    const result = { holdings: [{ error: 'no price' }, { error: 'no price' }] };
    expect(deriveJobOutcomeState('manual-holdings-create', 'completed', result)).toBe('failed');
  });

  test('one surviving holding is not a failure', () => {
    const result = { holdings: [{ error: 'no price' }, { symbol: 'BTC' }] };
    expect(deriveJobOutcomeState('manual-holdings-create', 'completed', result)).toBe('completed');
  });

  test('never touches a run that has not finished', () => {
    expect(deriveJobOutcomeState('screenshot-parse', 'active', null)).toBe('active');
  });

  test('a result it cannot introspect is left alone', () => {
    expect(deriveJobOutcomeState('exchange-import', 'completed', 'done')).toBe('completed');
  });
});

describe('summariseJobPayload', () => {
  test('names what a wallet import was pointed at', () => {
    expect(
      summariseJobPayload('wallet-import', { chain: 'ethereum', address: '0xabc', label: 'Cold' })
    ).toBe('ethereum · 0xabc · Cold');
  });

  test('drops the parts a payload does not carry', () => {
    expect(summariseJobPayload('wallet-import', { chain: 'solana' })).toBe('solana');
  });

  test('pluralises a file count and refuses to claim zero files', () => {
    expect(summariseJobPayload('screenshot-parse', { fileCount: 1 })).toBe('1 file');
    expect(summariseJobPayload('screenshot-parse', { fileCount: 4 })).toBe('4 files');
    expect(summariseJobPayload('screenshot-parse', {})).toBeNull();
  });

  test('marks an enriched file import', () => {
    expect(summariseJobPayload('file-import', { fileType: 'csv', enrich: true })).toBe(
      'csv · enriched'
    );
  });

  test('a job name with nothing to say says nothing', () => {
    expect(summariseJobPayload('transaction-import', { anything: 1 })).toBeNull();
  });

  test('survives a payload that is not an object', () => {
    expect(summariseJobPayload('wallet-import', 'oops')).toBeNull();
  });
});
