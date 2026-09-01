import { reviewBadgeCount } from '@scani/shared';
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
 ***REMOVED***
 ***REMOVED***
 * possible wrong answer here, because the badge is the only thing that
 * tells anyone the review page has contents.
 *
 * `review.listPending` filters server-side across all jobs, so the badge
 * and the page cannot disagree.
 *
 * **`count` is not `items.length`, and that is the point** (SC-860). Two
 * collectors emit one row for a whole unbounded queue — unpaired transfers,
 * unexplained balance changes — so a user with 200 of the first and 30 of the
 * second had a feed of two rows and a badge reading `2`. Each row carries
 * `represents`; `reviewBadgeCount` sums it. One query and one hook still, so
 * the two numbers are two questions about the same answer rather than two
 * answers that can drift.
 */
export function useReviewFeed(): UseReviewFeedResult {
  const query = trpc.review.listPending.useQuery();
  const items = query.data ?? [];
  return { items, count: reviewBadgeCount(items), isLoading: query.isLoading };
}
