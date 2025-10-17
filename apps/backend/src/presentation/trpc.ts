import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { type AuthContext, createAuthContext } from "./middleware/auth";
import {
  createTimer,
  generateRequestId,
  logConfig,
  trpcLogger,
} from "../utils/logger";

// Create context type with request tracking and auth
export type Context = {
  requestId: string;
  startTime: number;
} & AuthContext;

export const createContext = async (
  opts?: FetchCreateContextFnOptions
): Promise<Context> => {
  const requestId = generateRequestId();
  const startTime = Date.now();

  // Log incoming request
  if (opts?.req) {
    trpcLogger.info(
      {
        requestId,
        method: opts.req.method,
        url: opts.req.url,
        userAgent: opts.req.headers.get("user-agent"),
        contentType: opts.req.headers.get("content-type"),
      },
      "🔄 Incoming tRPC request"
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
const loggingMiddleware = t.middleware(
  async ({ ctx, path, type, input, next }) => {
    const timer = createTimer();
    const procedureLogger = trpcLogger.child({
      requestId: ctx.requestId,
      procedure: path,
      type,
    });

    const shouldLogPayload =
      logConfig.level === "debug" || logConfig.level === "trace";
    const serializedInput =
      shouldLogPayload && input !== undefined
        ? safeStringify(input)
        : undefined;

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
  }
);

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return "[Unserializable payload]";
  }
};

// Enhanced procedure with logging
export const publicProcedure = t.procedure.use(loggingMiddleware);

// Protected procedure that requires authentication
export const protectedProcedure = t.procedure
  .use(loggingMiddleware)
  .use(async ({ ctx, next }) => {
    if (!ctx.isAuthenticated || !ctx.user || !ctx.dbUser) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
        dbUser: ctx.dbUser,
      },
    });
  });

// Create router
export const router = t.router;
