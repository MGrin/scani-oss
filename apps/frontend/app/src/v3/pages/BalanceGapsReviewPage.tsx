import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { BalanceGapList } from '../components/review/BalanceGapList';

/**
 * "We think money moved here — tell us" (SC-501).
 *
 * Reached from the Review feed, which carries one row for the whole queue,
 * and sitting beside `/review/transfers` so somebody who already knows how
 * this product asks a question finds it where the other one is. `/review`
 * covers this path by the same path-segment rule, so the nav stays lit while
 * a reader works through it.
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
  const query = trpc.balanceGaps.listPending.useQuery();

  return (
    <PageLayout measure="wide">
      <PageHeader title={t('v3.review.page.balancesTitle')} />
      <p className="text-body text-muted-foreground">{t('v3.review.balances.intro')}</p>
      <BalanceGapList data={query.data} isLoading={query.isLoading} />
    </PageLayout>
  );
}
