import * as schema from '@scani/db/schema';
import type { SQL } from 'drizzle-orm';
import { asc, desc, sql } from 'drizzle-orm';

/**
 * The one order a ledger walk is allowed to read its events in (SC-342).
 *
 * FIFO lot matching is a fold over a sequence, so the answer is only a
 * function of the data if the sequence is. It was not: the repository ordered
 * on `occurred_at` alone, `CostBasisService` sorted on `(occurredAt,
 * outflowRank)`, and `Array.prototype.sort` is stable — so two events sharing
 * both keys were matched in whatever physical order Postgres happened to
 * return, which changes on a VACUUM, a dump/restore, a table rewrite or a
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 *
 * ## The keys, and why each one is there
 *
 * 1. `occurred_at` — when the source says it happened. The real order.
 * 2. outflow rank — an outflow before an inflow at the same instant, so a
 *    `transfer_out` buffers its lots before the paired `transfer_in` reaches
 *    for them (see `CostBasisService.walkComponent`).
 * 3. `source` — an `external_id` only means something inside the provider
 *    that issued it. Comparing a Kraken trade id against a Solana signature
 *    is comparing nothing; this keeps each provider's ids together.
 * 4. `external_id` — **chosen over `id` deliberately.** Where the provider
 *    numbers its own events this is real sequence, not an arbitrary one:
 *    IBKR's execution ids are fixed-width 10-digit integers, so ascending
 ***REMOVED***
 ***REMOVED***
 *    a hash (Solana signatures, `etherscan`'s `hash-contract`) it carries no
 *    sequence, but it is still intrinsic to the event rather than to our
 *    storage. `id` would be arbitrary in both cases.
 *    Caveat worth knowing: a future source with *variable-width* numeric ids
 *    would sort "10" before "9". That is no worse than `id`, which is
 *    arbitrary everywhere — and it stays deterministic, which is the point.
 * 5. `id` — the guarantee of totality, and it is load-bearing rather than
 *    decorative: `external_id` is unique only per (holding, source), and
 ***REMOVED***
 *    production (occurred_at, rank, source, external_id) keys are shared by
 *    two holdings — both legs of a transfer carry the same chain hash.
 *
 * `created_at` was considered and rejected on measurement: an importer writes
 * its batch in one statement, so `now()` is identical for every row in it, and
 ***REMOVED***
 * discriminates exactly the rows that never needed discriminating.
 *
 * ## Both ends, or neither
 *
 * The SQL and the in-memory comparator have to agree, because they are both
 * live: `walkLots` consumes the repository's order directly while
 * `walkComponent` re-sorts. `COLLATE "C"` on the text keys is what makes them
 * agree — production runs `C.UTF-8`, so it is already a no-op there, but a
 * self-hosted `en_US.UTF-8` database would otherwise order punctuation and
 * case differently from JavaScript's code-unit comparison and quietly hand
 * the two walkers different sequences.
 */

/**
 * Kinds that sort before a same-instant inflow.
 *
 * The rank exists for one reason: a `transfer_out` has to buffer its lots
 * before the paired `transfer_in` reaches for them, and the two legs of a
 * same-block move share a timestamp. `sell` and `swap_out` join them because
 * an outflow cannot consume a lot the same instant creates — you sell what
 * you already held.
 *
 * These are the same four kinds `CostBasisService` treats as outflows today,
 * and that is a coincidence rather than a constraint: a kind that leaves the
 * portfolio without a paired inflow (a burn, say) would belong in its outflow
 * branches and have no reason to be here.
 */
const LEDGER_OUTFLOW_KINDS: ReadonlySet<string> = new Set([
  'sell',
  'swap_out',
  'withdraw',
  'transfer_out',
]);

function outflowRank(kind: string): number {
  return LEDGER_OUTFLOW_KINDS.has(kind) ? 0 : 1;
}

/** The columns a walk orders on. Anything with these is orderable. */
export interface LedgerOrderKey {
  occurredAt: Date;
  kind: string;
  source: string;
  externalId: string;
  id: string;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareLedgerEvents(a: LedgerOrderKey, b: LedgerOrderKey): number {
  const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  const byKind = outflowRank(a.kind) - outflowRank(b.kind);
  if (byKind !== 0) return byKind;
  const bySource = compareText(a.source, b.source);
  if (bySource !== 0) return bySource;
  const byExternal = compareText(a.externalId, b.externalId);
  if (byExternal !== 0) return byExternal;
  return compareText(a.id, b.id);
}

/** Copy of `txs` in canonical order. Never sorts the caller's array. */
export function sortLedgerEvents<T extends LedgerOrderKey>(txs: ReadonlyArray<T>): T[] {
  return txs.slice().sort(compareLedgerEvents);
}

const tx = schema.holdingTransactions;

const kindRank = sql`case when ${tx.kind} in ('sell', 'swap_out', 'withdraw', 'transfer_out') then 0 else 1 end`;

/**
 * `ORDER BY` clause matching `compareLedgerEvents`, for every read a cost
 * walk (or a paginated list, which needs a total order for its own reasons)
 * consumes.
 */
export function ledgerOrderBy(direction: 'asc' | 'desc' = 'asc'): SQL[] {
  const dir = direction === 'asc' ? asc : desc;
  return [
    dir(tx.occurredAt),
    dir(kindRank),
    dir(sql`${tx.source} collate "C"`),
    dir(sql`${tx.externalId} collate "C"`),
    dir(tx.id),
  ];
}
