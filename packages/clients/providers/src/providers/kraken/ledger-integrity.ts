/**
 * Audit a Kraken `/private/Ledgers` walk against Kraken's own
 * internal consistency, so a PARTIAL ledger stops looking like a
 * complete one.
 *
 * Kraken stamps two things on every ledger entry that together make
 * the feed self-describing:
 *
 *   - `balance` — the running balance of that asset immediately after
 *     the entry. Consecutive entries for one asset therefore have to
 *     satisfy `balance = previous + amount - fee`. A break names an
 *     entry that exists on Kraken's books and never reached us, with
 *     its size and its instant.
 *   - `refid` — the operation id. An instant convert is one `spend`
 *     and one `receive`; a spot trade is a base leg and a quote leg.
 *     A refid holding only one of them names an asset the ledger
 *     never mentioned at all — which no balance chain can catch,
 *     because the chain of an asset we never see does not exist.
 *
 * SC-392 measured both on production. mgrin's Kraken key returns 492
 * entries across XETH / ZUSD / XETH.F / BABY / XXBT / XXBT.F whose
 * balance chains reconcile exactly — and 34 of 77 convert refids plus
 * all 6 trade refids are missing their counter leg, ~$49k of notional
 * whose other side is USDC. Kraken has never returned a USDC entry
 * for that key, and scani claimed `hasCompleteTxHistory: true` over
 * it, which `CostBasisService` reads as a `complete` cost basis.
 *
 * The audit is pure and runs over what the walk already buffered, so
 * it costs no extra API call.
 */

import Decimal from 'decimal.js';
import type { KrakenLedgerEntry } from './api-service';

/** One row as `/private/Ledgers` states it: the map key plus its value. */
export interface KrakenLedgerRow {
  ledgerId: string;
  entry: KrakenLedgerEntry;
}

/** An entry Kraken's own running balance proves we never received. */
interface BalanceChainBreak {
  /** Kraken's raw asset code — `XETH` and `XETH.F` are separate balances. */
  asset: string;
  /** The entry at which the chain stopped adding up. */
  ledgerId: string;
  at: Date;
  expected: string;
  reported: string;
  /** `reported - expected`: the size and direction of what we never saw. */
  missing: string;
}

/** A two-legged operation that reached us with one leg. */
interface UnpairedOperation {
  refid: string;
  ledgerId: string;
  type: string;
  asset: string;
  amount: string;
  at: Date;
}

export interface KrakenLedgerAudit {
  balanceChainBreaks: BalanceChainBreak[];
  unpairedOperations: UnpairedOperation[];
  /** False when the ledger contradicts itself, whatever the cause. */
  isComplete: boolean;
}

const CONVERT_TYPES = new Set(['spend', 'receive']);

function at(entry: KrakenLedgerEntry): Date {
  return new Date(entry.time * 1000);
}

/**
 * The first entry of an asset SEEDS the chain rather than being
 * checked against zero. An incremental sync names a `start`, so its
 * oldest entry legitimately opens on a balance the walk never saw
 * accumulate; only interior breaks are evidence.
 */
function findBalanceChainBreaks(rows: readonly KrakenLedgerRow[]): BalanceChainBreak[] {
  const byAsset = new Map<string, KrakenLedgerRow[]>();
  for (const row of rows) {
    const bucket = byAsset.get(row.entry.asset);
    if (bucket) bucket.push(row);
    else byAsset.set(row.entry.asset, [row]);
  }

  const breaks: BalanceChainBreak[] = [];
  for (const [asset, bucket] of byAsset) {
    const ordered = [...bucket].sort((a, b) => a.entry.time - b.entry.time);
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (!previous || !current) continue;
      const expected = new Decimal(previous.entry.balance)
        .plus(current.entry.amount)
        .minus(current.entry.fee);
      const reported = new Decimal(current.entry.balance);
      if (expected.equals(reported)) continue;
      breaks.push({
        asset,
        ledgerId: current.ledgerId,
        at: at(current.entry),
        expected: expected.toString(),
        reported: reported.toString(),
        missing: reported.minus(expected).toString(),
      });
    }
  }
  return breaks;
}

/**
 * Only `spend`/`receive` and `trade` are audited. `staking`,
 * `deposit`, `withdrawal` and `adjustment` are single-legged by
 * nature, and a `transfer` can legitimately be too — Kraken books the
 * old `spottostaking` / `spotfromstaking` moves as funding operations
 * whose counter side carries its own refid.
 *
 * A `start`/`end` window cannot manufacture a false positive here:
 * both legs of a refid are stamped within milliseconds of each other
 * (max 4.5ms across the 65 multi-leg refids on production), so a
 * boundary lands either side of the pair, not between it.
 */
function findUnpairedOperations(rows: readonly KrakenLedgerRow[]): UnpairedOperation[] {
  const byRefid = new Map<string, KrakenLedgerRow[]>();
  for (const row of rows) {
    const bucket = byRefid.get(row.entry.refid);
    if (bucket) bucket.push(row);
    else byRefid.set(row.entry.refid, [row]);
  }

  const unpaired: UnpairedOperation[] = [];
  for (const [refid, bucket] of byRefid) {
    const types = bucket.map((r) => r.entry.type);
    const isConvert = types.every((t) => CONVERT_TYPES.has(t));
    const isTrade = types.every((t) => t === 'trade');
    if (!isConvert && !isTrade) continue;

    const complete = isConvert
      ? types.includes('spend') && types.includes('receive')
      : bucket.length >= 2;
    if (complete) continue;

    for (const { ledgerId, entry } of bucket) {
      unpaired.push({
        refid,
        ledgerId,
        type: entry.type,
        asset: entry.asset,
        amount: entry.amount,
        at: at(entry),
      });
    }
  }
  return unpaired.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function auditKrakenLedger(rows: readonly KrakenLedgerRow[]): KrakenLedgerAudit {
  const balanceChainBreaks = findBalanceChainBreaks(rows);
  const unpairedOperations = findUnpairedOperations(rows);
  return {
    balanceChainBreaks,
    unpairedOperations,
    isComplete: balanceChainBreaks.length === 0 && unpairedOperations.length === 0,
  };
}
