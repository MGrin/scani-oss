/**
 * BackfillHistoricalPricesUseCase
 *
 * Identifies (token, date) pairs that need a daily-close price and runs
 * them through HistoricalPriceBackfillService. Scoped deliberately to
 * only the tokens users actually hold, in the user's base currency(s),
 * to keep request volume proportional to value delivered.
 *
 * Called from:
 *  - apps/backend/worker/src/processors/historical-price-backfill.ts (nightly)
 *  - apps/backend/worker/src/processors/ingest-transactions.ts (after an
 *    ingester populates new tx occurred_at dates)
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { HistoricalPriceBackfillService } from '../services';

const logger = createComponentLogger('use-case:backfill-historical-prices');

export interface BackfillSummary {
  attempted: number;
  inserted: number;
  alreadyHad: number;
  providerMissing: number;
  durationMs: number;
}

@Service()
export class BackfillHistoricalPricesUseCase {
  // Class-field DI — see note in BalanceAtTimeService.ts.
  private readonly backfillService = Container.get(HistoricalPriceBackfillService);

  // Walks every user's held tokens, identifies dates where we have a
  // transaction but no nearby daily price, and runs the backfill.
  // Idempotent — re-running does no harm because the service short-circuits
  // on existing daily prices within a 24h window.
  async execute(
    opts: {
      usdTokenId: string;
      lookbackDays?: number;
      // Scope to a single user — when set, both the holdings and
      // transactions discovery queries filter by user_id, so the
      // candidate set covers only this user's tokens.
      userId?: string;
      // Restrict to specific tokens — applied after the held/tx union,
      // before the existing-price-dedup. Useful for the manual-create
      // follow-up flow that wants to backfill exactly the tokens the
      // user just added.
      tokenIds?: string[];
    } = { usdTokenId: '' }
  ): Promise<BackfillSummary> {
    const start = Date.now();
    if (!opts.usdTokenId) {
      throw new Error('BackfillHistoricalPricesUseCase.execute requires opts.usdTokenId');
    }
    const lookback = opts.lookbackDays ?? 365 * 5;
    const since = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000);

    // Identify (token, date) pairs we need.
    //
    // Strategy: cross-product every token the user *has ever held*
    // (union of `holdings.token_id` with `holding_transactions.token_id`)
    // against every day in the lookback window, MINUS days that already
    // have a daily price within ±24h.
    //
    // Why not just tx-days? The rollup prices the portfolio at every
    // day in the lookback window, not just days the user transacted.
    // If the user's last BTC trade was in November 2025, the old
    // tx-only candidate set stored prices up to November and the
    // rollup then used November's $118k BTC close as the price for
    // every subsequent day — producing a flat chart and a wildly
    // wrong current-day total when the live price diverged. Covering
    // every day eliminates both problems.
    //
    // Scale: ~N_tokens × lookbackDays candidates. With the in-memory
    // per-pair cache in ExchangeKlinesProvider (one HTTP call per
    // pair covers ~720 daily bars from Kraken) and Frankfurter's
    // generous free tier, this fits easily inside the cron window
    // for users with tens of tokens.
    // Build the candidate set with three plain Drizzle queries + an
    // in-memory cross-product. Clearer than the previous raw-SQL CTE
    // (which was misparsing param order in postgres.js) and still
    // cheap: three indexed queries plus a Map-based dedup over a few
    // thousand rows.
    //   1. Every token the user has ever held (union of holdings
    //      + holding_transactions).
    //   2. Existing daily-granularity price rows in the lookback
    //      window (so we can skip candidates we already priced).
    //   3. generate_series in JS for the date list.
    const heldTokens = await db
      .select({ tokenId: schema.holdings.tokenId })
      .from(schema.holdings)
      .where(opts.userId ? eq(schema.holdings.userId, opts.userId) : undefined)
      .groupBy(schema.holdings.tokenId);
    const txTokens = await db
      .select({ tokenId: schema.holdingTransactions.tokenId })
      .from(schema.holdingTransactions)
      .where(
        opts.userId
          ? and(
              gte(schema.holdingTransactions.occurredAt, since),
              eq(schema.holdingTransactions.userId, opts.userId)
            )
          : gte(schema.holdingTransactions.occurredAt, since)
      )
      .groupBy(schema.holdingTransactions.tokenId);
    const userTokenSet = new Set<string>();
    for (const r of heldTokens) userTokenSet.add(r.tokenId);
    for (const r of txTokens) userTokenSet.add(r.tokenId);
    userTokenSet.delete(opts.usdTokenId); // base → identity; skip
    if (opts.tokenIds && opts.tokenIds.length > 0) {
      const restrict = new Set(opts.tokenIds);
      for (const id of [...userTokenSet]) {
        if (!restrict.has(id)) userTokenSet.delete(id);
      }
    }

    const existing = await db
      .select({
        tokenId: schema.tokenPrices.tokenId,
        // Bucket to day in SQL so the JS set key matches the series
        // format. `date_trunc('day', ts)` returns midnight UTC of the
        // row's day, which mirrors how we construct `dayAt` below.
        day: sql<Date>`date_trunc('day', ${schema.tokenPrices.timestamp})`,
      })
      .from(schema.tokenPrices)
      .where(
        and(
          eq(schema.tokenPrices.baseTokenId, opts.usdTokenId),
          eq(schema.tokenPrices.granularity, 'daily'),
          gte(schema.tokenPrices.timestamp, since),
          ne(schema.tokenPrices.tokenId, opts.usdTokenId)
        )
      );
    const havePriced = new Set<string>();
    for (const r of existing) {
      const dt = r.day instanceof Date ? r.day : new Date(r.day as unknown as string);
      havePriced.add(`${r.tokenId}:${dt.toISOString().slice(0, 10)}`);
    }

    // Day series in JS. `since` is already midnight UTC of the earliest
    // day we want to cover; step by 86400000ms until today inclusive.
    const sinceDay = new Date(
      Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
    );
    const today = new Date();
    const todayDay = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    );
    const dayMs = 86_400_000;
    const normalized: Array<{ tokenId: string; day: Date }> = [];
    for (const tokenId of userTokenSet) {
      for (let t = sinceDay.getTime(); t <= todayDay.getTime(); t += dayMs) {
        const dayAt = new Date(t);
        const key = `${tokenId}:${dayAt.toISOString().slice(0, 10)}`;
        if (havePriced.has(key)) continue;
        normalized.push({ tokenId, day: dayAt });
      }
    }

    logger.info(
      { pending: normalized.length, lookbackDays: lookback },
      'Historical price backfill candidates identified'
    );

    const summary: BackfillSummary = {
      attempted: normalized.length,
      inserted: 0,
      alreadyHad: 0,
      providerMissing: 0,
      durationMs: 0,
    };

    // Group candidates by tokenId so each token gets ONE range fetch
    // against its provider instead of one HTTP call per (token, day).
    // For range-aware providers (Finnhub, Yahoo, Frankfurter) this
    // collapses 365 sequential calls per token into one. For providers
    // without a range API (CoinGecko, DeFiLlama, Kraken historical)
    // backfillTokenRange falls back to parallel per-day calls within
    // the provider's own rate limiter — still much faster than the
    // old per-candidate loop because all days for one token now
    // share the limiter's bucket fill instead of being serialized.
    const daysByToken = new Map<string, Date[]>();
    for (const row of normalized) {
      const arr = daysByToken.get(row.tokenId);
      if (arr) arr.push(row.day);
      else daysByToken.set(row.tokenId, [row.day]);
    }
    const tokenIds = [...daysByToken.keys()];

    // Cap fan-out so we don't open dozens of HTTP connections at
    // once when the same provider would handle them all anyway.
    // Different tokens land on different providers (each with its
    // own rate limiter), so 10 parallel tokens is the sweet spot:
    // covers the typical 5-10 distinct holdings without DOS-ing
    // any single provider.
    const TOKEN_CONCURRENCY = 10;
    for (let i = 0; i < tokenIds.length; i += TOKEN_CONCURRENCY) {
      const batch = tokenIds.slice(i, i + TOKEN_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (tokenId) => {
          const days = daysByToken.get(tokenId) ?? [];
          return this.backfillService.backfillTokenRange(tokenId, opts.usdTokenId, days);
        })
      );
      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        if (result?.status === 'fulfilled') {
          summary.inserted += result.value.inserted;
          summary.alreadyHad += result.value.alreadyHad;
          summary.providerMissing += result.value.providerMissing;
        } else if (result?.status === 'rejected') {
          const tokenId = batch[j];
          const days = daysByToken.get(tokenId ?? '') ?? [];
          summary.providerMissing += days.length;
          logger.warn(
            { tokenId, error: result.reason },
            'Per-token range backfill rejected; counted as provider-missing'
          );
        }
      }
    }

    summary.durationMs = Date.now() - start;
    logger.info({ summary }, 'Historical price backfill complete');
    return summary;
  }
}
