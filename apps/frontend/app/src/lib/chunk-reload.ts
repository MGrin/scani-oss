import { importChunk } from '@scani/ui/lib/lazy-chunk';
import { reportClientError } from '@/lib/report-client-error';

/**
 * One reload per chunk, per tab, and never two in a row (SC-890).
 *
 * A route chunk that will not load cannot be re-requested in place. The browser
 * records a rejected dynamic import in its **module map**, keyed on the
 * resolved URL, and every later `import()` of that URL re-delivers the stored
 * failure without touching the network. Measured on Chromium 148, WebKit 26.4
 * and Brave 152: three `import()` calls of one failing URL produce **one**
 * request, and attempts two and three return in 0 ms. `lazy-chunk.ts` carries
 * the rest of that measurement and why the retry loop that used to sit there is
 * gone.
 *
 * So the recovery has to replace the document. A fresh document gets a fresh
 * module map *and* a fresh `index.html`, which is the only thing that helps
 * when the chunk is missing for the other reason — a new build having shipped
 * while this tab was open. That hashed filename will never exist again, and no
 * amount of re-requesting it can find it; the new `index.html` names the new
 * one. Measured: against a server answering the old path the way Cloudflare
 * Pages does (the SPA shell, HTTP 200, `text/html`), a cache-busting retry
 * issues three real requests and all three fail.
 *
 * **The whole risk is looping.** A chunk that is unavailable rather than
 * unlucky — the device is offline, the deploy is genuinely broken — fails again
 * on the fresh document, and a reload-on-failure with no memory would spin the
 * tab forever, burning battery and never showing the reader the error card that
 * has a button in it. That is worse than the defect this fixes, so the marker
 * is written **before** navigating, not after: a reload that never comes back
 * must still count as having happened.
 *
 * `sessionStorage` because the lifetime wanted is exactly a tab's: it survives
 * the reload it is guarding, and it is gone when the reader closes the tab.
 */

const PREFIX = 'scani.chunk-reload:';

/**
 * `sessionStorage` is not always reachable — Safari with website data blocked
 * throws on the property access itself, not on the call.
 *
 * A tab with no storage gets **no** automatic reload, which is the conservative
 * direction: without somewhere to record the attempt there is nothing to stop
 * the loop, and the reader still has the error card's own Reload button. Losing
 * an automatic recovery is a worse screen; losing the guard is a spinning tab.
 */
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Claim this tab's one reload for `chunk`, or report that it is already spent.
 *
 * Named for what it does to the state rather than for the question it answers:
 * calling it consumes the attempt, so it is not a check that can be repeated.
 */
function takeChunkReload(chunk: string, storage: Storage | null): boolean {
  if (!storage) return false;
  const key = PREFIX + chunk;
  try {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, '1');
    return true;
  } catch {
    // A quota or security error mid-sequence is the same situation as no
    // storage at all: the attempt cannot be recorded, so it must not be taken.
    return false;
  }
}

/** Give the tab its attempt back, once the chunk has actually arrived. */
function clearChunkReload(chunk: string, storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(PREFIX + chunk);
  } catch {
    // Nothing depends on it: the marker only ever suppresses a reload, so
    // failing to clear it errs toward showing the card, which is the safe way.
  }
}

/**
 * Whether this tab has already spent its reload on `chunk` — i.e. whether the
 * document you are looking at IS the retry.
 *
 * Read-only, unlike `takeChunkReload`, and it is what lets the route's spinner
 * say which of the two it is (`lazy-route.tsx`). Nothing else can: the state it
 * reports has to survive the document being replaced, so no counter held in a
 * module could carry it.
 */
export function chunkReloadSpent(chunk: string, storage: Storage | null = sessionStore()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(PREFIX + chunk) !== null;
  } catch {
    return false;
  }
}

/** Everything the recovery touches outside itself, so a test can hold all of
 *  it. Defaults are the real thing; no caller in `src/` passes any of them. */
export interface ChunkReloadDeps {
  storage?: Storage | null;
  reload?: () => void;
  report?: (error: Error) => void;
}

/**
 * Load a route chunk, and if it does not arrive, spend this tab's one reload on
 * it.
 *
 * Returns a promise that **never settles** on the reloading path. The document
 * is being replaced: resolving would render the screen and rejecting would
 * flash the error card, both over a page that is about to go, and neither is
 * true for the second it would be on screen. Not settling leaves the route's
 * own spinner up until the navigation lands.
 *
 * On the second failure it rejects with the `ChunkLoadError`, which is what
 * `ChunkErrorBoundary` above it turns into a card with a Reload button — the
 * reader's own attempt, after the app has had its automatic one.
 */
export async function loadChunkWithOneReload<T>(
  chunk: string,
  load: () => Promise<T>,
  { storage = sessionStore(), reload, report }: ChunkReloadDeps = {}
): Promise<T> {
  try {
    const loaded = await importChunk(load, { chunk });
    // Only now is the tab's reload given back. Clearing on failure would arm
    // the loop this guard exists to prevent; clearing here means each
    // independent failure gets its own attempt, which is what an installed PWA
    // needs when it holds one tab open across several deploys.
    clearChunkReload(chunk, storage);
    return loaded;
  } catch (error) {
    if (!takeChunkReload(chunk, storage)) throw error;

    // Reported before navigating, because the reload is about to destroy every
    // trace that this happened. Without this, a chunk failing for half the
    // readers on a bad deploy would look like nothing at all: they recover, and
    // nothing is ever told. `reportClientError` is fire-and-forget and swallows
    // its own failures, so it can neither delay nor block the recovery — which
    // is why it is not awaited.
    (report ?? ((e: Error) => void reportClientError({ error: e })))(error as Error);
    (reload ?? (() => window.location.reload()))();

    return await new Promise<never>(() => {});
  }
}
