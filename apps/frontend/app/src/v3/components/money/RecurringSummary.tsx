import { Block } from '@scani/ui/v3/components/Block';
import { useTranslation } from 'react-i18next';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import {
  asPaymentIntervalUnit,
  type HistoryEstimate,
  sumMonthlyEquivalentByCurrency,
  unestimatedCount,
} from '../../lib/paymentTotals';
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
 *
 * ## The denominator this figure did not have (SC-625)
 *
 * A variable payment with no estimate has always been skipped here, silently.
 * That is the same gap SC-461 found in the projection and closed by printing a
 * count — and the count is what makes a skip honest, because a total with
 * nothing beside it reads as complete whether or not it is. So the line below
 * is not decoration attached to the new option: it is the thing that was
 * missing before the option existed, and it stays after it is switched on for
 * whatever the option cannot reach.
 *
 * `historyEstimates` comes from the FORECAST payload, not from a second
 * computation here. `payments.list` carries no occurrence data, so there is
 * nothing to compute from — and reading the projection's own answer is what
 * makes this figure and the projection's agree by construction rather than by
 * being kept in step.
 */

type PaymentRow = RouterOutputs['payments']['list'][number];

interface RecurringSummaryProps {
  payments: readonly PaymentRow[];
  tokenSymbolById: Map<string, string>;
  rates: BaseCurrencyRates;
  /** From `payments.forecast`. Empty when it has not arrived — see the doc. */
  historyEstimates: ReadonlyMap<string, HistoryEstimate>;
}

export function RecurringSummary({
  payments,
  tokenSymbolById,
  rates,
  historyEstimates,
}: RecurringSummaryProps) {
  const { t } = useTranslation();
  const counted = payments
    .filter((payment) => payment.status === 'active' && payment.direction === 'outflow')
    .map((payment) => ({
      expectedAmount: payment.expectedAmount,
      intervalUnit: asPaymentIntervalUnit(payment.intervalUnit),
      intervalCount: payment.intervalCount,
      currencyTokenId: payment.currencyTokenId,
      historyEstimate: historyEstimates.get(payment.id) ?? null,
    }));

  const commitment = sumMonthlyEquivalentByCurrency(counted);
  const missing = unestimatedCount(counted);
  const estimated = counted.filter((payment) => payment.expectedAmount === null).length - missing;

  return (
    <Block className="flex flex-col gap-2 p-4">
      <ConvertedTotal
        label={t('v3.money.recurringSummary.committedEachMonth')}
        totals={commitment}
        tokenSymbolById={tokenSymbolById}
        rates={rates}
      />
      {estimated > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.recurringSummary.estimatedFromHistory', { count: estimated })}
        </p>
      ) : null}
      {missing > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.recurringSummary.notCounted', { count: missing })}
        </p>
      ) : null}
    </Block>
  );
}
