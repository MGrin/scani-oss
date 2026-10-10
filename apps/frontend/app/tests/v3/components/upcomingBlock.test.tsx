import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { UpcomingCard } from '../../../src/v3/components/home/UpcomingBlock';
import en from '../../../src/v3/i18n/locales/en.json';
import type { HomeCardQuery } from '../../../src/v3/lib/home-card';

/**
 * Upcoming bills on Home says "Nothing due" only when the bills query
 * succeeded and found nothing (SC-1667). While loading, and when a query
 * failed, it said the same sentence, and a reader takes that as no bills due.
 */

const NOTHING_DUE = en.v3.home.upcoming.empty_other.split('{{')[0] as string;
const ADD_PAYMENT = en.v3.home.upcoming.addPayment;
const ROWS = 'three bills';
const FOOT = 'overdue and income lines';

function query(overrides: Partial<HomeCardQuery>): HomeCardQuery {
  return {
    isLoading: false,
    fetchStatus: 'idle',
    isFetching: false,
    isError: false,
    error: null,
    data: [],
    dataUpdatedAt: Date.UTC(2026, 9, 9, 14, 2),
    refetch: () => {},
    ...overrides,
  };
}

function render(overrides: Partial<HomeCardQuery>, empty: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <UpcomingCard queries={[query(overrides)]} empty={empty} rows={ROWS} foot={FOOT} />
    </MemoryRouter>
  );
}

describe('Upcoming bills states (SC-1667)', () => {
  test('while loading it never says nothing is due', () => {
    const html = render({ isLoading: true, fetchStatus: 'fetching', data: undefined }, true);
    expect(html).not.toContain(NOTHING_DUE);
    expect(html).not.toContain(ADD_PAYMENT);
    expect(html).not.toContain(ROWS);
    expect(html).not.toContain(FOOT);
  });

  test('a failed query says it could not load, with a retry, and never that nothing is due', () => {
    const html = render({ isError: true, error: new Error('boom'), data: undefined }, true);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`load ${en.v3.home.upcoming.subject}`);
    expect(html).toContain('<button');
    expect(html).not.toContain(NOTHING_DUE);
    expect(html).not.toContain(ADD_PAYMENT);
    expect(html).not.toContain(ROWS);
    expect(html).not.toContain(FOOT);
  });

  test('control: a successful query with no bills says nothing is due, and keeps the foot-lines', () => {
    const html = render({}, true);
    expect(html).toContain(NOTHING_DUE);
    expect(html).toContain(ADD_PAYMENT);
    // Overdue bills and expected income still show when nothing is upcoming.
    expect(html).toContain(FOOT);
  });

  test('control: a successful query with bills shows them', () => {
    const html = render({}, false);
    expect(html).toContain(ROWS);
    expect(html).toContain(FOOT);
    expect(html).not.toContain(NOTHING_DUE);
  });
});

describe('the Bills tile (SC-1669)', () => {
  const tile = (overrides: Partial<HomeCardQuery>) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <UpcomingCard
          queries={[query(overrides)]}
          empty={false}
          rows={ROWS}
          foot={FOOT}
          variant="tile"
          tile={() => ({ figure: '£420.00', caption: '3 due · next in 3 days' })}
        />
      </MemoryRouter>
    );

  test('shows one figure and its caption, opens the Bills peek, and leaves the rows and foot to it', () => {
    const html = tile({});
    expect(html).toContain('£420.00');
    expect(html).toContain('3 due · next in 3 days');
    expect(html).toContain('href="/home/bills"');
    expect(html).not.toContain(ROWS);
    expect(html).not.toContain(FOOT);
  });

  test('a failed query never draws the tile figure', () => {
    const html = tile({ isError: true, error: new Error('boom'), data: undefined });
    expect(html).not.toContain('£420.00');
  });
});
