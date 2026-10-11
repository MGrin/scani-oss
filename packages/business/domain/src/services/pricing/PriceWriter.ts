import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import type { NewTokenPrice } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import type { Decimal } from '@scani/shared';
import { Container, Service } from 'typedi';
import { CANONICAL_PRICE_TEXT, positivePrice } from '../../engine/price-index';
import type { PriceGranularity } from '../../engine/types';
import { type PriceKey, TokenPriceRepository } from '../../repositories/TokenPriceRepository';

const writerLogger = createComponentLogger('pricing:writer');

export interface PriceWrite {
  tokenId: string;
  baseTokenId: string;
  price: string;
  at: Date;
  granularity: PriceGranularity;
  source: string;
}

/** A current quote. Its instant is the call's, and it is always intraday. */
export type CurrentPriceWrite = Omit<PriceWrite, 'at' | 'granularity'>;

export interface PairAt {
  tokenId: string;
  baseTokenId: string;
  at: Date;
}

export interface PriceWriteOutcome {
  /**
   * Rows the table took: inserted, overwritten, or rewritten unchanged. A
   * history row landing on another source's daily close is refused, and not
   * counted.
   */
  written: number;
  /** Rows whose price was not a reading, so nothing was sent for them. */
  dropped: number;
  /**
   * A current or manual write whose price differs from the pair's latest
   * reading at or before its instant, or that has no such reading (D-5). At
   * one instant the row this write would replace is the one compared.
   */
  changed: PairAt[];
  /**
   * A history write's pairs with a row inserted or repriced, each from the UTC
   * day ('YYYY-MM-DD') of its earliest such row (D-5).
   */
  seriesChanged: Array<{ tokenId: string; baseTokenId: string; fromDay: string }>;
}

export interface HistoryWriteOutcome extends PriceWriteOutcome {
  /** The keys the table took, in the order they were given. */
  accepted: PriceKey[];
}

/**
 * The only writer of `token_prices`. A price that is not a reading is dropped
 * and counted rather than sent: the column refuses it, and one refused row
 * would fail every other row in the statement. Each write runs in the caller's
 * transaction, or in its own, so A4 can add its outbox rows beside it.
 */
@Service()
export class PriceWriter {
  private readonly prices = Container.get(TokenPriceRepository);

  /**
   * One reading per pair, each intraday at `at`: the instant the caller asked
   * for, whatever stamp a provider gave its quote. Upsert on the table's key. A
   * second reading for a pair in one call throws; a dropped row is not a
   * reading, so it never counts.
   */
  async writeCurrent(
    rows: readonly CurrentPriceWrite[],
    at: Date,
    tx?: DatabaseTransaction
  ): Promise<PriceWriteOutcome> {
    const { kept, dropped } = this.readings(
      rows.map(
        ({ tokenId, baseTokenId, price, source }): PriceWrite => ({
          tokenId,
          baseTokenId,
          price,
          at,
          granularity: 'intraday',
          source,
        })
      )
    );
    const pairs = new Set<string>();
    for (const { row } of kept) {
      const pair = pairKey(row);
      if (pairs.has(pair)) {
        throw new Error(
          `PriceWriter.writeCurrent: two readings for one pair in one call (token ${row.tokenId}, base ${row.baseTokenId})`
        );
      }
      pairs.add(pair);
    }
    if (kept.length === 0) return outcome(0, dropped);
    return this.inTransaction(tx, async (db) => {
      const before = await this.prices.findLatestPricesAtOrBefore(kept.map(keyOf), db);
      await this.prices.bulkUpsert(
        kept.map(({ row }) => toRow(row)),
        db
      );
      return {
        ...outcome(kept.length, dropped),
        changed: changedPairs(kept, before),
      };
    });
  }

  /**
   * Bars and backfilled readings. Upsert, except that a daily close is updated
   * only by the source that wrote it, or replaces a downsample-daily row.
   */
  async writeHistory(
    rows: readonly PriceWrite[],
    tx?: DatabaseTransaction
  ): Promise<HistoryWriteOutcome> {
    const { kept, dropped } = this.readings(rows);
    if (kept.length === 0) return { ...outcome(0, dropped), accepted: [] };
    return this.inTransaction(tx, async (db) => {
      const stored = await this.prices.findPricesAtKeys(kept.map(keyOf), db);
      const written = await this.prices.bulkUpsert(
        kept.map(({ row }) => toRow(row)),
        db
      );
      const acceptedKeys = new Set(
        written.map((row) => `${pairKey(row)}|${row.timestamp.getTime()}|${row.granularity}`)
      );
      const accepted = kept.map(({ row }) =>
        acceptedKeys.has(`${pairKey(row)}|${row.at.getTime()}|${row.granularity}`)
      );
      return {
        ...outcome(written.length, dropped),
        seriesChanged: seriesChangedFrom(
          kept.filter((_, i) => accepted[i]),
          stored.filter((_, i) => accepted[i])
        ),
        accepted: kept.filter((_, i) => accepted[i]).map(keyOf),
      };
    });
  }

  /** A person's price. Plain insert, inside the caller's transaction. */
  async writeManual(row: PriceWrite, tx: DatabaseTransaction): Promise<PriceWriteOutcome> {
    const { kept, dropped } = this.readings([row]);
    if (kept.length === 0) return outcome(0, dropped);
    const before = await this.prices.findLatestPricesAtOrBefore(kept.map(keyOf), tx);
    await this.prices.create(toRow(row), tx);
    return { ...outcome(1, 0), changed: changedPairs(kept, before) };
  }

  private readings(rows: readonly PriceWrite[]): { kept: Kept[]; dropped: number } {
    const kept: Kept[] = [];
    const refused: PriceWrite[] = [];
    for (const row of rows) {
      const price = readingOf(row.price);
      if (price === null) refused.push(row);
      else kept.push({ row, price });
    }
    // Debug, as the router's own filter logged it: its failure sentinel is a
    // '0' quote, and every hourly run carries some.
    if (refused.length > 0) {
      writerLogger.debug(
        {
          dropped: refused.length,
          rows: refused.map(({ tokenId, baseTokenId, source }) => ({
            tokenId,
            baseTokenId,
            source,
          })),
        },
        'Dropped prices that are not a positive decimal reading'
      );
    }
    return { kept, dropped: refused.length };
  }

  /**
   * Not `withTransaction`: its timeout races the transaction rather than
   * ending it, so a slow write could reject to its caller and then commit.
   */
  private inTransaction<T>(
    tx: DatabaseTransaction | undefined,
    work: (db: DatabaseTransaction) => Promise<T>
  ): Promise<T> {
    if (tx) return work(tx);
    return db.transaction(work);
  }
}

/**
 * Whether the column would take a price text, so the writer sends it: canonical
 * decimal notation, each part bounded, that the engine reads as a positive
 * finite number. The engine alone also reads '+1', '0x1A', '1_000' and a part
 * past its bound, all of which the column refuses.
 */
export function isStorablePrice(text: string): boolean {
  return readingOf(text) !== null;
}

function readingOf(text: string): Decimal | null {
  return CANONICAL_PRICE_TEXT.test(text) ? positivePrice(text) : null;
}

interface Kept {
  row: PriceWrite;
  price: Decimal;
}

function outcome(written: number, dropped: number): PriceWriteOutcome {
  return { written, dropped, changed: [], seriesChanged: [] };
}

function pairKey(row: { tokenId: string; baseTokenId: string }): string {
  return `${row.tokenId}|${row.baseTokenId}`;
}

function keyOf({ row }: Kept): PriceKey {
  return {
    tokenId: row.tokenId,
    baseTokenId: row.baseTokenId,
    at: row.at,
    granularity: row.granularity,
  };
}

function toRow(row: PriceWrite): NewTokenPrice {
  return {
    tokenId: row.tokenId,
    baseTokenId: row.baseTokenId,
    price: row.price,
    timestamp: row.at,
    granularity: row.granularity,
    source: row.source,
  };
}

/** Whether a stored text reads as `price`. A stored text that is not a reading never does. */
function samePrice(stored: string | undefined, price: Decimal): boolean {
  if (stored === undefined) return false;
  return positivePrice(stored)?.eq(price) ?? false;
}

/** `before[i]` answers `kept[i]`. */
function changedPairs(kept: readonly Kept[], before: ReadonlyArray<string | undefined>): PairAt[] {
  return kept
    .filter(({ price }, i) => !samePrice(before[i], price))
    .map(({ row }) => ({ tokenId: row.tokenId, baseTokenId: row.baseTokenId, at: row.at }));
}

/** `stored[i]` is what the table held at `kept[i]`'s key. */
function seriesChangedFrom(
  kept: readonly Kept[],
  stored: ReadonlyArray<string | undefined>
): PriceWriteOutcome['seriesChanged'] {
  const earliest = new Map<string, { tokenId: string; baseTokenId: string; at: Date }>();
  kept.forEach(({ row, price }, i) => {
    if (samePrice(stored[i], price)) return;
    const pair = pairKey(row);
    const known = earliest.get(pair);
    if (known === undefined || row.at.getTime() < known.at.getTime()) {
      earliest.set(pair, { tokenId: row.tokenId, baseTokenId: row.baseTokenId, at: row.at });
    }
  });
  return [...earliest.values()].map(({ tokenId, baseTokenId, at }) => ({
    tokenId,
    baseTokenId,
    fromDay: at.toISOString().slice(0, 10),
  }));
}
