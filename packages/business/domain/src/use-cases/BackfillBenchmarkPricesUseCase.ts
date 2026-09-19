import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { and, eq, isNull, max, min } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { BENCHMARKS, type Benchmark, benchmarkDaysToFetch } from '../lib/returns/benchmarks';
import { TokenRepository } from '../repositories/TokenRepository';
import { HistoricalPriceBackfillService } from '../services/pricing/HistoricalPriceBackfillService';

const logger = createComponentLogger('use-case:backfill-benchmark-prices');

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

  async execute(opts: { usdTokenId: string; now?: Date }): Promise<BenchmarkBackfillResult[]> {
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
    return results;
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
