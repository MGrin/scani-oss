import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { BALANCE_GAP_REVIEW_KIND, TRANSFER_REVIEW_KIND } from '@scani/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { ReviewQueues } from '../../../src/v3/components/review/ReviewQueues';
import type { ReviewWireRow } from '../../../src/v3/lib/review-text';

/**
 * The two queues under `/review` are offered at every count (SC-849).
 *
 * `route-reachability.test.ts` gates that *something* links to them. This gates
 * the property that makes the link worth having: it is there when the queue is
 * EMPTY. A hub that renders only when there is work is the defect this ticket
 * is about — it takes `/review/transfers/answered` and `/review/transfers/rules`
 * with it, and those exist for the reader whose queue has reached zero.
 *
 * The counts are read out of the feed rather than fetched, so the reading is
 * real logic: each collector emits ONE aggregate row per queue carrying the
 * count in a discriminated `detail`. A wrong `kind` constant or a wrong
 * variant renders "Nothing waiting" over a queue that is holding work, which
 * is a lie the reachability guard cannot see.
 */

function render(items: ReviewWireRow[]): string {
  return renderToStaticMarkup(
    createElement(StaticRouter, { location: '/review' }, createElement(ReviewQueues, { items }))
  );
}

function feedRow(kind: string, detail: ReviewWireRow['detail']): ReviewWireRow {
  return {
    id: `${kind}:pending`,
    kind,
    label: { code: 'transfersToConfirm' },
    detail,
    href: '/unused — the hub links from the route table, not from the row',
    createdAt: '2026-08-29T00:00:00.000Z',
  };
}

describe('the review hub', () => {
  test('offers both queues when the feed is empty', () => {
    const html = render([]);
    expect(html).toContain('href="/review/transfers"');
    expect(html).toContain('href="/review/balances"');
    expect(html).toContain('Transfers to confirm');
    expect(html).toContain('Balance changes to explain');
  });

  test('says nothing is waiting rather than showing a zero', () => {
    // "0 transfers out with no matching deposit" is a true sentence nobody
    // wants to read on a queue they have finished.
    const html = render([]);
    expect(html).toContain('Nothing waiting');
    expect(html).not.toContain('0 transfers');
  });

  test("reads each queue's count out of its own aggregate row", () => {
    const html = render([
      feedRow(TRANSFER_REVIEW_KIND, { code: 'unpairedTransfers', transfers: 12 }),
      feedRow(BALANCE_GAP_REVIEW_KIND, { code: 'unexplainedBalanceChanges', changes: 3 }),
    ]);
    expect(html).toContain('12 transfers out with no matching deposit');
    expect(html).toContain('3 balance changes we cannot explain');
    expect(html).not.toContain('Nothing waiting');
  });

  test('one waiting item reads as one, not as a plural', () => {
    const html = render([
      feedRow(TRANSFER_REVIEW_KIND, { code: 'unpairedTransfers', transfers: 1 }),
    ]);
    expect(html).toContain('1 transfer out with no matching deposit');
  });

  test('a queue with no row in the feed still gets its link', () => {
    // The collectors emit nothing at all once a queue empties, so "absent"
    // and "zero" arrive as the same observation and must render the same way.
    const html = render([
      feedRow(TRANSFER_REVIEW_KIND, { code: 'unpairedTransfers', transfers: 4 }),
    ]);
    expect(html).toContain('href="/review/balances"');
    expect(html).toContain('Nothing waiting');
  });
});
