import {
  createComponentLogger,
  createTimer,
  generateRequestId,
  logConfig,
  sanitizeUrl,
} from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import { initTRPC, TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import type { BetterAuthInstance } from '../auth/better-auth';
import { type AuthContext, createAuthContext } from './middleware/auth';

const trpcLogger = createComponentLogger('trpc');

// Injected at boot so tRPC's context creator can read Better-Auth sessions.
// Must be set before the first request — done in index.ts immediately after
// the Better-Auth instance is created.
let betterAuthRef: BetterAuthInstance | null = null;
export function setBetterAuthForContext(instance: BetterAuthInstance) {
  betterAuthRef = instance;
}

/**
 * Resolved Better-Auth instance for routers that need to call the server
 * API directly (e.g. `sessions.list` wrapping `betterAuth.api.listSessions`).
 * Throws if the boot ordering is wrong; that's a configuration bug, not a
 * recoverable runtime condition.
 */
export function getBetterAuth(): BetterAuthInstance {
  if (!betterAuthRef) {
    throw new Error('Better-Auth not initialized — setBetterAuthForContext must be called at boot');
  }
  return betterAuthRef;
}

// Request-scoped cache that lives in context - shared across all procedures in a batch
type RequestCache = Map<string, unknown>;

// Create context type with request tracking, auth, and request-scoped cache
export type Context = {
  requestId: string;
  startTime: number;
  requestCache: RequestCache; // Shared cache for all procedures in this request
  // Raw request headers — threaded through so routers that wrap Better-
  // Auth server APIs (e.g. sessions.list, sessions.revoke) can pass the
  // caller's cookies straight back to `betterAuth.api.*`. Null for the
  // synthetic context used in tests / out-of-request code paths.
  headers: Headers | null;
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
        url: sanitizeUrl(opts.req.url),
        userAgent: opts.req.headers.get('user-agent'),
        contentType: opts.req.headers.get('content-type'),
      },
      '🔄 Incoming tRPC request'
    );
  }

  // Create auth context. setBetterAuthForContext() must have been called
  // at boot — we assert it here so any misconfiguration fails loudly.
  if (!betterAuthRef) {
    throw new Error('Better-Auth not initialized — setBetterAuthForContext must be called at boot');
  }
  const authContext = opts?.req
    ? await createAuthContext({ req: opts.req, betterAuth: betterAuthRef })
    : {
        userId: null,
        email: null,
        isAuthenticated: false,
        dbUser: null,
      };

  return {
    requestId,
    startTime,
    requestCache, // Pass the cache to all procedures
    headers: opts?.req?.headers ?? null,
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

    // Capture to Sentry with route/user/requestId so triage isn't anonymous.
    // Skip TRPCError 4xx codes — those are intentional client-fault throws
    // (UNAUTHORIZED, BAD_REQUEST, NOT_FOUND, FORBIDDEN, CONFLICT) that
    // would otherwise drown out real server errors.
    if (!isExpectedClientError(error)) {
      captureException(error, {
        route: path,
        type,
        requestId: ctx.requestId,
        ...(ctx.userId ? { userId: ctx.userId } : {}),
      });
    }

    throw error;
  }
});

const CLIENT_ERROR_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_SUPPORTED',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNPROCESSABLE_CONTENT',
  'TOO_MANY_REQUESTS',
]);

function isExpectedClientError(error: unknown): boolean {
  return error instanceof TRPCError && CLIENT_ERROR_CODES.has(error.code);
}

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

// ---- Mutation helpers --------------------------------------------------

/**
 * Authenticated-procedure wrapper that bundles the `requireAuth` boilerplate
 * every router mutation was repeating (`const { dbUser } = await requireAuth(ctx)` +
 * forwarding `dbUser.id` into downstream service / use-case calls).
 *
 * The entity-change emission (`emitEntityChange`) stays at the call site —
 * the shape varies enough per router that forcing a single signature here
 * would hide the bits reviewers actually need to see. This helper handles
 * just the auth + context-forwarding ritual, not the WS fan-out.
 *
 * Import the helper as `authedMutation` and compose with a zod input:
 *
 *   authedMutation(MyInput, async ({ ctx, input }) => {
 *     const { dbUser } = ctx;           // already required + resolved
 *     return Container.get(FooService).doThing(dbUser.id, input);
 *   })
 */
type AuthedContext = Context & {
  dbUser: NonNullable<
    Awaited<ReturnType<typeof import('./middleware/auth').requireAuth>>['dbUser']
  >;
  userId: string;
};

import type { ZodTypeAny, z as zRuntime } from 'zod';
import { requireAuth } from './middleware/auth';

export function authedMutation<TSchema extends ZodTypeAny, TOutput>(
  input: TSchema,
  handler: (args: { ctx: AuthedContext; input: zRuntime.infer<TSchema> }) => Promise<TOutput>
) {
  return protectedProcedure.input(input).mutation(async ({ ctx, input: parsedInput }) => {
    const { dbUser } = await requireAuth(ctx);
    return handler({ ctx: { ...ctx, dbUser, userId: dbUser.id }, input: parsedInput });
  });
}

export function authedQuery<TSchema extends ZodTypeAny, TOutput>(
  input: TSchema,
  handler: (args: { ctx: AuthedContext; input: zRuntime.infer<TSchema> }) => Promise<TOutput>
) {
  return protectedProcedure.input(input).query(async ({ ctx, input: parsedInput }) => {
    const { dbUser } = await requireAuth(ctx);
    return handler({ ctx: { ...ctx, dbUser, userId: dbUser.id }, input: parsedInput });
  });
}
