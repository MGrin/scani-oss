import { PortalContainerProvider } from '@scani/ui/lib/portal-container';
import { type CSSProperties, type MutableRefObject, type ReactNode, useState } from 'react';

interface V3TokenScopeProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /**
   * Receives the scope element. The shell needs it imperatively — it resizes
   * it to the visible band while the keyboard is up (SC-65) — and a ref
   * object cannot replace the callback below, which has to hand the element
   * to the portal provider as a *value* during render.
   */
  rootRef?: MutableRefObject<HTMLDivElement | null>;
  /**
   * Pins the token block to one theme regardless of the document's, via
   * `[data-ui='v3'][data-theme='dark']` in `v3-tokens.css`. Only the kitchen
   * sink needs it — the app inherits the document theme.
   */
  theme?: 'light' | 'dark';
}

/**
 * The element the v3 tokens hang off, and the element overlays portal into.
 *
 * Those are the same element and this component is what keeps them that way.
 * `data-ui="v3"` scopes the v3 token block (V3-03), but Radix mounts Dialog,
 * Sheet, Select, Popover, Tooltip and BottomDrawer on `document.body` — one
 * level *above* this div — so without a container every v3 overlay resolves
 * `--popover`, `--border`, the surface ramp and the gain/loss pair against
 * v2's values. It still renders a coherent-looking overlay, from the wrong
 * design system, which is why nothing but a side-by-side screenshot catches
 * it. Publishing the root through `PortalContainerProvider` puts them back
 * inside the scope without any call site having to remember.
 *
 * A callback ref rather than `useRef`: the provider needs the element as a
 * value during render, and a ref object is still null on the render that
 * creates it. The extra render that `setState` causes is the mount pass,
 * where nothing is open yet.
 */
export function V3TokenScope({ children, className, style, theme, rootRef }: V3TokenScopeProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);

  const attach = (element: HTMLDivElement | null) => {
    if (rootRef) rootRef.current = element;
    setRoot(element);
  };

  return (
    <div ref={attach} data-ui="v3" data-theme={theme} className={className} style={style}>
      <PortalContainerProvider container={root}>{children}</PortalContainerProvider>
    </div>
  );
}
