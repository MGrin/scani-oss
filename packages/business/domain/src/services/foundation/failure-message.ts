/**
 * One line for an operator's report; the log keeps the whole error. drizzle
 * wraps a database error as `Failed query: <SQL> params: …`, and its cause
 * carries the database's own sentence.
 */
export function failureOf(err: unknown): string {
  const reason = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.split('\n', 1)[0] ?? message;
}
