import type { Result } from '../result';
import { tryCatch } from '../result';
import { signedAdminJson } from './backend-admin';

/**
 * Operator-facing audit log for admin write actions.
 *
 * Rows live in the backend's tamper-evident `admin_audit_log` Postgres
 * table — the same HMAC-chained trail the job retry/remove endpoints
 * write — reached through the HMAC-gated `/admin/audit-log` endpoints.
 * (Previously an Upstash list at `admin:audit`; unified into Postgres
 * when the Upstash database was retired, 2026-07.) The page lives at
 * `/audit-log`.
 */

export type AuditOutcome = 'ok' | 'error' | 'denied';

export interface AuditEntry {
  /** ISO timestamp. */
  ts: string;
  /** `passkey:<credShort>:<sessionIat>` per the HMAC actor convention. */
  actor: string;
  /** Dot-separated action key (e.g. `cloudflare.purge-cache`, `bullmq.retry`). */
  action: string;
  /** Short target identifier — zone name, machine id, job id, etc. */
  target?: string;
  /** Whether the action succeeded, errored, or was denied (e.g. flag off). */
  outcome: AuditOutcome;
  /** Free-form one-liner with extra context. */
  detail?: string;
}

/**
 * Record an audit entry. Best-effort — a backend failure here must NEVER
 * fail the calling action. The action already happened (or didn't); we
 * just lose the audit row.
 */
export async function appendAudit(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
  try {
    await signedAdminJson('POST', '/admin/audit-log', {
      actor: entry.actor,
      body: {
        action: entry.action,
        target: entry.target,
        outcome: entry.outcome,
        detail: entry.detail,
      },
    });
  } catch {
    // Audit failures are non-fatal.
  }
}

export async function getAuditLog(limit = 100): Promise<Result<AuditEntry[]>> {
  return tryCatch(async () => {
    const parsed = await signedAdminJson<{ entries?: AuditEntry[] }>(
      'GET',
      `/admin/audit-log?limit=${Math.max(1, limit)}`
    );
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  });
}
