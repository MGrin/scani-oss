// Frontend-safe contract for the Scani app: zod DTOs (the tRPC wire),
// the project's configured Decimal.js instance, plus a small set of UI
// helpers (currency / date / validators).
//
// Strict rule: no Node-only APIs (`node:crypto`, `node:async_hooks`,
// `node:fs`) anywhere reachable from this barrel. Encryption lives in
// `@scani/security`; resilience primitives live in `@scani/rate-limiter`;
// request-scope caching lives in `@scani/domain/lib/request-cache`.
export * from './decimal';
export * from './dtos';
export * from './format/currency';
export * from './format/date';
export * from './token-validatiion';
export { safeRedirectPath } from './utils/safe-redirect';
export {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubString,
} from './utils/sentry-scrubber';
export * from './validators';
