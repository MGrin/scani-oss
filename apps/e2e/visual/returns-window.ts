/**
 * The returns window, dated from the pinned day rather than the api's (SC-1300).
 *
 * The home Returns card asks for a NAMED window — `ytd` by default — and the
 * api resolves it against its own clock. `page.clock.setFixedTime` cannot reach
 * that clock, so the card measured the real year to date over whatever rollup
 * rows the stack happened to hold: two runs on 2026-09-23 against freshly reset
 * databases rendered `Down $180,650` with a cliff and `Unchanged` with a flat
 * line. A baseline written from either photographed that box's state.
 *
 * SC-1305 gave the procedures a `custom` window, so the named one is rewritten
 * into the same window as of the pinned day. That day is in 2027, so the window
 * lies ahead of every rollup row a worker could have written and the card has
 * no history to draw — the same honest, stable render `screens.ts` describes
 * for the hero chart, and for the same reason. What the card looks like WITH
 * history needs rollup rows at fixed dates, which is the gap that note files.
 *
 * A `custom` window is already a function of the browser's pinned clock (the
 * hero's period control computes it), so it passes through untouched.
 */

export const RETURNS_PROCEDURES = [
  'portfolio.hasReturns',
  'portfolio.getReturns',
  'portfolio.getReturnsComparison',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReturnsWindowPin =
  | { kind: 'pinned'; input: Record<string, unknown> }
  | { kind: 'unchanged'; input: Record<string, unknown> }
  | { kind: 'refused'; reason: string };

/** `asOf` is a `YYYY-MM-DD` day. */
export function pinReturnsWindow(input: unknown, asOf: string): ReturnsWindowPin {
  const record = (input ?? {}) as Record<string, unknown>;
  const window = record.window as { kind?: unknown } | undefined;
  switch (window?.kind) {
    case 'custom':
      return { kind: 'unchanged', input: record };
    case 'ytd':
      return pinned(record, `${asOf.slice(0, 4)}-01-01`, asOf);
    case '1y':
      return pinned(
        record,
        new Date(Date.parse(`${asOf}T00:00:00.000Z`) - 365 * DAY_MS).toISOString().slice(0, 10),
        asOf
      );
    case 'all':
      // From the epoch, so it spans every rollup row there is, and the api caps
      // a custom window at ten years — there is no pinned equivalent to send.
      return {
        kind: 'refused',
        reason: "the 'all' window reads every rollup row the stack holds and has no pinned form",
      };
    default:
      return { kind: 'refused', reason: `no window this rewrite knows: ${JSON.stringify(window)}` };
  }
}

function pinned(record: Record<string, unknown>, from: string, to: string): ReturnsWindowPin {
  return { kind: 'pinned', input: { ...record, window: { kind: 'custom', from, to } } };
}
