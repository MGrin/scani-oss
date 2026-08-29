/**
 * The result of asking for a price in some other currency.
 *
 * There is deliberately no member carrying a bare number. A caller
 * cannot read a price out of this without having matched `ok` first,
 * so the three ways this provider used to publish a figure whose
 * currency it had not established — keeping the native value, storing
 * `'0'`, and skipping conversion entirely when `exchangeInfo` was
 * absent — are unrepresentable rather than guarded against one call
 * site at a time.
 *
 * The shape this replaces returned `string`, with `'0'` meaning
 * "failed". An in-band sentinel makes the failure indistinguishable
 * from a legitimate value and leaves every call site to remember a
 * rule; four call sites remembered it three different ways, and the
 * two that kept the native value published Toronto-listed CAD prices
 * as USD — ~37% high, and indistinguishable from a real price (SC-847).
 */
export type ConversionOutcome =
  | { readonly ok: true; readonly price: string }
  | { readonly ok: false; readonly reason: string };
