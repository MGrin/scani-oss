import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { BlsClient } from '@scani/providers/providers/bls';
import { and, eq, isNull, max, min, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import {
  BENCHMARKS,
  type Benchmark,
  benchmarkDaysToFetch,
  US_INFLATION,
} from '../lib/returns/benchmarks';
import { TokenRepository } from '../repositories/TokenRepository';
import { HistoricalPriceBackfillService } from '../services/pricing/HistoricalPriceBackfillService';

const logger = createComponentLogger('use-case:backfill-benchmark-prices');

export interface InflationBackfillResult {
  seriesId: string;
  months: number;
  /** Set when BLS could not be read; the price benchmarks still ran. */
  error?: string;
}

export interface BenchmarkBackfillResult {
  key: Benchmark['key'];
  tokenId: string;
  requestedDays: number;
  inserted: number;
  providerUsed: string | null;
  attemptFailed: boolean;
}

/**
 * Daily USD closes for each benchmark, back to the earliest measured
 * portfolio day (SC-464).
 *
 * The nightly price backfill fetches only what somebody holds, so a user who
 * holds no Bitcoin has no Bitcoin history to be compared against. This fills
 * that for the benchmarks alone: two tokens, one range request each.
 */
@Service()
export class BackfillBenchmarkPricesUseCase {
  private readonly backfillService = Container.get(HistoricalPriceBackfillService);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly bls = Container.get(BlsClient);

  async execute(opts: {
    usdTokenId: string;
    now?: Date;
  }): Promise<{ prices: BenchmarkBackfillResult[]; inflation: InflationBackfillResult | null }> {
    const now = opts.now ?? new Date();
    // Yesterday: today's close does not exist yet.
    const through = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [earliest] = await db
      .select({ day: min(schema.portfolioValueDaily.snapshotDate) })
      .from(schema.portfolioValueDaily);
    const earliestNeeded = earliest?.day ? new Date(`${earliest.day}T00:00:00Z`) : null;

    const results: BenchmarkBackfillResult[] = [];
    for (const benchmark of BENCHMARKS) {
      const tokenId = await this.ensureToken(benchmark);
      const [stored] = await db
        .select({
          first: min(schema.tokenPrices.timestamp),
          last: max(schema.tokenPrices.timestamp),
        })
        .from(schema.tokenPrices)
        .where(
          and(
            eq(schema.tokenPrices.tokenId, tokenId),
            eq(schema.tokenPrices.baseTokenId, opts.usdTokenId)
          )
        );
      const days = benchmarkDaysToFetch({
        earliestNeeded,
        storedFirst: stored?.first ?? null,
        storedLast: stored?.last ?? null,
        through,
      });
      const outcome = await this.backfillService.backfillTokenRange(tokenId, opts.usdTokenId, days);
      const result = {
        key: benchmark.key,
        tokenId,
        requestedDays: days.length,
        inserted: outcome.inserted,
        providerUsed: outcome.providerUsed,
        attemptFailed: outcome.attemptFailed,
      };
      logger.info(result, 'Benchmark history backfilled');
      results.push(result);
    }
    const inflation = earliestNeeded ? await this.backfillInflation(earliestNeeded, now) : null;
    return { prices: results, inflation };
  }

  /**
   * US CPI, every month from the earliest measured portfolio day's year. One
   * request whatever the gap: BLS answers up to ten years at once, and a
   * published month can be revised, so re-reading the span costs nothing
   * and keeps the stored values current.
   */
  private async backfillInflation(
    earliestNeeded: Date,
    now: Date
  ): Promise<InflationBackfillResult> {
    const seriesId = US_INFLATION.seriesId;
    try {
      const points = await this.bls.fetchMonthly(
        seriesId,
        earliestNeeded.getUTCFullYear(),
        now.getUTCFullYear()
      );
      if (points.length > 0) {
        await db
          .insert(schema.inflationIndexMonthly)
          .values(
            points.map((p) => ({
              seriesId,
              month: p.month,
              value: p.value,
              source: US_INFLATION.source,
            }))
          )
          .onConflictDoUpdate({
            target: [schema.inflationIndexMonthly.seriesId, schema.inflationIndexMonthly.month],
            set: { value: sql`excluded.value`, fetchedAt: sql`now()` },
          });
      }
      const result = { seriesId, months: points.length };
      logger.info(result, 'Inflation index backfilled');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ seriesId, error: message }, 'Inflation index backfill failed');
      return { seriesId, months: 0, error: message };
    }
  }

  /** The benchmark's token row, created if no user has ever held it. */
  private async ensureToken(benchmark: Benchmark): Promise<string> {
    const [type] = await db
      .select({ id: schema.tokenTypes.id })
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, benchmark.typeCode))
      .limit(1);
    if (!type) throw new Error(`token type ${benchmark.typeCode} is missing`);

    const [existing] = await db
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(
        and(
          eq(schema.tokens.symbol, benchmark.symbol),
          eq(schema.tokens.typeId, type.id),
          benchmark.marketSegment === null
            ? isNull(schema.tokens.marketSegment)
            : eq(schema.tokens.marketSegment, benchmark.marketSegment)
        )
      )
      .orderBy(schema.tokens.isScamProbability, schema.tokens.createdAt)
      .limit(1);
    if (existing) return existing.id;

    const [created] = await this.tokenRepository.createMany([
      {
        symbol: benchmark.symbol,
        name: benchmark.name,
        typeId: type.id,
        marketSegment: benchmark.marketSegment,
      },
    ]);
    if (!created) throw new Error(`could not create the ${benchmark.symbol} benchmark token`);
    return created.id;
  }
}
