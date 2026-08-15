import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import {
  type CommitmentInput,
  comparableBaseAmount,
  formatConvertedFigure,
  INCOME_COMMITMENT_LABEL,
  isIncomeVendor,
  mergeCurrencyTotals,
  monthlyCommitmentByVendor,
  noSettledSpend,
  PAID_ALL_TIME_LABEL,
  PER_MONTH_LABEL,
  paidWindowLabel,
  RECEIVED_ALL_TIME_LABEL,
  receivedWindowLabel,
  settledByVendor,
  settlementsByVendor,
  unpricedNote,
  type VendorSettlement,
  type VendorSpendTotal,
  vendorDirectionKind,
  vendorDirectionKinds,
  vendorKindLabel,
} from '@/lib/vendorSpend';
import type { BaseCurrencyRate } from '@/v2/lib/paymentTotals';

const EUR = 'token-eur';
const USD = 'token-usd';
const GBP = 'token-gbp';
const NOW = new Date('2026-08-13T12:00:00Z');
const FRESH = '2026-08-13T06:00:00Z';

const context = (entries: Array<[string, BaseCurrencyRate | null]>) => ({
  baseCurrencyTokenId: EUR,
  rateByCurrencyTokenId: new Map(entries),
  now: NOW,
});

const payment = (overrides: Partial<CommitmentInput> = {}): CommitmentInput => ({
  vendorId: 'v1',
  expectedAmount: '10',
  intervalUnit: 'month',
  intervalCount: 1,
  currencyTokenId: EUR,
  direction: 'outflow',
  status: 'active',
  ...overrides,
});

const total = (overrides: Partial<VendorSpendTotal> = {}): VendorSpendTotal => ({
  vendorId: 'v1',
  currencyTokenId: EUR,
  direction: 'outflow',
  allTime: '100',
  inWindow: '60',
  settledCount: 3,
  unpricedCount: 0,
  ...overrides,
});

describe('monthlyCommitmentByVendor', () => {
  test('a fortnightly payment annualises before it is divided back to a month', () => {
    // 20 × 26 ÷ 12, not 20 × 2 — the bug the annualisation rule exists for.
    const commitment = monthlyCommitmentByVendor([
      payment({ expectedAmount: '20', intervalUnit: 'week', intervalCount: 2 }),
    ]);
    expect(commitment.get('v1')?.get(EUR)?.toFixed(2)).toBe('43.33');
  });

  test('only what is still running counts as a commitment', () => {
    const commitment = monthlyCommitmentByVendor([
      payment({ status: 'active', expectedAmount: '10' }),
      payment({ status: 'paused', expectedAmount: '99' }),
      payment({ status: 'ended', expectedAmount: '99' }),
    ]);
    expect(commitment.get('v1')?.get(EUR)?.toString()).toBe('10');
  });

  test('income is not spend', () => {
    const commitment = monthlyCommitmentByVendor([
      payment({ direction: 'inflow', expectedAmount: '3000' }),
    ]);
    expect(commitment.get('v1')).toBeUndefined();
  });

  test('a vendor billed in two currencies keeps them apart until conversion', () => {
    const commitment = monthlyCommitmentByVendor([
      payment({ expectedAmount: '10', currencyTokenId: EUR }),
      payment({ expectedAmount: '20', currencyTokenId: GBP }),
    ]);
    expect(commitment.get('v1')?.get(EUR)?.toString()).toBe('10');
    expect(commitment.get('v1')?.get(GBP)?.toString()).toBe('20');
  });
});

describe('settledByVendor', () => {
  test('adds a vendor’s currencies without adding its income into its spend', () => {
    const settled = settledByVendor([
      total({ currencyTokenId: EUR, allTime: '100', inWindow: '60' }),
      total({ currencyTokenId: GBP, allTime: '50', inWindow: '50' }),
      total({ direction: 'inflow', currencyTokenId: EUR, allTime: '9000', inWindow: '9000' }),
    ]);
    const v1 = settled.get('v1');
    expect(v1?.allTime.get(EUR)?.toString()).toBe('100');
    expect(v1?.allTime.get(GBP)?.toString()).toBe('50');
    expect(v1?.settledCount).toBe(6);
  });

  test('a vendor with no settlements reads as zero, not as an absent figure', () => {
    const settled = settledByVendor([]);
    const none = settled.get('v1') ?? noSettledSpend();
    expect(none.allTime.size).toBe(0);
    expect(none.settledCount).toBe(0);
    expect(formatConvertedFigure(none.allTime, context([]), '€', () => '€')).toBe('€ 0.00');
  });
});

describe('settlementsByVendor', () => {
  const settlement = (overrides: Partial<VendorSettlement> = {}): VendorSettlement => ({
    id: 'o1',
    vendorId: 'v1',
    paymentId: 'p1',
    dueDate: '2026-07-01',
    amount: '10',
    currencyTokenId: EUR,
    direction: 'outflow',
    ...overrides,
  });

  test('groups by vendor and drops the other direction', () => {
    const grouped = settlementsByVendor([
      settlement({ id: 'a' }),
      settlement({ id: 'b', vendorId: 'v2' }),
      settlement({ id: 'c', direction: 'inflow' }),
    ]);
    expect(grouped.get('v1')?.map((s) => s.id)).toEqual(['a']);
    expect(grouped.get('v2')?.map((s) => s.id)).toEqual(['b']);
  });
});

describe('comparableBaseAmount', () => {
  // The reason the list sorts on a converted figure: raw per-currency maps
  // would put a £10 vendor above a €100 one.
  test('orders vendors by what they cost in the reader’s own currency', () => {
    const ctx = context([[GBP, { rate: '1.17', asOf: FRESH }]]);
    const gbp = comparableBaseAmount(new Map([[GBP, new Decimal('10')]]), ctx);
    const eur = comparableBaseAmount(new Map([[EUR, new Decimal('100')]]), ctx);
    expect(gbp).toBeCloseTo(11.7, 5);
    expect(eur).toBe(100);
    expect(gbp).toBeLessThan(eur);
  });

  test('a vendor with nothing committed sorts as zero rather than throwing', () => {
    expect(comparableBaseAmount(undefined, context([]))).toBe(0);
  });
});

describe('formatConvertedFigure', () => {
  test('one figure when everything converts', () => {
    const figure = formatConvertedFigure(
      new Map([
        [EUR, new Decimal('100')],
        [USD, new Decimal('10')],
      ]),
      context([[USD, { rate: '0.9', asOf: FRESH }]]),
      '€',
      () => '$'
    );
    expect(figure).toBe('€ 109.00');
  });

  // The failure this ticket must not ship: a vendor billed only in a currency
  // we hold no rate for reading as costing nothing.
  test('an un-convertible currency is printed beside the total, never as zero', () => {
    const figure = formatConvertedFigure(
      new Map([[GBP, new Decimal('30')]]),
      context([[GBP, null]]),
      '€',
      () => '£'
    );
    expect(figure).toBe('€ 0.00 + £ 30.00 unconverted');
  });
});

describe('mergeCurrencyTotals', () => {
  test('adds several vendors’ per-currency maps into one', () => {
    const merged = mergeCurrencyTotals([
      new Map([
        [EUR, new Decimal('10')],
        [GBP, new Decimal('5')],
      ]),
      new Map([[EUR, new Decimal('2.50')]]),
    ]);
    expect(merged.get(EUR)?.toString()).toBe('12.5');
    expect(merged.get(GBP)?.toString()).toBe('5');
  });
});

describe('labels', () => {
  test('every paid figure names its window', () => {
    expect(paidWindowLabel(12)).toBe('Paid, last 12 months');
    expect(paidWindowLabel(6)).toBe('Paid, last 6 months');
  });

  test('settlements with no amount are declared, not silently zeroed', () => {
    expect(unpricedNote(0)).toBeNull();
    expect(unpricedNote(1)).toContain('1 settlement has no amount');
    expect(unpricedNote(3)).toContain('3 settlements have no amount');
  });
});

/**
 * SC-78 §5. A seeded employer paying €5,850 a month rendered `Employer ·
 * 1 payment — €0.00` under a column headed "Committed per month", and four
 * €0.00 figures in its peek beside the words "Payments 1". The direction
 * filter was doing exactly what SC-61 asked of it; what was missing is that
 * the vendor was never classified, so everything the filter dropped came back
 * as a confident zero.
 */
describe('classifying a vendor by the direction its money moves', () => {
  test('a vendor with only inflow is income, not a spend vendor worth €0', () => {
    const kinds = vendorDirectionKinds([{ vendorId: 'acme', direction: 'inflow' }]);
    expect(vendorDirectionKind(kinds, 'acme')).toBe('income');
    expect(isIncomeVendor(vendorDirectionKind(kinds, 'acme'))).toBe(true);
  });

  test('a vendor with only outflow is a spend vendor', () => {
    const kinds = vendorDirectionKinds([{ vendorId: 'aws', direction: 'outflow' }]);
    expect(vendorDirectionKind(kinds, 'aws')).toBe('spend');
    expect(isIncomeVendor(vendorDirectionKind(kinds, 'aws'))).toBe(false);
  });

  test('both directions is `both`, and `both` is NOT income — the two are never one figure', () => {
    const kinds = vendorDirectionKinds([
      { vendorId: 'mixed', direction: 'outflow' },
      { vendorId: 'mixed', direction: 'inflow' },
    ]);
    expect(vendorDirectionKind(kinds, 'mixed')).toBe('both');
    expect(isIncomeVendor(vendorDirectionKind(kinds, 'mixed'))).toBe(false);
  });

  test('a direction we do not recognise is `unclassified`, never quietly spend', () => {
    const kinds = vendorDirectionKinds([{ vendorId: 'odd', direction: 'transfer' }]);
    expect(vendorDirectionKind(kinds, 'odd')).toBe('unclassified');
  });

  test('a vendor nothing points at is `none` — the one case €0.00 is the true answer', () => {
    expect(vendorDirectionKind(vendorDirectionKinds([]), 'ghost')).toBe('none');
  });

  test('payments and settled totals classify from one call, so an ended salary still reads as income', () => {
    const kinds = vendorDirectionKinds([
      ...[payment({ vendorId: 'acme', direction: 'inflow', status: 'ended' })].map((p) => ({
        vendorId: p.vendorId,
        direction: p.direction,
      })),
      total({ vendorId: 'acme', direction: 'inflow' }),
    ]);
    expect(vendorDirectionKind(kinds, 'acme')).toBe('income');
  });

  test('inflow commitments are summed when asked for, so the row has a figure to show', () => {
    const totals = monthlyCommitmentByVendor(
      [payment({ vendorId: 'acme', direction: 'inflow', expectedAmount: '5850' })],
      'inflow'
    );
    expect(totals.get('acme')?.get(EUR)?.toString()).toBe('5850');
  });

  test('inflow settlements are summed when asked for', () => {
    const settled = settledByVendor(
      [total({ vendorId: 'acme', direction: 'inflow', allTime: '46800', inWindow: '46800' })],
      'inflow'
    );
    expect(settled.get('acme')?.allTime.get(EUR)?.toString()).toBe('46800');
  });
});

describe('income wording', () => {
  test('income is expected and received, never committed and paid', () => {
    expect(INCOME_COMMITMENT_LABEL).toBe('Expected per month');
    expect(receivedWindowLabel(12)).toBe('Received, last 12 months');
    expect(receivedWindowLabel(3)).toBe('Received, last 3 months');
    expect(RECEIVED_ALL_TIME_LABEL).toBe('Received, all time');
    // The spend wording is untouched — the two vocabularies stay distinct.
    expect(PAID_ALL_TIME_LABEL).toBe('Paid, all time');
  });

  test('the column header is direction-neutral, because the column is', () => {
    expect(PER_MONTH_LABEL).toBe('Per month');
  });

  test('a row says what it is only when the direction adds something', () => {
    expect(vendorKindLabel('income')).toBe('Income');
    expect(vendorKindLabel('both')).toBe('Bills & income');
    expect(vendorKindLabel('unclassified')).toBe('Direction not recorded');
    expect(vendorKindLabel('spend')).toBeNull();
    expect(vendorKindLabel('none')).toBeNull();
  });
});
