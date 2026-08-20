import Decimal from 'decimal.js';

/**
 * Splitting a base-currency return into what the ASSETS did and what the
 * EXCHANGE RATE did (SC-458).
 *
 * The question a multi-currency owner actually has is "I am up 12% — how much
 * of that did I earn?". Every figure in Scani is converted to base currency
 * before it is shown, so the two effects arrive fused and nothing on screen
 * can tell them apart. This is the arithmetic that separates them.
 *
 * ## The composition rule is MULTIPLICATIVE, and that is the whole design
 *
 *     (1 + assetReturn) × (1 + currencyReturn) = 1 + baseReturn
 *
 * exactly, per sub-period and over the chain. The additive reading —
 * `base = asset + currency` — is wrong, and not by a rounding amount: it
 * leaves the interaction term `assetReturn × currencyReturn` unallocated. An
 * asset up 40% in its own currency, in a year the base currency fell 15%
 * against it, is up 61% in base — additive attribution says 55% and loses six
 * percentage points, which is larger than most people's entire annual return.
 * Returns compound; an attribution that does not is a different number
 * wearing the same label.
 *
 * `crossTerm` is carried out anyway, so a reader who wants the additive form
 * gets it with the residual named rather than hidden:
 * `asset + currency + cross = base`, to the last digit.
 *
 * ## How the asset leg is measured: freeze the rates, not the prices
 *
 * Per sub-period, every closing value is re-expressed at the rates that held
 * at the period's OPENING. What is left moving is the asset alone:
 *
 *     assetFactor = (Σ_b V_b(1)·X_b(0)/X_b(1) − F′) / Σ_b V_b(0)
 *     baseFactor  = (Σ_b V_b(1) − F) / Σ_b V_b(0)
 *     currencyFactor = baseFactor / assetFactor
 *
 * where `b` runs over currency buckets, `V_b` is that bucket's value in BASE
 * currency, `X_b` is its currency's rate into base, `F` is the net external
 * flow and `F′` the same flow re-expressed at the opening rates.
 *
 * Two properties make this the right decomposition rather than one of many:
 * the denominators are identical (`Σ V_b(0)·X_b(0)/X_b(0)` is just
 * `Σ V_b(0)`), so the currency factor is an exact ratio with nothing dropped;
 * and for a single-currency scope the rates cancel completely, leaving
 * `V_local(1)/V_local(0)` — the asset's return in its own currency, with no
 * approximation anywhere.
 *
 * Local values are DERIVED as `V_base / X`, never re-priced. Re-pricing every
 * holding in its own currency for every day would be a second valuation path
 * that could disagree with the chart it is printed under, which is the one
 * thing SC-60 exists to prevent — and it would cost a query per holding per
 * day. One rate per currency per day is the whole input.
 *
 * ## Per sub-period, not once across the window
 *
 * Attribution is chained over exactly the boundaries `computeTimeWeightedReturn`
 * produced, which is why `TwrResult.periods` was preserved. Attributing once
 * from window start to window end would weight every day of FX movement by
 * today's portfolio rather than by the portfolio that was actually exposed to
 * it, so a currency move in January would be scaled by a position bought in
 * June.
 *
 * ## A missing rate is never zero movement
 *
 * The failure this is most likely to commit is the one SC-471 found in
 * `tryDirect`: a pair with no price answered `null`, and the engine booked the
 * gap as performance. A bucket whose rate is unknown at either boundary makes
 * its whole sub-period UNATTRIBUTED — counted, reasoned, and excluded from
 * both legs. It never contributes `X_b(0)/X_b(1) = 1`, which would be the
 * confident claim that the currency did not move.
 *
 * Because unattributed periods are excluded, `baseReturn` is reported over the
 * attributed sub-chain rather than copied from `TwrResult.cumulative`. The two
 * are equal when every period was attributed and visibly differ otherwise,
 * which is the point: the identity above must hold on the numbers actually
 * shown, and a reader must be able to see when the split covers less than the
 * headline.
 */

export interface CurrencyBucket {
  /**
   * The currency this slice of the scope is quoted in. `null` when nothing
   * could say — a private-company holding, an unrecognised listing venue.
   */
  currencyTokenId: string | null;
  /** This bucket's value in BASE currency, already scope-weighted. */
  value: Decimal;
  /**
   * Units of base currency per one unit of `currencyTokenId`, on this day.
   * `null` when no rate could be resolved, which is NOT a rate of 1.
   */
  rate: Decimal | null;
}

export interface AttributionPoint {
  /** Same `YYYY-MM-DD` boundary the TWR chain uses. */
  date: string;
  /**
   * EVERY currency the scope touches anywhere in the window, on EVERY point,
   * carrying a zero value where the scope held nothing in it that day.
   *
   * A ragged bucket set would make a currency first acquired mid-window
   * indistinguishable from one whose rate could not be read: both would find
   * no opening rate, and the second must abandon the period while the first
   * must not. Filling the set is the caller's job because only the caller
   * knows the window.
   */
  buckets: CurrencyBucket[];
  /**
   * Net external flow inside `(previous point, this point]`, base currency,
   * positive into the scope, split by the bucket it landed in. Ignored on the
   * first point, exactly as `ValuationPoint.netExternalFlow` is.
   */
  flowByCurrency: Map<string | null, Decimal>;
}

export type UnattributedReason =
  /** The scope held nothing to earn a return on — mirrors TWR's skip. */
  | 'no-opening-value'
  /** A bucket had no rate at one of the two boundaries. */
  | 'unpriced-currency'
  /** The asset leg came out at or below zero, so the ratio is undefined. */
  | 'non-positive-asset-leg';

export interface AttributionPeriod {
  from: string;
  to: string;
  /** `null` exactly when `reason` is set. */
  assetReturn: string | null;
  currencyReturn: string | null;
  reason: UnattributedReason | null;
}

export interface ReturnAttribution {
  /** Cumulative asset-only return over the attributed sub-chain. */
  assetReturn: string;
  /** Cumulative currency-only return over the same sub-chain. */
  currencyReturn: string;
  /**
   * The base-currency return over EXACTLY those periods, so
   * `(1+asset)(1+currency) = 1+base` holds on the numbers printed. Equal to
   * `TwrResult.cumulative` when `unattributedPeriods` is 0.
   */
  baseReturn: string;
  /** `asset + currency + cross = base`, for a reader who wants it additive. */
  crossTerm: string;
  attributedPeriods: number;
  unattributedPeriods: number;
  /** Of `unattributedPeriods`, how many because a currency had no rate. */
  unpricedCurrencyPeriods: number;
  /**
   * Which currencies the scope was exposed to, by share of the CLOSING value.
   * `null` is the share nothing could assign a currency to — the honest way
   * to say how much of the figure the split does not cover.
   */
  currencies: Array<{ currencyTokenId: string | null; endWeight: string }>;
  periods: AttributionPeriod[];
}

/**
 * Chain `points` into an asset/currency split.
 *
 * `null` when there is nothing to say — fewer than two points, or not one
 * period that could be attributed. An attribution of 0% and 0% over zero
 * measured periods is a fabrication, and the caller renders an absence
 * differently from a flat result.
 */
export function attributeCurrencyEffect(
  points: readonly AttributionPoint[]
): ReturnAttribution | null {
  if (points.length < 2) return null;

  const periods: AttributionPeriod[] = [];
  let assetFactor = new Decimal(1);
  let baseFactor = new Decimal(1);
  let attributed = 0;
  let unpricedCurrency = 0;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1] as AttributionPoint;
    const curr = points[i] as AttributionPoint;
    const outcome = attributePeriod(prev, curr);

    if (outcome.reason !== null) {
      if (outcome.reason === 'unpriced-currency') unpricedCurrency += 1;
      periods.push({
        from: prev.date,
        to: curr.date,
        assetReturn: null,
        currencyReturn: null,
        reason: outcome.reason,
      });
      continue;
    }

    attributed += 1;
    assetFactor = assetFactor.mul(outcome.asset);
    baseFactor = baseFactor.mul(outcome.base);
    periods.push({
      from: prev.date,
      to: curr.date,
      assetReturn: outcome.asset.minus(1).toString(),
      currencyReturn: outcome.base.div(outcome.asset).minus(1).toString(),
      reason: null,
    });
  }

  if (attributed === 0) return null;

  const assetReturn = assetFactor.minus(1);
  const currencyReturn = baseFactor.div(assetFactor).minus(1);
  const base = baseFactor.minus(1);

  return {
    assetReturn: assetReturn.toString(),
    currencyReturn: currencyReturn.toString(),
    baseReturn: base.toString(),
    crossTerm: assetReturn.mul(currencyReturn).toString(),
    attributedPeriods: attributed,
    unattributedPeriods: periods.length - attributed,
    unpricedCurrencyPeriods: unpricedCurrency,
    currencies: closingWeights(points[points.length - 1] as AttributionPoint),
    periods,
  };
}

type PeriodOutcome =
  | { reason: null; asset: Decimal; base: Decimal }
  | { reason: UnattributedReason };

function attributePeriod(prev: AttributionPoint, curr: AttributionPoint): PeriodOutcome {
  const openingValue = sumValues(prev.buckets);
  if (openingValue.lte(0)) return { reason: 'no-opening-value' };

  const priorRates = ratesOf(prev.buckets);
  let closingValue = new Decimal(0);
  let closingAtPriorRates = new Decimal(0);

  for (const bucket of curr.buckets) {
    if (bucket.value.isZero()) continue;
    closingValue = closingValue.add(bucket.value);
    const ratio = rateRatio(priorRates.get(bucket.currencyTokenId) ?? null, bucket.rate);
    if (ratio === null) return { reason: 'unpriced-currency' };
    closingAtPriorRates = closingAtPriorRates.add(bucket.value.mul(ratio));
  }

  const currRates = ratesOf(curr.buckets);
  let flow = new Decimal(0);
  let flowAtPriorRates = new Decimal(0);

  for (const [currencyTokenId, amount] of curr.flowByCurrency) {
    if (amount.isZero()) continue;
    flow = flow.add(amount);
    // The flow is valued at the instant it happened, and TWR's end-of-day
    // convention already treats it as arriving at the period's close — so the
    // rate it was converted at is this point's rate, and re-expressing it in
    // the opening rate's terms is the same ratio the values use.
    const ratio = rateRatio(
      priorRates.get(currencyTokenId) ?? null,
      currRates.get(currencyTokenId) ?? null
    );
    if (ratio === null) return { reason: 'unpriced-currency' };
    flowAtPriorRates = flowAtPriorRates.add(amount.mul(ratio));
  }

  const assetLeg = closingAtPriorRates.minus(flowAtPriorRates).div(openingValue);
  const baseLeg = closingValue.minus(flow).div(openingValue);
  // A non-positive asset leg cannot carry a ratio, and flooring it at zero the
  // way the TWR chain floors its own factor would make the currency leg
  // infinite rather than wrong-but-bounded. Both legs are dropped instead.
  if (assetLeg.lte(0)) return { reason: 'non-positive-asset-leg' };
  return { reason: null, asset: assetLeg, base: baseLeg };
}

function sumValues(buckets: readonly CurrencyBucket[]): Decimal {
  return buckets.reduce((sum, bucket) => sum.add(bucket.value), new Decimal(0));
}

function ratesOf(buckets: readonly CurrencyBucket[]): Map<string | null, Decimal | null> {
  return new Map(buckets.map((bucket) => [bucket.currencyTokenId, bucket.rate]));
}

/**
 * `X(prev) / X(curr)` — the factor that undoes this period's currency move.
 * `null` when either end is missing or non-positive, which is the caller's
 * signal to abandon the period rather than to substitute 1.
 */
function rateRatio(prev: Decimal | null | undefined, curr: Decimal | null): Decimal | null {
  if (!prev || !curr) return null;
  if (prev.lte(0) || curr.lte(0)) return null;
  return prev.div(curr);
}

function closingWeights(
  last: AttributionPoint
): Array<{ currencyTokenId: string | null; endWeight: string }> {
  const total = sumValues(last.buckets);
  return last.buckets
    .filter((bucket) => !bucket.value.isZero())
    .map((bucket) => ({
      currencyTokenId: bucket.currencyTokenId,
      endWeight: total.isZero() ? '0' : bucket.value.div(total).toString(),
    }))
    .sort((a, b) => Number(b.endWeight) - Number(a.endWeight));
}
