// Frontend-safe contract for the Scani app: zod DTOs (the tRPC wire),
// the project's configured Decimal.js instance, plus a small set of UI
// helpers (currency / date / validators).
//
// Strict rule: no Node-only APIs (`node:crypto`, `node:async_hooks`,
// `node:fs`) anywhere reachable from this barrel. Encryption lives in
// `@scani/security`; resilience primitives live in `@scani/rate-limiter`;
// request-scope caching lives in `@scani/domain/lib/request-cache`.
export * from './brand/scani-mark';
export * from './decimal';
export * from './dtos';
export * from './format/currency';
export * from './format/date';
export * from './format/locale';
export * from './format/precision';
export {
  BALANCE_GAP_ANSWERS,
  BALANCE_GAP_DATE_PROMPT_MIN_SPAN_MS,
  BALANCE_GAP_MIN_BASE_VALUE,
  BALANCE_GAP_REVERSAL_REQUIRES_EXACT_NEGATION,
  BALANCE_GAP_REVIEW_KIND,
  BALANCE_GAP_SUPPRESSIONS,
  BALANCE_GAP_UNKNOWN,
  type BalanceGapAnswer,
  type BalanceGapSuppression,
  type BalanceGapSuppressionCounts,
  isBalanceGapAnswer,
  isLedgerWritingAnswer,
} from './lib/balance-gap';
export {
  counterpartyFromPayload,
  type ExplorerLinks,
  explorerLinks,
  normalizeCounterparty,
  txHashFromPayload,
} from './lib/block-explorer';
export {
  HOLDING_MOVEMENT_DIRECTIONS,
  type HoldingMovementDirection,
  isHoldingMovementDirection,
  isOutflowDestination,
  OUTFLOW_DESTINATIONS,
  type OutflowDestination,
  outflowDestinationIsReviewDecision,
} from './lib/holding-movement';
export {
  isManualEditCause,
  MANUAL_EDIT_CAUSES,
  type ManualEditCause,
  manualEditNeedsCause,
} from './lib/manual-balance-edit';
export * from './token-validatiion';
export * from './usage/outcomes';
export { safeExternalUrl } from './utils/safe-external-url';
export { safeRedirectPath } from './utils/safe-redirect';
export {
  isIgnoredSentryMessage,
  isThirdPartyOnlyStack,
  SENTRY_IGNORED_ERROR_PATTERNS,
} from './utils/sentry-noise';
export {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubString,
} from './utils/sentry-scrubber';
export * from './validators';
