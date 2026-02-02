import { setUser } from '@scani/core/lib/sentry';
import { createTimer, generateRequestId, logConfig, trpcLogger } from '@scani/core/utils/logger';
import { initTRPC, TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import { type AuthContext, createAuthContext } from './middleware/auth';

// Request-scoped cache that lives in context - shared across all procedures in a batch
type RequestCache = Map<string, unknown>;

// Create context type with request tracking, auth, and request-scoped cache
export type Context = {
  requestId: string;
  startTime: number;
  requestCache: RequestCache; // Shared cache for all procedures in this request
} & AuthContext;

export const createContext = async (opts?: FetchCreateContextFnOptions): Promise<Context> => {
  const requestId = generateRequestId();
  const startTime = Date.now();
  const requestCache: RequestCache = new Map(); // Create ONE cache per HTTP request

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
        userId: null,
        email: null,
        isAuthenticated: false,
        dbUser: null,
      };

  // Set user context in Sentry for tracing
  if (authContext.userId) {
    setUser({
      id: authContext.userId,
      email: authContext.email || undefined,
    });
  }

  return {
    requestId,
    startTime,
    requestCache, // Pass the cache to all procedures
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

// NOTE: Request cache is now initialized at the HTTP request level in index.ts
// using runWithRequestCacheAsync() wrapper around the tRPC handler.
// This ensures ALL procedures in a batched request share the same cache.

// Logging middleware for all procedures
const loggingMiddleware = t.middleware(async ({ ctx, path, type, input, next }) => {
  const timer = createTimer();
  const procedureLogger = trpcLogger.child({
    requestId: ctx.requestId,
    procedure: path,
    type,
  });

  const shouldLogPayload = logConfig.level === 'debug' || logConfig.level === 'trace';
  const serializedInput =
    shouldLogPayload && input !== undefined ? safeStringify(input) : undefined;

  procedureLogger.debug(
    {
      input:
        shouldLogPayload && serializedInput
          ? serializedInput.length > 1000
            ? `[Large input: ${serializedInput.length} chars]`
            : input
          : undefined,
    },
    `⚡ Starting ${type} procedure: ${path}`
  );

  try {
    const result = await next();
    const duration = timer.end();
    const serializedOutput =
      shouldLogPayload && result.ok && result.data !== undefined
        ? safeStringify(result.data)
        : undefined;

    if (result.ok) {
      procedureLogger.info(
        {
          duration: `${duration}ms`,
          outputSize: serializedOutput ? serializedOutput.length : undefined,
          output:
            shouldLogPayload && serializedOutput
              ? serializedOutput.length > 1000
                ? `[Large output: ${serializedOutput.length} chars]`
                : result.data
              : undefined,
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

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return '[Unserializable payload]';
  }
};

// Enhanced procedure with logging
// NOTE: Request cache is shared across all procedures via HTTP-level wrapper in index.ts
export const publicProcedure = t.procedure.use(loggingMiddleware);

// Protected procedure that requires authentication
// Note: dbUser is NOT checked here - it will be fetched lazily by requireAuth when needed
export const protectedProcedure = t.procedure.use(loggingMiddleware).use(async ({ ctx, next }) => {
  if (!ctx.isAuthenticated || !ctx.userId) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
  return next({
    ctx: {
      ...ctx,
      userId: ctx.userId,
      email: ctx.email,
      dbUser: ctx.dbUser,
    },
  });
});

// Create router
export const router = t.router;
