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
 * So two rules:
 *
 * 1. **Ask again, because the common failure is transient.** A flaky mobile
 *    connection usually succeeds on the second attempt, and a reader who
 *    pressed Export should not be told to try again for something the app can
 *    do itself.
 * 2. **When it still does not arrive, fail with something a person can read.**
 *    The native error is `Failed to fetch dynamically imported module:
 *    https://…`, which is a URL and a stack trace. `ChunkLoadError` carries a
 *    sentence, and the toast and boundary wording downstream both key off it.
 *
 * **This module is rule 2, and only rule 2** (SC-890). It used to claim both,
 * with a three-attempt loop that could not issue a second request — see
 * `importChunk` below for what was measured and why the loop is gone. Rule 1
 * needs a URL nothing here can obtain, so it lives in `lazyRoute`, as one
 * document reload.
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
 * What a pending chunk is doing right now (SC-840, amended by SC-890).
 *
 * `loading` — a request is in flight and none has failed. `retrying` — a fetch
 * of this chunk has ALREADY FAILED in this tab, and what is in flight now is
 * the second go at it.
 *
 * **The distinction is the whole point of reporting anything.** A caller
 * showing a spinner shows the identical spinner whether the chunk is arriving
 * or has already failed once, and those need opposite responses — wait, versus
 * stop waiting. The terminal failure was always distinguishable, because
 * `ChunkErrorBoundary` swaps in a card a reader can act on; it is these two that
 * were one observation, which is how the visual gate spent four runs unable to
 * say what it had photographed (SC-840).
 *
 * **SC-890 changed what `retrying` counts, and made it truer.** It used to mean
 * "between two attempts of `importChunk`'s retry loop" — and that loop issued no
 * second request, so `failures` counted attempts that never reached the network.
 * The second go is now a document reload, so a `failures` of 1 means one fetch
 * genuinely failed and a genuinely new one is in flight. The state therefore
 * crosses a document boundary, which is why the caller seeds it from
 * `chunk-reload.ts`'s marker rather than from a counter in this module: there is
 * no counter here that could survive the reload it is describing.
 */
export interface ChunkLoadState {
  phase: 'loading' | 'retrying';
  /** 1-based: the request this state is about. */
  attempt: number;
  /** How many fetches of this chunk have already failed in this tab. `0` while
   *  the first is in flight, so `failures > 0` is exactly "this chunk is
   *  erroring, not slow". */
  failures: number;
}

interface ImportChunkOptions {
  /** Named in the failure message, so it says what could not be loaded rather
   *  than that something could not be. */
  chunk: string;
}

/**
 * `import()`, and a readable error if it does not arrive.
 *
 * ## This used to retry three times, and the retries could not issue a request
 *
 * The docblock here claimed the opposite, in a sentence that was precise and
 * wrong: *"a rejected module promise is cached by the browser's module map
 * under some engines, so re-awaiting the same promise re-delivers the same
 * failure forever. Re-invoking the factory is what actually issues a second
 * request."* The hazard is real and the mitigation does not clear it. **The
 * module map is keyed on the resolved URL, not on the promise**, so calling the
 * factory again resolves the same specifier to the same URL and reaches the
 * same stored rejection. Nothing about calling it afresh reaches the network.
 *
 * Measured three ways for SC-890 — a bare HTML page with server-side request
 * counting, and the real production bundle behind a fault-injecting server:
 *
 *     three import() of one failing URL   ->  ONE request; attempts 2 and 3 return in 0 ms
 *     the same, with `?retry=N` appended  ->  three requests, and a chunk that
 *                                             was serving again arrived on #2
 *
 * Identical on Chromium 148, WebKit 26.4 and Brave 152, so `under some engines`
 * understated it: it is every engine tested. In the production build the same
 * reading holds with the service worker both blocked and allowed, and Vite's
 * `__vitePreload` deps list for the route chunk is empty, so there is no
 * preload machinery that could have behaved differently from dev.
 *
 * The cost of the loop was **750 ms of backoff over two no-ops** in front of a
 * reader who was already waiting, and the appearance — in `CLAUDE.md`, in
 * `lazyRoute` and in the tests — of a protection that did not exist.
 *
 * ## Why there is no retry here now instead of a fixed one
 *
 * A second request needs a **different URL**, and this function is handed an
 * opaque factory. It cannot append anything: Vite compiles `import('@/x')` to a
 * string literal inside a closure, with no runtime handle on the emitted path.
 * Recovering the URL from the rejection is Chromium-only — Chromium says
 * `Failed to fetch dynamically imported module: <url>` and **WebKit says only
 * `Importing a module script failed.`**, with no URL in it, which is precisely
 * the installed-PWA reader the retry existed for.
 *
 * So the recovery lives where a new URL is actually obtainable — one document
 * reload, in `lazyRoute`, which gets a fresh module map and a fresh
 * `index.html` naming the current hashes. This function's remaining job is the
 * second of the two rules above: turn the native message, which is a URL and a
 * stack, into a sentence a person can act on.
 */
export async function importChunk<T>(
  load: () => Promise<T>,
  { chunk }: ImportChunkOptions
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    throw new ChunkLoadError(chunk, error);
  }
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
