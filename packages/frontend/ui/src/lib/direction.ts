import { useSyncExternalStore } from 'react';

/**
 * The class that mirrors a *navigational* icon under `dir="rtl"` (SC-760).
 *
 * Logical CSS properties mirror boxes; they do nothing to a glyph. A back
 * button drawn with `ArrowLeft` still points left in an Arabic layout, where
 * left is the direction the reader is travelling *towards* — so the one
 * control whose entire job is to say "backwards" says "forwards" instead.
 * Nothing about that is visible in a diff of class names, which is why it is
 * named here rather than left to a `rtl:-scale-x-100` scattered across a dozen
 * call sites.
 *
 * **Navigational, not semantic.** Mirror an icon whose meaning is a direction
 * of TRAVEL through the interface — back, forward, the chevron on a row that
 * opens something. Do NOT mirror one whose meaning is a direction in the
 * world: the up-right and down-left arrows on money leaving and arriving
 * (`UpcomingFeed`, `ExpectedIncome`) encode outflow and inflow, and flipping
 * them would change what they claim rather than where they point. That call is
 * a product one and is deliberately not made here.
 *
 * `-scale-x-100` rather than swapping the component for its opposite: one
 * class, no second import at each site, and it cannot drift out of step with
 * the document direction the way a hand-picked pair can.
 */
export const MIRROR_IN_RTL = 'rtl:-scale-x-100';

/**
 * Which way the document reads, as a value React can render from (SC-969).
 *
 * `MIRROR_IN_RTL` above is the whole answer for anything CSS can reach. A
 * recharts chart is the case it cannot: the value axis is placed by an x
 * coordinate computed in JS, so no logical property and no `rtl:` variant
 * touches it. Under `dir="rtl"` every other block on the home screen moved its
 * leading edge to the right and the chart's y-axis gutter stayed on the
 * physical left — see `home-phone-rtl.png`.
 *
 * **Why this subscribes rather than reading `document.documentElement.dir`
 * during render.** In the app that read would be correct: `applyFormatLocale`
 * writes `<html dir>` from a `useMemo` in a provider, above the tree, so a
 * language change re-renders everything below it with the attribute already
 * set. The visual harness does not go through that path — there is no `ar.json`
 * yet, so no reader can select their way to RTL and `v3-screens.spec.ts`
 * assigns the attribute from `page.evaluate` after mount, with nothing to make
 * React re-render. A render-time read would therefore be right in production
 * and stale in the one instrument that photographs RTL, and `--update` would
 * write an LTR axis into an RTL baseline that agrees with itself forever. That
 * is `assertStillInDirection`'s failure one level down, and it is why the
 * attribute is watched instead of sampled.
 *
 * Scoped to `<html>` deliberately: that is the only element either path writes.
 * A `dir` on a subtree — `NetWorthTape`'s `dir="ltr"` on a figure — is a bidi
 * fix for one string and is not a claim about layout.
 */
export type Direction = 'ltr' | 'rtl';

function readDocumentDirection(): Direction {
  return typeof document === 'undefined' ? 'ltr' : directionOf(document.documentElement.dir);
}

/** Exported for the test: `dir` is a free-form attribute, so anything that is
 *  not `rtl` is `ltr` — including the empty string a document that never set
 *  it returns. */
export function directionOf(value: string | null | undefined): Direction {
  return value?.toLowerCase() === 'rtl' ? 'rtl' : 'ltr';
}

function subscribeToDocumentDirection(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
  return () => observer.disconnect();
}

export function useDirection(): Direction {
  // The snapshot is a string, so its identity is stable across reads and this
  // cannot loop the way an object-returning store does. The server snapshot is
  // `'ltr'` because this repo's component tests render through
  // `react-dom/server`, where there is no document to ask.
  return useSyncExternalStore(subscribeToDocumentDirection, readDocumentDirection, () => 'ltr');
}
