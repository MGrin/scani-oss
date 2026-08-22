import { demoIdentity } from '@scani/domain/demo';
import {
  createComponentLogger,
  createTimer,
  generateRequestId,
  logConfig,
  sanitizeUrl,
} from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import type { InflowRateLimiter } from '@scani/rate-limiter';
import { initTRPC, TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import type { BetterAuthInstance } from '../auth/better-auth';
import { isDemoMode } from '../config/demo';
import { type AuthContext, createAuthContext } from './middleware/auth';

const trpcLogger = createComponentLogger('trpc');

// Injected at boot so tRPC's context creator can read Better-Auth sessions.
// Must be set before the first request — done in index.ts immediately after
// the Better-Auth instance is created.
let betterAuthRef: BetterAuthInstance | null = null;
export function setBetterAuthForContext(instance: BetterAuthInstance) {
  betterAuthRef = instance;
}

// Per-user rate limiter for session-revocation actions. Injected at boot the
// same way Better-Auth is — kept as a setter rather than passed via
// createContext options because the existing pattern is module-level
// dependency injection (createContext is handed straight to tRPC without
// a deps object).
let sessionRevokeLimiterRef: InflowRateLimiter | null = null;
export function setSessionRevokeLimiterForContext(instance: InflowRateLimiter) {
  sessionRevokeLimiterRef = instance;
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
  // Per-user limiter for session-revoke actions. Resolved once at boot
  // and exposed on every context so routers can call
  // `ctx.sessionRevokeLimiter.tryConsumeKey(...)` without reaching for
  // a module-global.
  sessionRevokeLimiter: InflowRateLimiter;
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
  if (!sessionRevokeLimiterRef) {
    throw new Error(
      'Session-revoke limiter not initialized — setSessionRevokeLimiterForContext must be called at boot'
    );
  }
  // Demo mode does not resolve a session, and that is the point (SC-466 #1).
  // The dataset's scheduled reset deletes the demo user and rewrites it, which
  // cascades away every `user_sessions` row hanging off it — so a demo built on
  // a real session logs its visitor out on every reset, which is what SC-465
  // measured. There is no cookie here to invalidate: the identity is derived
  // from constants (`demoIdentity()` returns the same uuid the seeder writes),
  // so a reset is invisible to whoever is looking at the demo when it fires.
  const demoUser = isDemoMode() ? demoIdentity() : null;
  const authContext = demoUser
    ? {
        userId: demoUser.id,
        email: demoUser.email,
        isAuthenticated: true,
        dbUser: null,
      }
    : opts?.req
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
    sessionRevokeLimiter: sessionRevokeLimiterRef,
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

/**
 * Demo mode is read-only, and this is where that is true (SC-466).
 *
 * Enforced on `type`, not on a list of procedure names: every mutation the
 * app has and every mutation it grows is covered the day it is written, and
 * nobody has to remember to add it here. It sits above the auth middleware so
 * a refused write says FORBIDDEN — "this deployment will not do that" — rather
 * than UNAUTHORIZED, which would be a lie in a session that is authenticated.
 *
 * The UI is deliberately NOT disabled to match. A greyed-out button is a
 * statement about the client; this is a statement about the server, and it is
 * the only one that survives someone opening a console.
 */
const demoReadOnly = t.middleware(async ({ type, path, next }) => {
  if (isDemoMode() && type === 'mutation') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `This is a read-only demo — '${path}' and every other write is refused by the server.`,
    });
  }
  return next();
});

// Enhanced procedure with logging
// NOTE: Request cache is shared across all procedures via HTTP-level wrapper in index.ts
export const publicProcedure = t.procedure.use(loggingMiddleware).use(demoReadOnly);

// Protected procedure that requires authentication
// Note: dbUser is NOT checked here - it will be fetched lazily by requireAuth when needed
export const protectedProcedure = t.procedure
  .use(loggingMiddleware)
  .use(demoReadOnly)
  .use(async ({ ctx, next }) => {
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
