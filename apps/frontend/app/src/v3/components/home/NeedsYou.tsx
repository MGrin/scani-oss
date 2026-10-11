import { reviewBadgeCount } from '@scani/shared';
import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import { Button } from '@scani/ui/ui/button';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { peekOpenState, peekPath } from '@scani/ui/v3/lib/peek';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { INCOME_HORIZON_DAYS, splitByDirection } from '../../lib/money';
import { type NeedsYouRow, needsYouRows } from '../../lib/needs-you';
import { todayDateString } from '../../lib/paymentTotals';
import { V3_ROUTES } from '../../lib/routes';

const ROW = cn(
  'flex min-h-11 items-center gap-3 px-4 py-2.5',
  'transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
);

/**
 * What asks the person to act, under the hero (SC-1669). It replaces the
 * review-only `AttentionRow`, and unlike it says so when nothing does: an
 * absent strip and a strip that could not look read the same otherwise.
 *
 * The bills query is the one Upcoming bills reads, so this costs no request.
 */
export function NeedsYou() {
  const { t } = useTranslation();
  const review = trpc.review.listPending.useQuery();
  const payments = trpc.payments.upcoming.useQuery({ days: INCOME_HORIZON_DAYS });
  const today = todayDateString();
  const rows = needsYouRows({
    reviewCount: review.data ? reviewBadgeCount(review.data) : null,
    bills: payments.data ? splitByDirection(payments.data).bills : null,
    today,
  });

  const shell = 'overflow-hidden rounded-lg border border-border bg-surface-1';
  // A failed source is said out loud beside whatever did answer: a strip that
  // listed only the review row would read as "no bills are late" when nobody
  // could look.
  const failed = [review, payments].filter((query) => query.isError && query.data === undefined);
  const pending = [review, payments].some((query) => query.data === undefined && !query.isError);
  const failure =
    failed.length > 0 ? (
      <div role="alert" className="flex items-center gap-3 px-4 py-2.5">
        <AlertTriangle aria-hidden="true" className="size-5 shrink-0 text-loss" />
        <span className="min-w-0 flex-1 text-label">
          {t(failed.length === 2 ? 'v3.home.needsYou.failed' : 'v3.home.needsYou.partlyFailed')}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            for (const query of failed) void query.refetch();
          }}
        >
          {t('v3.home.needsYou.retry')}
        </Button>
      </div>
    ) : null;

  if (rows.length === 0) {
    if (failure) return <div className={shell}>{failure}</div>;
    // Clear is a claim about two answers, so it waits for both.
    if (pending) return <Skeleton aria-hidden="true" className="h-11 w-full rounded-lg" />;
    return (
      <div className={cn(shell, 'flex items-center gap-3 px-4 py-2.5')}>
        <CheckCircle2 aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <span className="text-label text-muted-foreground">{t('v3.home.needsYou.clear')}</span>
      </div>
    );
  }

  return (
    <ul className={cn(shell, 'divide-y divide-border')}>
      {rows.map((row) => (
        <li key={row.kind}>
          <Link className={ROW} to={target(row)} state={linkState(row)}>
            {row.kind === 'review' ? (
              // `--interactive` rather than a warning hue: the accent marks
              // what you can act on, and amber would read as "stale price".
              <ClipboardCheck aria-hidden="true" className="size-5 shrink-0 text-interactive" />
            ) : (
              <CalendarClock
                aria-hidden="true"
                className={cn(
                  'size-5 shrink-0',
                  row.kind === 'overdue' ? 'text-loss' : 'text-interactive'
                )}
              />
            )}
            <span className="min-w-0 flex-1 text-label">
              {t(`v3.home.needsYou.${row.kind}`, { count: row.count })}
            </span>
            <ChevronRight
              aria-hidden="true"
              className={cn(MIRROR_IN_RTL, 'size-4 shrink-0 text-muted-foreground')}
            />
          </Link>
        </li>
      ))}
      {failure ? <li>{failure}</li> : null}
    </ul>
  );
}

function target(row: NeedsYouRow): string {
  if (row.kind === 'review') return V3_ROUTES.review;
  return row.onlyId ? peekPath(V3_ROUTES.money, row.onlyId) : V3_ROUTES.money;
}

function linkState(row: NeedsYouRow) {
  return row.kind !== 'review' && row.onlyId ? peekOpenState(V3_ROUTES.money) : undefined;
}
