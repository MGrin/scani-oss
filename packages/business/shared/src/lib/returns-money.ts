import Decimal from 'decimal.js';

/**
 * The window's money change, split the way the rates split (SC-1297).
 *
 * It lives in the frontend-safe contract rather than in `@scani/domain`
 * because the returns card computes it too. The card's sentence and its
 * attribution bar read `portfolio.getReturns`, which is cheap; the chart is a
 * second, expensive call, and a price lookup that times out must not take the
 * money figures down with it. Two copies of this arithmetic would let the
 * server's split and the card's disagree for reasons no reader could see.
 *
 * `fx-attribution.ts` produces rates that compose exactly in the additive
 * form `asset + currency + cross = base`. That is what makes a MONEY split
 * possible at all: the three shares of `base` are the three shares of the
 * gain, and they add back to it to the last digit.
 *
 * The share is meaningless when `base` is ~0, which is not a corner case but
 * the ordinary shape of a currency-hedged year: assets up 20%, the currency
 * down nearly 17%, a portfolio that barely moved. Dividing a near-zero gain by
 * a near-zero base gives enormous shares of nothing. Then the gain is reported
 * WHOLE and both legs are null, so the caller says "market and currency"
 * rather than printing two confident numbers that would flip sign on a
 * rounding difference.
 */

export interface MoneyAttributionRates {
  assetReturn: string;
  currencyReturn: string;
  crossTerm: string;
  baseReturn: string;
}

export interface MoneyAttributionInput {
  openingValue: Decimal;
  closingValue: Decimal;
  /** Net external flow over the window: deposits minus withdrawals. */
  netFlow: Decimal;
  attribution: MoneyAttributionRates | null;
}

export interface MoneySplit {
  /** What the reader put in (or took out) over the window. */
  contributions: Decimal;
  /** Everything the portfolio itself did: value change minus contributions. */
  gain: Decimal;
  /** The gain's asset leg, or null when it cannot be told from the rates. */
  market: Decimal | null;
  /** The gain's currency leg, or null on the same condition. */
  currency: Decimal | null;
  /** The interaction term, carried so the parts add back exactly. */
  crossEffect: Decimal | null;
}

/** Below this the base return is indistinguishable from zero for a share. */
const SHARE_FLOOR = new Decimal('0.0001');

export function splitChangeIntoMoney(input: MoneyAttributionInput): MoneySplit {
  const contributions = input.netFlow;
  const gain = input.closingValue.minus(input.openingValue).minus(contributions);
  const unsplit: MoneySplit = {
    contributions,
    gain,
    market: null,
    currency: null,
    crossEffect: null,
  };

  if (!input.attribution) return unsplit;

  const base = new Decimal(input.attribution.baseReturn);
  if (base.abs().lt(SHARE_FLOOR)) return unsplit;

  const asset = new Decimal(input.attribution.assetReturn);
  const currency = new Decimal(input.attribution.currencyReturn);
  const market = gain.mul(asset.div(base));
  const currencyEffect = gain.mul(currency.div(base));

  return {
    contributions,
    gain,
    market,
    currency: currencyEffect,
    // Taken as the remainder, not as its own share: the three legs then add
    // back to the gain exactly, whatever the rates rounded to.
    crossEffect: gain.minus(market).minus(currencyEffect),
  };
}
