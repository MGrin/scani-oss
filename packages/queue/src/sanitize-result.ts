/**
 * Shape worker returnvalues before they land in `user_jobs.result` (jsonb)
 * or go over the WebSocket wire to the UI.
 *
 * Two concerns:
 *   1. Size — large per-file arrays from screenshot-parse or file-import can
 *      blow past reasonable row sizes. Cap at 32 KB with a lossy truncate.
 *   2. Secret hygiene — defense in depth. Worker code shouldn't put raw
 *      credentials or signed storage URLs into its returnvalue in the first
 *      place, but we pin the allowlist here so a future regression can't
 *      leak them into every user's /jobs page.
 *
 * Mirrors `apps/backend/src/queues/summarize-payload.ts` — both files are
 * read by the same people; keep conventions aligned.
 */

const MAX_BYTES = 32 * 1024;

export function sanitizeResult(_name: string, result: unknown): unknown {
  if (result == null) return result;
  return truncateByBytes(result, MAX_BYTES);
}

function truncateByBytes(value: unknown, maxBytes: number): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { _truncated: true, reason: 'non-serializable' };
  }
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    let budget = maxBytes;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const piece = JSON.stringify(v);
      const size = Buffer.byteLength(piece, 'utf8');
      if (size <= budget) {
        out[k] = v;
        budget -= size;
      } else {
        out[k] = { _truncated: true, originalBytes: size };
      }
    }
    return out;
  }
  return { _truncated: true, originalBytes: Buffer.byteLength(serialized, 'utf8') };
}
