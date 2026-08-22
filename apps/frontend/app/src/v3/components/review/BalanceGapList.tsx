import type { BalanceGapList as BalanceGapListDto } from '@scani/shared';
import { Block } from '@scani/ui/v3/components/Block';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { BalanceGapAnswer } from './BalanceGapAnswer';

/**
 * Balance changes the ledger cannot explain (SC-501).
 *
 * A card per gap rather than a `V3DataView`, and the reason is the answer
 * control: this list is not something you sort and filter, it is a short
 * sequence of questions each carrying its own three-way control and a date
 ***REMOVED***
 * shrinks as it is worked.
 *
 * ## The line that says what was left out
 *
 * `examined` and `suppressed` are printed, not logged. A queue of 37 drawn
 * from 258 candidates is trustworthy in a way that a queue of 37 drawn from
 ***REMOVED***
 * is a query that silently misses rows, which is indistinguishable from a
 * suppression rule doing its job unless the counts are on screen. The reader
 * is also the only person who knows whether the thing that was suppressed
 * mattered.
 */

interface BalanceGapListProps {
  data: BalanceGapListDto | undefined;
  isLoading: boolean;
}

export function BalanceGapList({ data, isLoading }: BalanceGapListProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  // The two reads an answer moves, invalidated together: the queue itself and
  // the review feed whose badge counts it. A badge that still says 37 over a
  // queue of 12 is the disagreement `useReviewFeed` exists to prevent.
  const onAnswered = async () => {
    await Promise.all([
      utils.balanceGaps.listPending.invalidate(),
      utils.review.listPending.invalidate(),
    ]);
  };

  if (isLoading) return <p className="text-body">{t('v3.review.balances.loading')}</p>;
  if (!data) return null;

  const suppressedTotal = Object.values(data.suppressed).reduce((sum, n) => sum + n, 0);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-label text-muted-foreground">
        {t('v3.review.balances.examined', {
          shown: data.items.length,
          examined: data.examined,
          suppressed: suppressedTotal,
        })}
      </p>

      {data.items.length === 0 ? (
        <p className="text-body">{t('v3.review.balances.empty')}</p>
      ) : null}

      {data.items.map((gap) => (
        <Block key={gap.observationId} className="flex flex-col gap-3 p-4">
          <div className="flex items-baseline justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-body font-medium">
                {gap.accountName
                  ? t('v3.review.balances.subject', {
                      account: gap.accountName,
                      symbol: gap.tokenSymbol,
                    })
                  : gap.tokenSymbol}
              </span>
              <span className="text-label text-muted-foreground">
                {t('v3.review.balances.between', {
                  from: new Date(gap.from).toLocaleDateString(),
                  to: new Date(gap.to).toLocaleDateString(),
                })}
              </span>
            </div>
            {/* Signed and toned: money arriving and money leaving are
                different questions and the reader should not have to read the
                two balances to tell which one they are being asked. */}
            <Numeric value={gap.drift} format="plain" delta decimals={2} className="text-figure" />
          </div>

          <p className="text-label text-muted-foreground">
            {t('v3.review.balances.balances', {
              previous: gap.previousBalance,
              current: gap.balance,
              symbol: gap.tokenSymbol,
            })}
            {gap.transactionsApplied > 0
              ? ` ${t('v3.review.balances.partlyExplained', { count: gap.transactionsApplied })}`
              : ''}
          </p>

          <BalanceGapAnswer gap={gap} onAnswered={onAnswered} />
        </Block>
      ))}
    </div>
  );
}
