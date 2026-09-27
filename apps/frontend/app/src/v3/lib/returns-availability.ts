/**
 * The last answer the server gave to "does this reader have returns history",
 * kept per browser so the home tab strip is right at FIRST PAINT (SC-1307).
 *
 * SC-1306 took the returns engine off Home's critical path by putting the tab
 * behind a `portfolio.hasReturns` probe. That fixed the wait and introduced
 * this: the strip paints `Net worth · PnL`, the probe answers ~465ms later, and
 * a third tab appears — moving the targets under a finger already travelling
 * toward one. A slow screen reads as slow; a control that arrives after you
 * have started reading reads as a screen changing its mind.
 *
 * Nothing on the screen could answer it earlier, because the only source was a
 * round trip. This is a synchronous source: read during render, exactly as
 * `useViewPreference` reads a stored choice.
 *
 * **It is deliberately NOT a view preference.** That module's contract is "the
 * shape a reader CHOSE for a screen, never the data on it", and whether an
 * account has returns history is data. Widening it quietly would cost the next
 * reader the one sentence that makes it a preference store.
 *
 * **It is a hint and never an authority.** The probe's answer always wins, so
 * an account whose history goes away loses the tab on the next load rather than
 * keeping one onto an empty state — which is the constraint SC-1307 names, and
 * SC-1301's problem inverted.
 *
 * **UNKNOWN is a third state and the point of it.** "This browser has never
 * been told" is not "this account has no returns". Collapsing them makes a
 * first visit indistinguishable from an empty account, and that is the reading
 * that decides whether a tab may be shown. A first-ever visit therefore still
 * pops in once; there is no synchronous source on a browser that has never
 * asked, and pretending otherwise would mean guessing.
 *
 * Both halves are `typeof window`-guarded and both swallow, for the reasons
 * `view-preference.ts` sets out: v3 components render through
 * `renderToStaticMarkup` in tests where there is no storage at all, and Safari
 * with site data blocked throws on the property access itself.
 */

const STORAGE_KEY = 'scani.v3.hint.home.has-returns';

const TRUE = 'yes';
const FALSE = 'no';

export function returnsAvailabilityStorageKey(): string {
  return STORAGE_KEY;
}

type HintStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): HintStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The last answer, or `null` when this browser has never been told. */
export function readReturnsAvailability(): boolean | null {
  try {
    const raw = browserStorage()?.getItem(STORAGE_KEY);
    if (raw === TRUE) return true;
    if (raw === FALSE) return false;
    return null;
  } catch {
    return null;
  }
}

export function writeReturnsAvailability(hasReturns: boolean): void {
  try {
    browserStorage()?.setItem(STORAGE_KEY, hasReturns ? TRUE : FALSE);
  } catch {
    // A choice that does not survive the reload is the cost of a blocked or
    // full store. The strip still works.
  }
}
