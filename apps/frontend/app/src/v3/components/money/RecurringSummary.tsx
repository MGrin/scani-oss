import { Block } from '@scani/ui/v3/components/Block';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import { asPaymentIntervalUnit, sumMonthlyEquivalentByCurrency } from '@/v2/lib/paymentTotals';
import { ConvertedTotal } from '../ConvertedTotal';

/**
 * What the recurring list adds up to, over the rows actually shown.
 *
 * It is a `summary` on the data view rather than a header on the page because
 * it must see the *filtered* set: narrowing to one vendor and reading the whole
 * book's commitment underneath it is a wrong number, sitting next to a count
 * line that says the list is narrowed. The count line answers what is being
 * added up, so a figure that shrinks with the filter reads as the answer to
 * "these", not as a claim about everything.
 *
 * Across currencies it is one figure, in the reader's base currency:
 * `<ConvertedTotal>` owns the conversion and the sentence that admits to it.
 *
 * Within that set, only what is still running counts. A paused or ended payment
 * is not a commitment, and counting it would make the figure disagree with the
 * bank. Filter to `paused` and the figure is zero — which is the honest reading
 * of "what do these rows commit me to each month".
 */

type PaymentRow = RouterOutputs['payments']['list'][number];

interface RecurringSummaryProps {
  payments: readonly PaymentRow[];
  tokenSymbolById: Map<string, string>;
  rates: BaseCurrencyRates;
}

export function RecurringSummary({ payments, tokenSymbolById, rates }: RecurringSummaryProps) {
  const commitment = sumMonthlyEquivalentByCurrency(
    payments
      .filter((payment) => payment.status === 'active' && payment.direction === 'outflow')
      .map((payment) => ({
        expectedAmount: payment.expectedAmount,
        intervalUnit: asPaymentIntervalUnit(payment.intervalUnit),
        intervalCount: payment.intervalCount,
        currencyTokenId: payment.currencyTokenId,
      }))
  );

  return (
    <Block className="flex flex-col gap-2 p-4">
      <ConvertedTotal
        label="Committed each month"
        totals={commitment}
        tokenSymbolById={tokenSymbolById}
        rates={rates}
      />
    </Block>
  );
}
