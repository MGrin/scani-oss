import { describe, expect, it } from 'bun:test';
import type { ConversionOutcome } from '../src/conversion-outcome';
import { type ConvertPriceFn, priceInBaseCurrency } from '../src/price-in-base-currency';

const never: ConvertPriceFn = async () => {
  throw new Error('convertPrice must not be called');
};

const refuses =
  (reason: string): ConvertPriceFn =>
  async () => ({ ok: false, reason });

const converts =
  (rate: number): ConvertPriceFn =>
  async (price) => ({ ok: true, price: (Number(price) * rate).toString() });

/**
 * A Toronto-listed CAD security. GOOGLEFINANCE renders `TSE:<sym>` in
 * CAD, so this is the class of token whose price only means anything
 * after a conversion step — US-listed holdings never take one.
 */
const CAD_USD = 0.72;
const LISTED = [
  { symbol: 'AAA', cad: '50', usd: '36' },
  { symbol: 'BBB', cad: '25', usd: '18' },
];
const PRIMARY = LISTED[0]!;

describe('priceInBaseCurrency', () => {
  it('converts a CAD listing into the base currency', async () => {
    const outcome = await priceInBaseCurrency({
      rawPrice: PRIMARY.cad,
      currency: 'CAD',
      baseCurrencySymbol: 'USD',
      timestamp: new Date(),
      convertPrice: converts(CAD_USD),
      symbol: PRIMARY.symbol,
    });

    expect(outcome).toEqual({ ok: true, price: PRIMARY.usd });
  });

  /**
   * SC-847. The existing-sheet-row paths guarded on `converted !== '0'`
   * and so kept the pre-conversion figure, publishing a CAD price as USD
   * — around a third too high, and indistinguishable from a real price.
   * This is the assertion that fails on that shape.
   */
  it.each(
    LISTED
  )('refuses rather than publishing the native $symbol figure when conversion fails', async ({
    cad,
  }) => {
    const outcome = await priceInBaseCurrency({
      rawPrice: cad,
      currency: 'CAD',
      baseCurrencySymbol: 'USD',
      timestamp: new Date(),
      convertPrice: refuses('CAD->USD rate lookup failed: The operation was aborted.'),
      symbol: 'X',
    });

    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(cad);
  });

  /**
   * The other half of the same defect: the new-token paths assigned the
   * conversion result straight into `price`, so the `'0'` sentinel was
   * published as the price. A zero is loud rather than plausible, but it
   * is still not the answer to "what is this worth".
   */
  it('refuses rather than reporting a zero price', async () => {
    const outcome = await priceInBaseCurrency({
      rawPrice: PRIMARY.cad,
      currency: 'CAD',
      baseCurrencySymbol: 'USD',
      timestamp: new Date(),
      convertPrice: refuses('no CAD->USD rate available upstream'),
      symbol: PRIMARY.symbol,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome).not.toHaveProperty('price');
  });

  /**
   * The quietest of the three paths, and the one no guard covered: with
   * `exchangeInfo` absent the old `if` was simply skipped, so the native
   * figure was published with no failure and no log line anywhere.
   */
  it('refuses when the currency is unknown, attempting no conversion', async () => {
    const outcome = await priceInBaseCurrency({
      rawPrice: PRIMARY.cad,
      currency: undefined,
      baseCurrencySymbol: 'USD',
      timestamp: new Date(),
      convertPrice: never,
      symbol: PRIMARY.symbol,
    });

    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toContain('no exchange currency known');
    expect(JSON.stringify(outcome)).not.toContain(PRIMARY.cad);
  });

  it('delegates a same-currency price to the converter, which passes it through', async () => {
    const passthrough: ConvertPriceFn = async (price, from, to) =>
      from === to ? { ok: true, price } : { ok: false, reason: 'unexpected' };

    const outcome = await priceInBaseCurrency({
      rawPrice: '33.06',
      currency: 'USD',
      baseCurrencySymbol: 'USD',
      timestamp: new Date(),
      convertPrice: passthrough,
      symbol: 'VTI',
    });

    expect(outcome).toEqual({ ok: true, price: '33.06' });
  });

  /**
   * The type is the fix. A refusal has no `price` member, so a caller
   * cannot reach a number without having matched `ok` first — which is
   * what makes the four call sites unable to disagree again.
   */
  it('never carries a price on a refusal', () => {
    const refusal: ConversionOutcome = { ok: false, reason: 'anything' };
    expect(Object.keys(refusal)).toEqual(['ok', 'reason']);
  });
});
