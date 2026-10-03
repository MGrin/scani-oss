import { reachedPublicIngress } from '@scani/rate-limiter';

/**
 * Is this the data-provider asking who a Cloud console user is?
 *
 * It calls `GET /api/auth/get-session` over the private network, where no
 * public-ingress header is set, so the inflow key collapses every such call
 * onto one bucket and the console's traffic would starve itself at 300/min.
 * Only where the ingress is marked (on Fly, or `SCANI_INGRESS_MARKED=on`) does
 * that header's absence identify a private caller; elsewhere nothing is exempt.
 */
export function isPrivateSessionRead(request: Request, ingressMarked: boolean): boolean {
  if (!ingressMarked || request.method !== 'GET') return false;
  if (reachedPublicIngress(request)) return false;
  try {
    return new URL(request.url).pathname === '/api/auth/get-session';
  } catch {
    return false;
  }
}
