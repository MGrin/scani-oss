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
