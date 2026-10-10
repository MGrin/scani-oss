import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewTokenPrice, TokenPrice } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, gte, inArray, like, lt, ne, or, sql } from 'drizzle-orm';
import { Service } from 'typedi';

/** A row's place in the table's unique key. */
export interface PriceKey {
  tokenId: string;
  baseTokenId: string;
  at: Date;
  granularity: string;
}

// The `i` column carries each key's position, so no timestamp is parsed back.
// Instants go as ISO text: a raw template would send `Date.toString()`.
function keyValues(keys: readonly PriceKey[]) {
  return sql.join(
    keys.map(
      (key, i) =>
        sql`(${i}::int, ${key.tokenId}::uuid, ${key.baseTokenId}::uuid, ${key.at.toISOString()}::timestamptz, ${key.granularity}::text)`
    ),
    sql`, `
  );
}

function byPosition(
  keys: readonly PriceKey[],
  rows: ReadonlyArray<{ i: number; price: string }>
): Array<string | undefined> {
  const prices: Array<string | undefined> = keys.map(() => undefined);
  for (const row of rows) prices[Number(row.i)] = row.price;
  return prices;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Past this age a day whose readings are all early is no longer asked for: a
// weekend or holiday has no close at any provider, and asking every night would
// grow without end.
const SETTLED_HISTORY_DAYS = 7;

/** A sample of a curve, as opposed to a person's mark. */
const SAMPLED_READING = sql`(granularity = 'intraday' AND (source IS NULL OR source NOT LIKE 'manual%'))`;

/** D-7: a sampled reading in the last hour of its UTC day stands in for that day's close. */
const LAST_HOUR_READING = sql`(${SAMPLED_READING} AND extract(hour FROM "timestamp" AT TIME ZONE 'UTC') = 23)`;

@Service()
export class TokenPriceRepository extends BaseRepository<TokenPrice, NewTokenPrice> {
  protected readonly table = schema.tokenPrices;
  protected readonly tableName = 'token_prices';

  async findLatestPrice(
    tokenId: string,
    baseTokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.tokenPrices)
        .where(
          and(
            eq(schema.tokenPrices.tokenId, tokenId),
            eq(schema.tokenPrices.baseTokenId, baseTokenId)
          )
        )
        .orderBy(desc(schema.tokenPrices.timestamp))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ tokenId, baseTokenId, error }, 'Failed to find latest price');
      throw error;
    }
  }

  async findLatestPricesForTokens(
    tokenIds: string[],
    baseTokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<Map<string, TokenPrice>> {
    try {
      if (tokenIds.length === 0) return new Map();

      const database = this.getDb(transaction);

      // Bounded read: DISTINCT ON (token_id) rides idx_token_prices_lookup
      // (token_id, base_token_id, timestamp DESC) to the latest row per token
      // instead of reading each token's whole history.
      const results = await database
        .selectDistinctOn([schema.tokenPrices.tokenId])
        .from(schema.tokenPrices)
        .where(
          and(
            inArray(schema.tokenPrices.tokenId, tokenIds),
            eq(schema.tokenPrices.baseTokenId, baseTokenId)
          )
        )
        .orderBy(asc(schema.tokenPrices.tokenId), desc(schema.tokenPrices.timestamp));

      return new Map(results.map((price) => [price.tokenId, price]));
    } catch (error) {
      this.logger.error(
        { tokenIds, baseTokenId, error },
        'Failed to find latest prices for tokens'
      );
      throw error;
    }
  }

  /**
   * Return the latest manual price per tokenId regardless of baseTokenId.
   * A price a person typed is stored in the currency they typed it in, so
   * the warm-up and the refresh ask whether one exists in any base, and a
   * new manual price records the one it replaces from there.
   */
  async findLatestManualPricesForTokensAnyBase(
    tokenIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, TokenPrice>> {
    try {
      if (tokenIds.length === 0) return new Map();

      const database = this.getDb(transaction);

      // Bounded read: DISTINCT ON (token_id) rides idx_token_prices_lookup
      // to fetch the latest manual row per token instead of scanning the
      // whole table.
      const results = await database
        .selectDistinctOn([schema.tokenPrices.tokenId])
        .from(schema.tokenPrices)
        .where(
          and(
            inArray(schema.tokenPrices.tokenId, tokenIds),
            like(schema.tokenPrices.source, 'manual%')
          )
        )
        .orderBy(asc(schema.tokenPrices.tokenId), desc(schema.tokenPrices.timestamp));

      const priceMap = new Map<string, TokenPrice>();
      for (const price of results) {
        if (!priceMap.has(price.tokenId)) {
          priceMap.set(price.tokenId, price);
        }
      }

      return priceMap;
    } catch (error) {
      this.logger.error(
        { tokenIds, error },
        'Failed to find latest manual prices for tokens (any base)'
      );
      throw error;
    }
  }

  async bulkUpsert(
    prices: NewTokenPrice[],
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice[]> {
    try {
      if (prices.length === 0) return [];

      const database = this.getDb(transaction);

      // Insert with conflict handling. Migration 0053 widened the
      // unique key to include `granularity`; include it here so existing
      // call-sites (still passing 3 columns) align with the new schema.
      const results = await database
        .insert(schema.tokenPrices)
        // biome-ignore lint/suspicious/noExplicitAny: Generic array type for batch insert with conflict resolution
        .values(prices as any[])
        .onConflictDoUpdate({
          target: [
            schema.tokenPrices.tokenId,
            schema.tokenPrices.baseTokenId,
            schema.tokenPrices.timestamp,
            schema.tokenPrices.granularity,
          ],
          set: {
            price: sql`EXCLUDED.price`,
            source: sql`EXCLUDED.source`,
          },
          // A close belongs to its source: every provider's close of a day
          // shares one stamp, so a plain upsert would hand the day to whichever
          // answered last. A downsample-daily row only stands in for a close.
          setWhere: sql`${schema.tokenPrices.granularity} <> 'daily'
            OR ${schema.tokenPrices.source} IS NOT DISTINCT FROM EXCLUDED.source
            OR ${schema.tokenPrices.source} = 'downsample-daily'`,
        })
        .returning();

      this.logger.debug({ count: results.length }, 'Bulk upserted token prices');
      return results;
    } catch (error) {
      this.logger.error({ count: prices.length, error }, 'Failed to bulk upsert prices');
      throw error;
    }
  }

  /**
   * For each key, the price of its pair's latest row at or before its
   * instant; at one instant, the row of the key's own granularity first,
   * being the one an upsert of the key replaces. Answers by position.
   */
  async findLatestPricesAtOrBefore(
    keys: readonly PriceKey[],
    transaction?: DatabaseTransaction
  ): Promise<Array<string | undefined>> {
    if (keys.length === 0) return [];
    const rows = (await this.getDb(transaction).execute(sql`
      SELECT a.i, latest.price
        FROM (VALUES ${keyValues(keys)}) AS a(i, token_id, base_token_id, at, granularity)
        CROSS JOIN LATERAL (
          SELECT p.price FROM token_prices p
           WHERE p.token_id = a.token_id AND p.base_token_id = a.base_token_id
             AND p."timestamp" <= a.at
           ORDER BY p."timestamp" DESC, (p.granularity = a.granularity) DESC
           LIMIT 1
        ) latest
    `)) as unknown as Array<{ i: number; price: string }>;
    return byPosition(keys, rows);
  }

  /** For each key, the price stored at exactly that key, if any. Answers by position. */
  async findPricesAtKeys(
    keys: readonly PriceKey[],
    transaction?: DatabaseTransaction
  ): Promise<Array<string | undefined>> {
    if (keys.length === 0) return [];
    const rows = (await this.getDb(transaction).execute(sql`
      SELECT a.i, p.price
        FROM (VALUES ${keyValues(keys)}) AS a(i, token_id, base_token_id, at, granularity)
        JOIN token_prices p
          ON p.token_id = a.token_id AND p.base_token_id = a.base_token_id
         AND p."timestamp" = a.at AND p.granularity = a.granularity
    `)) as unknown as Array<{ i: number; price: string }>;
    return byPosition(keys, rows);
  }

  // `${tokenId}:${YYYY-MM-DD}` for every UTC day at or after `since` that is
  // covered against `baseTokenId`, so there is nothing to fetch for it (D-8,
  // foundation A3 Task 13). Today is covered by any reading since it began. A
  // past day is covered by a daily row of any source, by a last-hour reading
  // (`LAST_HOUR_READING`), or, once older than `SETTLED_HISTORY_DAYS`, by any
  // reading. `tokenIds` scopes the read; omitted, it is every token but the
  // base. A per-user caller must pass its tokens: unscoped, this is one row per
  // priced day of every token on the platform (SC-1283).
  async findPricedDayKeys(
    opts: { baseTokenId: string; since: Date; tokenIds?: readonly string[]; now?: Date },
    transaction?: DatabaseTransaction
  ): Promise<Set<string>> {
    const keys = new Set<string>();
    if (opts.tokenIds?.length === 0) return keys;
    const now = opts.now ?? new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const settledBefore = new Date(todayStart.getTime() - SETTLED_HISTORY_DAYS * DAY_MS);
    const rows = await this.getDb(transaction)
      .selectDistinct({
        tokenId: schema.tokenPrices.tokenId,
        // The `AT TIME ZONE` pair is load-bearing: `date_trunc('day', ts)`
        // on a `timestamptz` buckets in the SESSION timezone, which nothing
        // in this repo pins. On a connection an hour east of UTC every key
        // would land a day off the UTC series callers build, and a dedup
        // over them would match nothing.
        day: sql<string>`to_char(date_trunc('day', ${schema.tokenPrices.timestamp} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
      })
      .from(schema.tokenPrices)
      .where(
        and(
          eq(schema.tokenPrices.baseTokenId, opts.baseTokenId),
          gte(schema.tokenPrices.timestamp, opts.since),
          opts.tokenIds
            ? inArray(schema.tokenPrices.tokenId, [...opts.tokenIds])
            : ne(schema.tokenPrices.tokenId, opts.baseTokenId),
          or(
            eq(schema.tokenPrices.granularity, 'daily'),
            LAST_HOUR_READING,
            gte(schema.tokenPrices.timestamp, todayStart),
            lt(schema.tokenPrices.timestamp, settledBefore)
          )
        )
      );
    for (const r of rows) keys.add(`${r.tokenId}:${r.day}`);
    return keys;
  }
}
