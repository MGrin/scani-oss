import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { gateRedirect, legacyV3Redirect } from '../lib/ui-version';

/**
 * Honours a stored preference for the classic UI on the root routes.
 *
 * v3 is what `/` serves now (V3-19), so this wraps the *v3* tree — the mirror
 * of what it used to do. With no stored choice the reader gets v3; with `v2`
 * stored they are sent to the same screen under `/v2`, which is what makes the
 * flip invisible to someone who had already chosen the classic UI. Their old
 * root bookmarks and the installed PWA's `/` both land them back where they
 * were.
 *
 * There is no gate in the other direction any more, and that is the point of
 * giving v2 its own namespace: a `/v2/...` URL after the flip can only come
 * from the switch or from a deliberate link, so it is honoured rather than
 * bounced. The old gate had to redirect v2 paths — the two trees shared one
 * namespace and a v2 URL was usually reached by habit — which is why it needed
 * an exemption list (`V2_BORROWED_PATHS`) for the v2 screens v3 linked to on
 * purpose. One namespace each retires both the redirect and the list.
 *
 * Wraps the authenticated tree only, so it never sees the public auth routes
 * and cannot redirect a sign-in away. The decision itself is `gateRedirect`,
 * which is where it is asserted.
 */
export function UiVersionGate({ children }: { children: ReactElement }) {
  const { pathname, search } = useLocation();
  const redirect = gateRedirect(pathname, search);

  return redirect === null ? children : <Navigate to={redirect} replace />;
}

/**
 * `/v3/holdings` → `/holdings`. See `legacyV3Redirect`.
 */
export function LegacyV3PathRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={legacyV3Redirect(pathname, search)} replace />;
}
