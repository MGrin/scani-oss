/**
 * Every user job's id. BullMQ 6.3.12 refuses a custom id holding `:` unless it
 * splits into exactly three parts, and ids are built from payload values that
 * can carry one (a requestId derived from a repeatable job's own id), so each
 * part is escaped. `%` is escaped first so two different parts can never give
 * the same id; a part with neither character is left as it was, which keeps
 * the ids of jobs already queued (SC-1710).
 */
export function jobIdOf(...parts: readonly string[]): string {
  return parts.map((part) => part.replaceAll('%', '%25').replaceAll(':', '%3A')).join('_');
}
