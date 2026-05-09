import { createHash } from 'node:crypto';

/**
 * Deterministic pseudonymization helper for user-bearing identifiers in
 * structured logs.
 *
 * Why this exists: tenant identifiers (user IDs, account IDs) appear in
 * a *lot* of structured-log fields — request bindings, processor
 * payloads, error contexts. Forwarding them as plain UUIDs to a shared
 * log aggregator means anyone with read access can correlate every
 * action of a single tenant. Hashing with a per-deployment pepper
 * (`LOG_ID_PEPPER`) gives us correlatability **within** a deployment
 * (same user → same hash → join across services) without exposing the
 * raw identifier.
 *
 * Behaviour:
 *  - Input is a string (UUID or any opaque identifier).
 *  - Output is a 16-char hex prefix of `sha256(pepper || ":" || id)`.
 *  - Empty / nullish input returns the empty string — callers are
 *    expected to omit the field rather than log an empty string.
 *
 * If `LOG_ID_PEPPER` is unset (dev / OSS / single-developer), the
 * helper returns the raw id verbatim — pseudonymization is a
 * production-aggregator concern, not a dev-loop concern. Production
 * deploys MUST stage `LOG_ID_PEPPER` (see docs/technical/disaster-recovery.md).
 */
const PEPPER = process.env.LOG_ID_PEPPER;
const HEX_PREFIX_LEN = 16;

export function pseudonymizeId(id: string | null | undefined): string {
  if (!id) return '';
  if (!PEPPER) return id;
  return createHash('sha256').update(`${PEPPER}:${id}`).digest('hex').slice(0, HEX_PREFIX_LEN);
}

/**
 * Convenience for nested log payloads. Walks an object one level deep
 * and returns a shallow copy with any keys named `userId`, `user_id`,
 * `tenantId`, `accountId`, `apiKeyId` rewritten via `pseudonymizeId`.
 *
 * Single-level only by design — deeper traversal in a hot logging path
 * is a foot-gun. Callers logging structured payloads from the same
 * surface multiple times should pseudonymize the IDs once and pass
 * the result.
 */
const SENSITIVE_ID_KEYS = new Set([
  'userId',
  'user_id',
  'tenantId',
  'tenant_id',
  'accountId',
  'account_id',
  'apiKeyId',
  'api_key_id',
]);

export function pseudonymizeIdFields<T extends Record<string, unknown>>(payload: T): T {
  if (!PEPPER) return payload;
  let copied: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== 'string') continue;
    if (!SENSITIVE_ID_KEYS.has(key)) continue;
    if (!copied) copied = { ...payload };
    copied[key] = pseudonymizeId(value);
  }
  return (copied ?? payload) as T;
}
