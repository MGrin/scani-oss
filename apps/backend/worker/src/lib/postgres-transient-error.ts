/**
 * Whether an uncaught error is postgres.js losing a socket, which the driver
 * recovers from, rather than a bug the worker must exit on.
 *
 * The null-socket write is `nextWrite` in postgres.js 3.4.9 dereferencing a
 * socket that `closed()` has nulled — porsager/postgres#1208, reached through
 * a `reserve()`d connection whose backend Neon terminated. It is thrown from a
 * socket handler, so no promise carries it and it arrives here.
 *
 * **The receiver's NAME is not part of the match, because it is the
 * minifier's.** This read `'v\.write'` until SC-1231: the bundle minified
 * `socket` to `v` when it was written, then to `Y`, and the same crash exited
 * the worker (2026-09-17T19:00Z) with a whitelist that no
 * longer said what it meant. The V8 spelling is here too, because the message
 * belongs to the runtime rather than the driver.
 */
const POSTGRES_TRANSIENT_ERROR = new RegExp(
  [
    'CONNECTION_CLOSED',
    "null is not an object \\(evaluating '[\\w$.]+\\.write'\\)",
    "Cannot read properties of null \\(reading 'write'\\)",
    'write after end',
  ].join('|'),
  'i'
);

export function isPostgresTransientError(message: string): boolean {
  return POSTGRES_TRANSIENT_ERROR.test(message);
}

const SURGE_WINDOW_MS = 3_600_000;
// Neon suspends production's compute every 30-60 minutes; more drops than this
// in an hour is something else wearing the same message.
const SURGE_LIMIT = 5;

interface ReportedEvent {
  level?: string;
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
}

/**
 * A connection drop the uncaught-exception handler survives is reported as a
 * warning, not Sentry's default fatal, so a routine Neon suspend does not page
 * (SC-1738). Past `SURGE_LIMIT` in an hour it is an error again. Any other
 * event keeps its level. Counts are per process.
 */
export class PostgresTransientReport {
  private seen: number[] = [];

  adjust<T>(event: T, now: number = Date.now()): T {
    const reported = event as ReportedEvent;
    const message = reported.exception?.values?.at(-1)?.value ?? reported.message ?? '';
    if (!isPostgresTransientError(message)) return event;
    this.seen = this.seen.filter((at) => now - at < SURGE_WINDOW_MS);
    this.seen.push(now);
    return { ...reported, level: this.seen.length > SURGE_LIMIT ? 'error' : 'warning' } as T;
  }
}
