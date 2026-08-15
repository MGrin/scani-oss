import { formatCurrency, formatNumber, moneyDecimals, quantityDecimals } from '@scani/shared';

/**
 * The two figures the v2 surface renders that a fixed precision gets wrong:
 * a token balance and a token price.
 *
 * Both rules live in `@scani/shared/format/precision` and are the ones v3
 * already asks (SC-177/179). What is here is only the pairing of a rule with
 * the formatter it governs, so a call site names the *kind* of figure it holds
 * instead of restating how to round it — the restating is what let
 * `maximumFractionDigits: 8`, `decimals: 4` and a bare `toLocaleString()` give
 * three answers for one number on one screen.
 *
 * This file previously held a copy of `formatCurrency` / `formatCompact` that
 * nothing imported.
 */

/**
 * A unit count, at the decimals it actually carries (SC-184).
 *
 * A bare `toLocaleString()` is wrong twice over here: it follows the device
 * locale, so `0.5` becomes `0,5` beside a value of `€30,617.28` where the comma
 * groups instead; and it caps at three fraction digits, so a dust balance of
 * `0.00007715` renders `0` — a claim that the position is empty rather than
 * that it is small.
 */
export function formatQuantity(value: number | string): string {
  return formatNumber(value, { decimals: quantityDecimals(value) });
}

/**
 * Money whose magnitude can fall below a cent — a token price, or a value
 * derived from one (SC-185).
 *
 * Two decimals unless two would print a figure that is not zero as `0.00`:
 * `4,200,000` units at `€0.00` is a row whose own multiplication contradicts
 * the `€324.03` printed beside it. Fiat a human typed cannot go sub-cent, so
 * the payments and vault surfaces keep calling `formatCurrency` directly.
 *
 * Deltas keep their fixed two on purpose: a gain of `-0.004` extended until it
 * is non-zero would be reported as a loss the reader cannot see.
 */
export function formatMoney(value: number | string | null | undefined, currency: string): string {
  if (value === null || value === undefined) return formatCurrency(value, currency);
  return formatCurrency(value, currency, { decimals: moneyDecimals(value) });
}

/**
 * The same rule as `formatMoney` for the two surfaces that print a currency
 * *code* beside the figure rather than passing it to `Intl` — the custom-token
 * list and its price-edit dialog. `Intl` rejects a code it doesn't know, and
 * the tokens these screens exist for are exactly the ones it doesn't.
 */
export function formatMoneyPlain(value: number | string): string {
  return formatNumber(value, { decimals: moneyDecimals(value) });
}
