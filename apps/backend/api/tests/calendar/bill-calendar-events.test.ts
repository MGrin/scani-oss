import { describe, expect, test } from 'bun:test';
import {
  PaymentOccurrenceRepository,
  PaymentRepository,
  TokenRepository,
  VendorRepository,
} from '@scani/domain/repositories';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { billCalendarEvents } from '../../src/calendar/bill-calendar-events';

restoreContainerAfterAll();

// SC-1654: which bills the feed lists, and how each reads in a calendar.

const NOW = new Date('2026-10-10T12:00:00Z');

const payment = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  userId: 'u1',
  vendorId: 'v-hyper',
  direction: 'outflow',
  status: 'active',
  expectedAmount: '42',
  currencyTokenId: 't-gbp',
  ...over,
});

const occurrence = (
  id: string,
  paymentId: string,
  dueDate: string,
  over: Record<string, unknown> = {}
) => ({
  id,
  paymentId,
  dueDate,
  status: 'scheduled',
  expectedAmount: null,
  settledVendorId: null,
  settledCurrencyTokenId: null,
  settledDirection: null,
  ...over,
});

function stub(payments: unknown[], occurrences: unknown[]) {
  Container.set(PaymentRepository, { findByUser: async () => payments } as never);
  Container.set(PaymentOccurrenceRepository, {
    findByPaymentIds: async () => occurrences,
  } as never);
  Container.set(VendorRepository, {
    findByUser: async () => [
      { id: 'v-hyper', displayName: 'Hyperoptic' },
      { id: 'v-rent', displayName: 'Foxwood Lettings' },
    ],
  } as never);
  Container.set(TokenRepository, {
    findManyWithTypes: async () => [{ id: 't-gbp', symbol: 'GBP' }],
  } as never);
}

describe('billCalendarEvents', () => {
  test('a scheduled bill becomes an all-day event named by payee and amount', async () => {
    stub([payment('p1')], [occurrence('o1', 'p1', '2026-11-01')]);
    expect(await billCalendarEvents('u1', NOW)).toEqual([
      { uid: 'o1', date: '2026-11-01', summary: 'Hyperoptic · 42.00 GBP' },
    ]);
  });

  test('an occurrence’s own amount wins, and a bill with no amount is named by payee alone', async () => {
    stub(
      [payment('p1'), payment('p2', { vendorId: 'v-rent', expectedAmount: null })],
      [
        occurrence('o1', 'p1', '2026-11-01', { expectedAmount: '43.5' }),
        occurrence('o2', 'p2', '2026-11-02'),
      ]
    );
    expect((await billCalendarEvents('u1', NOW)).map((e) => e.summary)).toEqual([
      'Hyperoptic · 43.50 GBP',
      'Foxwood Lettings',
    ]);
  });

  test('income, settled or skipped occurrences and paused payments are left out', async () => {
    stub(
      [payment('p1'), payment('p2', { direction: 'inflow' }), payment('p3', { status: 'paused' })],
      [
        occurrence('o1', 'p1', '2026-11-01', { status: 'matched' }),
        occurrence('o2', 'p1', '2026-11-02', { status: 'skipped' }),
        occurrence('o3', 'p2', '2026-11-03'),
        occurrence('o4', 'p3', '2026-11-04'),
        occurrence('o5', 'p1', '2026-11-05'),
      ]
    );
    expect((await billCalendarEvents('u1', NOW)).map((e) => e.uid)).toEqual(['o5']);
  });

  test('the window is the last 30 days (still unpaid) through the next 365, in date order', async () => {
    stub(
      [payment('p1')],
      [
        occurrence('late-ok', 'p1', '2026-09-10'),
        occurrence('too-old', 'p1', '2026-09-09'),
        occurrence('far-ok', 'p1', '2027-10-10'),
        occurrence('too-far', 'p1', '2027-10-11'),
        occurrence('soon', 'p1', '2026-10-11'),
      ]
    );
    expect((await billCalendarEvents('u1', NOW)).map((e) => e.uid)).toEqual([
      'late-ok',
      'soon',
      'far-ok',
    ]);
  });
});
