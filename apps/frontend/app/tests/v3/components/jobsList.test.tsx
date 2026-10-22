import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { SETTLED_QUERY_STATE } from '@scani/ui/v3/lib/query-state';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { JobsList } from '../../../src/v3/components/jobs/JobsList';
import type { JobRow } from '../../../src/v3/lib/jobs';

/**
 * SC-1527. A screenshot parse whose page read "Failed · Files read 0 of 1"
 * sat in /jobs as "Completed": the list badged BullMQ's state, the page
 * badged what the run produced. The row now carries the outcome counts
 * (`jobs.listMine`), and the list must read them the way the page does.
 *
 * Same harness as `documents.test.tsx`: no `window`, so the phone list renders.
 */
function render(jobs: JobRow[], accountNames?: ReadonlyMap<string, string>): string {
  return renderToStaticMarkup(
    <StaticRouter location="/jobs">
      <JobsList jobs={jobs} query={SETTLED_QUERY_STATE} accountNames={accountNames} />
    </StaticRouter>
  );
}

const parse = (outcome: JobRow['outcome']): JobRow => ({
  jobId: 'job-1',
  jobName: 'screenshot-parse',
  state: 'completed',
  createdAt: '2026-10-02T09:00:00.000Z',
  actionTakenAt: '2026-10-02T09:01:00.000Z',
  payloadSummary: { fileCount: 1 },
  outcome,
});

describe('the jobs list badges the outcome the detail page shows', () => {
  test('a parse that read none of its files is Failed, not Completed', () => {
    const html = render([parse({ succeeded: 0, failed: 1 })]);
    expect(html).toContain('Failed');
    expect(html).not.toContain('Completed');
  });

  test('CONTROL: a parse that read its file is still Completed', () => {
    const html = render([parse({ succeeded: 1, failed: 0 })]);
    expect(html).toContain('Completed');
    expect(html).not.toContain('Failed');
  });
});

/**
 * SC-1724. Opening the app queues one `refresh-account-balance` per synced
 * account, all carrying the `requestId` of the `app-open-refresh` that queued
 * them. Listed one per row, mgrin's 14 accounts read as a 14-job backlog. A
 * burst is one row, named for what the person did and showing its progress.
 */
describe('one app-open is one row, not one row per account', () => {
  const at = '2026-10-11T09:00:00.000Z';
  const parent = (requestId: string, jobId = `open-${requestId}`): JobRow => ({
    jobId,
    jobName: 'app-open-refresh',
    state: 'completed',
    createdAt: at,
    payloadSummary: { requestId },
  });
  const refresh = (requestId: string, i: number, state: string): JobRow => ({
    jobId: `refresh-${requestId}-${i}`,
    jobName: 'refresh-account-balance',
    state,
    createdAt: at,
    payloadSummary: { requestId, accountId: `acct-${i}` },
  });
  const burst = (requestId: string, done: number, total: number): JobRow[] => [
    parent(requestId),
    ...Array.from({ length: total }, (_, i) =>
      refresh(requestId, i, i < done ? 'completed' : 'active')
    ),
  ];
  const rows = (html: string) => html.match(/<li><button /g) ?? [];

  test('14 refreshes from one open render as one row with their progress', () => {
    const html = render(burst('req-1', 9, 14));
    expect(rows(html)).toHaveLength(1);
    expect(html).toContain('Refreshing 14 accounts');
    expect(html).toContain('9 of 14 done');
    expect(html).not.toContain('refresh-account-balance');
  });

  test('a finished burst says so, and names its failures', () => {
    const jobs = burst('req-1', 14, 14);
    const last = jobs[jobs.length - 1];
    if (last) last.state = 'failed';
    const html = render(jobs);
    expect(rows(html)).toHaveLength(1);
    expect(html).toContain('Refreshed 14 accounts');
    expect(html).toContain('1 failed');
  });

  test('CONTROL: two opens stay two rows', () => {
    const html = render([...burst('req-1', 14, 14), ...burst('req-2', 3, 14)]);
    expect(rows(html)).toHaveLength(2);
  });

  test('a single refresh names its account, as a burst row names its progress', () => {
    const html = render([refresh('req-manual', 0, 'completed')], new Map([['acct-0', 'Wise EUR']]));
    expect(rows(html)).toHaveLength(1);
    expect(html).toContain('Wise EUR');
  });

  test('CONTROL: one account synced by hand stays its own row', () => {
    const html = render([refresh('req-manual', 0, 'completed')]);
    expect(rows(html)).toHaveLength(1);
    expect(html).not.toContain('accounts');
  });
});
