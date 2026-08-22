import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { trpc } from '../../../src/lib/trpc';
import {
  JobDetailHeader,
  type JobDetailHeaderJob,
} from '../../../src/v3/components/jobs/JobDetailHeader';

/**
 * The failed-job block, rendered — because the defect it now guards was
 * invisible to every test of the pieces (SC-554).
 *
 * `jobFailureSentence` was correct on its own and the detail block was correct
 * on its own; what was wrong was that they disagreed. The sentence said
 * "Check the details below, correct them, and start it again" while the block
 * beneath it is gated on `job.userFacingError`, which is `null` for any throw
 * no processor marked `userFacing(...)`. Two such throws exist in the worker
 * today — `exchange-import.ts:243` and `wallet-import.ts:40` — and both put
 * that instruction in front of a reader with nothing to follow it.
 *
 * So these assert the two halves TOGETHER, on the real component, which is the
 * only place their agreement is a property at all. Testing
 * `jobFailureSentence(t, failure, { detailShown })` alone would pass on a page
 * that never passes the flag.
 */

function Harness({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return (
    <trpc.Provider client={trpcClient} queryClient={client}>
      <QueryClientProvider client={client}>
        <StaticRouter location="/jobs/job-1">{children}</StaticRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

/** A terminally-failed exchange import — `failureReason: 'unrecoverable'` is
 *  what `worker-client.ts` writes for any `UnrecoverableError`, marked or not.
 *  `userFacingError` is the only thing that differs between the two cases. */
function failedJob(userFacingError: string | null): JobDetailHeaderJob {
  return {
    jobId: 'job-1',
    jobName: 'exchange-import',
    state: 'failed',
    frameworkState: 'failed',
    attemptsMade: 1,
    attemptsAllowed: 1,
    payloadSummary: null,
    createdAt: '2026-08-22T09:00:00.000Z',
    startedAt: '2026-08-22T09:00:01.000Z',
    finishedAt: '2026-08-22T09:00:09.000Z',
    actionTakenAt: null,
    userFacingError,
    deadAt: '2026-08-22T09:00:09.000Z',
    failureReason: 'unrecoverable',
    retry: { available: true, reason: 'unrecoverable', queueHasJob: true },
  };
}

function render(userFacingError: string | null): string {
  return renderToStaticMarkup(
    <Harness>
      <JobDetailHeader job={failedJob(userFacingError)} />
    </Harness>
  );
}

const POINTS_AT_DETAIL = 'Check the details below';
const DEAD_END = 'nothing was recorded that we can show you';

describe('a terminal failure never points at a detail block it is not rendering', () => {
  test('with no marked message: the dead end is stated and nothing is pointed at', () => {
    const html = render(null);
    expect(html).toContain(DEAD_END);
    expect(html).not.toContain(POINTS_AT_DETAIL);
  });

  test('with a marked message: the message renders and the sentence may point at it', () => {
    const html = render('Kraken rejected request: EAPI:Invalid key');
    expect(html).toContain('Kraken rejected request: EAPI:Invalid key');
    expect(html).toContain(POINTS_AT_DETAIL);
    expect(html).not.toContain(DEAD_END);
  });

  /**
   * The one to keep when the other two look redundant. Both cases above assert
   * a specific wording, so both survive a change that renders the RIGHT
   * sentence beside the WRONG block — which is the defect, stated exactly.
   *
   * Do not "simplify" this to a check that the sentence is non-empty: the
   * broken page rendered a perfectly good sentence. The bug was the pairing.
   */
  test('the instruction and the thing it instructs you to read arrive together or not at all', () => {
    for (const message of [null, 'Kraken rejected request: EAPI:Invalid key']) {
      const html = render(message);
      const instructs = html.includes(POINTS_AT_DETAIL);
      const hasBlock = message !== null && html.includes(message);
      expect(instructs).toBe(hasBlock);
    }
  });
});
