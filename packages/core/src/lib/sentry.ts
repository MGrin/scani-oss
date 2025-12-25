import * as Sentry from '@sentry/bun';
import logger from '../utils/logger';

/**
 * Initialize Sentry for error tracking and monitoring
 */
export function initializeSentry() {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    console.warn('⚠️ SENTRY_DSN not configured, Sentry will not be initialized');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.RELEASE_VERSION || '1.0.0',

    // Performance monitoring
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Capture context
    beforeSend(event) {
      // Add request context if available
      if (event.request) {
        event.tags = {
          ...event.tags,
          url: event.request.url,
          method: event.request.method,
        };
      }
      return event;
    },

    // Ignore certain errors
    ignoreErrors: [
      'ECONNRESET',
      'EPIPE',
      'ENOTFOUND',
      'ECONNREFUSED',
      'TimeoutError',
      'AbortError',
    ],

    // Don't send events in development unless explicitly enabled
    enabled: process.env.NODE_ENV === 'production' || process.env.SENTRY_ENABLED === 'true',
  });

  logger.info('✅ Sentry initialized successfully');
}

/**
 * Capture an exception with additional context
 */
export function captureException(error: Error, context?: Record<string, unknown>) {
  Sentry.withScope((scope) => {
    if (context) {
      Object.keys(context).forEach((key) => {
        scope.setTag(key, String(context[key]));
      });
    }
    Sentry.captureException(error);
  });
}

/**
 * Capture a message with level and context
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = 'info',
  context?: Record<string, unknown>
) {
  Sentry.withScope((scope) => {
    if (context) {
      Object.keys(context).forEach((key) => {
        scope.setTag(key, String(context[key]));
      });
    }
    Sentry.captureMessage(message, level);
  });
}

/**
 * Add breadcrumb for debugging
 */
export function addBreadcrumb(message: string, category?: string, level?: Sentry.SeverityLevel) {
  Sentry.addBreadcrumb({
    message,
    category: category || 'custom',
    level: level || 'info',
    timestamp: Date.now() / 1000,
  });
}

/**
 * Set user context for error tracking
 */
export function setUser(user: { id: string; email?: string; username?: string }) {
  Sentry.setUser({
    id: user.id,
    email: user.email,
    username: user.username,
  });
}

/**
 * Create a transaction for HTTP request tracing
 */
export function startHttpTransaction<T>(
  method: string,
  url: string,
  requestId: string | undefined,
  callback: () => T
): T {
  return Sentry.startSpan(
    {
      name: `${method} ${url}`,
      op: 'http.server',
      attributes: {
        method,
        url,
        requestId,
      },
    },
    callback
  );
}

/**
 * Create a span for database query tracing
 */
export function startDbSpan<T>(
  operation: string,
  table: string | undefined,
  query: string | undefined,
  parameters: unknown[] | undefined,
  callback: () => T
): T {
  return Sentry.startSpan(
    {
      op: 'db.query',
      name: query ? `${operation} ${query.substring(0, 100)}` : operation,
      attributes: {
        table,
        query: query?.substring(0, 2000), // Allow longer queries for better debugging
        parameters: parameters ? JSON.stringify(parameters.slice(0, 10)) : undefined, // Include parameters, limit to first 10
      },
    },
    callback
  );
}

/**
 * Wrap an async function with tracing
 */
export async function withTracing<T>(
  operation: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return Sentry.startSpan(
    {
      op: operation,
      name: operation,
      attributes,
    },
    async () => {
      try {
        const result = await fn();
        return result;
      } catch (error) {
        Sentry.setTag('error', true);
        throw error;
      }
    }
  );
}

/**
 * Flush pending events to Sentry
 */
export async function flush(timeout = 2000): Promise<boolean> {
  return await Sentry.flush(timeout);
}

/**
 * Close the Sentry client
 */
export async function close(timeout = 2000): Promise<boolean> {
  return await Sentry.close(timeout);
}
