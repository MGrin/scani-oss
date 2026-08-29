import { BALANCE_GAP_REVIEW_KIND, type ReviewDetail, TRANSFER_REVIEW_KIND } from '@scani/shared';
import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import { ArrowLeftRight, ChevronRight, type LucideIcon, Scale } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { ReviewWireRow } from '../../lib/review-text';
import { BALANCE_GAP_REVIEW_PATH, TRANSFER_REVIEW_PATH } from '../../lib/routes';

/**
 * The queues that live under Review, always (SC-849).
 *
 * `/review` looked like the hub for these two and was not: it rendered the
 * feed alone, so `/review/transfers` was reachable only from the realized-PnL
 * ledger and a home-screen note that renders when it has something to say,
 * and `/review/balances` was reachable only by typing the URL. A screen
 * holding work the user has to do — an unanswered transfer is booked as a
 * gain until somebody says otherwise — sat behind links the app decided
 * whether to offer.
 *
 * **Rendered at every count, including zero**, which is the opposite of what
 * `AttentionRow` does on home and the difference is the whole point. Home
 * answers "is anything wrong", so an all-clear row there is chrome on every
 * visit. This is a hub: a destination that disappears when its queue empties
 * takes `answered` and `rules` with it, and those two exist precisely for the
 * reader whose queue is empty — 573 transfers were answered in one bulk pass
 * before splitting existed (SC-181), and the way back to them cannot be
 * conditional on there being a 574th.
 *
 * The counts come out of the feed the page has already loaded rather than
 * from two more queries. Both collectors emit one aggregate row per queue
 * carrying its count, so the number here and the number on the queue's own
 * page have one source — which is the disagreement `useReviewFeed` exists to
 * prevent.
 *
 * The feed below still carries those aggregate rows. Dropping them would make
 * a reader whose only pending work is a queue open a badged `/review` and
 * read "Nothing needs your review", which is the failure this ticket is
 * about wearing a different costume.
 */

interface ReviewQueuesProps {
  items: ReviewWireRow[];
}

interface QueueProps {
  to: string;
  icon: LucideIcon;
  title: string;
  detail: string;
}

function Queue({ to, icon: Icon, title, detail }: QueueProps) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3',
        'transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0 text-interactive" />
      <span className="min-w-0 flex-1">
        <span className="block text-label">{title}</span>
        <span className="block truncate text-caption text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn(MIRROR_IN_RTL, 'size-4 shrink-0 text-muted-foreground')}
      />
    </Link>
  );
}

/** The detail a queue's own aggregate row is carrying, or undefined once the
 *  queue has emptied and the collector has stopped emitting one. */
function queueDetail(items: ReviewWireRow[], kind: string): ReviewDetail | null | undefined {
  return items.find((item) => item.kind === kind)?.detail;
}

export function ReviewQueues({ items }: ReviewQueuesProps) {
  const { t } = useTranslation();
  const transferDetail = queueDetail(items, TRANSFER_REVIEW_KIND);
  const transfers = transferDetail?.code === 'unpairedTransfers' ? transferDetail.transfers : 0;
  const gapDetail = queueDetail(items, BALANCE_GAP_REVIEW_KIND);
  const gaps = gapDetail?.code === 'unexplainedBalanceChanges' ? gapDetail.changes : 0;

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Queue
        to={TRANSFER_REVIEW_PATH}
        icon={ArrowLeftRight}
        title={t('v3.review.page.transfersTitle')}
        detail={
          transfers === 0
            ? t('v3.review.queues.clear')
            : t('v3.review.item.unpairedTransfers', { count: transfers })
        }
      />
      <Queue
        to={BALANCE_GAP_REVIEW_PATH}
        icon={Scale}
        title={t('v3.review.page.balancesTitle')}
        detail={
          gaps === 0
            ? t('v3.review.queues.clear')
            : t('v3.review.item.unexplainedBalanceChanges', { count: gaps })
        }
      />
    </div>
  );
}
