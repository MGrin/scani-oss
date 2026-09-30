import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { AnsweredBalanceGapList } from '../components/review/AnsweredBalanceGapList';
import { ReviewQueueHeader } from '../components/review/ReviewQueueHeader';

/** The balance queue's answered view, and where an answer is undone (SC-1433). */
export function BalanceGapsAnsweredPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.review.balances.answeredTitle'));
  const query = trpc.balanceGaps.listAnswered.useQuery();

  return (
    <PageLayout measure="wide">
      <ReviewQueueHeader queue="balances" view="answered" />
      <AnsweredBalanceGapList items={query.data ?? []} query={mergeQueries(query)} />
    </PageLayout>
  );
}
