import { Skeleton } from '@scani/ui/ui/skeleton';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import { useGroupBillsCommitted } from '../../hooks/useGroupBillsCommitted';
import { convertTotalsToBase } from '../../lib/paymentTotals';

/**
 * The group page's "Bills committed" figure at row size, for Home (SC-1437).
 * Same hook, same conversion, and the same two rules as `ConvertedTotal`: a
 * figure still waiting on rates is not shown, and a part no rate covers is
 * named beside the figure rather than dropped.
 */
export function GroupBillsFigure({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const { committed, tokenSymbolById, rates, loading } = useGroupBillsCommitted(groupId);
  const total = convertTotalsToBase(committed, rates);

  if (loading || total.pending) {
    return (
      <>
        <Skeleton aria-hidden="true" className="inline-block h-4 w-16 align-middle" />
        <span className="sr-only" role="status">
          {t('v3.common.convertedTotal.working')}
        </span>
      </>
    );
  }

  const leftOut = [...total.unconverted, ...total.unknown];
  return (
    <span>
      <Numeric value={total.amount.toString()} currency={rates.baseSymbol} compact />
      {leftOut.map((part) => (
        <span key={part.currencyTokenId} className="text-muted-foreground">
          {' + '}
          <Numeric
            value={part.amount.toString()}
            currency={tokenSymbolById.get(part.currencyTokenId) ?? rates.baseSymbol}
            compact
          />
        </span>
      ))}
    </span>
  );
}
