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
//
// SC-145: an oversized field used to be *replaced* by a marker object.
// That silently changed `chains: [...]` into `chains: {_truncated: true}`,
// and a reader doing `Array.isArray(result.chains)` then took a branch
// meant for a different outcome and asserted a cause that never happened.
// A size guard must never hand a consumer a value of a type it did not
// produce: an over-budget field is now OMITTED, and the omission is
// reported once, out of band, under `_truncation`. `undefined` is a shape
// every reader already has to handle; a differently-typed value is not.

/** Durable copy (the `user_jobs.result` jsonb row) — read by the review
 *  UI and by `walletImport.confirmHoldings`, so it has to hold real
 *  payloads. jsonb TOASTs, and 2 MB is ~7k wallet tokens. */
export const DURABLE_RESULT_MAX_BYTES = 2 * 1024 * 1024;

/** Live WS copy. Every open tab gets this on completion and no surface
 *  renders from it while the durable row is reachable, so it stays small. */
export const WIRE_RESULT_MAX_BYTES = 32 * 1024;

export const TRUNCATION_KEY = '_truncation';

/** Marks a root-level value (an array or scalar result) that did not fit. */
export const TRUNCATION_ROOT_FIELD = '<root>';

export interface TruncationNotice {
  /** Field names dropped from the object, or `['<root>']` for a whole value. */
  omittedFields: string[];
  /** Serialized size of the value before anything was dropped. */
  originalBytes: number;
}

/** Reads the notice off a sanitized result. Null when nothing was dropped. */
export function readTruncationNotice(result: unknown): TruncationNotice | null {
  if (!result || typeof result !== 'object') return null;
  const notice = (result as Record<string, unknown>)[TRUNCATION_KEY];
  if (!notice || typeof notice !== 'object') return null;
  const { omittedFields, originalBytes } = notice as Record<string, unknown>;
  if (!Array.isArray(omittedFields)) return null;
  return {
    omittedFields: omittedFields.filter((f): f is string => typeof f === 'string'),
    originalBytes: typeof originalBytes === 'number' ? originalBytes : 0,
  };
}

export class ResultTruncator {
  constructor(private readonly maxBytes: number = DURABLE_RESULT_MAX_BYTES) {}

  truncate(value: unknown): unknown {
    if (value == null) return value;
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return {
        [TRUNCATION_KEY]: { omittedFields: [TRUNCATION_ROOT_FIELD], originalBytes: 0 },
      };
    }
    const totalBytes = Buffer.byteLength(serialized, 'utf8');
    if (totalBytes <= this.maxBytes) return value;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = {};
      const omittedFields: string[] = [];
      let budget = this.maxBytes;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const size = Buffer.byteLength(JSON.stringify(v) ?? 'null', 'utf8');
        if (size <= budget) {
          out[k] = v;
          budget -= size;
        } else {
          omittedFields.push(k);
        }
      }
      out[TRUNCATION_KEY] = { omittedFields, originalBytes: totalBytes };
      return out;
    }

    return {
      [TRUNCATION_KEY]: { omittedFields: [TRUNCATION_ROOT_FIELD], originalBytes: totalBytes },
    };
  }
}
