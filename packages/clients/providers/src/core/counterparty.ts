/**
 * Per-source counterparty/description extraction over a provider's
 * `rawPayload`.
 *
 * Only sources whose transactions carry a real payee/payer get an
 * extractor: Wise and Airwallex (multi-currency account ledgers where
 * every line has a counterparty), and Etherscan, where a transfer names
 * the address on the other side of it.
 *
 * Exchange TRADES stay unextracted and that is still correct — a Kraken
 * buy is asset-centric and has no payee, so a missing entry yields `{}`.
 * That reasoning used to be written as "crypto is asset-centric", which
 * swept chain TRANSFERS in with it and was wrong about them (SC-329):
 ***REMOVED***
 * `from` in its payload and a NULL counterparty, while the transfer
 * review queue rendered that empty column under the label "to" — the
 * one screen whose whole question is where the money went.
 *
 * Runs over every historical `holding_transactions` row during the
 * counterparty backfill (see
 * `apps/backend/worker/src/processors/backfill-counterparty.ts`), so it
 * must be total: an unexpected `rawPayload` shape must never throw, only
 * yield `{}`. Same discipline as
 * `packages/business/domain/src/services/reviewDetail.ts`.
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

/**
 * etherscan: a normal-transaction / token-transfer row — `{ from, to,
 * hash, value, ... }`. Both sides are always present, so which one is
 * the counterparty depends on which way the value moved: for an outflow
 * it is `to`, for an inflow it is `from`. That is why this extractor
 * needs `kind` and the ledger ones do not.
 *
 * Deliberately returns NO `description`. `to` is a 42-character hex
 * address, not prose — it belongs in the field the review queue labels
 * "to", and putting it in `description` as well would render the same
 * address twice on one row.
 *
 * An unknown `kind` yields `{}` rather than guessing a direction. A
 * counterparty pointing the wrong way is worse than an absent one: it
 * would say the user sent funds to themselves.
 */
function extractEtherscan(raw: unknown, kind?: string): CounterpartyExtraction {
  const root = asRecord(raw);
  if (!root) return {};
  if (kind && OUTFLOW_KINDS.has(kind)) {
    const to = asNonEmptyString(root.to);
    return to ? { counterparty: to } : {};
  }
  if (kind && INFLOW_KINDS.has(kind)) {
    const from = asNonEmptyString(root.from);
    return from ? { counterparty: from } : {};
  }
  return {};
}

/** Value leaving the wallet — the counterparty is the destination. */
const OUTFLOW_KINDS = new Set(['transfer_out', 'withdraw', 'swap_out', 'sell']);
/** Value arriving — the counterparty is the sender. */
const INFLOW_KINDS = new Set(['transfer_in', 'deposit', 'swap_in', 'buy', 'airdrop']);

// Keyed by the `holding_transactions.source` tag (see
// `packages/business/domain/src/services/transactions/transaction-source.ts`).
// Both the `-api` tag and the bare provider name are registered: Wise's
// tag isn't wired into that map yet (`sourceForProvider('wise')` returns
// null today — transaction import is dormant for it), so 'wise-api' is
// the forward-compatible tag and 'wise' is a defensive alias.
const EXTRACTORS: Record<string, (raw: unknown, kind?: string) => CounterpartyExtraction> = {
  'wise-api': extractWise,
  wise: extractWise,
  'airwallex-api': extractAirwallex,
  airwallex: extractAirwallex,
  etherscan: extractEtherscan,
};

export function extractCounterparty(
  source: string,
  rawPayload: unknown,
  /** Required only by direction-dependent sources; the ledger ones ignore it. */
  kind?: string
): CounterpartyExtraction {
  const extractor = EXTRACTORS[source];
  if (!extractor) return {};
  try {
    return extractor(rawPayload, kind);
  } catch {
    // Defensive accessors above should make this unreachable, but the
    // backfill sweep runs unattended over ~1850 unstructured historical
    // payloads — a thrown extractor must not abort the batch.
    return {};
  }
}
