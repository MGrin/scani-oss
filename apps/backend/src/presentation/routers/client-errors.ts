import { db } from '@scani/core/database/connection';
import { clientErrors } from '@scani/core/database/schema';
import { createComponentLogger } from '@scani/core/utils/logger';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc';

const logger = createComponentLogger('router:client-errors');

/**
 * Client-side error reporting endpoint.
 *
 * The V2 ErrorBoundary posts to this on every caught exception. Without an
 * external error-reporting service, this is the only way operators learn
 * about frontend crashes. Size limits on every field prevent an abusive
 * client from filling the DB with garbage.
 *
 * Intentionally a public procedure: if auth is the thing that's broken,
 * we still want the error report.
 */

const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 8000;
const MAX_COMPONENT_STACK_LEN = 8000;
const MAX_ROUTE_LEN = 500;
const MAX_USER_AGENT_LEN = 500;
const MAX_APP_VERSION_LEN = 50;

const reportInput = z.object({
  message: z.string().min(1).max(MAX_MESSAGE_LEN),
  stack: z.string().max(MAX_STACK_LEN).optional(),
  componentStack: z.string().max(MAX_COMPONENT_STACK_LEN).optional(),
  route: z.string().max(MAX_ROUTE_LEN).optional(),
  userAgent: z.string().max(MAX_USER_AGENT_LEN).optional(),
  appVersion: z.string().max(MAX_APP_VERSION_LEN).optional(),
});

export const clientErrorsRouter = router({
  report: publicProcedure.input(reportInput).mutation(async ({ ctx, input }) => {
    try {
      await db.insert(clientErrors).values({
        // userId is set from auth ctx if available, otherwise null (public route).
        userId: ctx.userId ?? null,
        message: input.message,
        stack: input.stack ?? null,
        componentStack: input.componentStack ?? null,
        route: input.route ?? null,
        userAgent: input.userAgent ?? null,
        appVersion: input.appVersion ?? null,
      });
      return { ok: true };
    } catch (err) {
      // Never fail the mutation back to the client; that just creates a
      // retry loop on an already-crashed UI. Log on the server and ack.
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to record client error report'
      );
      return { ok: true };
    }
  }),
});
