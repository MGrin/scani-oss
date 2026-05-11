import type { Result } from '../result';
import { tryCatch } from '../result';
import { redisCmd } from './upstash';

/**
 * Operator-facing audit log for admin write actions.
 *
 * Backed by an Upstash list at `admin:audit`, capped at the most-recent
 * `CAP` entries via `LTRIM` on every write. The DLQ-style depth probe
 * never hits this — it's purely a record of what humans did, not what
 * the system did. Sample row JSON:
 *
 *   {
 *     "ts": "2026-05-11T12:34:56.000Z",
 *     "actor": "passkey:abcdef012345:1715423696",
 *     "action": "cloudflare.purge-cache",
 *     "target": "zone:scani.xyz",
 *     "outcome": "ok",
 *     "detail": "Purged 12 URLs"
 *   }
 *
 * Reads page through `LRANGE 0 N-1` (newest first because writes use
 * `LPUSH`). The page lives at `/audit-log`.
 */

const KEY = 'admin:audit';
const CAP = 500;

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
 * Record an audit entry. Best-effort — a Redis failure here must NEVER
 * fail the calling action. The action already happened (or didn't); we
 * just lose the audit row.
 */
export async function appendAudit(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
  const row: AuditEntry = { ts: new Date().toISOString(), ...entry };
  try {
    await redisCmd('LPUSH', KEY, JSON.stringify(row));
    // Keep only the most recent CAP entries. LTRIM is idempotent and
    // cheap; running it on every write keeps the list bounded without a
    // separate sweeper.
    await redisCmd('LTRIM', KEY, 0, CAP - 1);
  } catch {
    // Audit failures are non-fatal.
  }
}

export async function getAuditLog(limit = 100): Promise<Result<AuditEntry[]>> {
  return tryCatch(async () => {
    const raw = await redisCmd('LRANGE', KEY, 0, Math.max(0, limit - 1));
    if (!Array.isArray(raw)) return [];
    const entries: AuditEntry[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      try {
        const parsed = JSON.parse(item) as AuditEntry;
        if (parsed && typeof parsed.ts === 'string' && typeof parsed.action === 'string') {
          entries.push(parsed);
        }
      } catch {
        // Skip malformed rows — never fail the whole page on one bad entry.
      }
    }
    return entries;
  });
}
