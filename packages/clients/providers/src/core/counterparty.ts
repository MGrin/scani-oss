/**
 * Per-source counterparty/description extraction over a provider's
 * `rawPayload`.
 *
 * Only sources whose transactions carry a real payee/payer get an
 * extractor: today that's Wise and Airwallex (multi-currency account
 * ledgers where every line has a counterparty). Crypto exchange trades
 * and chain swaps are asset-centric — there is no payee to find, and a
 * missing entry in `EXTRACTORS` yields `{}` for them, which is correct,
 * not a gap.
 *
 * Runs over every historical `holding_transactions` row during the
 * counterparty backfill (see
 * `apps/backend/worker/src/processors/backfill-counterparty.ts`), so it
 * must be total: an unexpected `rawPayload` shape must never throw, only
 * yield `{}`. Same discipline as
 * `packages/business/domain/src/services/reviewSummary.ts`.
 */

export interface CounterpartyExtraction {
  counterparty?: string;
  description?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * wise: `WiseStatementTransaction` (`providers/wise/index.ts`) —
 * `{ type, date, amount, totalFees?, details?: { type?, description? },
 * referenceNumber }`. `details.description` is the only free-text field
 * the statement API exposes on our type; Wise gives no separate
 * structured payee (no `recipient`/`merchant` field is declared), so it
 * doubles as both the statement line and the best-effort counterparty.
 * CONVERSION rows and the sibling fee row (`{ referenceNumber,
 * totalFees }`) carry no `details.description` at all — `{}` for those
 * is expected, not a miss.
 */
function extractWise(raw: unknown): CounterpartyExtraction {
  const root = asRecord(raw);
  const details = asRecord(root?.details);
  const description = asNonEmptyString(details?.description);
  if (!description) return {};
  return { counterparty: description, description };
}

/**
 * airwallex: `AirwallexFinancialTransaction` (`providers/airwallex/index.ts`)
 * — `{ id, amount?, currency?, source_type?, financial_transaction_type?,
 * status?, created_at?, description? }`. `description` is typed and
 * top-level; same reasoning as Wise applies to reusing it for both
 * fields — it's the only free-text signal our type declares.
 */
function extractAirwallex(raw: unknown): CounterpartyExtraction {
  const root = asRecord(raw);
  const description = asNonEmptyString(root?.description);
  if (!description) return {};
  return { counterparty: description, description };
}

// Keyed by the `holding_transactions.source` tag (see
// `packages/business/domain/src/services/transactions/transaction-source.ts`).
// Both the `-api` tag and the bare provider name are registered: Wise's
// tag isn't wired into that map yet (`sourceForProvider('wise')` returns
// null today — transaction import is dormant for it), so 'wise-api' is
// the forward-compatible tag and 'wise' is a defensive alias.
const EXTRACTORS: Record<string, (raw: unknown) => CounterpartyExtraction> = {
  'wise-api': extractWise,
  wise: extractWise,
  'airwallex-api': extractAirwallex,
  airwallex: extractAirwallex,
};

export function extractCounterparty(source: string, rawPayload: unknown): CounterpartyExtraction {
  const extractor = EXTRACTORS[source];
  if (!extractor) return {};
  try {
    return extractor(rawPayload);
  } catch {
    // Defensive accessors above should make this unreachable, but the
    // backfill sweep runs unattended over ~1850 unstructured historical
    // payloads — a thrown extractor must not abort the batch.
    return {};
  }
}
