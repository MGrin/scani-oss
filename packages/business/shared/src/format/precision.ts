import { Decimal } from '../decimal';

/**
 * How many decimals a figure should be *shown* at — asked of the figure, not
 * fixed by the column it lands in.
 *
 * Every surface that renders money or a quantity has to answer this, and until
 * SC-172/174/177/179 each of them answered it separately with a constant. The
 * constants were individually defensible and collectively produced four defects
 * of the same shape: `€0.00` against a quantity of 4,200,000, a repeating
 * decimal written into a spreadsheet as text so `SUM` skipped it, a CSV of
 * 28-digit money, and `500,000,000.00000000` wrapped over three lines on a
 * phone. A fixed precision is wrong at one end of the range or the other; which
 * end depends only on the magnitude, which is something the value knows.
 *
 * So the rule lives here once, in two flavours, and both are stated the same
 * way: **the precision a figure of ordinary magnitude gets, extended only when
 * that precision would misrepresent the figure, and only by as much as the
 * figure has digits to justify.**
 *
 * Frontend-safe (`@scani/shared`), because it is needed by the browser's
 * exporters, by the app's ledger and by the server's PDF renderer, and three
 * copies of a rounding rule is how the drift started.
 */

/** Below this, a token has no units left to price — the `minE` the project's
 *  `Decimal` is configured with. Nothing is shown past it. */
const SMALLEST_UNIT_DECIMALS = 18;

/** Where a balance column stops carrying meaning — the cap v3's holdings list
 *  has always used. */
const QUANTITY_DECIMALS = 8;

/** Money is two decimals, and that is a fact about currency rather than a
 *  default worth making configurable. */
const MONEY_DECIMALS = 2;

/**
 * How many leading digits survive when a figure has to be extended.
 *
 * Four, so a price a reader multiplies out lands within a rounding of the
 * total on the same row: `4,200,000 × 0.00007715` is `324.03`, the value the
 * statement prints beside it. Two would give `323.40` and invite the reader to
 * conclude the document is wrong.
 */
const SIGNIFICANT_DIGITS = 4;

function parse(value: Decimal.Value | null | undefined): Decimal | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

/**
 * The zeros between the decimal point and the first significant digit — 4 for
 * `0.00007`. Zero for anything at or above 1, which needs no extension.
 */
function leadingZeros(absolute: Decimal): number {
  if (absolute.isZero() || absolute.gte(1)) return 0;
  // `e` is the exponent of the normalised form (`7.714e-5` → -5), so the digit
  // count between the point and the first significant digit is one less.
  return -absolute.e - 1;
}

/** The decimals that show `SIGNIFICANT_DIGITS` of the figure, or all of them if
 *  it has fewer — `0.004` needs three, not six. */
function extendedDecimals(absolute: Decimal): number {
  const significant = Math.min(SIGNIFICANT_DIGITS, absolute.sd(true));
  return Math.min(leadingZeros(absolute) + significant, SMALLEST_UNIT_DECIMALS);
}

/** Whether rounding to `decimals` would leave nothing of a figure that is not
 *  nothing — the one condition that justifies showing more. */
function vanishesAt(absolute: Decimal, decimals: number): boolean {
  return !absolute.isZero() && absolute.toDecimalPlaces(decimals).isZero();
}

/**
 * The decimals to show a money figure at: two, unless two would render it as
 * `0.00` when it is not zero.
 *
 * SC-179 — a holding of 4,200,000 LUNC at `€0.00` is a row whose own
 * multiplication contradicts the total printed beside it, and the reader a PDF
 * statement is *for* is the one who checks that multiplication. The alternatives
 * were a `<0.01` marker, which cannot be multiplied out, and widening the whole
 * column, which pads `62,000.00` with zeros to make room for one row.
 */
export function moneyDecimals(value: Decimal.Value | null | undefined): number {
  const decimal = parse(value);
  if (decimal === null) return MONEY_DECIMALS;
  const absolute = decimal.abs();
  if (!vanishesAt(absolute, MONEY_DECIMALS)) return MONEY_DECIMALS;
  return Math.max(extendedDecimals(absolute), MONEY_DECIMALS);
}

/**
 * The decimals to show a quantity at: the ones it actually carries, capped
 * where a balance stops meaning anything, and lifted past that cap only for a
 * dust balance the cap would render as `0`.
 *
 * SC-177 — `500,000,000.00000000 XSHIBDROP` is twenty characters of which eight
 * carry no information, and at 390px it wraps to three lines. The trailing
 * zeros are not precision: a quantity that ends in them never had those digits.
 * `0.05 BTC` and `1,200 ADA` are what the rest of v3 already renders.
 */
export function quantityDecimals(value: Decimal.Value | null | undefined): number {
  const decimal = parse(value);
  if (decimal === null) return 0;
  const absolute = decimal.abs();
  // `Decimal` normalises on construction, so this is the digits the figure has
  // rather than the digits its string was written with: `500000000.00000000`
  // and `500000000` are the same number and both answer 0.
  const carried = absolute.dp();
  if (carried <= QUANTITY_DECIMALS) return carried;
  if (!vanishesAt(absolute, QUANTITY_DECIMALS)) return QUANTITY_DECIMALS;
  return Math.min(carried, extendedDecimals(absolute));
}

/**
 * A figure rounded to a fixed number of decimals, as a decimal string.
 *
 * `Decimal.toFixed`, so it rounds where the rest of the app rounds (HALF_UP,
 * never through a float) and never emits an exponent — `1e-7` in a spreadsheet
 * cell is text to some readers and a number to none. An unparseable input comes
 * back untouched: this is a formatting step, not a validation one, and blanking
 * a figure it did not understand would lose data that the caller can still see.
 */
export function roundToDecimals(value: Decimal.Value, decimals: number): string {
  const decimal = parse(value);
  if (decimal === null) return String(value);
  return decimal.toFixed(Math.max(decimals, 0));
}
