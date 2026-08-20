import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import {
  type AttributionPoint,
  attributeCurrencyEffect,
  type CurrencyBucket,
} from '../../../src/lib/returns/fx-attribution';

/**
 * SC-458 — worked examples with answers known before the code ran.
 *
 * The hard constraint on this ticket is that a performance number which is
 * subtly wrong is worse than one that is absent: a reader cannot audit a
 * percentage, so every scenario below fixes both legs in advance and asserts
 * the split lands on them, rather than asserting that the code agrees with
 * itself.
 *
 * Rates throughout are UNITS OF BASE PER UNIT OF THE ASSET'S CURRENCY, so a
 * rate that rises is the base currency weakening — which is a gain for the
 * holder of the foreign asset.
 */

const USD = 'token-usd';
const GBP = 'token-gbp';

function bucket(
  currencyTokenId: string | null,
  value: string,
  rate: string | null
): CurrencyBucket {
  return {
    currencyTokenId,
    value: new Decimal(value),
    rate: rate === null ? null : new Decimal(rate),
  };
}

function point(
  date: string,
  buckets: CurrencyBucket[],
  flows: Array<[string | null, string]> = []
): AttributionPoint {
  return {
    date,
    buckets,
    flowByCurrency: new Map(flows.map(([key, amount]) => [key, new Decimal(amount)])),
  };
}

/** `(1+asset)(1+currency)` must be `1+base` to the last digit, always. */
function composes(result: {
  assetReturn: string;
  currencyReturn: string;
  baseReturn: string;
}): boolean {
  const composed = new Decimal(result.assetReturn)
    .plus(1)
    .mul(new Decimal(result.currencyReturn).plus(1))
    .minus(1);
  return composed.minus(new Decimal(result.baseReturn)).abs().lt('1e-24');
}

describe('attributeCurrencyEffect — the scenario the whole ticket exists for', () => {
  test('an asset flat in its own currency, base currency down 10%: 0% asset, ~10% currency', () => {
    // The named case from the brief. A holder whose asset did nothing is up
    // 10% in base, and every point of it is the exchange rate. Splitting it
    // "somehow" between the two legs is the failure this asserts against.
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0')]),
      point('2026-02-01', [bucket(USD, '1100', '1.1')]),
    ]);

    expect(result).not.toBeNull();
    expect(Number(result?.assetReturn)).toBeCloseTo(0, 12);
    expect(Number(result?.currencyReturn)).toBeCloseTo(0.1, 12);
    expect(Number(result?.baseReturn)).toBeCloseTo(0.1, 12);
    expect(result?.attributedPeriods).toBe(1);
  });

  test('an asset up 10% with the rate unmoved: 10% asset, 0% currency', () => {
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0')]),
      point('2026-02-01', [bucket(USD, '1100', '1.0')]),
    ]);

    expect(Number(result?.assetReturn)).toBeCloseTo(0.1, 12);
    expect(Number(result?.currencyReturn)).toBeCloseTo(0, 12);
  });

  test('a currency the scope is entirely quoted in cancels: rates never enter the asset leg', () => {
    // Same asset return, three different rate paths. If the rate leaked into
    // the asset leg at all, these would disagree.
    const paths = [
      ['1.0', '1.0'],
      ['1.0', '2.0'],
      ['3.0', '0.5'],
    ] as const;
    const assetLegs = paths.map(([open, close]) => {
      const closeValue = new Decimal('1200').mul(close).div(open).toString();
      return attributeCurrencyEffect([
        point('2026-01-01', [bucket(USD, new Decimal('1000').mul(open).toString(), open)]),
        point('2026-02-01', [bucket(USD, new Decimal(closeValue).mul(open).toString(), close)]),
      ])?.assetReturn;
    });
    for (const leg of assetLegs) expect(Number(leg)).toBeCloseTo(0.2, 12);
  });
});

describe('attributeCurrencyEffect — the composition rule is multiplicative', () => {
  test('40% asset and 15% currency make 61% base, not 55%', () => {
    // The defence of the rule, as a number. Additive attribution loses the
    // interaction term — six percentage points here, larger than most
    // people's entire annual return.
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0')]),
      point('2027-01-01', [bucket(USD, '1610', '1.15')]),
    ]);

    expect(Number(result?.assetReturn)).toBeCloseTo(0.4, 12);
    expect(Number(result?.currencyReturn)).toBeCloseTo(0.15, 12);
    expect(Number(result?.baseReturn)).toBeCloseTo(0.61, 12);
    expect(Number(result?.crossTerm)).toBeCloseTo(0.06, 12);
    expect(composes(result as never)).toBe(true);
  });

  test('the additive form reconciles exactly once the cross term is named', () => {
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0')]),
      point('2027-01-01', [bucket(USD, '1610', '1.15')]),
    ]) as NonNullable<ReturnType<typeof attributeCurrencyEffect>>;

    const additive = new Decimal(result.assetReturn)
      .plus(result.currencyReturn)
      .plus(result.crossTerm);
    expect(additive.minus(result.baseReturn).abs().lt('1e-24')).toBe(true);
  });
});

describe('attributeCurrencyEffect — attribution is per sub-period, never once across the window', () => {
  test('a currency move is weighted by the portfolio that was exposed to it', () => {
    // Held entirely in USD while USD gains 20%, then held entirely in GBP
    // while nothing moves — and the USD rate collapses afterwards, with none
    // of it held. Chained per period the answer is +20% currency, 0% asset.
    //
    // Attributing once from the first point to the last would read the
    // CLOSING mix — 100% GBP, whose rate never moved — and report 0%
    // currency with the whole 20% as skill. That is the error this asserts
    // cannot happen, and it is why `TwrResult.periods` was preserved.
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0'), bucket(GBP, '0', '2.0')]),
      point('2026-02-01', [bucket(USD, '1200', '1.2'), bucket(GBP, '0', '2.0')]),
      point('2026-03-01', [bucket(USD, '0', '0.6'), bucket(GBP, '1200', '2.0')]),
    ]);

    expect(Number(result?.assetReturn)).toBeCloseTo(0, 12);
    expect(Number(result?.currencyReturn)).toBeCloseTo(0.2, 12);
    expect(result?.attributedPeriods).toBe(2);
    const perPeriod = (result?.periods ?? []).map((p) => Number(p.currencyReturn));
    expect(perPeriod[0]).toBeCloseTo(0.2, 12);
    expect(perPeriod[1]).toBeCloseTo(0, 12);
  });

  test('two currencies moving in opposite directions net out by value, not by count', () => {
    // 750 in USD up 10%, 250 in GBP down 10%. Assets flat in local terms, so
    // the whole move is currency, and it is weighted by VALUE rather than by
    // currency count: +75 and -25 on an opening 1000 is +5%, not the 0% two
    // equal-and-opposite moves would give.
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '750', '1.0'), bucket(GBP, '250', '1.0')]),
      point('2026-02-01', [bucket(USD, '825', '1.1'), bucket(GBP, '225', '0.9')]),
    ]);

    expect(Number(result?.assetReturn)).toBeCloseTo(0, 12);
    expect(Number(result?.currencyReturn)).toBeCloseTo(0.05, 12);
    expect(composes(result as never)).toBe(true);
  });
});

describe('attributeCurrencyEffect — a flow is not performance and not a currency move', () => {
  test('a deposit mid-period leaves the asset leg at zero', () => {
    // Opening 1000 base at rate 1.0. A 1100-base deposit lands, and the rate
    // moves to 1.1. Closing 2200. Nothing was earned: the asset leg is 0 and
    // the whole 10% is the rate, on the money that was there to feel it.
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0')]),
      point('2026-02-01', [bucket(USD, '2200', '1.1')], [[USD, '1100']]),
    ]);

    expect(Number(result?.assetReturn)).toBeCloseTo(0, 12);
    expect(Number(result?.currencyReturn)).toBeCloseTo(0.1, 12);
    expect(composes(result as never)).toBe(true);
  });

  test('a withdrawal is symmetric', () => {
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0')]),
      point('2026-02-01', [bucket(USD, '550', '1.1')], [[USD, '-550']]),
    ]);

    expect(Number(result?.assetReturn)).toBeCloseTo(0, 12);
    expect(Number(result?.currencyReturn)).toBeCloseTo(0.1, 12);
  });
});

describe('attributeCurrencyEffect — a rate nobody could read is never a rate of 1', () => {
  test('an unpriced currency drops its period and says so', () => {
    // The defect one layer down that SC-471 found: `tryDirect` answered null
    // for a missing pair and the engine booked the gap as performance. A
    // missing rate here must cost the period, not become "the currency did
    // not move".
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0')]),
      point('2026-02-01', [bucket(USD, '1100', null)]),
      point('2026-03-01', [bucket(USD, '1210', '1.0')]),
    ]);

    // Both periods touch the unreadable boundary, so there is nothing left to
    // attribute and the answer is an absence rather than a flat split.
    expect(result).toBeNull();
  });

  test('the periods that CAN be attributed still are, and the shortfall is counted', () => {
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0')]),
      point('2026-02-01', [bucket(USD, '1100', '1.0')]),
      point('2026-03-01', [bucket(USD, '1210', null)]),
    ]);

    expect(result?.attributedPeriods).toBe(1);
    expect(result?.unattributedPeriods).toBe(1);
    expect(result?.unpricedCurrencyPeriods).toBe(1);
    expect(result?.periods[1]?.reason).toBe('unpriced-currency');
    // `baseReturn` covers the attributed sub-chain ONLY, so the identity
    // holds on the numbers actually shown. It is deliberately NOT the
    // headline TWR, which chained both periods.
    expect(Number(result?.baseReturn)).toBeCloseTo(0.1, 12);
    expect(composes(result as never)).toBe(true);
  });

  test('value nothing could place a currency for costs its period too', () => {
    // A private-company holding, an unrecognised listing venue. Its bucket
    // has no currency at all, so no ratio exists and the period is dropped
    // rather than silently treated as base-currency-denominated.
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '900', '1.0'), bucket(null, '100', null)]),
      point('2026-02-01', [bucket(USD, '990', '1.1'), bucket(null, '100', null)]),
    ]);

    expect(result).toBeNull();
  });

  test('a zero rate is a missing rate, not a currency worth nothing', () => {
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '0')]),
      point('2026-02-01', [bucket(USD, '1100', '1.1')]),
    ]);

    expect(result).toBeNull();
  });
});

describe('attributeCurrencyEffect — absences', () => {
  test('fewer than two points is null, not a flat split', () => {
    expect(attributeCurrencyEffect([])).toBeNull();
    expect(attributeCurrencyEffect([point('2026-01-01', [bucket(USD, '1000', '1')])])).toBeNull();
  });

  test('a period opening at zero is skipped the way the TWR chain skips it', () => {
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '0', '1.0')]),
      point('2026-02-01', [bucket(USD, '1000', '1.0')]),
      point('2026-03-01', [bucket(USD, '1100', '1.0')]),
    ]);

    expect(result?.attributedPeriods).toBe(1);
    expect(result?.periods[0]?.reason).toBe('no-opening-value');
    expect(result?.unpricedCurrencyPeriods).toBe(0);
    expect(Number(result?.assetReturn)).toBeCloseTo(0.1, 12);
  });

  test('an asset leg wiped to zero or below is dropped rather than divided by', () => {
    // A closing value below the flow that arrived in the same period is an
    // inconsistency between the value series and the ledger. The TWR chain
    // floors it at a -100% period; doing that here would make the currency
    // leg infinite, so both legs are abandoned instead.
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0')]),
      point('2026-02-01', [bucket(USD, '100', '1.0')], [[USD, '500']]),
    ]);

    expect(result).toBeNull();
  });
});

describe('attributeCurrencyEffect — what the scope was exposed to', () => {
  test('closing weights name every currency and the share nothing could place', () => {
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '600', '1.0'), bucket(GBP, '400', '1.0')]),
      point('2026-02-01', [bucket(USD, '750', '1.0'), bucket(GBP, '250', '1.0')]),
    ]);

    expect(result?.currencies).toEqual([
      { currencyTokenId: USD, endWeight: '0.75' },
      { currencyTokenId: GBP, endWeight: '0.25' },
    ]);
  });

  test('a bucket that closed empty is not listed as a 0% exposure', () => {
    const result = attributeCurrencyEffect([
      point('2026-01-01', [bucket(USD, '1000', '1.0'), bucket(GBP, '0', '1.0')]),
      point('2026-02-01', [bucket(USD, '1100', '1.0'), bucket(GBP, '0', '1.0')]),
    ]);

    expect(result?.currencies).toEqual([{ currencyTokenId: USD, endWeight: '1' }]);
  });
});
