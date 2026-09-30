import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { BalanceGapList } from '../components/review/BalanceGapList';
import { ReviewQueueHeader } from '../components/review/ReviewQueueHeader';

/**
 * "We think money moved here — tell us" (SC-501).
 *
 * Reached from the Review feed, which carries one row for the whole queue,
 * and sitting beside `/review/transfers` so somebody who already knows how
 * this product asks a question finds it where the other one is — with the
 * same header, the same list and the question in the same peek (SC-1433).
 * `/review` covers this path by the same path-segment rule, so the nav stays
 * lit while a reader works through it.
 *
 * What is at stake, and the reason the page exists at all: until somebody
 * answers, an untracked departure is booked as a loss and an untracked
 * arrival as a gain, because the returns engine has no transaction to
 * classify and must attribute the whole step to performance. Answering writes
 * a real `deposit` or `withdraw` at a date the owner gives, and the figure
 * corrects itself through the ordinary transaction path.
 */
export function BalanceGapsReviewPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.review.page.balancesTitle'));
  const query = trpc.balanceGaps.listPending.useQuery();

  return (
    <PageLayout measure="wide">
      <ReviewQueueHeader queue="balances" view="pending" />
      <BalanceGapList data={query.data} query={mergeQueries(query)} />
    </PageLayout>
  );
}
