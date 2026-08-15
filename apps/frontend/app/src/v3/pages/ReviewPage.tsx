import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { loadingOnly } from '@scani/ui/v3/lib/query-state';
import { useReviewFeed } from '@/v2/hooks/useReviewFeed';
import { ReviewList } from '../components/review/ReviewList';

/**
 * Everything waiting on the user.
 *
 * `useReviewFeed` is imported from v2 unchanged, and the comment on it is the
 * reason: counting client-side over `jobs.listMine` looks equivalent and is
 * not — that query returns the 50 newest, so a pending review older than the
 * last 50 jobs is invisible to it. Measured against real data the badge read 0
 ***REMOVED***
 * badge and this page cannot disagree.
 */
export function ReviewPage() {
  const { items, isLoading } = useReviewFeed();

  return (
    <PageLayout measure="wide">
      <PageHeader title="Review" />
      <ReviewList items={items} query={loadingOnly(isLoading)} />
    </PageLayout>
  );
}
