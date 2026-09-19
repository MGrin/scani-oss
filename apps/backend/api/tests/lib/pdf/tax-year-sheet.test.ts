import { describe, expect, test } from 'bun:test';
import { RenderPdfInput, type TaxYearDisposals, type TaxYearPdfLabels } from '@scani/shared';
import { documentText, renderStatement } from '../../../src/lib/pdf/statement';
import { taxYearDocument } from '../../../src/lib/pdf/tax-year-sheet';

/**
 * SC-90's PDF: the server turns a `portfolio.taxYear` result into the one
 * sheet the statement engine renders. The client supplies words only; every
 * figure here comes from the result.
 *
 * The engine sums a totalled column over the WHOLE sheet, so no column is
 * totalled: that would add airdrops into the income, which mgrin's 2026-09-11
 * ruling forbids. Totals go in the provenance block instead, taken from the
 * engine's own sums rather than re-added.
 */

const LABELS: TaxYearPdfLabels = {
  subject: 'Tax year statement',
  headers: {
    date: 'Date',
    asset: 'Asset',
    quantity: 'Quantity',
    acquired: 'Acquired',
    amount: 'Proceeds or value',
    costBasis: 'Cost basis',
    gain: 'Gain',
    daysHeld: 'Days held',
  },
  groups: {
    disposals: 'Disposals',
    interest: 'Interest',
    rewards: 'Rewards',
    airdrops: 'Airdrops',
  },
  details: {
    year: 'Tax year',
    method: 'Cost-basis method',
    timeZone: 'Time zone',
    gainTotal: 'Realized gain',
    interestTotal: 'Interest',
    rewardTotal: 'Rewards',
    airdropNote: 'Airdrops',
    caveat: 'Note',
    basisIncomplete: 'Rows with incomplete cost basis',
    awaitingReview: 'Outflows awaiting your answer',
    unvaluedIncome: 'Income receipts without a value',
  },
  methods: { fifo: 'First in, first out (FIFO)', uk_section_104: 'UK Section 104 pooling' },
  yearStarts: {
    'jan-1': '1 January (calendar year)',
    'apr-1': '1 April',
    'apr-6': '6 April (UK)',
    'jul-1': '1 July (Australia)',
  },
  airdropNote: 'listed, not totalled',
  caveat: 'figures can change if past data or the method changes; keep the PDF you filed',
};

function result(over: Partial<TaxYearDisposals> = {}): TaxYearDisposals {
  return {
    generatedAt: '2026-09-19T08:00:00.000Z',
    periodStart: '2024-04-05T23:00:00.000Z',
    periodEnd: '2025-04-05T23:00:00.000Z',
    baseCurrencyId: 'usd',
    costBasisMethod: 'uk_section_104',
    taxYear: { year: 2024, yearStart: 'apr-6', timeZone: 'Europe/London', timeZoneSource: 'user' },
    rows: [
      {
        transactionId: 't1',
        holdingId: 'h',
        tokenId: 'btc',
        kind: 'sell',
        disposedAt: '2024-06-01T00:00:00.000Z',
        acquiredAt: '2023-01-01T00:00:00.000Z',
        quantity: '2',
        proceeds: '400',
        costBasis: '200',
        gain: '200',
        holdingDays: 517,
        portionIndex: 0,
        portionCount: 1,
        basisQuality: 'known',
        outcome: 'realized',
      },
    ] as TaxYearDisposals['rows'],
    rowCount: 1,
    byOutcome: { realized: 1, unpriced: 0, unreviewed: 0, retained: 0, awaiting_pair: 0 },
    byBasisQuality: { known: 1, partial: 0, unknown: 0 },
    totals: { proceeds: '400', costBasis: '200', gain: '200' },
    income: {
      rows: [
        {
          transactionId: 'i1',
          holdingId: 'h',
          tokenId: 'eth',
          kind: 'interest',
          receivedAt: '2024-07-01T00:00:00.000Z',
          quantity: '0.5',
          value: '1000',
          stale: false,
        },
        {
          transactionId: 'a1',
          holdingId: 'h',
          tokenId: 'eth',
          kind: 'airdrop',
          receivedAt: '2024-08-01T00:00:00.000Z',
          quantity: '3',
          value: '6000',
          stale: false,
        },
      ],
      totals: { interest: '1000', reward: '0' },
      unvalued: { interest: 0, reward: 0, airdrop: 0 },
    },
    ...over,
  };
}

const SYMBOL = (tokenId: string) => tokenId.toUpperCase();

describe('taxYearDocument — the sheet', () => {
  test('names the method and the year start in words, never as codes', () => {
    const { details } = taxYearDocument(result(), LABELS, {
      currency: 'USD',
      symbolOf: SYMBOL,
    }).provenance;
    const value = (label: string) => details.find((d) => d.label === label)?.value ?? '';
    expect(value('Cost-basis method')).toBe(LABELS.methods[result().costBasisMethod]);
    expect(value('Tax year')).toContain(LABELS.yearStarts[result().taxYear.yearStart]);
    expect(value('Tax year')).not.toContain(`(${result().taxYear.yearStart})`);
  });

  test('is a valid statement input', () => {
    const doc = taxYearDocument(result(), LABELS, { currency: 'USD', symbolOf: SYMBOL });
    const parsed = RenderPdfInput.safeParse(doc);
    expect(parsed.success).toBe(true);
  });

  test('groups rows into disposals, interest, rewards and airdrops, covering every row once', () => {
    const { sheet } = taxYearDocument(result(), LABELS, { currency: 'USD', symbolOf: SYMBOL });
    expect(sheet.groups).toEqual([
      { label: 'Disposals', rowCount: 1 },
      { label: 'Interest', rowCount: 1 },
      { label: 'Rewards', rowCount: 0 },
      { label: 'Airdrops', rowCount: 1 },
    ]);
    expect(sheet.rows).toHaveLength(3);
  });

  test('no column is totalled, so airdrops cannot be summed into anything', () => {
    const { sheet } = taxYearDocument(result(), LABELS, { currency: 'USD', symbolOf: SYMBOL });
    expect((sheet.totalColumns ?? []).some(Boolean)).toBe(false);
  });

  test('a disposal row carries proceeds, cost and gain as money in the base currency', () => {
    const { sheet } = taxYearDocument(result(), LABELS, { currency: 'USD', symbolOf: SYMBOL });
    const [row] = sheet.rows;
    expect(row?.[1]).toEqual({ kind: 'text', value: 'BTC' });
    expect(row?.[4]).toMatchObject({
      kind: 'number',
      value: '400',
      style: 'money',
      currency: 'USD',
    });
    expect(row?.[6]).toMatchObject({
      kind: 'number',
      value: '200',
      style: 'money',
      currency: 'USD',
    });
  });

  test('an unvalued figure is blank, not zero', () => {
    const base = result();
    const unvalued = result({
      income: {
        ...base.income,
        rows: [{ ...(base.income.rows[0] as TaxYearDisposals['income']['rows'][0]), value: null }],
      },
    });
    const { sheet } = taxYearDocument(unvalued, LABELS, { currency: 'USD', symbolOf: SYMBOL });
    expect(sheet.rows[1]?.[4]).toEqual({ kind: 'blank' });
  });
});

describe('taxYearDocument — the stamp (v1 ruling, bus #12532)', () => {
  const detail = (label: string) =>
    taxYearDocument(result(), LABELS, {
      currency: 'USD',
      symbolOf: SYMBOL,
    }).provenance.details.find((d) => d.label === label)?.value;

  test('carries the generation time, method and zone', () => {
    const { provenance } = taxYearDocument(result(), LABELS, { currency: 'USD', symbolOf: SYMBOL });
    expect(provenance.generatedAt).toBe('2026-09-19T08:00:00.000Z');
    expect(detail('Cost-basis method')).toBe('UK Section 104 pooling');
    expect(detail('Time zone')).toBe('Europe/London');
  });

  test('carries the caveat line', () => {
    expect(detail('Note')).toBe(LABELS.caveat);
  });

  test("totals are the engine's own, and airdrops are noted, not totalled", () => {
    expect(detail('Realized gain')).toBe('200 USD');
    expect(detail('Interest')).toBe('1000 USD');
    expect(detail('Rewards')).toBe('0 USD');
    // CONTROL: the airdrop row is worth 6000, and that figure appears nowhere
    // in the provenance.
    expect(detail('Airdrops')).toBe('listed, not totalled');
    const { provenance } = taxYearDocument(result(), LABELS, { currency: 'USD', symbolOf: SYMBOL });
    expect(provenance.details.some((d) => d.value.includes('6000'))).toBe(false);
  });
});

describe('taxYearDocument — rendered', () => {
  test('renders a PDF whose drawn text carries the caveat, the method and the totals', async () => {
    const doc = taxYearDocument(result(), LABELS, { currency: 'USD', symbolOf: SYMBOL });
    const input = { ...doc, account: 'Test account' };
    const pdf = await renderStatement(input);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const drawn = documentText(input, doc.sheet).join('\n');
    expect(drawn).toContain(LABELS.caveat);
    expect(drawn).toContain('UK Section 104 pooling');
    expect(drawn).toContain('Airdrops');
  });
});

describe('taxYearDocument — the gaps the ledger knows about are printed', () => {
  const gaps = result({
    byOutcome: { realized: 1, unpriced: 0, unreviewed: 2, retained: 0, awaiting_pair: 1 },
    byBasisQuality: { known: 1, partial: 3, unknown: 1 },
  });
  const detailOf = (r: TaxYearDisposals, label: string) =>
    taxYearDocument(r, LABELS, { currency: 'USD', symbolOf: SYMBOL }).provenance.details.find(
      (d) => d.label === label
    )?.value;

  test('partial and unknown cost basis are counted together', () => {
    expect(detailOf(gaps, 'Rows with incomplete cost basis')).toBe('4');
  });

  test('unreviewed and awaiting-pair outflows are counted together', () => {
    expect(detailOf(gaps, 'Outflows awaiting your answer')).toBe('3');
  });

  test('unvalued income receipts are counted across all three kinds', () => {
    const base = result();
    const r = result({
      income: { ...base.income, unvalued: { interest: 1, reward: 0, airdrop: 2 } },
    });
    expect(detailOf(r, 'Income receipts without a value')).toBe('3');
  });

  test('CONTROL: a clean ledger prints zeros, not nothing', () => {
    expect(detailOf(result(), 'Rows with incomplete cost basis')).toBe('0');
  });
});

describe('taxYearDocument — the scope is the tax year in its own zone', () => {
  test('a UK year reads 6 April to 5 April, not the UTC instants', () => {
    const { provenance } = taxYearDocument(result(), LABELS, { currency: 'USD', symbolOf: SYMBOL });
    expect(provenance.scope).toBe('2024-04-06 – 2025-04-05');
  });
});
