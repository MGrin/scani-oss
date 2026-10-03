import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { JOB_STATUS_POLL_OPTIONS, jobPollIsDone } from '../../../src/v3/lib/jobs';

/**
 * SC-1542. A job page read "Active" for 34 seconds after its job had finished
 * in a tenth of one. `useJobStatus` polls `jobs.status` every 2 s when no
 * realtime event has arrived, but it polled through the query cache, and the
 * app's client treats an answer as fresh for 30 s. Timed in the page: the
 * request went out at 0.1 s and 32.1 s and nowhere between.
 *
 * `fetchStatus` below is what `utils.jobs.status.fetch(input, opts)` does: a
 * `fetchQuery` under the client's defaults, with the caller's options on top.
 */

const APP_STALE_MS = 30 * 1000;

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: APP_STALE_MS, retry: false } },
  });
  const server = { state: 'active', requests: 0 };
  const fetchStatus = (jobId: string, opts?: { staleTime?: number }) =>
    client.fetchQuery({
      queryKey: ['jobs.status', { jobId }],
      queryFn: async () => {
        server.requests += 1;
        return { state: server.state };
      },
      ...opts,
    });
  return { server, fetchStatus };
}

describe('the job status poll', () => {
  test('control: through the cache, a second poll never reaches the server', async () => {
    const { server, fetchStatus } = harness();
    await fetchStatus('job-1');
    server.state = 'completed';
    const second = await fetchStatus('job-1');
    expect(server.requests).toBe(1);
    expect(second.state).toBe('active');
  });

  test('with the poll options, every poll asks the server', async () => {
    const { server, fetchStatus } = harness();
    await fetchStatus('job-1', JOB_STATUS_POLL_OPTIONS);
    server.state = 'completed';
    const second = await fetchStatus('job-1', JOB_STATUS_POLL_OPTIONS);
    expect(server.requests).toBe(2);
    expect(second.state).toBe('completed');
  });

  test('the hook polls with them', async () => {
    const hook = await Bun.file(
      new URL('../../../src/v3/hooks/useJobStatus.ts', import.meta.url)
    ).text();
    expect(hook).toMatch(/jobs\.status\.fetch\(\{ jobId \}, JOB_STATUS_POLL_OPTIONS\)/);
  });
});

/**
 * Bypassing the cache exposed that nothing ended the poll: with the socket
 * blocked, a finished job's page asked six times in twelve seconds. The cache
 * had been the only thing rationing it.
 */
describe('when the poll stops', () => {
  test("the queue's own answer is final, either way", () => {
    expect(jobPollIsDone('poll', 'completed')).toBe(true);
    expect(jobPollIsDone('poll', 'failed')).toBe(true);
  });

  test('a realtime completed ends it', () => {
    expect(jobPollIsDone('event', 'completed')).toBe(true);
  });

  test('a realtime failed does not: it is one attempt, and a retry may complete', () => {
    expect(jobPollIsDone('event', 'failed')).toBe(false);
  });

  test('control: a job still in flight keeps it going', () => {
    for (const state of ['queued', 'active', 'unknown', undefined]) {
      expect(jobPollIsDone('poll', state)).toBe(false);
      expect(jobPollIsDone('event', state)).toBe(false);
    }
  });

  test('the hook asks it on both paths, and the timer honours the answer', async () => {
    const hook = await Bun.file(
      new URL('../../../src/v3/hooks/useJobStatus.ts', import.meta.url)
    ).text();
    expect(hook).toMatch(/if \(jobPollIsDone\('event', event\.state\)\) settled = true;/);
    expect(hook).toMatch(/if \(jobPollIsDone\('poll', nextState\)\) settled = true;/);
    expect(hook).toMatch(/if \(cancelled \|\| settled\) return;/);
  });
});
