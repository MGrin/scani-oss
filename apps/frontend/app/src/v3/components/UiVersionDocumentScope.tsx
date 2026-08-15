import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { activeUiVersion, applyDocumentUiVersion } from '../lib/ui-version';

/**
 * Keeps `<html data-ui="v3">` in step with which interface is on screen.
 *
 * That attribute is the v3 token block's scope, and on `<html>` it is `:root`
 * in everything but spelling — same element, same specificity — so the whole
 * token layer applies to the document: its background behind an overscroll, its
 * scrollbars, its form controls, and anything Radix portals onto `<body>`. It
 * is set rather than assumed because v2 shares all 25 shadcn custom-property
 * names, so a token block that could not be taken back off would repaint every
 * classic screen. See `applyDocumentUiVersion`.
 *
 * `main.tsx` sets the same attribute from the same function before React's
 * first paint, so the document does not flash the other design system while
 * this effect is still queued; this component is what keeps it right across
 * every client-side navigation afterwards.
 */
export function UiVersionDocumentScope() {
  const { pathname } = useLocation();

  useEffect(() => {
    applyDocumentUiVersion(activeUiVersion(pathname), document.documentElement);
  }, [pathname]);

  return null;
}
