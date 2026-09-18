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
