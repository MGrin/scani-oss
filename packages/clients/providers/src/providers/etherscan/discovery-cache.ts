import { StoreCommandTimeoutError, withDeadline } from '@scani/deadline';
import type { Redis } from 'ioredis';

/**
 * The tokens an address has transferred, remembered between runs (SC-1535).
 *
 * After the balance cache (SC-1513) the hourly wallet sync spent most of its
 * Etherscan time re-reading every wallet's whole `tokentx` history to find
 * which tokens it holds — 15.5s for one 554-row wallet. Transfers are
 * append-only, so a run that knows the history up to block B only needs the
 * transfers from B on.
 *
 * What keeps that from ever supplying a set the chain would not:
 *
 * - **No entry, Redis down or slow** — a miss, and the caller reads the whole
 *   history as it always did.
 * - **A day since the last full read** — a miss. Incremental reads never move
 *   `sweptAt`, so every address is read in full at least once a day whatever
 *   an incremental read could have missed.
 * - **Late indexing** — the incremental read starts `OVERLAP_BLOCKS` before
 *   the newest block seen, and a transfer seen twice is merged, not counted.
 */

export const DISCOVERY_SWEEP_SECONDS = 86_400;
export const OVERLAP_BLOCKS = 200;
const DEADLINE_MS = 500;

export interface DiscoveredToken {
  readonly contract: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  /** The newest transfer of this token to or from the address. */
  readonly newest: {
    readonly blockNumber: string;
    readonly hash: string;
    readonly timeStamp: string;
  };
}

export interface DiscoveryEntry {
  /** Unix seconds of the last FULL read of the history. */
  readonly sweptAt: number;
  /** The newest block any transfer read so far was in. */
  readonly lastBlock: number;
  /** Newest first, as a full read would order them. */
  readonly tokens: readonly DiscoveredToken[];
}

export type DiscoveryCacheStore = Pick<Redis, 'get' | 'set'>;

export class TokenDiscoveryCache {
  constructor(
    private readonly store: DiscoveryCacheStore | null,
    readonly now: () => number = () => Date.now() / 1000
  ) {}

  key(chainId: number, address: string): string {
    return `etherscan:tokentx:${chainId}:${address.toLowerCase()}`;
  }

  /** `available: false` means the store could not be asked; `entry: null` is a miss either way. */
  async read(key: string): Promise<{ available: boolean; entry: DiscoveryEntry | null }> {
    if (!this.store) return { available: false, entry: null };
    let value: string | null;
    try {
      value = await withDeadline(
        this.store.get(key),
        DEADLINE_MS,
        () => new StoreCommandTimeoutError('redis', 'etherscan discovery cache read', DEADLINE_MS)
      );
    } catch {
      return { available: false, entry: null };
    }
    const entry = parse(value);
    if (!entry || this.now() - entry.sweptAt >= DISCOVERY_SWEEP_SECONDS) {
      return { available: true, entry: null };
    }
    return { available: true, entry };
  }

  /** Best effort, and it expires with the sweep it carries rather than a day from now. */
  async write(key: string, entry: DiscoveryEntry): Promise<void> {
    if (!this.store) return;
    const ttl = Math.floor(DISCOVERY_SWEEP_SECONDS - (this.now() - entry.sweptAt));
    if (ttl <= 0) return;
    try {
      await withDeadline(
        this.store.set(key, JSON.stringify(entry), 'EX', ttl),
        DEADLINE_MS,
        () => new StoreCommandTimeoutError('redis', 'etherscan discovery cache write', DEADLINE_MS)
      );
    } catch {
      // The next run reads the whole history again.
    }
  }
}

function parse(value: string | null | undefined): DiscoveryEntry | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Partial<DiscoveryEntry>;
    if (typeof v.sweptAt !== 'number' || typeof v.lastBlock !== 'number') return null;
    if (!Array.isArray(v.tokens)) return null;
    for (const t of v.tokens) {
      if (
        typeof t?.contract !== 'string' ||
        typeof t.symbol !== 'string' ||
        typeof t.name !== 'string' ||
        typeof t.decimals !== 'number' ||
        typeof t.newest?.blockNumber !== 'string' ||
        typeof t.newest.hash !== 'string' ||
        typeof t.newest.timeStamp !== 'string'
      ) {
        return null;
      }
    }
    return { sweptAt: v.sweptAt, lastBlock: v.lastBlock, tokens: v.tokens };
  } catch {
    return null;
  }
}
