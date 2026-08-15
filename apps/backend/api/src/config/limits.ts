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
   * Enforced at admission (storage.getUploadUrl), and by the presigned URL
   * itself, which binds Content-Length into the SigV4 signature — R2 rejects
   * a PUT that does not match.
   *
   * That signature is the whole enforcement. This used to add "and the R2
   * bucket has a lifecycle rule that sweeps oversized blobs"; an R2 lifecycle
   * rule can only match on prefix and age, so no such rule is expressible,
   * and none existed (SC-144). The 30-day `temp/` expiry that exists now is
   * an orphan backstop and knows nothing about size.
   */
  PRESIGN_UPLOAD_BYTES: 8 * 1024 * 1024, // 8 MB

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
