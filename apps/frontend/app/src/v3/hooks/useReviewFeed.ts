import { type RouterOutputs, trpc } from '@/lib/trpc';

type ReviewFeedItem = RouterOutputs['review']['listPending'][number];

export interface UseReviewFeedResult {
  items: ReviewFeedItem[];
  count: number;
  isLoading: boolean;
}

/**
 * The single source for "how many things need the user's attention".
 *
 * Counting client-side over `jobs.listMine` looks equivalent and is not:
 * that query is paginated (50 newest), so a pending review older than the
 * last 50 jobs is invisible to it. Measured against real data — an account
 * with 295 completed-unactioned jobs whose only 3 reviewable ones were 5
 * weeks old — the badge read 0 while the feed held 3. Zero is the worst
 * possible wrong answer here, because the badge is the only thing that
 * tells anyone the review page has contents.
 *
 * `review.listPending` filters server-side across all jobs, so the badge
 * and the page cannot disagree.
 */
export function useReviewFeed(): UseReviewFeedResult {
  const query = trpc.review.listPending.useQuery();
  const items = query.data ?? [];
  return { items, count: items.length, isLoading: query.isLoading };
}
