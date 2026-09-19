import { describe, expect, test } from 'bun:test';
import { taxYearDisposalsSchema } from '@scani/shared';
import { appRouter } from '../../src/presentation/router';

/**
 * SC-90 — `portfolio.taxYear` takes a year and where that year starts, and
 * nothing else.
 *
 * `yearStart` has no default (Operator ruling, bus #12480): the cost-basis
 * method is not the jurisdiction, so the caller always names it. The method is
 * the account's stored one and cannot be requested (SC-957).
 *
 * Asserted against the schema the real router parses with, and every refusal
 * sits beside an acceptance: a schema that refused everything would pass the
 * refusals alone.
 */
function inputSchemaFor(path: string): { safeParse: (v: unknown) => { success: boolean } } {
  const procedures = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
    ._def.procedures;
  const procedure = procedures[path];
  if (!procedure) throw new Error(`no such procedure: ${path}`);
  const inputs = (procedure as { _def?: { inputs?: unknown[] } })._def?.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw new Error(`${path} does not have exactly one input schema`);
  }
  return inputs[0] as { safeParse: (v: unknown) => { success: boolean } };
}

describe('portfolio.taxYear input', () => {
  const schema = inputSchemaFor('portfolio.taxYear');

  test('every supported start is accepted — so a refusal below means something', () => {
    for (const yearStart of ['jan-1', 'apr-1', 'apr-6', 'jul-1']) {
      expect(`${yearStart}=${schema.safeParse({ year: 2024, yearStart }).success}`).toBe(
        `${yearStart}=true`
      );
    }
  });

  test('a missing yearStart is refused rather than defaulted', () => {
    expect(schema.safeParse({ year: 2024 }).success).toBe(false);
  });

  test('an unsupported yearStart is refused', () => {
    expect(schema.safeParse({ year: 2024, yearStart: 'apr-5' }).success).toBe(false);
  });

  test('a fractional year is refused', () => {
    expect(schema.safeParse({ year: 2024.5, yearStart: 'jan-1' }).success).toBe(false);
  });

  test('a request naming a cost-basis method is refused (SC-957)', () => {
    expect(
      schema.safeParse({ year: 2024, yearStart: 'jan-1', costBasisMethod: 'fifo' }).success
    ).toBe(false);
  });
});

/**
 * Every statement is stamped with when it was generated (Operator ruling, bus
 * #12532): a closed year is re-walked on every read, so without the time a
 * reader cannot tell two differing statements apart. The method is already
 * required beside it.
 */
describe('the tax-year result carries its generation time', () => {
  const minimal = {
    periodStart: '2024-01-01T00:00:00.000Z',
    periodEnd: '2025-01-01T00:00:00.000Z',
    baseCurrencyId: null,
    costBasisMethod: 'fifo',
    rows: [],
    rowCount: 0,
    byOutcome: { realized: 0, unpriced: 0, unreviewed: 0, retained: 0, awaiting_pair: 0 },
    byBasisQuality: { known: 0, partial: 0, unknown: 0 },
    totals: { proceeds: '0', costBasis: '0', gain: '0' },
    taxYear: { year: 2024, yearStart: 'jan-1', timeZone: 'UTC', timeZoneSource: 'utc-fallback' },
    income: {
      rows: [],
      totals: { interest: '0', reward: '0' },
      unvalued: { interest: 0, reward: 0, airdrop: 0 },
    },
  };

  test('with generatedAt it parses', () => {
    expect(
      taxYearDisposalsSchema.safeParse({ ...minimal, generatedAt: '2026-09-19T08:00:00.000Z' })
        .success
    ).toBe(true);
  });

  test('without generatedAt it is refused', () => {
    expect(taxYearDisposalsSchema.safeParse(minimal).success).toBe(false);
  });
});

/**
 * The income section (mgrin, 2026-09-11): interest and rewards totalled,
 * airdrops listed with no total. The wire type has no airdrop total to fill, so
 * no client can print one.
 */
describe('the tax-year result carries income, with no airdrop total', () => {
  const base = {
    periodStart: '2024-01-01T00:00:00.000Z',
    periodEnd: '2025-01-01T00:00:00.000Z',
    generatedAt: '2026-09-19T08:00:00.000Z',
    baseCurrencyId: 'usd',
    costBasisMethod: 'fifo',
    rows: [],
    rowCount: 0,
    byOutcome: { realized: 0, unpriced: 0, unreviewed: 0, retained: 0, awaiting_pair: 0 },
    byBasisQuality: { known: 0, partial: 0, unknown: 0 },
    totals: { proceeds: '0', costBasis: '0', gain: '0' },
    taxYear: { year: 2024, yearStart: 'jan-1', timeZone: 'UTC', timeZoneSource: 'utc-fallback' },
  };
  const income = {
    rows: [
      {
        transactionId: 't',
        holdingId: 'h',
        tokenId: 'eth',
        kind: 'airdrop',
        receivedAt: '2024-06-01T00:00:00.000Z',
        quantity: '3',
        value: '6000',
        stale: false,
      },
    ],
    totals: { interest: '0', reward: '0' },
    unvalued: { interest: 0, reward: 0, airdrop: 0 },
  };

  test('with income it parses', () => {
    expect(taxYearDisposalsSchema.safeParse({ ...base, income }).success).toBe(true);
  });

  test('without income it is refused', () => {
    expect(taxYearDisposalsSchema.safeParse(base).success).toBe(false);
  });

  test('an airdrop total is refused', () => {
    const withAirdropTotal = { ...income, totals: { ...income.totals, airdrop: '6000' } };
    expect(taxYearDisposalsSchema.safeParse({ ...base, income: withAirdropTotal }).success).toBe(
      false
    );
  });
});

/**
 * `exports.taxYearPdf` takes the year and the WORDS; the server computes every
 * figure. A request carrying its own sheet is refused, so a client cannot print
 * a number the ledger did not produce.
 */
describe('exports.taxYearPdf input', () => {
  const schema = inputSchemaFor('exports.taxYearPdf');
  const labels = {
    subject: 'Tax year statement',
    headers: {
      date: 'Date',
      asset: 'Asset',
      quantity: 'Quantity',
      acquired: 'Acquired',
      amount: 'Amount',
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
      year: 'Year',
      method: 'Method',
      timeZone: 'Zone',
      gainTotal: 'Gain',
      interestTotal: 'Interest',
      rewardTotal: 'Rewards',
      airdropNote: 'Airdrops',
      caveat: 'Note',
      basisIncomplete: 'Incomplete basis',
      awaitingReview: 'Awaiting review',
      unvaluedIncome: 'Unvalued income',
    },
    methods: { fifo: 'FIFO', uk_section_104: 'Section 104' },
    yearStarts: { 'jan-1': '1 Jan', 'apr-1': '1 Apr', 'apr-6': '6 Apr', 'jul-1': '1 Jul' },
    airdropNote: 'listed, not totalled',
    caveat: 'figures can change if past data or the method changes; keep the PDF you filed',
  };
  const ok = { year: 2024, yearStart: 'apr-6', labels };

  test('year, start and labels are accepted — so a refusal below means something', () => {
    expect(schema.safeParse(ok).success).toBe(true);
  });

  test('a request with no caveat is refused', () => {
    expect(schema.safeParse({ ...ok, labels: { ...labels, caveat: '' } }).success).toBe(false);
    expect(
      schema.safeParse({ ...ok, labels: { ...labels, methods: { fifo: 'FIFO' } } }).success
    ).toBe(false);
  });

  test('a request carrying its own sheet is refused', () => {
    expect(schema.safeParse({ ...ok, sheet: { rows: [] } }).success).toBe(false);
  });

  test("the statement's own words travel too, so the page is in the reader's language", () => {
    const text = {
      total: 'Итого',
      pageOf: 'Страница {{page}} из {{pages}}',
      account: 'Аккаунт',
      generated: 'Создано',
      generatedAt: '19 сентября 2026 г. в 08:00 UTC',
      rows: 'Строк',
      amounts: 'Суммы',
      amountsWithheld: 'скрыты',
      characters: 'Символы',
      unsupportedNote: 'примечание',
      noRows: 'Нет строк',
    };
    expect(schema.safeParse({ ...ok, text }).success).toBe(true);
  });

  test('yearStart has no default here either', () => {
    expect(schema.safeParse({ year: 2024, labels }).success).toBe(false);
  });
});
