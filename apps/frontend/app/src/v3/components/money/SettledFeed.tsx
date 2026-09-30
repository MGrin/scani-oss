import { formatDate } from '@scani/shared';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { DataViewSkeleton } from '@scani/ui/v3/components/data-view/DataViewSkeleton';
import { DataViewGroupHeading } from '@scani/ui/v3/components/data-view/V3DataView';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PeekSheet } from '@scani/ui/v3/components/PeekSheet';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { usePeekRoute } from '@scani/ui/v3/hooks/usePeekRoute';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import { directionLabel } from '../../lib/money';
import { type HistoryEstimate, todayDateString } from '../../lib/paymentTotals';
import { V3_ROUTES } from '../../lib/routes';
import { BaseEquivalent } from '../BaseEquivalent';
import { type GroupTag, WithGroupTags } from './GroupTags';
import { upcomingPeekSpec } from './UpcomingFeed';

const NO_GROUPS: ReadonlyMap<string, GroupTag> = new Map();

type Occurrence = RouterOutputs['payments']['upcoming'][number];

interface SettledFeedProps {
  /** Already narrowed to the period and the filters, newest first. */
  occurrences: Occurrence[];
  vendorNameById: Map<string, string>;
  tokenSymbolById: Map<string, string>;
  rates: BaseCurrencyRates;
  query: V3QueryState;
  historyEstimates: ReadonlyMap<string, HistoryEstimate>;
  /** Which groups each occurrence is in, and their names and colours, for
   *  the tags after each row's cadence (SC-1408). */
  occurrenceGroups?: Readonly<Record<string, readonly string[]>>;
  groupById?: ReadonlyMap<string, GroupTag>;
}

/**
 * The Bills list once the status filter asks for history rather than what is
 * due (SC-1405): paid, missed, skipped, or all of them. It has no committed
 * figure, because nothing on it is still to pay, and it groups by the date
 * each one fell due without an Overdue heading, because a paid bill from last
 * month is not late.
 */
export function SettledFeed({
  occurrences,
  vendorNameById,
  tokenSymbolById,
  rates,
  query,
  historyEstimates,
  occurrenceGroups,
  groupById = NO_GROUPS,
}: SettledFeedProps) {
  const { t } = useTranslation();
  const loadingPhase = useDelayedLoading(query.isLoading);
  const peekRoute = usePeekRoute(V3_ROUTES.money);
  const today = todayDateString();

  const groups = useMemo(() => {
    const byDate = new Map<string, Occurrence[]>();
    for (const occurrence of occurrences) {
      const day = byDate.get(occurrence.dueDate) ?? [];
      day.push(occurrence);
      byDate.set(occurrence.dueDate, day);
    }
    return [...byDate.entries()];
  }, [occurrences]);

  const peeked = occurrences.find((occurrence) => occurrence.id === peekRoute.id) ?? null;
  const sheet = (
    <PeekSheet
      open={peekRoute.id !== null}
      onOpenChange={(next) => {
        if (!next) peekRoute.close();
      }}
      spec={
        peeked
          ? upcomingPeekSpec({
              t,
              occurrence: peeked,
              vendorNameById,
              tokenSymbolById,
              historyEstimates,
              today,
              onSettled: peekRoute.close,
            })
          : null
      }
      noun="payment"
      isLoading={query.isLoading}
    />
  );

  if (query.isError && occurrences.length === 0) {
    return (
      <QueryError
        error={query.error}
        subject={t('v3.money.upcoming.label')}
        onRetry={query.retry}
      />
    );
  }

  if (query.isLoading) {
    return (
      <>
        <LoadingRamp
          phase={loadingPhase}
          skeleton={<DataViewSkeleton />}
          label={t('v3.money.upcoming.label')}
          onRetry={query.retry}
        />
        {sheet}
      </>
    );
  }

  if (occurrences.length === 0) {
    return (
      <>
        <p className="px-4 text-body text-muted-foreground">{t('v3.money.settled.none')}</p>
        {sheet}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map(([dueDate, items]) => (
        <section key={dueDate} className="flex flex-col gap-1">
          <div className="px-4">
            <DataViewGroupHeading label={formatDate(dueDate)} count={items.length} />
          </div>
          <DataRowList>
            {items.map((occurrence) => {
              const vendorName =
                vendorNameById.get(occurrence.payment.vendorId) ?? t('v3.common.unknownVendor');
              const amount = occurrence.actualAmount ?? occurrence.expectedAmount;
              return (
                <DataRow
                  key={occurrence.id}
                  label={vendorName}
                  sublabel={t('v3.money.settled.rowMeta', {
                    direction: directionLabel(occurrence.payment.direction, t),
                    status: t(`v3.money.groups.statuses.${occurrence.status}`),
                  })}
                  value={
                    <Numeric
                      value={amount}
                      currency={tokenSymbolById.get(occurrence.payment.currencyTokenId) ?? 'USD'}
                    />
                  }
                  delta={
                    <WithGroupTags
                      groupIds={occurrenceGroups?.[occurrence.id]}
                      groupById={groupById}
                    >
                      <BaseEquivalent
                        amount={amount}
                        currencyTokenId={occurrence.payment.currencyTokenId}
                        rates={rates}
                      />
                    </WithGroupTags>
                  }
                  onClick={() => peekRoute.open(occurrence.id)}
                  aria-label={t('v3.money.upcoming.row', {
                    vendor: vendorName,
                    date: formatDate(occurrence.dueDate),
                  })}
                />
              );
            })}
          </DataRowList>
        </section>
      ))}
      {sheet}
    </div>
  );
}
