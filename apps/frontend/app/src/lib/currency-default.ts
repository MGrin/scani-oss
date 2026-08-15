/**
 * When the payment forms may fill the currency with the user's base currency.
 *
 * Both forms guarded that on `currency === null` while also depending on it,
 * which made "never chosen" and "just cleared" the same state: pressing Change
 * cleared the field, the effect re-ran, and the base currency was reinstated
 * before a frame went out — so the button did nothing at all (V3-50). The
 * default is a one-shot. Once it has had its chance the field is the user's,
 * empty or not.
 *
 * `spend` rather than `fill` covers the invoice-prefill route, where the
 * extraction has already chosen a currency by the time the base currency
 * resolves: nothing to write, but the default is still spent, or clearing an
 * invoice's currency would hand it the base currency instead of a search field.
 */
export type BaseCurrencyDefaultAction =
  /** Do nothing: already spent, an edit form, or the base currency is still loading. */
  | 'wait'
  /** Latch only: something else already filled the field. */
  | 'spend'
  /** Latch and write the base currency in. */
  | 'fill';

export function baseCurrencyDefaultAction(state: {
  isEdit: boolean;
  alreadySpent: boolean;
  baseCurrencyResolved: boolean;
  currency: unknown;
}): BaseCurrencyDefaultAction {
  if (state.isEdit || state.alreadySpent) return 'wait';
  if (!state.baseCurrencyResolved) return 'wait';
  return state.currency ? 'spend' : 'fill';
}
