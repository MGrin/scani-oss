/**
 * Review feed router.
 *
 * One endpoint, deliberately: the feed is a read-model and every action a
 * user can take on an item happens on that item's own surface (a job's
 * detail page stamps `action_taken_at` through the jobs router). Adding
 * mutations here would put review state in two places.
 */

import { ReviewFeedService } from '@scani/domain/services';
import Container from 'typedi';
import { protectedProcedure, router } from '../trpc';

export const reviewRouter = router({
  listPending: protectedProcedure.query(async ({ ctx }) => {
    const items = await Container.get(ReviewFeedService).listPending(ctx.userId);
    return items.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    }));
  }),
});
