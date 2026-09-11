import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { DESKTOP_QUERY } from '../../src/v3/hooks/useMediaQuery';

/**
 * Mounting for `*.dom.tsx` specs, which run in their own process under
 * `dom-preload.ts` — see `dom-specs.ts` (SC-801).
 *
 * Assert on STRINGS, never on DOM nodes. A failing `expect(node)` makes bun
 * inspect the node, which under happy-dom can grow past JSC's string limit and
 * come back empty — and an assertion with no message reports as a pass.
 */

export type Viewport = 'desktop' | 'phone';

/**
 * The overlay each shell draws, and the one class that tells them apart:
 * `sheet.tsx` (desktop) is `bg-black/80`, `bottom-drawer.tsx` (phone) is
 * `bg-black/60`. Assert the pair — one present, the other absent — to say
 * WHICH shell rendered rather than that something did.
 */
export const SHELL_OVERLAY: Record<Viewport, string> = {
  desktop: 'bg-black/80',
  phone: 'bg-black/60',
};

export const OTHER_VIEWPORT: Record<Viewport, Viewport> = { desktop: 'phone', phone: 'desktop' };

/**
 * Mount `node` with `useIsDesktop()` answering for `viewport`, and return what
 * the document body holds — which is where a portal draws.
 *
 * `matchMedia` is stubbed for the one query the hook asks rather than left to
 * happy-dom's window size, so the caller chooses the branch rather than a
 * default viewport that sits exactly on the 1024px breakpoint.
 *
 * It throws when nothing read the stub, for `renderDesktop`'s reason: a stub
 * that stops taking renders one branch under both names.
 */
export async function mountForViewport(node: ReactNode, viewport: Viewport): Promise<string> {
  if (typeof document === 'undefined') {
    throw new Error(
      'mountForViewport: there is no DOM. Name the spec *.dom.tsx so dom-specs.ts runs it ' +
        'under dom-preload.ts.'
    );
  }
  const real = window.matchMedia;
  let reads = 0;
  window.matchMedia = ((query: string) => {
    if (query === DESKTOP_QUERY) reads += 1;
    return {
      matches: query === DESKTOP_QUERY && viewport === 'desktop',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(node);
    });
    if (reads === 0) {
      throw new Error(
        `mountForViewport: nothing read ${DESKTOP_QUERY}, so this markup is not the ${viewport} ` +
          'branch of anything. Mount a component that calls useIsDesktop().'
      );
    }
    return document.body.innerHTML;
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    window.matchMedia = real;
  }
}
