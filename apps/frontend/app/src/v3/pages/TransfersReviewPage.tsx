import { Button } from '@scani/ui/ui/button';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { TransferReviewList } from '../components/review/TransferReviewList';
import { TRANSFER_ANSWERED_PATH } from '../lib/routes';

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
  const query = trpc.transferReview.listPending.useQuery();

  return (
    <PageLayout measure="wide">
      {/* The route back to an answer already given (SC-181) — an action rather
          than a tab, because this page's count reaching zero is the feedback
          that working through it is finishing, and a view that also holds
          every answered row can never reach zero. */}
      <PageHeader
        title="Transfers to confirm"
        action={
          <Button asChild variant="outline">
            <Link to={TRANSFER_ANSWERED_PATH}>Answered</Link>
          </Button>
        }
      />
      <TransferReviewList items={query.data ?? []} query={mergeQueries(query)} />
    </PageLayout>
  );
}
