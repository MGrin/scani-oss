import { createHmac } from 'node:crypto';
import { desc } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { adminAuditLog } from './schema/admin-audit-log';

// Cap audit-log detail payloads so a misbehaving caller can't inflate
// the jsonb column (every write tries to log; an OOM here would take
// down the admin surface entirely). Strings are truncated, nested
// objects are stringified-and-truncated, everything else passes
// through. Single-level walk only — deeper hostile payloads are
// flattened rather than fully sanitised.
const AUDIT_DETAIL_MAX_KEYS = 20;
const AUDIT_DETAIL_VALUE_MAX_CHARS = 1024;

function sanitizeAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, v] of Object.entries(input)) {
    if (keys >= AUDIT_DETAIL_MAX_KEYS) break;
    if (v == null) {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] =
        v.length > AUDIT_DETAIL_VALUE_MAX_CHARS
          ? `${v.slice(0, AUDIT_DETAIL_VALUE_MAX_CHARS)}…`
          : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      const stringified = JSON.stringify(v);
      out[k] =
        stringified.length > AUDIT_DETAIL_VALUE_MAX_CHARS
          ? `${stringified.slice(0, AUDIT_DETAIL_VALUE_MAX_CHARS)}…`
          : stringified;
    }
    keys++;
  }
  return out;
}

// Canonical serialization for the HMAC chain. Order is fixed and
// independent of insertion order so a verifier can recompute the
// signature without seeing the schema. JSON.stringify of `details` is
// already canonicalized by sanitizeAuditDetails (it walks keys in
// insertion order); we accept that as the "as-stored" payload.
function canonicalAuditPayload(row: {
  actor: string;
  action: string;
  resource: string;
  result: string;
  details: Record<string, unknown>;
  createdAtIso: string;
  prevSignature: string;
}): string {
  return [
    `actor=${row.actor}`,
    `action=${row.action}`,
    `resource=${row.resource}`,
    `result=${row.result}`,
    `details=${JSON.stringify(row.details)}`,
    `created_at=${row.createdAtIso}`,
    `prev=${row.prevSignature}`,
  ].join('\n');
}

export interface AuditRow {
  actor: string;
  action: string;
  resource: string;
  result: 'success' | 'failure' | 'denied';
  details: Record<string, unknown>;
}

/**
 * Appends one row to `admin_audit_log` through `executor`, which may be a
 * transaction: a caller that must not change state without a record passes
 * its transaction, so a failed append rolls the change back with it. Throws
 * on failure; swallowing is the caller's decision.
 *
 * With `hmacSecret` the row joins the HMAC chain (migration 0014). Race: two
 * concurrent writers might both read the same prev row and produce sibling
 * rows that share `prev_signature`. That's still detectable by the verifier
 * (the chain forks) but would make a clean linear chain harder to rebuild.
 * Writes are single-actor in practice, so concurrent writes are rare; if
 * that changes, take a Postgres advisory lock keyed on the table name.
 */
export async function appendAuditRow<T extends PgQueryResultHKT>(
  executor: PgDatabase<T, Record<string, unknown>>,
  row: AuditRow,
  hmacSecret: string | undefined
): Promise<void> {
  const details = sanitizeAuditDetails(row.details);
  // Use the same `created_at` value in both the signature and the
  // INSERT so the canonical payload exactly matches what's stored.
  const createdAt = new Date();
  let prevSignature = '';
  let signature: string | null = null;
  if (hmacSecret) {
    const [prev] = await executor
      .select({ signature: adminAuditLog.signature })
      .from(adminAuditLog)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(1);
    prevSignature = prev?.signature ?? '';
    signature = createHmac('sha256', hmacSecret)
      .update(
        canonicalAuditPayload({
          ...row,
          details,
          createdAtIso: createdAt.toISOString(),
          prevSignature,
        })
      )
      .digest('hex');
  }
  await executor.insert(adminAuditLog).values({
    ...row,
    details,
    createdAt,
    prevSignature: hmacSecret ? prevSignature : null,
    signature,
  });
}
