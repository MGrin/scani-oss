/**
 * The Scani mark, as geometry rather than as markup.
 *
 * A rounded square with three bars inside it — stacked like the rows of a
 * holdings table, which is the whole idea — drawn in `currentColor` so it takes
 * the foreground of wherever it lands.
 *
 * **Why the numbers live here and not in the component.** The mark now has two
 * renderers that share no runtime: `ScaniLogo` in `@scani/ui` emits SVG for a
 * browser, and `apps/backend/api`'s PDF statement draws the same shape with
 * pdfkit's path API. The api cannot import `@scani/ui` — that package is React
 * and CSS — so without a common home the second renderer would have been a
 * third copy of the same eight numbers, and the first time the brand moved, two
 * of the three would have moved with it. `@scani/shared` is the one package
 * both sides already depend on, and geometry is data, not UI.
 *
 * The estate's rasters — every favicon, `.ico` and PWA icon — are **generated**
 * from the marketing site's `public/favicon.svg` by `bun run icons:generate`
 * (SC-80). That file is plain SVG on a CDN path with no build step, so it
 * cannot import this one and carries the same numbers by value. Changing the
 * mark means changing both and re-running the generator; there is no third
 * place, and `scani-mark.test.ts` fails if that SVG stops matching.
 */
export const SCANI_MARK = {
  /** The square viewport every coordinate below is expressed in. */
  size: 24,
  /** The rounded square: inset from the viewport on all four sides. */
  frame: { inset: 3, radius: 4 },
  strokeWidth: 2.4,
  /** The three bars, longest at the top, all starting at the same left edge. */
  bars: [
    { y: 7, x1: 7, x2: 17 },
    { y: 11, x1: 7, x2: 14 },
    { y: 15, x1: 7, x2: 11 },
  ],
} as const;

/** The brand violet. The mark is drawn in `currentColor` on screen, but a PDF
 *  has no cascade to inherit one from, so the print renderer needs the value. */
export const SCANI_VIOLET = '#5b3df5';
