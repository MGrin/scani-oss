import { Button } from '@scani/ui/ui/button';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { AnsweredTransferList } from '../components/review/AnsweredTransferList';
import { TRANSFER_REVIEW_PATH } from '../lib/routes';

/**
 * Transfers you have already answered (SC-181).
 *
 * The counterpart to the queue, and deliberately not part of it: the queue's
 * count reaching zero is the only feedback that working through it is
 * finishing, and a list holding every answered row can never reach zero. See
 * `TRANSFER_ANSWERED_PATH` for why it exists at all — 573 answers were given
 * in one bulk pass before an answer could apply to part of a transaction.
 */
export function AnsweredTransfersPage() {
  const query = trpc.transferReview.listAnswered.useQuery();

  return (
    <PageLayout measure="wide">
      <PageHeader
        title="Answered transfers"
        action={
          <Button asChild variant="outline">
            <Link to={TRANSFER_REVIEW_PATH}>Back to the queue</Link>
          </Button>
        }
      />
      <AnsweredTransferList items={query.data ?? []} query={mergeQueries(query)} />
    </PageLayout>
  );
}
