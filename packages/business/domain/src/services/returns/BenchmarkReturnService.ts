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
import { PriceGraphService } from '../pricing/PriceGraphService';

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
  private readonly priceGraphService = Container.get(PriceGraphService);

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
    return Promise.all(
      BENCHMARKS.map(async (benchmark) => {
        const tokenId = await this.tokenIdOf(benchmark);
        if (!tokenId) return { key: benchmark.key, cumulative: null };
        const [opening, closing] = await Promise.all([
          this.priceGraphService.convert(new Decimal(1), tokenId, baseCurrencyId, start, {
            tx: undefined,
            preferGranularity: 'daily',
          }),
          this.priceGraphService.convert(new Decimal(1), tokenId, baseCurrencyId, end, {
            tx: undefined,
            preferGranularity: 'daily',
          }),
        ]);
        if (!opening || !closing || opening.amount.lte(0)) {
          return { key: benchmark.key, cumulative: null };
        }
        return {
          key: benchmark.key,
          cumulative: closing.amount.div(opening.amount).minus(1).toString(),
        };
      })
    );
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
