/**
 * `@scani/logging`
 *
 * Pino-based structured logger used by every Scani app (backend, worker,
 * cron, admin, and integrations). Consolidated here so that there's one
 * canonical configuration for log level / pretty-printing / Sentry
 * forwarding, rather than each app wiring up its own formatters.
 *
 * Sentry helpers are a separate entry point (`@scani/logging/sentry`) so
 * that build pipelines which don't need Sentry (landing page, etc.) can
 * omit it via tree-shaking.
 */

export {
  authLogger,
  type CustomLogger,
  createComponentLogger,
  createTimer,
  dbLogger,
  generateRequestId,
  type LogContext,
  logConfig,
  logger,
  logRequestResponse,
  sanitizeUrl,
  trpcLogger,
  wsLogger,
} from './logger';
