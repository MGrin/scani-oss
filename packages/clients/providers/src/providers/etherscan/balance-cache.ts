import { StoreCommandTimeoutError, withDeadline } from '@scani/deadline';
import type { Redis } from 'ioredis';

/**
 * ERC-20 balances that cannot have moved since they were last read (SC-1513).
 *
 * The hourly wallet sync spent ~110s of every run on one `tokenbalance` call
 * per discovered token, behind a 5/s limit — 346 calls on 2026-10-03, most of
 * them for spam and long-emptied tokens whose answer never changes. A balance
 * moves only by a `Transfer`, so a balance read while the address's newest
 * transfer of that token was X is still right while it is still X.
 *
 * Three ways that is not enough, each handled where it is decided:
 *
 * - **Tokens whose balance moves WITHOUT a transfer** — rebasing and interest
 *   bearing ones. The shadow run that measured this caught stETH. They are
 *   never served from here (`balanceMovesWithoutTransfers`).
 * - **Anything the list misses** — every entry expires after a day, so no
 *   cached balance is older than one day whatever kind of token it is.
 * - **Redis missing, down or slow** — it restarts with every worker deploy. A
 *   read that fails or does not answer inside the deadline is a MISS for
 *   every key, which means the caller fetches. Nothing here ever supplies a
 *   balance it did not read from the chain.
 */

export const BALANCE_CACHE_TTL_SECONDS = 86_400;
const DEADLINE_MS = 500;

/**
 * A transfer this recent may not be reflected in the balance Etherscan serves
 * yet, and caching that answer would keep it for a day.
 */
export const SETTLE_SECONDS = 15 * 60;

/**
 * Matched by symbol, not contract: a spam token wearing one of these names
 * costs one extra call an hour, and a real one is never served stale.
 */
const MOVES_WITHOUT_TRANSFERS = new Set(['steth', 'ampl', 'ousd']);

export function balanceMovesWithoutTransfers(symbol: string, name: string): boolean {
  return MOVES_WITHOUT_TRANSFERS.has(symbol.trim().toLowerCase()) || /^aave /i.test(name.trim());
}

export interface CachedBalance {
  /** The newest transfer of this token the balance was read under. */
  readonly fingerprint: string;
  /** The balance in the token's smallest unit. */
  readonly raw: string;
}

export type BalanceCacheStore = Pick<Redis, 'mget' | 'set'>;

export class TokenBalanceCache {
  constructor(private readonly store: BalanceCacheStore | null) {}

  key(chainId: number, address: string, contract: string): string {
    return `etherscan:tokenbalance:${chainId}:${address.toLowerCase()}:${contract.toLowerCase()}`;
  }

  /** `available: false` means nothing was read, and every key is a miss. */
  async read(
    keys: readonly string[]
  ): Promise<{ available: boolean; hits: Map<string, CachedBalance> }> {
    const hits = new Map<string, CachedBalance>();
    if (!this.store) return { available: false, hits };
    if (keys.length === 0) return { available: true, hits };
    let values: (string | null)[];
    try {
      values = await withDeadline(
        this.store.mget(...keys),
        DEADLINE_MS,
        () => new StoreCommandTimeoutError('redis', 'etherscan balance cache read', DEADLINE_MS)
      );
    } catch {
      return { available: false, hits };
    }
    keys.forEach((key, i) => {
      const parsed = parse(values[i]);
      if (parsed) hits.set(key, parsed);
    });
    return { available: true, hits };
  }

  /** Best effort: a write that fails only costs the next run a fetch. */
  async write(entries: ReadonlyArray<readonly [string, CachedBalance]>): Promise<void> {
    if (!this.store || entries.length === 0) return;
    const store = this.store;
    try {
      await withDeadline(
        Promise.all(
          entries.map(([key, value]) =>
            store.set(key, JSON.stringify(value), 'EX', BALANCE_CACHE_TTL_SECONDS)
          )
        ),
        DEADLINE_MS,
        () => new StoreCommandTimeoutError('redis', 'etherscan balance cache write', DEADLINE_MS)
      );
    } catch {
      // Nothing to undo: an entry that did land is still a true reading.
    }
  }
}

function parse(value: string | null | undefined): CachedBalance | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Partial<CachedBalance>;
    if (typeof v.fingerprint !== 'string' || typeof v.raw !== 'string') return null;
    if (!/^\d+$/.test(v.raw)) return null;
    return { fingerprint: v.fingerprint, raw: v.raw };
  } catch {
    return null;
  }
}
