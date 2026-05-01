/**
 * Bitstamp's `/api/v2/user_transactions/` returns rows with a per-pair
 * dynamic shape: a BTC/USD trade looks like
 * `{ btc: '-0.1', usd: '5000.00', btc_usd: '50000.00', fee: '...', ... }`,
 * an ETH/EUR trade like `{ eth: '1.0', eur: '2500.00', eth_eur: '...' }`,
 * and a deposit like `{ btc: '0.5' }` with no underscored price key.
 *
 * The resolver here detects (base, quote) by walking the row's numeric
 * keys and looking for an `<x>_<y>` pair where both `<x>` and `<y>` are
 * also present as plain numeric keys — the price field. For non-trade
 * rows (deposits / withdrawals / sub-account transfers) only one
 * currency leg appears; `resolveSingleAsset` returns it.
 */

import Decimal from 'decimal.js';

const RESERVED_KEYS = new Set([
  'id',
  'datetime',
  'type',
  'subtype',
  'order_id',
  'fee',
  'side',
  'tid',
  'eur_usd_rate',
]);

export interface PairResolution {
  /** Lowercase base currency, e.g. `btc`. */
  base: string;
  /** Lowercase quote currency, e.g. `usd`. */
  quote: string;
  /** The composed key holding the per-unit price, e.g. `btc_usd`. */
  priceKey: string;
}

function parseNumeric(value: unknown): Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const dec = new Decimal(value);
    return dec.isFinite() ? dec : null;
  } catch {
    return null;
  }
}

function collectNumericKeys(row: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(row)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (parseNumeric(value) !== null) out.add(key);
  }
  return out;
}

/**
 * Detect the trading pair from a `user_transactions` row. Returns null
 * for non-trade rows where no `<base>_<quote>` price field is present.
 */
export function resolvePair(row: Record<string, unknown>): PairResolution | null {
  const numericKeys = collectNumericKeys(row);
  for (const key of numericKeys) {
    if (!key.includes('_')) continue;
    const idx = key.indexOf('_');
    const base = key.slice(0, idx);
    const quote = key.slice(idx + 1);
    if (!base || !quote) continue;
    if (numericKeys.has(base) && numericKeys.has(quote)) {
      return { base, quote, priceKey: key };
    }
  }
  return null;
}

/**
 * For non-trade rows: return the single non-zero asset key carrying the
 * amount (e.g. a deposit row with `{ btc: '0.5' }` returns `'btc'`).
 * Returns null when zero or more than one candidate asset is present.
 */
export function resolveSingleAsset(row: Record<string, unknown>): string | null {
  const candidates: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (key.includes('_')) continue;
    const num = parseNumeric(value);
    if (num !== null && !num.isZero()) candidates.push(key);
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
