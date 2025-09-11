import { initTRPC } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import { type AuthContext, createAuthContext } from './middleware/auth';
import { createTimer, generateRequestId, trpcLogger } from './utils/logger';

// Create context type with request tracking and auth
export type Context = {
  requestId: string;
  startTime: number;
} & AuthContext;

export const createContext = async (opts?: FetchCreateContextFnOptions): Promise<Context> => {
  const requestId = generateRequestId();
  const startTime = Date.now();

  // Log incoming request
  if (opts?.req) {
    trpcLogger.info(
      {
        requestId,
        method: opts.req.method,
        url: opts.req.url,
        userAgent: opts.req.headers.get('user-agent'),
        contentType: opts.req.headers.get('content-type'),
      },
      '🔄 Incoming tRPC request'
    );
  }

  // Create auth context
  const authContext = opts?.req
    ? await createAuthContext({ req: opts.req })
    : {
        user: null,
        isAuthenticated: false,
      };

  return {
    requestId,
    startTime,
    ...authContext,
  };
};

// Initialize tRPC with logging
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error, ctx }) {
    const duration = ctx ? Date.now() - ctx.startTime : undefined;

    // Log the error with context
    trpcLogger.error(
      {
        requestId: ctx?.requestId,
        error: {
          name: error.name,
          message: error.message,
          code: error.code,
          cause: error.cause,
          stack: error.stack,
        },
        duration: duration ? `${duration}ms` : undefined,
      },
      `❌ tRPC Error: ${error.message}`
    );

    return {
      ...shape,
      data: {
        ...shape.data,
        requestId: ctx?.requestId,
      },
    };
  },
});

// Logging middleware for all procedures
const loggingMiddleware = t.middleware(async ({ ctx, path, type, input, next }) => {
  const timer = createTimer();
  const procedureLogger = trpcLogger.child({
    requestId: ctx.requestId,
    procedure: path,
    type,
  });

  procedureLogger.debug(
    {
      input: input
        ? JSON.stringify(input).length > 1000
          ? `[Large input: ${JSON.stringify(input).length} chars]`
          : input
        : undefined,
    },
    `⚡ Starting ${type} procedure: ${path}`
  );

  try {
    const result = await next();
    const duration = timer.end();

    if (result.ok) {
      procedureLogger.info(
        {
          duration: `${duration}ms`,
          outputSize: result.data ? JSON.stringify(result.data).length : 0,
        },
        `✅ Procedure completed successfully: ${path}`
      );
    } else {
      procedureLogger.warn(
        {
          duration: `${duration}ms`,
          error: result.error,
        },
        `⚠️ Procedure completed with error: ${path}`
      );
    }

    return result;
  } catch (error) {
    const duration = timer.end();

    procedureLogger.error(
      {
        duration: `${duration}ms`,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
      },
      `💥 Procedure threw exception: ${path}`
    );

    throw error;
  }
});

// Enhanced procedure with logging
export const publicProcedure = t.procedure.use(loggingMiddleware);

// Protected procedure that requires authentication
export const protectedProcedure = t.procedure.use(loggingMiddleware).use(async ({ ctx, next }) => {
  if (!ctx.isAuthenticated || !ctx.user) {
    throw new Error('Authentication required');
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user, // Ensure user is not null in protected procedures
    },
  });
});

// Create router
export const router = t.router;
