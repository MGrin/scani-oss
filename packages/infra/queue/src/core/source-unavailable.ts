import type { JobDeathReason } from './types';

/**
 * "This run stopped because something it reads from could not be reached"
 * (SC-1527).
 *
 * A processor throws `UnrecoverableError` for two different reasons that
 * BullMQ cannot tell apart: the input is wrong and re-running it is the same
 * failure (a burn address, a rejected API key), or every upstream it needed
 * was down and spending the remaining attempts against the outage would only
 * fail faster. The api offers Retry on the second and not the first, so the
 * worker has to record which one it was — and it records it from this brand,
 * set at the throw site, never from the error's words.
 *
 * A brand rather than a subclass for the reason `userFacing` gives: it
 * composes with `UnrecoverableError` instead of competing with it.
 */

const SOURCE_UNAVAILABLE = Symbol.for('scani.queue.sourceUnavailable');

export function sourceUnavailable<E extends Error>(error: E): E {
  Object.defineProperty(error, SOURCE_UNAVAILABLE, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return error;
}

/** Why the queue gave up on a job whose error is `err`. */
export function jobDeathReason(err: unknown, unrecoverable: boolean): JobDeathReason {
  if (!unrecoverable) return 'retries_exhausted';
  const branded =
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[SOURCE_UNAVAILABLE] === true;
  return branded ? 'source_unavailable' : 'unrecoverable';
}
