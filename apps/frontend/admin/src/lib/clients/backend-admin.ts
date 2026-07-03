/**
 * HMAC-signed fetch against the backend's `/admin/*` endpoints — the
 * shared transport for everything that used to hit Upstash REST
 * directly (queue reads, spend overrides, the audit log). Signs
 *   `${method}\n${path}\n${timestamp}\n${actor}\n${sha256Hex(body)}`
 * with `JOBS_HMAC_SECRET`, matching the backend's admin gate.
 *
 * Pass the passkey-session actor for writes so the backend audit trail
 * attributes them; reads that run during page render (no per-request
 * caller in scope) fall back to a constant app-level actor.
 */

import { hmacSha256Hex, sha256Hex } from '../auth/admin-write';
import { getEnv } from '../env';

export const READ_ACTOR = 'admin-app:read';

export async function signedAdminFetch(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { body?: unknown; actor?: string } = {}
): Promise<Response> {
  const secret = getEnv('JOBS_HMAC_SECRET');
  const backendUrl = getEnv('BACKEND_BASE_URL') ?? 'https://api.scani.xyz';
  if (!secret) throw new Error('JOBS_HMAC_SECRET missing — cannot reach backend admin endpoints');

  const actor = opts.actor ?? READ_ACTOR;
  const bodyText = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const timestamp = String(Date.now());
  // Signature covers the path WITHOUT the query string — mirror of the
  // backend, which verifies `new URL(request.url).pathname`.
  const pathname = path.split('?')[0] ?? path;
  const canonical = `${method}\n${pathname}\n${timestamp}\n${actor}\n${await sha256Hex(bodyText)}`;
  const hmacHex = await hmacSha256Hex(secret, canonical);

  const headers: Record<string, string> = {
    'x-admin-hmac': hmacHex,
    'x-admin-timestamp': timestamp,
    'x-admin-actor': actor,
  };
  if (bodyText) headers['content-type'] = 'application/json';

  return fetch(`${backendUrl}${path}`, {
    method,
    headers,
    body: bodyText || undefined,
    cache: 'no-store',
  });
}

/** `signedAdminFetch` + status check + JSON parse in one call. */
export async function signedAdminJson<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { body?: unknown; actor?: string } = {}
): Promise<T> {
  const res = await signedAdminFetch(method, path, opts);
  if (!res.ok) throw new Error(`backend admin ${method} ${path} returned ${res.status}`);
  return (await res.json()) as T;
}
