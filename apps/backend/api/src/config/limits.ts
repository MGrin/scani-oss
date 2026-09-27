import { UPLOADED_FILE_MAX_BYTES } from '@scani/jobs';
/**
 * Centralized admission-validation limits.
 *
 * Before this file every router that took untrusted input re-declared
 * its own `MAX_...` constant, and the values drifted — `storage.ts`
 * allowed 8 MB uploads while `file-import.ts` capped parsed output at
 * 4 MB, and the two lived in different files with no cross-reference.
 * Keeping them here makes the limits auditable in one diff + lets future
 * tuning happen in one commit.
 */

export const UPLOAD_LIMITS = {
  /**
   * Max size for a single presigned upload (screenshots, CSV files).
   * Admitted at storage.getUploadUrl and NOT enforced by the upload itself:
   * this said the presigned URL binds Content-Length into its signature, and
   * it does not — Bun's presign signs only `host` (SC-1345). The bound that
   * holds is the worker's read, which asks storage for the object's size and
   * refuses past this number before downloading it.
   *
   * An R2 lifecycle rule cannot help either: it matches on prefix and age
   * only (SC-144). The 30-day `temp/` expiry is an orphan backstop and knows
   * nothing about size.
   */
  PRESIGN_UPLOAD_BYTES: UPLOADED_FILE_MAX_BYTES,

  /**
   * Max decoded-bytes budget for an inline file-import preview. Smaller
   * than PRESIGN_UPLOAD_BYTES because the preview endpoint decodes
   * base64 in-memory and we don't want a 6 MB base64 payload blowing up
   * the backend process.
   */
  INLINE_DECODED_BYTES: 4 * 1024 * 1024, // 4 MB

  /**
   * Max parsed transactions per file. Files that exceed this are either
   * genuine (rare for personal bank statements) or adversarial. Failing
   * fast here keeps the parser out of O(N²) edge cases.
   */
  PARSED_TRANSACTIONS: 10_000,
} as const;

export const CLIENT_ERROR_LIMITS = {
  /** Max length of a reported client error message (fits most call stacks' top frame). */
  MESSAGE_LEN: 2000,
  /** Max length of a reported client stack trace. */
  STACK_LEN: 8000,
  /** Max length of a URL reported with the error (sanitized before logging). */
  URL_LEN: 2000,
} as const;

/**
 * Per-caller allowances on endpoints that are expensive to serve (SC-1267).
 * Scripted accounts on 2026-09-19 called exports.everything, getUploadUrl and
 * clientErrors.report in loops; each figure sits well above what a person does
 * in the same window.
 */
export const USER_BUDGETS = {
  /** Full-account exports per user per hour. */
  EXPORTS_PER_HOUR: 10,
  /** Bytes of presigned uploads per user per UTC day: 30 max-size files. */
  UPLOAD_BYTES_PER_DAY: 30 * UPLOAD_LIMITS.PRESIGN_UPLOAD_BYTES,
  /** Client error reports per caller per 10 minutes; past it they are dropped. */
  CLIENT_ERRORS_PER_10_MIN: 30,
  /** Test notifications per user per hour; each one POSTs to every device (SC-1346). */
  PUSH_TESTS_PER_HOUR: 10,
} as const;
