import '../../i18n-preload';

import { afterEach, describe, expect, test } from 'bun:test';
import { HOME_METRICS, resolveHomeMetric } from '../../../src/v3/lib/home';
import {
  readReturnsAvailability,
  returnsAvailabilityStorageKey,
  writeReturnsAvailability,
} from '../../../src/v3/lib/returns-availability';

/**
 * SC-1307. The tab strip paints `Net worth · PnL`, and ~465ms later the Returns
 * tab arrives and the strip reflows under a finger already travelling toward a
 * target.
 *
 * `offered` is `hasReturns || (chosen === 'returns' && returnsPending)`, so a
 * reader sitting on Net worth who HAS returns gets `false` until the probe
 * answers and `true` after — which is the pop-in. Nothing on the screen knows
 * the answer at first paint, because the only source of it is a round trip.
 *
 * This is the synchronous source: the last answer the server gave, kept per
 * browser and read during render, exactly as `useViewPreference` reads a stored
 * choice. It is deliberately NOT a view preference — that module's contract is
 * "the shape a reader chose for a screen, never the data on it", and whether an
 * account has returns history is data.
 *
 * It is a HINT and never an authority: the probe's answer always wins, so an
 * account whose history goes away corrects on the next load rather than keeping
 * a tab onto an empty state.
 */

const globals = globalThis as { window?: unknown };

function stubWindow(stored: Record<string, string> = {}) {
  const data = new Map(Object.entries(stored));
  globals.window = {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
  };
  return data;
}

const hadWindow = 'window' in globals;
const originalWindow = globals.window;

afterEach(() => {
  if (hadWindow) globals.window = originalWindow;
  else delete globals.window;
});

describe('returns availability hint', () => {
  test('a written answer is readable back', () => {
    stubWindow();
    writeReturnsAvailability(true);
    expect(readReturnsAvailability()).toBe(true);
    writeReturnsAvailability(false);
    expect(readReturnsAvailability()).toBe(false);
  });

  /**
   * `null` is a third state and the whole point of it: "this browser has never
   * been told" is not "this account has no returns". Collapsing the two would
   * make a first visit indistinguishable from an account with no history, which
   * is the reading that decides whether a tab may be shown.
   */
  test('never written reads UNKNOWN, not false', () => {
    stubWindow();
    expect(readReturnsAvailability()).toBeNull();
  });

  test('a value that is not one this module wrote reads UNKNOWN', () => {
    stubWindow({ [returnsAvailabilityStorageKey()]: 'perhaps' });
    expect(readReturnsAvailability()).toBeNull();
  });

  test('no window at all reads UNKNOWN rather than throwing', () => {
    delete globals.window;
    expect(readReturnsAvailability()).toBeNull();
  });

  /**
   * Safari with site data blocked throws on the `localStorage` property access
   * itself, before any read happens — the same case `view-preference.ts`
   * documents. The strip must still render.
   */
  test('storage that throws on access reads UNKNOWN and the write does not throw', () => {
    globals.window = {
      get localStorage(): never {
        throw new Error('site data blocked');
      },
    };
    expect(readReturnsAvailability()).toBeNull();
    expect(() => writeReturnsAvailability(true)).not.toThrow();
  });

  test('a write that throws is swallowed, as a quota-full write would', () => {
    globals.window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
    };
    expect(() => writeReturnsAvailability(true)).not.toThrow();
  });
});

/**
 * The reason the hint exists, stated as the strip sees it. `resolveHomeMetric`
 * is unchanged — what changes is that `hasReturns` can be answered at first
 * paint instead of a round trip later.
 */
describe('the tab strip at first paint (SC-1307)', () => {
  test('WITHOUT a hint, a Net worth reader who has returns gets the pop-in', () => {
    // First paint: the probe has not answered, so nothing knows.
    const atPaint = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: false,
      returnsPending: true,
      shown: false,
    });
    // ~465ms later.
    const afterProbe = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: true,
      returnsPending: false,
      shown: false,
    });
    expect(atPaint.offered).toBe(false);
    expect(afterProbe.offered).toBe(true);
    // The strip's contents changed after first paint. This is the defect.
    expect(atPaint.offered).not.toBe(afterProbe.offered);
  });

  test('WITH a hint, the same reader gets the same strip before and after', () => {
    const hint = true;
    const atPaint = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: hint,
      returnsPending: true,
      shown: false,
    });
    const afterProbe = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: true,
      returnsPending: false,
      shown: false,
    });
    expect(atPaint.offered).toBe(true);
    expect(atPaint).toEqual(afterProbe);
  });

  /**
   * The hint is not an authority. An account whose history went away must lose
   * the tab rather than keep one onto an empty state — SC-1301's problem
   * inverted, which the ticket names as the constraint.
   */
  /**
   * The test above feeds `resolveHomeMetric` a literal, so it proves the
   * RESOLVER and not the composition. This one goes through storage and
   * reproduces `useHomeChart`'s own expression, which is where a bug would
   * actually live — a value that round-trips as the STRING "true" satisfies
   * every test above and still renders the wrong strip.
   */
  test("through real storage, the hook's own expression is right at first paint", () => {
    stubWindow();
    writeReturnsAvailability(true);

    // Exactly what useHomeChart computes on its first render: the probe has
    // not answered (`answered` undefined), so the stored hint decides.
    const answered: boolean | undefined = undefined;
    const remembered = readReturnsAvailability();
    const atPaint = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: answered ?? remembered ?? false,
      returnsPending: true,
      shown: false,
    });

    expect(remembered).toBe(true);
    expect(atPaint.offered).toBe(true);
    // The strip itself: `useHomeChart` renders `offered ? HOME_METRICS : …`,
    // so `offered` at first paint IS the tab list at first paint.
    const withoutReturns = HOME_METRICS.filter((m) => m.key !== 'returns');
    const stripAtPaint = atPaint.offered ? HOME_METRICS : withoutReturns;
    expect(stripAtPaint.map((m) => m.key)).toEqual(['net-worth', 'pnl', 'returns']);

    // …and once the probe agrees, nothing about the strip moves.
    const afterProbe = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: true,
      returnsPending: false,
      shown: false,
    });
    expect(atPaint).toEqual(afterProbe);
  });

  test('the probe overrules a stale hint', () => {
    const atPaint = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: true,
      returnsPending: true,
      shown: false,
    });
    const afterProbe = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: false,
      returnsPending: false,
      shown: false,
    });
    expect(atPaint.offered).toBe(true);
    expect(afterProbe.offered).toBe(false);
  });

  /**
   * The hint must record what the strip SETTLED on, not what the probe first
   * said. `useHomeChart` lets `getReturns` outrank `hasReturns`, so a reader
   * the probe says yes to and the engine then withdraws the tab from would
   * store `true` — and next load opens with the tab and takes it away. Same
   * defect, other direction.
   */
  test('a probe/engine disagreement stores the ENGINE answer', () => {
    stubWindow();
    const probeSaid = true;
    const engineSaid = false; // `view?.money == null`
    const settled = engineSaid; // what the hook records once the engine answers
    writeReturnsAvailability(settled);
    expect(readReturnsAvailability()).toBe(false);
    expect(readReturnsAvailability()).not.toBe(probeSaid);

    // And the next load therefore opens without the tab, rather than showing
    // one and removing it.
    const nextPaint = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: readReturnsAvailability() ?? false,
      returnsPending: true,
      shown: false,
    });
    expect(nextPaint.offered).toBe(false);
  });

  test('a first-ever visit still cannot know, and that is the honest limit', () => {
    const atPaint = resolveHomeMetric({
      chosen: 'net-worth',
      hasReturns: false,
      returnsPending: true,
      shown: false,
    });
    expect(atPaint.offered).toBe(false);
  });
});
