import { createComponentLogger } from '@scani/core/utils/logger';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc';

const logger = createComponentLogger('router:client-errors');

/**
 * Client-side error reporting endpoint.
 *
 * The V2 ErrorBoundary posts to this on every caught exception. Errors are
 * logged as structured JSON so they can be found via log search / grep.
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
    logger.error(
      {
        userId: ctx.userId ?? null,
        route: input.route,
        message: input.message,
        stack: input.stack,
        componentStack: input.componentStack,
        userAgent: input.userAgent,
        appVersion: input.appVersion,
      },
      'Client error reported'
    );
    return { ok: true };
  }),
});
