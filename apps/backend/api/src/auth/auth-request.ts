import { CLIENT_IP_HEADER } from './better-auth';

/**
 * Elysia has already consumed the request body by the time `/api/auth/*`
 * runs, so the Request handed to Better-Auth is rebuilt from the parsed body.
 * A form body has to go back as a form: the OAuth token and revoke endpoints
 * only take `application/x-www-form-urlencoded` (SC-1615), and a JSON string
 * under that content type parses as one meaningless key.
 */
export function rebuildAuthRequest(
  request: Request,
  body: unknown,
  headers: Record<string, string | undefined>,
  clientIp: string
): Request {
  const cloneHeaders = new Headers();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (typeof v === 'string') cloneHeaders.set(k, v);
  }
  // Overwrites anything the client sent under this name (SC-1351).
  cloneHeaders.set(CLIENT_IP_HEADER, clientIp);
  const init: RequestInit = { method: request.method, headers: cloneHeaders };
  if (request.method !== 'GET' && request.method !== 'HEAD' && body !== undefined) {
    const isForm = cloneHeaders
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/x-www-form-urlencoded');
    if (typeof body === 'string') {
      init.body = body;
    } else if (isForm && body && typeof body === 'object') {
      init.body = new URLSearchParams(body as Record<string, string>).toString();
    } else {
      init.body = JSON.stringify(body);
    }
    if (!cloneHeaders.has('content-type')) {
      cloneHeaders.set('content-type', 'application/json');
    }
  }
  return new Request(request.url, init);
}
