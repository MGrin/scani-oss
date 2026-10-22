import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { RefreshBurstAccountsCard } from '../../../src/v3/components/jobs/RefreshBurstAccounts';
import { burstAccountRows, type JobRow } from '../../../src/v3/lib/jobs';

/**
 * SC-1724. The Jobs page folds an app-open's refreshes into one row; the open's
 * own page is where each account's refresh is listed, by account name.
 */
const t = i18n.t.bind(i18n);
const at = '2026-10-11T09:00:00.000Z';
const refresh = (requestId: string, accountId: string, state: string): JobRow => ({
  jobId: `refresh-${accountId}`,
  jobName: 'refresh-account-balance',
  state,
  createdAt: at,
  payloadSummary: { requestId, accountId },
});
const jobs = [
  refresh('r1', 'a-wise', 'completed'),
  refresh('r1', 'a-kraken', 'failed'),
  refresh('r1', 'a-ibkr', 'active'),
  refresh('r2', 'a-other', 'completed'),
];
const names = new Map([
  ['a-wise', 'Wise'],
  ['a-kraken', 'Kraken'],
  ['a-ibkr', 'Interactive Brokers'],
]);

describe('the open lists each account it refreshed', () => {
  test('one row per account of THIS open, by name, linking to its refresh', () => {
    const rows = burstAccountRows(t, jobs, 'r1', names);
    expect(rows.map((r) => r.label)).toEqual(['Wise', 'Kraken', 'Interactive Brokers']);
    const html = renderToStaticMarkup(
      <StaticRouter location="/jobs/open-r1">
        <RefreshBurstAccountsCard rows={rows} />
      </StaticRouter>
    );
    expect(html).toContain('Accounts refreshed');
    expect(html).toContain('href="/jobs/refresh-a-kraken"');
    expect(html).toContain('Failed');
    expect(html).not.toContain('a-other');
  });

  test('an account no longer listed still gets a row, under a plain label', () => {
    const rows = burstAccountRows(t, [refresh('r1', 'a-gone', 'completed')], 'r1', names);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Account refresh');
  });
});
