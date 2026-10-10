import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { BillCalendarFeedService } from '../../calendar/bill-calendar-feed';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const feeds = () => Container.get(BillCalendarFeedService);

/** The URL a calendar app subscribes to. Shown once: only its hash is kept. */
function feedUrl(token: string): string {
  const base = (process.env.BACKEND_URL || 'http://localhost:3001').replace(/\/+$/, '');
  return `${base}/calendar/${token}.ics`;
}

/** The opt-in bills calendar feed (SC-1654), managed from Settings. */
export const billCalendarRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return feeds().status(dbUser.id);
  }),

  enable: protectedProcedure.mutation(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return { url: feedUrl(await feeds().enable(dbUser.id)) };
  }),

  rotate: protectedProcedure.mutation(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const token = await feeds().rotate(dbUser.id);
    if (!token) throw new TRPCError({ code: 'NOT_FOUND', message: 'The calendar feed is off' });
    return { url: feedUrl(token) };
  }),

  disable: protectedProcedure.mutation(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    await feeds().disable(dbUser.id);
    return { enabled: false };
  }),
});
