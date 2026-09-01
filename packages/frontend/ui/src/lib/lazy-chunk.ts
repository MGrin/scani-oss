/**
 * Loading a chunk on a connection that may not finish the job.
 *
 * Everything reached by `import()` after the first paint is a second network
 * request, made minutes or hours after the page was opened, on whatever
 * connection the reader has now. Three ways it fails, all routine on a phone:
 * the request times out mid-tunnel; the device is offline; or the deploy that
 * produced the chunk has been replaced and the hashed filename is a 404.
 *
 * All three arrive as a rejected promise, and an unhandled one inside React's
 * render path is a **white screen** — no message, no button, nothing to press.
 * That is SC-62's shape exactly: a service worker rejecting a fetch surfaced as
 * an unhandled error rather than as anything a reader could act on.
 *
 * So two rules, and this module is both of them:
 *
 * 1. **Retry, because the common failure is transient.** A flaky mobile
 *    connection usually succeeds on the second attempt, and a reader who
 *    pressed Export should not be told to try again for something the app can
 *    do itself.
 * 2. **When retries are exhausted, fail with something a person can read.** The
 *    native error is `Failed to fetch dynamically imported module: https://…`,
 *    which is a URL and a stack trace. `ChunkLoadError` carries a sentence, and
 *    the toast and boundary wording downstream both key off it.
 */

import { uiT } from '../i18n';
import { UserFacingError } from './user-facing-error';

/** Recognisable downstream, so a failed chunk fetch can be worded as the
 *  connectivity problem it almost always is rather than as a crash.
 *
 *  A `UserFacingError` (SC-311) because this sentence is the answer, not a
 *  diagnostic: the reader is told what did not arrive and what to do about it,
 *  and the renderers only show a message somebody vouched for. */
export class ChunkLoadError extends UserFacingError {
  readonly chunk: string;

  constructor(chunk: string, cause: unknown) {
    super(uiT('ui.errors.chunk.message', { chunk }), { cause });
    this.name = 'ChunkLoadError';
    this.chunk = chunk;
  }
}

/**
 * What a pending chunk is doing right now (SC-840).
 *
 * `loading` — a request is in flight. `retrying` — the last one REJECTED and
 * this is the backoff before the next.
 *
 * **The distinction is the whole point of reporting anything.** The retry loop
 * below is invisible from outside it: for the entire 250ms + 500ms backoff, and
 * for however long three failing fetches take, a caller showing a spinner shows
 * the identical spinner whether the chunk is arriving or has already failed
 * twice. Those need opposite responses — wait, versus stop waiting — and until
 * this existed nothing anywhere could tell them apart.
 *
 * The *terminal* failure was always distinguishable, because `ChunkErrorBoundary`
 * swaps in a card a reader can act on. It is these two that were one observation,
 * which is how the visual gate spent four runs unable to say what it had
 * photographed (SC-840).
 */
export interface ChunkLoadState {
  phase: 'loading' | 'retrying';
  /** 1-based: the request this state is about. */
  attempt: number;
  /** How many attempts have already rejected. `0` while the first is in flight,
   *  so `failures > 0` is exactly "this chunk is erroring, not slow". */
  failures: number;
}

interface ImportChunkOptions {
  /** Named in the failure message, so it says what could not be loaded rather
   *  than that something could not be. */
  chunk: string;
  attempts?: number;
  /** Overridden in tests. Real backoff is short on purpose: this runs while
   *  someone is looking at a spinner. */
  delayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called on every transition, so whoever is showing the spinner can say
   *  which of the two it stands for. Optional, and never called after the
   *  promise settles — by then the caller has either the module or the error. */
  onState?: (state: ChunkLoadState) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `import()` with retries, and a readable error if they run out.
 *
 * The factory is called afresh each attempt rather than the promise being
 * retained: a rejected module promise is **cached by the browser's module map**
 * under some engines, so re-awaiting the same promise re-delivers the same
 * failure forever. Re-invoking the factory is what actually issues a second
 * request.
 */
export async function importChunk<T>(
  load: () => Promise<T>,
  {
    chunk,
    attempts = 3,
    delayMs = (n) => 250 * 2 ** n,
    sleep = defaultSleep,
    onState,
  }: ImportChunkOptions
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    onState?.({ phase: 'loading', attempt: attempt + 1, failures: attempt });
    try {
      return await load();
    } catch (error) {
      last = error;
      if (attempt < attempts - 1) {
        // Reported BEFORE the sleep, not after it. The backoff is most of the
        // time a caller spends in this state, so a report that waited until the
        // next request would leave the whole gap described as `loading` — the
        // one window where "arriving" is precisely what it is not.
        onState?.({ phase: 'retrying', attempt: attempt + 1, failures: attempt + 1 });
        await sleep(delayMs(attempt));
      }
    }
  }
  throw new ChunkLoadError(chunk, last);
}

/** Whether a caught error is a chunk that would not load — including one that
 *  reached us before `importChunk` could wrap it, which is why the native
 *  message is matched too. */
export function isChunkLoadError(error: unknown): boolean {
  if (error instanceof ChunkLoadError) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('error loading dynamically imported module') ||
    message.includes('Importing a module script failed')
  );
}
