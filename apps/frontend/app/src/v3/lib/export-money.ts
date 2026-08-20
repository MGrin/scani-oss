import { type ExportCell, exportMoney } from '@scani/ui/v3/lib/export/cell';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { convertAmountToBase } from './paymentTotals';

/**
 * A money cell that carries what the screen carries.
 *
 * On a multi-currency surface a row does not show one figure, it shows two:
 * `£42.50` and, under it, `≈ €49.73` — the base-currency equivalent
 * `<BaseEquivalent>` draws. An export that took only the first would drop the
 * column the reader can actually total; one that took only the second would
 * drop the figure that matches their bank statement. So both go in the file,
 * `workbook.ts` puts them in two columns, and the converted one's header says
 * it was converted.
 *
 * Routed through `convertAmountToBase` — SC-60's single rate path — rather than
 * re-deriving a rate here. There is exactly one place in this app that turns an
 * amount into base currency, and an export quietly becoming the second would be
 * the first way the file and the screen could disagree.
 */
export function exportMoneyInBase(
  amount: string | null | undefined,
  currencyTokenId: string,
  symbol: string,
  rates: BaseCurrencyRates
): ExportCell {
  const converted = amount ? convertAmountToBase(amount, currencyTokenId, rates) : null;
  return exportMoney(
    amount ?? null,
    symbol,
    converted
      ? {
          value: converted.amount.toString(),
          currency: rates.baseSymbol,
        }
      : undefined
  );
}
