import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { and, eq, isNull } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { BENCHMARKS, type Benchmark } from '../../lib/returns/benchmarks';
import { PriceGraphService } from '../pricing/PriceGraphService';

export interface BenchmarkReturn {
  key: Benchmark['key'];
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
