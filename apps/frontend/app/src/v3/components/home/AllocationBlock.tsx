import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { TruncatedText } from '@scani/ui/v3/components/TruncatedText';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { CHART_OTHER_COLOR, foldAllocation } from '@scani/ui/v3/lib/chart';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useViewPreference } from '../../hooks/useViewPreference';
import {
  ALLOCATION_DIMENSION_KEYS,
  ALLOCATION_DIMENSIONS,
  allocationHref,
  allocationItems,
  DEFAULT_ALLOCATION_DIMENSION,
  foldedAllocationItems,
} from '../../lib/home';
import { V3_ROUTES } from '../../lib/routes';
import { VIEW_PREFERENCE_KEYS } from '../../lib/view-preference';
import { AllocationBar } from '../charts/AllocationBar';
import { DisclosureButton } from './DisclosureButton';

/**
 * "What is it in" — with v2's four cuts restored.
 *
 * The dimension filter is information: type, institution, account and group are
 * four different answers, and V3-09 shipped only the first. The **chart-type**
 * filter is not restored. v2 also offers donut / bar / list, which is three
 * renderings of one dataset; v3's chart language has a single answer for
 * share-of-total (`AllocationBar`, §2.1) and offering the reader a choice of
 * how to draw it is a preference toggle wearing the clothes of a data control.
 *
 * The fold is the one real cost. `foldAllocation` stops at six segments because
 * slots 7 and 8 carry `--interactive`'s and `--loss`'s hues, so a seventh
 * coloured part would read as a button or as a falling figure — a constraint on
 * colour, which raising the cap cannot buy its way out of. Cut by account this
 * portfolio has twenty parts. So the bar keeps six and the remainder is offered
 * in full behind a disclosure, uncoloured: nothing is hidden, and no slot is
 * spent to show it.
 */

/**
 * One row of the disclosed tail — the parts the bar folded into "Other".
 *
 * Same three zones as `AllocationBar`'s list and the same link treatment, so
 * opening the disclosure does not drop the reader onto a run of rows that read
 * like the ones above and cannot be tapped. `href` is null for a part that
 * stands for no record (an ungrouped share), which stays inert.
 */
function FoldedRow({
  label,
  href,
  children,
}: {
  label: string;
  href: string | null;
  children: ReactNode;
}) {
  const zones = (
    <>
      {/* The fold's own colour, not a seventh slot: every one of these rows is
          part of the same "Other" segment. */}
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-sm"
        style={{ backgroundColor: CHART_OTHER_COLOR }}
      />
      <TruncatedText className="truncate text-label text-muted-foreground">{label}</TruncatedText>
      {children}
    </>
  );

  const columns = 'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-1';

  return (
    <li>
      {href === null ? (
        <span className={columns}>{zones}</span>
      ) : (
        <Link
          to={href}
          className={cn(
            columns,
            '-mx-2 rounded-md px-2',
            'transition-colors duration-fast ease-emphasized hover:bg-surface-hover active:bg-surface-hover',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
        >
          {zones}
        </Link>
      )}
    </li>
  );
}

export function AllocationBlock() {
  const { t } = useTranslation();
  // The cut survives a reload (V3-48): it is the one thing on this screen the
  // reader sets *about* the screen, and v2 has remembered it since the start.
  const [dimension, setDimension] = useViewPreference(
    VIEW_PREFERENCE_KEYS.homeAllocationDimension,
    DEFAULT_ALLOCATION_DIMENSION,
    ALLOCATION_DIMENSION_KEYS
  );
  const [expanded, setExpanded] = useState(false);

  const allocation = trpc.dashboard.getAssetAllocation.useQuery({ dimension });
  const loadingPhase = useDelayedLoading(allocation.isLoading);

  const currency = allocation.data?.baseCurrency ?? 'USD';
  const items = allocationItems(allocation.data?.items ?? [], dimension);
  const segments = foldAllocation(items);
  const folded = foldedAllocationItems(items, segments);

  const labelKey =
    ALLOCATION_DIMENSIONS.find((option) => option.key === dimension)?.labelKey ??
    'v3.home.allocation.dimension.tokenType';

  return (
    <Block>
      <BlockHeader
        title={t('v3.home.allocation.title')}
        href={V3_ROUTES.holdings}
        action={t('nav.holdings')}
      />
      <div className="flex flex-col gap-4 px-4 pb-4">
        <Segmented
          value={dimension}
          onValueChange={(value) => {
            setDimension(value);
            // The disclosure is about *this* cut's tail. Carrying it across a
            // dimension change would open the next cut on a list the reader
            // never asked to see, of parts with different names.
            setExpanded(false);
          }}
          aria-label={t('v3.home.allocation.cutBy')}
        >
          {ALLOCATION_DIMENSIONS.map((option) => (
            <SegmentedItem key={option.key} value={option.key} className="px-2 text-caption">
              {t(option.labelKey)}
            </SegmentedItem>
          ))}
        </Segmented>

        {allocation.data === undefined ? (
          // The ramp rather than a bare skeleton: switching cut refetches, and
          // a placeholder at 0ms is the flash V3-16 exists to remove — most
          // switches come back from cache.
          <LoadingRamp
            phase={loadingPhase}
            skeleton={
              <div className="flex flex-col gap-3">
                <Skeleton className="h-2 w-full rounded-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            }
            label={t('v3.home.allocation.loadingLabel')}
            onRetry={() => void allocation.refetch()}
          />
        ) : segments.length === 0 ? (
          <p className="text-body text-muted-foreground">{t('v3.home.allocation.empty')}</p>
        ) : (
          <>
            {/* Every row reaches the holdings behind its share (SC-74). The
                whole block used to be inert text on the app's first screen:
                a reader could see that 38% of his money was at one institution
                and had no way from here to ask which positions those were. */}
            <AllocationBar
              items={items}
              currency={currency}
              label={t('v3.home.allocation.barLabel', { dimension: t(labelKey) })}
              itemHref={(segment) => allocationHref(dimension, segment.key)}
            />

            {folded.length > 0 ? (
              <div className="flex flex-col gap-2">
                <DisclosureButton
                  expanded={expanded}
                  onToggle={() => setExpanded((open) => !open)}
                  label={t('v3.home.disclosure.theNInOther', { count: folded.length })}
                />

                {/* The list is flush, like the bar's own above it and for the
                    same reason: these rows are 44px controls on touch, and 8px
                    on top of that reads as floating lines rather than a list. */}
                {expanded ? (
                  <ul className="flex flex-col">
                    {folded.map((item) => (
                      <FoldedRow
                        key={item.key}
                        label={item.label}
                        href={allocationHref(dimension, item.key)}
                      >
                        <Numeric
                          value={item.value}
                          currency={currency}
                          compact
                          className="text-label text-muted-foreground"
                        />
                      </FoldedRow>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Block>
  );
}
