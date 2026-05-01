// Shapes worker return values before they land in `user_jobs.result`
// (jsonb) or go over the WS wire to the UI.
//
// Two concerns:
//   1. Size — large per-file arrays from screenshot-parse / file-import
//      can blow past reasonable row sizes. Cap at the configured maxBytes.
//   2. Secret hygiene — defense in depth. Worker code shouldn't put raw
//      credentials or signed storage URLs into its return value in the
//      first place, but a future regression shouldn't leak them into
//      every user's /jobs page.
const DEFAULT_MAX_BYTES = 32 * 1024;

export class ResultTruncator {
  constructor(private readonly maxBytes: number = DEFAULT_MAX_BYTES) {}

  truncate(value: unknown): unknown {
    if (value == null) return value;
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return { _truncated: true, reason: 'non-serializable' };
    }
    if (Buffer.byteLength(serialized, 'utf8') <= this.maxBytes) return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = {};
      let budget = this.maxBytes;
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
}
