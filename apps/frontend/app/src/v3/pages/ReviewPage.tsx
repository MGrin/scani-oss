import {
  transitQuestionOf,
  UNPRICEABLE_AIRDROPS_REVIEW_KIND,
  untrackedArrivalQuestionOf,
} from '@scani/shared';
import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { usePeekRoute } from '@scani/ui/v3/hooks/usePeekRoute';
import { loadingOnly } from '@scani/ui/v3/lib/query-state';
import { useTranslation } from 'react-i18next';
import { useReviewFeed } from '@/v3/hooks/useReviewFeed';
import { ReviewList } from '../components/review/ReviewList';
import { isQueueRow, ReviewQueues } from '../components/review/ReviewQueues';
import { SettlementAnswersSheet } from '../components/review/SettlementAnswers';
import { TransitReviewSheet } from '../components/review/TransitReview';
import { UnpriceableAirdropsSheet } from '../components/review/UnpriceableAirdrops';
import { UntrackedArrivalSheet } from '../components/review/UntrackedArrivalReview';
import { V3_ROUTES } from '../lib/routes';

/**
 * Everything waiting on the user, and the way into the queues that hold the
 * rest of it (SC-849).
 *
 * `useReviewFeed` is imported from v2 unchanged, and the comment on it is the
 * reason: counting client-side over `jobs.listMine` looks equivalent and is
 * not — that query returns the 50 newest, so a pending review older than the
 * last 50 jobs is invisible to it. Measured against real data the badge read 0
 * while the feed held several. v3's home screen already reads the same hook, so the
 * badge and this page cannot disagree.
 *
 * This is the destination the nav entry and its badge have always pointed at,
 * and until SC-849 it was a flat feed that led nowhere: the two sub-queues
 * under it were reachable from a ledger note, a conditional home-screen note,
 * and — for `/review/balances` — nothing at all. `ReviewQueues` is what makes
 * the badge's promise good, and it reads the counts out of the feed this page
 * has already fetched rather than asking twice.
 *
 * A row for answers imported trades now explain opens its holding's sheet over
 * this page, at `/review/<holdingId>` (SC-1453), so closing it lands back on
 * the feed that led there. Wallet tokens nothing can price open theirs the
 * same way, at `/review/unpriceable-airdrops` (SC-1469), and a transfer still
 * travelling after 7 days at `/review/transit-<outflowId>_<destinationHoldingId>`
 * (SC-1675, SC-1684).
 */
export function ReviewPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.review.page.title'));
  const { items, isLoading } = useReviewFeed();
  const peek = usePeekRoute(V3_ROUTES.review);
  const transit = peek.id ? transitQuestionOf(peek.id) : null;
  const untrackedArrival = peek.id ? untrackedArrivalQuestionOf(peek.id) : null;

  return (
    <PageLayout measure="wide">
      <PageHeader title={t('v3.review.page.title')} />
      <ReviewQueues items={items} />
      <ReviewList
        items={items.filter((item) => !isQueueRow(item))}
        queueHasWork={items.some(isQueueRow)}
        query={loadingOnly(isLoading)}
      />
      {peek.id === UNPRICEABLE_AIRDROPS_REVIEW_KIND ? (
        <UnpriceableAirdropsSheet onClose={peek.close} />
      ) : transit ? (
        <TransitReviewSheet transit={transit} onClose={peek.close} />
      ) : untrackedArrival ? (
        <UntrackedArrivalSheet question={untrackedArrival} onClose={peek.close} />
      ) : peek.id ? (
        <SettlementAnswersSheet holdingId={peek.id} onClose={peek.close} />
      ) : null}
    </PageLayout>
  );
}
