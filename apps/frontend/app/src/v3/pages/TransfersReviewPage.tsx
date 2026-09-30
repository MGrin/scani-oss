import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { ReviewQueueHeader } from '../components/review/ReviewQueueHeader';
import { TransferReviewList } from '../components/review/TransferReviewList';

/**
 * Transfers Scani could not match to the other half of themselves (SC-150).
 *
 * Reached from the Review feed, which carries one row for the whole queue
 * rather than one per transfer. `/review` covers this path by the same
 * path-segment rule that makes Money cover the recurring list, so the nav
 * stays lit on Review while a reader works through it.
 *
 * The page is thin on purpose: what the queue *says about itself* — that
 * unanswered transfers are currently booked as gains, and how much that
 * amounts to — lives in the list's `summary`, because it has to count the
 * filtered set and only the list knows what that is.
 */
export function TransfersReviewPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.review.page.transfersTitle'));
  const query = trpc.transferReview.listPending.useQuery();

  return (
    <PageLayout measure="wide">
      <ReviewQueueHeader queue="transfers" view="pending" />
      <TransferReviewList items={query.data ?? []} query={mergeQueries(query)} />
    </PageLayout>
  );
}
