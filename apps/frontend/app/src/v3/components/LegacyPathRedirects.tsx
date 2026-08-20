import { Navigate, useLocation } from 'react-router-dom';
import { LEGACY_V2_BASE, LEGACY_V3_BASE, stripLegacyBase } from '../lib/ui-version';

/**
 * `/v3/holdings` → `/holdings`. See `stripLegacyBase`.
 *
 * v3 spent the whole rebuild mounted at `/v3`, so the readers most likely to
 * have bookmarked it are the ones who were testing it.
 */
export function LegacyV3PathRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={stripLegacyBase(pathname, LEGACY_V3_BASE, search)} replace />;
}

/**
 * `/v2/holdings` → `/holdings` (SC-423).
 *
 * The classic interface is gone, and `/v2` was its namespace for the whole
 * time it had one — so this prefix is in bookmarks, in shared links, and in
 * the installed PWA's start URL for every reader who had chosen it. Its route
 * names were v3's under a prefix by construction, so stripping the prefix
 * lands most of those readers on the screen they asked for; the rest reach
 * v3's not-found screen, which is a destination the classic interface's own
 * catch-all used to provide and nothing else did.
 *
 * The gate that used to wrap the v3 tree here is gone with it. It existed to
 * honour a stored preference for the classic UI by sending a root URL to
 * `/v2`, and there is nothing at `/v2` to send anyone to.
 */
export function LegacyV2PathRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={stripLegacyBase(pathname, LEGACY_V2_BASE, search)} replace />;
}
