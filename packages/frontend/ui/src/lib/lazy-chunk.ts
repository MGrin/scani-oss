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

/** Recognisable downstream, so a failed chunk fetch can be worded as the
 *  connectivity problem it almost always is rather than as a crash. */
export class ChunkLoadError extends Error {
  readonly chunk: string;

  constructor(chunk: string, cause: unknown) {
    super(
      `Could not load the ${chunk}. Check your connection and try again — if the app was updated while this tab was open, reloading the page will fix it.`
    );
    this.name = 'ChunkLoadError';
    this.chunk = chunk;
    this.cause = cause;
  }
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
  { chunk, attempts = 3, delayMs = (n) => 250 * 2 ** n, sleep = defaultSleep }: ImportChunkOptions
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await load();
    } catch (error) {
      last = error;
      if (attempt < attempts - 1) await sleep(delayMs(attempt));
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
