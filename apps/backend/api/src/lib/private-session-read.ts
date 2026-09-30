/**
 * Is this the data-provider asking who a Cloud console user is?
 *
 * It calls `GET /api/auth/get-session` over Fly's private network, where no
 * `fly-client-ip` is set, so the inflow key collapses every such call onto the
 * one `fly:no-client-ip` bucket and the console's traffic would starve itself
 * at 300/min. Fly's public proxy always sets that header, so on Fly its
 * absence identifies a private-network caller; off Fly nothing sets it, and
 * nothing is exempt.
 */
export function isPrivateSessionRead(request: Request, onFly: boolean): boolean {
  if (!onFly || request.method !== 'GET') return false;
  if (request.headers.has('fly-client-ip')) return false;
  try {
    return new URL(request.url).pathname === '/api/auth/get-session';
  } catch {
    return false;
  }
}
