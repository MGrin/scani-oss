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
function render(jobs: JobRow[]): string {
  return renderToStaticMarkup(
    <StaticRouter location="/jobs">
      <JobsList jobs={jobs} query={SETTLED_QUERY_STATE} />
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
