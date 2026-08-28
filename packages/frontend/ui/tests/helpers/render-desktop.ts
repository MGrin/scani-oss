import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Render the DESKTOP branch of a component that reads `useIsDesktop()`.
 *
 * `renderToStaticMarkup` has no `window`, so `useMediaQuery` resolves false and
 * every static-markup test in this repo sees the phone surface. Measured on
 * `main` at `283acc2be`: 58 test files render through `renderToStaticMarkup`
 * and one of them stubs `matchMedia`, so 57 cover one branch of seven
 * components and say nothing whatever about the other.
 *
 * That gap is not abstract. SC-625 shipped a desktop `amount` column rendering
 * a bare dash while `expect(html).toInclude('84.20')` passed off the phone card
 * beside it, and the whole suite was green over it.
 *
 * `useMediaQuery` reads `window.matchMedia` in a `useState` INITIALISER rather
 * than in an effect, so a stub is enough — no DOM and no jsdom.
 *
 * THE STUB IS REMOVED IN A `finally`. `bun test` runs every file in one
 * process, so a `window` left defined is read by every later file that branches
 * on `typeof window`, failing in code its author never touched — the same class
 * of leak `restoreContainerAfterAll()` exists to prevent for the DI container
 * (SC-448). The `finally` is what makes that hold when the render throws.
 *
 * IT THROWS WHEN NOTHING READ THE STUB. A stub that stops taking renders the
 * phone surface, and every assertion written for the desktop branch then passes
 * against the wrong one — this ticket's own defect, reintroduced inside its
 * fix. Checking it here covers every call site rather than asking each author
 * to remember a control.
 *
 * IT IS NOT SUFFICIENT, and the two checks answer different questions:
 *
 *     matchMedia was read      the hook ran and saw the stub
 *     a desktop-only marker    the desktop branch actually produced markup
 *
 * Six of the seven consumers return a Radix portal on BOTH branches, and a
 * portal renders null until it has mounted — so the hook runs, the stub is
 * read, and the output is empty either way (measured: `PeekSheet` desktop 0
 * bytes, mobile 0 bytes). Only a marker that no other branch emits — `<table`
 * for `V3DataView` — separates "the desktop branch rendered" from "nothing
 * rendered at all". Assert one in every test that uses this.
 */
export function renderDesktop(node: ReactNode): string {
  const target = globalThis as { window?: unknown };
  const had = 'window' in target;
  const previous = target.window;
  let reads = 0;

  target.window = {
    matchMedia: () => {
      reads += 1;
      return { matches: true, addEventListener: () => {}, removeEventListener: () => {} };
    },
  };

  try {
    const html = renderToStaticMarkup(node);
    if (reads === 0) {
      throw new Error(
        'renderDesktop: nothing read window.matchMedia during this render, so this markup is the ' +
          'PHONE surface and any desktop assertion made on it passes for the wrong branch. ' +
          'Render a component that calls useIsDesktop(), or use renderToStaticMarkup directly.'
      );
    }
    return html;
  } finally {
    if (had) target.window = previous;
    else delete target.window;
  }
}
