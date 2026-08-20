import type { Decimal } from '@scani/shared';
import { Block } from '@scani/ui/v3/components/Block';
import { useTranslation } from 'react-i18next';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import {
  incomeCommitmentLabel,
  mergeCurrencyTotals,
  paidWindowLabel,
  unpricedNote,
} from '@/lib/vendorSpend';
import { ConvertedTotal } from '../ConvertedTotal';

/**
 * What the vendors on screen cost, over the rows actually shown.
 *
 * Two figures, never one. "Committed each month" is a claim about the future
 * — what the standing payments pointed at these vendors add up to — and
 * "Paid" is a claim about the past. Netting them, or showing either alone
 * under a label as vague as "spend", would answer a question the reader did
 * not ask with a number they cannot act on.
 *
 * Committed leads as the hero because it is the comparable one: it does not
 * depend on how long ago each vendor was set up, which is what makes the list
 * beneath it sortable in a way that means anything.
 */

interface VendorSpendSummaryProps {
  /** Outflow only — an income vendor contributes nothing to what is owed. */
  commitment: Map<string, Decimal>[];
  paidInWindow: Map<string, Decimal>[];
  /** Inflow commitments across the same rows (SC-78 §5). Rendered only when
   *  there is any, and never netted against the two above. */
  expectedIncome: Map<string, Decimal>[];
  windowMonths: number;
  unpricedCount: number;
  tokenSymbolById: Map<string, string>;
  rates: BaseCurrencyRates;
}

export function VendorSpendSummary({
  commitment,
  paidInWindow,
  expectedIncome,
  windowMonths,
  unpricedCount,
  tokenSymbolById,
  rates,
}: VendorSpendSummaryProps) {
  const { t } = useTranslation();
  const unpriced = unpricedNote(t, unpricedCount);
  const income = mergeCurrencyTotals(expectedIncome);

  return (
    <Block className="flex flex-col gap-4 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <ConvertedTotal
            label={t('v3.money.recurringSummary.committedEachMonth')}
            totals={mergeCurrencyTotals(commitment)}
            tokenSymbolById={tokenSymbolById}
            rates={rates}
          />
        </div>
        <div className="flex flex-col gap-2">
          <ConvertedTotal
            emphasis="default"
            label={paidWindowLabel(t, windowMonths)}
            totals={mergeCurrencyTotals(paidInWindow)}
            tokenSymbolById={tokenSymbolById}
            rates={rates}
          />
          {unpriced ? <p className="text-caption text-muted-foreground">{unpriced}</p> : null}
        </div>
      </div>

      {/* Below the two spend figures and behind a rule, not a third cell
          beside them: what a vendor pays you is not a smaller version of what
          you owe, and V3-47 forbids the two being read as a comparable pair.
          Absent entirely when there is no income among the rows on screen —
          an empty "Expected each month" would be the €0.00 this ticket is
          about, one level up. */}
      {income.size > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <ConvertedTotal
            emphasis="default"
            delta
            label={incomeCommitmentLabel(t)}
            totals={income}
            tokenSymbolById={tokenSymbolById}
            rates={rates}
          />
          <p className="text-caption text-muted-foreground">
            {t('v3.money.vendorSpend.notSubtracted')}
          </p>
        </div>
      ) : null}
    </Block>
  );
}
