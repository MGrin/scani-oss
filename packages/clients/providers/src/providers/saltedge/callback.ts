import { createVerify } from 'node:crypto';

/**
 * Salt Edge signs every callback with its own key: a base64 RSA-SHA256
 * `Signature` header over `callback_url|raw_body`. Partners cannot use mutual
 * TLS instead, so this is the only proof a callback came from Salt Edge.
 *
 * `callbackUrl` must be the exact URL Salt Edge was told to call, not the one
 * this process sees behind a proxy, or every genuine callback fails.
 */
export function verifySaltEdgeCallback(
  callbackUrl: string,
  rawBody: string,
  signature: string,
  publicKeyPem: string
): boolean {
  if (!signature) return false;
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${callbackUrl}|${rawBody}`);
    return verifier.verify(publicKeyPem, signature, 'base64');
  } catch {
    return false;
  }
}

interface SaltEdgeCallback {
  connectionId: string;
  customerId: string;
  /** `error_class` on a fail callback, `reason` on a consent one. */
  errorClass?: string;
}

/** The fields a callback is acted on by, or null when it lacks them. */
export function parseSaltEdgeCallback(rawBody: string): SaltEdgeCallback | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const data = (parsed as { data?: Record<string, unknown> } | null)?.data;
  if (!data) return null;
  const id = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  const connectionId = id(data.connection_id);
  const customerId = id(data.customer_id);
  if (!connectionId || !customerId) return null;
  const errorClass = id(data.error_class) ?? id(data.reason);
  return errorClass ? { connectionId, customerId, errorClass } : { connectionId, customerId };
}
