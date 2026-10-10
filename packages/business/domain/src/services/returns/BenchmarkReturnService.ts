import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import {
  BENCHMARKS,
  type Benchmark,
  type BenchmarkKey,
  monthOf,
  US_INFLATION,
} from '../../lib/returns/benchmarks';
import { PriceReader } from '../pricing/PriceReader';

export interface BenchmarkReturn {
  key: BenchmarkKey;
  /** Cumulative, as a fraction. Null when either end has no price. */
  cumulative: string | null;
}

/**
 * The instant a measured day is valued at, as `RollupPortfolioValueDailyUseCase`
 * values it: the end of that UTC day, or now for today. A benchmark read at
 * any other instant would be compared against a portfolio measured at a
 * different moment.
 */
export function measuredDayInstant(day: string, now: Date = new Date()): Date {
  const endOfDay = new Date(`${day}T23:59:59.999Z`);
  return endOfDay.getTime() > now.getTime() ? now : endOfDay;
}

/**
 * What each benchmark did over the window a return was measured on (SC-464),
 * in the reader's base currency.
 *
 * A benchmark is bought and held, so its time-weighted return over any
 * boundaries is its price ratio: end over start, minus one. Converted into
 * the base currency, so a GBP reader's S&P 500 carries the dollar's move as
 * their own portfolio does.
 */
@Service()
export class BenchmarkReturnService {
  private readonly priceReader = Container.get(PriceReader);

  async over(
    window: { from: string; to: string },
    baseCurrencyId: string,
    now: Date = new Date()
  ): Promise<BenchmarkReturn[]> {
    const start = measuredDayInstant(window.from, now);
    const end = measuredDayInstant(window.to, now);
    const [prices, inflation] = await Promise.all([
      this.priceBenchmarks(start, end, baseCurrencyId),
      this.inflationOver(window),
    ]);
    return inflation ? [...prices, inflation] : prices;
  }

  /**
   * Each benchmark's price on each of `days`, in the reader's base currency
   * (SC-1297), so the same money can be charted as if it had gone there
   * instead. Inflation is an index rather than a price and is returned on the
   * same shape, rebased to the first day that has one.
   *
   * A day with no price is ABSENT from its map rather than carried forward.
   * A flat segment drawn through a gap is a claim the benchmark did not move,
   * which is the one thing an unpriced day cannot support.
   *
   * Every day is read from one series with `priceAt`, the path the
   * cumulative figure printed beside this chart reads too, so the two cannot
   * disagree. One load covers every benchmark and every day (SC-1306: a
   * 120-point chart once cost 120 sequential round trips). Every measured day
   * is needed to fund and value the benchmark before the chart is sampled.
   */
  async pricesOn(
    days: string[],
    baseCurrencyId: string,
    now: Date = new Date()
  ): Promise<Map<BenchmarkKey, Map<string, Decimal>>> {
    const out = new Map<BenchmarkKey, Map<string, Decimal>>();
    const resolved = await this.resolved();
    const prices = await this.priceReader.series(
      resolved.flatMap(({ tokenId }) =>
        days.map((day) => ({ tokenId, at: measuredDayInstant(day, now) }))
      ),
      baseCurrencyId
    );
    for (const { benchmark, tokenId } of resolved) {
      const byDay = new Map<string, Decimal>();
      for (const day of days) {
        const price = prices.priceAt(tokenId, measuredDayInstant(day, now))?.price;
        if (price?.gt(0)) byDay.set(day, price);
      }
      if (byDay.size > 0) out.set(benchmark.key, byDay);
    }

    const inflation = await this.inflationIndexOn(days);
    if (inflation.size > 0) out.set(US_INFLATION.key, inflation);
    return out;
  }

  /**
   * The CPI index on each day, read as the value for the month that day falls
   * in. A month whose figure is unpublished — CPI lands mid-way through the
   * following month — has no entry, so the line stops rather than flattening.
   */
  private async inflationIndexOn(days: string[]): Promise<Map<string, Decimal>> {
    const byMonth = new Map<string, Decimal | null>();
    const index = new Map<string, Decimal>();

    for (const day of days) {
      const month = monthOf(day);
      if (!byMonth.has(month)) byMonth.set(month, await this.indexAt(month));
      const value = byMonth.get(month);
      if (value?.gt(0)) index.set(day, value);
    }
    return index;
  }

  /**
   * US CPI between the months the window's first and last measured days fall
   * in. Never converted: an index is a rate, and a currency move does not
   * change what US prices did. Null when either month is unpublished — CPI
   * for a month lands mid-way through the next one.
   */
  private async inflationOver(window: {
    from: string;
    to: string;
  }): Promise<BenchmarkReturn | null> {
    const [opening, closing] = await Promise.all([
      this.indexAt(monthOf(window.from)),
      this.indexAt(monthOf(window.to)),
    ]);
    if (!opening || !closing || opening.lte(0)) return null;
    return { key: US_INFLATION.key, cumulative: closing.div(opening).minus(1).toString() };
  }

  /** The series' value for `month`, or the latest published before it. */
  private async indexAt(month: string): Promise<Decimal | null> {
    const [row] = await db
      .select({ value: schema.inflationIndexMonthly.value })
      .from(schema.inflationIndexMonthly)
      .where(
        and(
          eq(schema.inflationIndexMonthly.seriesId, US_INFLATION.seriesId),
          lte(schema.inflationIndexMonthly.month, month)
        )
      )
      .orderBy(desc(schema.inflationIndexMonthly.month))
      .limit(1);
    return row ? new Decimal(row.value) : null;
  }

  private async priceBenchmarks(
    start: Date,
    end: Date,
    baseCurrencyId: string
  ): Promise<BenchmarkReturn[]> {
    const resolved = new Map(
      (await this.resolved()).map(({ benchmark, tokenId }) => [benchmark.key, tokenId])
    );
    const prices = await this.priceReader.series(
      [...resolved.values()].flatMap((tokenId) => [
        { tokenId, at: start },
        { tokenId, at: end },
      ]),
      baseCurrencyId
    );
    return BENCHMARKS.map((benchmark) => {
      const tokenId = resolved.get(benchmark.key);
      const opening = tokenId ? prices.priceAt(tokenId, start)?.price : undefined;
      const closing = tokenId ? prices.priceAt(tokenId, end)?.price : undefined;
      if (!opening || !closing || opening.lte(0)) return { key: benchmark.key, cumulative: null };
      return { key: benchmark.key, cumulative: closing.div(opening).minus(1).toString() };
    });
  }

  /** Every benchmark whose token exists, with that token. */
  private async resolved(): Promise<Array<{ benchmark: Benchmark; tokenId: string }>> {
    const tokenIds = await Promise.all(BENCHMARKS.map((benchmark) => this.tokenIdOf(benchmark)));
    return BENCHMARKS.flatMap((benchmark, i) => {
      const tokenId = tokenIds[i];
      return tokenId ? [{ benchmark, tokenId }] : [];
    });
  }

  private async tokenIdOf(benchmark: Benchmark): Promise<string | null> {
    const [row] = await db
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
      .where(
        and(
          eq(schema.tokens.symbol, benchmark.symbol),
          eq(schema.tokenTypes.code, benchmark.typeCode),
          benchmark.marketSegment === null
            ? isNull(schema.tokens.marketSegment)
            : eq(schema.tokens.marketSegment, benchmark.marketSegment)
        )
      )
      .orderBy(schema.tokens.isScamProbability, schema.tokens.createdAt)
      .limit(1);
    return row?.id ?? null;
  }
}
