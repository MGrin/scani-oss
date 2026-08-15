import * as React from 'react';

/**
 * Where a portalled overlay mounts.
 *
 * Mirrors Radix's own `Portal.container` type (`@radix-ui/react-portal`), so
 * the value round-trips through our primitives without a cast. `undefined`
 * means "Radix's default", which is `document.body`.
 */
export type PortalContainer = Element | DocumentFragment | null | undefined;

/**
 * Dialog, Sheet, Select, Popover, Tooltip and BottomDrawer all portal their
 * content to `document.body`. That is the right answer for a token set
 * defined on `:root` and the wrong one for a scoped set: v3 hangs its tokens
 * off `[data-ui="v3"]` on the shell root, so an overlay portalled to the body
 * resolves `--popover`, `--border`, the surface ramp and the gain/loss pair
 * against v2's values instead. It still looks like a plausible UI — just one
 * from the other design system — which is why nothing catches it: not tsgo,
 * not the test suite, and not a screenshot of the overlay on its own.
 *
 * A context rather than a prop on every call site because the leak also
 * happens inside shared components that v3 renders but does not own — the
 * `ThemeToggle` popover is one — where there is no v3 call site to pass a
 * prop at. Wrapping the v3 tree once fixes every overlay under it.
 *
 * Unset (v2, cloud, admin) the context is `undefined` and every primitive
 * behaves exactly as it did before.
 */
const PortalContainerContext = React.createContext<PortalContainer>(undefined);

export function PortalContainerProvider({
  container,
  children,
}: {
  container: PortalContainer;
  children: React.ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
  );
}

/**
 * Resolves the container an overlay should portal into: an explicit prop
 * wins, otherwise the nearest provider, otherwise `document.body`.
 *
 * Note that Radix renders *nothing* for a `null` container, so a provider
 * seeded from a callback ref renders no overlay on the mount pass. That is
 * the one render before the ref fires, with nothing open yet.
 */
export function usePortalContainer(override?: PortalContainer): PortalContainer {
  const inherited = React.useContext(PortalContainerContext);
  return override ?? inherited;
}
