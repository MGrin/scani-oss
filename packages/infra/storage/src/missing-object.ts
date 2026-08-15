/**
 * "Is this storage error just a missing object?"
 *
 * Every caller that has to tell "the file is gone" apart from "storage is
 * broken" was writing its own substring test, and they disagreed. The one
 * that mattered — `CloudStorage.delete` — tested
 * `/NoSuchKey|404|not found/i`, which matches none of the words in the
 * message R2 actually returns:
 *
 *   The specified key does not exist.
 *
 * It only ever looked right because the data-provider swallows the raw
 * `NoSuchKey` server-side before the client sees anything.
 *
 * The distinction is load-bearing in both directions. A missing object is
 * terminal and the caller's problem to explain; anything else (5xx, a
 * dropped connection, bad credentials) must stay retryable and keep
 * alerting. Widening these patterns to "any storage error" would silently
 * bury a real R2 incident.
 */

// Matched against the message as it arrives, which may be the raw S3 error
// name, an HTTP status line, or R2's prose relayed through a TRPCError.
const MISSING_OBJECT_PATTERNS = [
  /NoSuchKey/i,
  /specified key does not exist/i,
  /\b404\b/,
  /\bnot found\b/i,
] as const;

export function isMissingObjectError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return MISSING_OBJECT_PATTERNS.some((pattern) => pattern.test(message));
}
