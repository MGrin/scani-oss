import type { CSSProperties } from 'react';

/**
 * How a figure is kept inside its line (SC-72).
 *
 * The bug this exists for: a hero figure wide enough to exceed the phone
 * viewport pushed the whole page sideways. v3's scroller is `<main>`, so the
 * document never grew — `<main>` gained a horizontal scroll instead, which is
 * why the tab bar stayed put while the page slid. Measured at 390px with a
 * twelve-digit total: `main.scrollWidth` 526 against a 390px box.
 *
 * **Why `min-w-0` is not the fix.** The guard on the grid items is real and
 * still needed, but it caps a *box*; an over-long figure is *content* spilling
 * out of a box that is already the right size, and spilled content is
 * scrollable overflow on the nearest scroller whatever its box measures. The
 * only way to stop a figure widening the page is to make the figure narrower.
 *
 * **Why a monospaced figure hits this first.** Every glyph in IBM Plex Mono —
 * digit, comma, decimal point, currency symbol — occupies the same 0.6em cell,
 * and `--text-numeric-tracking` takes 0.01em back, so a run is *exactly*
 * `cells x 0.59em` wide. Measured at `--text-display-size`: 25.96px per
 * character, for every character, at every length. A proportional face would
 * set the same string ~20% narrower because its separators are narrow, which is
 * precisely why a hero that looks comfortable in a mock overflows in the app.
 *
 * That exactness is what makes the fix arithmetic rather than a guess: the
 * component knows the cell count, CSS knows the line width through `100cqi`,
 * and the size that fits is one division. `v3-tokens.css` does the division;
 * this module supplies the count.
 *
 * **How far it goes.** The budget is one line of the box the figure sits in,
 * and the floor is `--text-caption-size` — v3's stated smallest type, which a
 * figure has no licence to go under. Between them the rule holds every
 * realistic money value: the widest case worth designing for is a weak-currency
 * total with a three-letter code, fifteen grouped digits and two decimals —
 * `IDR 999,999,999,999,999.00`, 25 cells — and at 320px, inside a card whose
 * interior is 256px, that lands at 17px. A figure longer than ~33 cells would
 * bottom out on the floor, and there `overflow-wrap` lets it take a second line
 * rather than leave the box. Nothing truncates: an ellipsis on money is a
 * different number.
 */

/**
 * The nominal advance of the mono face, in `em`. The measured advance is
 * 0.59em — 0.6em of glyph less 0.01em of `--text-numeric-tracking` — and the
 * nominal figure is used deliberately: it errs 1.7% narrow, which costs a pixel
 * of type and covers the fallback faces in the `--font-mono` stack (Menlo is
 * 0.602em) for the render before the webfont lands.
 */
export const FIGURE_ADVANCE = 0.6;

/**
 * Cells a rendered run occupies. Every glyph is one cell in a monospaced face,
 * so this is a code-point count — `Array.from` rather than `.length` so an
 * astral glyph counts once rather than twice.
 */
export function figureCells(text: string): number {
  return Array.from(text).length;
}

/**
 * The custom properties `figure.css` reads.
 *
 * `inset` is space inside the line that the fitted run does not get: the
 * net-worth tape spends some of its width on a currency symbol and a fraction
 * that are set at caption size and therefore do not shrink with the run.
 */
export function figureFitStyle(cells: number, inset?: string): CSSProperties {
  return {
    '--figure-cells': cells,
    ...(inset === undefined ? {} : { '--figure-inset': inset }),
  } as CSSProperties;
}
