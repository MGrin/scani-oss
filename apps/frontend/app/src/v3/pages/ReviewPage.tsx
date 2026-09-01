import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { loadingOnly } from '@scani/ui/v3/lib/query-state';
import { useTranslation } from 'react-i18next';
import { useReviewFeed } from '@/v3/hooks/useReviewFeed';
import { ReviewList } from '../components/review/ReviewList';
import { ReviewQueues } from '../components/review/ReviewQueues';

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
 */
export function ReviewPage() {
  const { t } = useTranslation();
  const { items, isLoading } = useReviewFeed();

  return (
    <PageLayout measure="wide">
      <PageHeader title={t('v3.review.page.title')} />
      <ReviewQueues items={items} />
      <ReviewList items={items} query={loadingOnly(isLoading)} />
    </PageLayout>
  );
}
